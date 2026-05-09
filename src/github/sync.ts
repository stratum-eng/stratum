/**
 * GitHub Sync - Outbound
 * Push Stratum Changes to GitHub PRs and post evaluation comments
 */

import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import { getWorkspace } from "../storage/state";
import type { Change, ProjectEntry } from "../types";
import { AppError, NotFoundError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { GitHubClient, getGitHubToken } from "./client";

export interface PushChangeOpts {
  change: Change;
  project: ProjectEntry;
  userId: string;
  title?: string;
  body?: string;
}

/**
 * Push a Stratum Change to GitHub as a Pull Request
 * Creates PR if doesn't exist, updates if it does
 */
export async function pushChangeToGitHub(
  db: D1Database,
  kv: KVNamespace,
  opts: PushChangeOpts,
  encryptionSecret: string,
  logger: Logger,
): Promise<Result<{ prNumber: number; prUrl: string }, AppError>> {
  const { change, project, userId, title, body } = opts;

  logger.info("Pushing Change to GitHub", { changeId: change.id, projectId: project.id });

  // Look up workspace first — fail fast if it doesn't exist
  const workspaceResult = await getWorkspace(kv, project.id, change.workspace, logger);
  if (!workspaceResult.success) {
    return err(
      new AppError(
        `Workspace '${change.workspace}' not found for change ${change.id}`,
        "NOT_FOUND",
        404,
      ),
    );
  }
  const workspace = workspaceResult.data;
  const branch = workspace.branchName ?? workspace.name;
  if (!branch) {
    return err(
      new AppError(`Workspace '${change.workspace}' has no branch name`, "INVALID_STATE", 500),
    );
  }

  // Get user's GitHub token
  const tokenResult = await getGitHubToken(db, userId, encryptionSecret, logger);
  if (!tokenResult) {
    return err(new AppError("GitHub not connected", "GITHUB_NOT_CONNECTED", 400));
  }

  // Parse GitHub owner/repo from project source URL
  const sourceUrl = project.sourceUrl || project.githubUrl;
  if (!sourceUrl) {
    return err(new AppError("Project has no GitHub URL", "INVALID_STATE", 400));
  }

  const repoMatch = sourceUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
  if (!repoMatch) {
    return err(new AppError("Invalid GitHub URL", "INVALID_STATE", 400));
  }

  const [, owner, repo] = repoMatch;
  if (!owner || !repo) {
    return err(new AppError("Could not parse GitHub owner/repo", "INVALID_STATE", 400));
  }

  // Create GitHub client
  const client = new GitHubClient(tokenResult.accessToken, logger);

  // Build PR title and body
  const prTitle = title || `Stratum Change: ${change.id.slice(0, 8)}`;
  const prBody = body || buildPRBody(change, project);

  const baseBranch = project.sourceDefaultBranch || project.githubDefaultBranch || "main";

  try {
    let prNumber: number;
    let prUrl: string;

    if (change.githubPrNumber) {
      // Update existing PR
      logger.debug("Updating existing PR", { prNumber: change.githubPrNumber });
      const updateResult = await client.updatePR({
        owner,
        repo,
        pull_number: change.githubPrNumber,
        title: prTitle,
        body: prBody,
      });

      if (!updateResult.success) {
        return err(new AppError(`Failed to update PR: ${updateResult.error}`, "GITHUB_ERROR", 502));
      }

      prNumber = updateResult.pr.number;
      prUrl = updateResult.pr.html_url;
    } else {
      // Create new PR
      logger.debug("Creating new PR");
      const createResult = await client.createPR({
        owner,
        repo,
        title: prTitle,
        body: prBody,
        head: branch,
        base: baseBranch,
      });

      if (!createResult.success) {
        return err(new AppError(`Failed to create PR: ${createResult.error}`, "GITHUB_ERROR", 502));
      }

      prNumber = createResult.pr.number;
      prUrl = createResult.pr.html_url;

      // Store PR number in Change
      await db
        .prepare(
          `UPDATE changes
           SET github_pr_number = ?, github_pr_url = ?, github_owner = ?, github_repo = ?
           WHERE id = ?`,
        )
        .bind(prNumber, prUrl, owner, repo, change.id)
        .run();
    }

    logger.info("Successfully pushed Change to GitHub PR", {
      changeId: change.id,
      prNumber,
      prUrl,
    });
    return ok({ prNumber, prUrl });
  } catch (error) {
    logger.error("Failed to push Change to GitHub", error instanceof Error ? error : undefined, {
      changeId: change.id,
    });
    return err(new AppError("Failed to push to GitHub", "GITHUB_ERROR", 500));
  }
}

/**
 * Build PR body from Change data
 */
function buildPRBody(change: Change, project: ProjectEntry): string {
  const lines = [
    "## Stratum Change",
    "",
    `**Change ID:** ${change.id}`,
    `**Project:** ${project.namespace}/${project.slug}`,
    `**Workspace:** ${change.workspace}`,
    `**Status:** ${change.status}`,
    "",
    "---",
    "",
    "_This PR was created from [Stratum](https://stratum.dev)_",
  ];

  return lines.join("\n");
}

/**
 * Post evaluation results as a PR comment
 */
export async function postEvaluationComment(
  db: D1Database,
  changeId: string,
  evaluationResults: {
    compositeScore: number;
    passed: boolean;
    results: Array<{
      evaluatorId: string;
      evaluatorType: string;
      passed: boolean;
      score: number;
      summary: string;
    }>;
  },
  encryptionSecret: string,
  logger: Logger,
): Promise<Result<{ commentId: number }, AppError>> {
  logger.info("Posting evaluation comment", { changeId });

  // Get Change details
  const changeResult = await db
    .prepare(
      `SELECT c.*, p.owner_id as project_owner_id
       FROM changes c
       JOIN projects p ON c.project_id = p.id
       WHERE c.id = ?`,
    )
    .bind(changeId)
    .first<Change & { project_owner_id: string }>();

  if (!changeResult) {
    return err(new NotFoundError("Change", changeId));
  }

  if (!changeResult.githubPrNumber || !changeResult.githubOwner || !changeResult.githubRepo) {
    return err(new AppError("Change has no associated GitHub PR", "INVALID_STATE", 400));
  }

  // Get project owner's GitHub token
  const tokenResult = await getGitHubToken(
    db,
    changeResult.project_owner_id,
    encryptionSecret,
    logger,
  );
  if (!tokenResult) {
    return err(new AppError("GitHub not connected for project", "GITHUB_NOT_CONNECTED", 400));
  }

  const client = new GitHubClient(tokenResult.accessToken, logger);

  // Build comment body
  const commentBody = buildEvaluationComment(evaluationResults);

  // Post comment
  const commentResult = await client.postComment({
    owner: changeResult.githubOwner,
    repo: changeResult.githubRepo,
    issue_number: changeResult.githubPrNumber,
    body: commentBody,
  });

  if (!commentResult.success) {
    return err(new AppError(`Failed to post comment: ${commentResult.error}`, "GITHUB_ERROR", 502));
  }

  // Store comment ID
  await db
    .prepare("UPDATE changes SET github_comment_id = ? WHERE id = ?")
    .bind(commentResult.id, changeId)
    .run();

  // Set commit status using the head SHA from the PR
  const headSha = changeResult.githubHeadSha;
  if (!headSha) {
    logger.warn("Cannot set commit status: no head SHA available", { changeId });
  } else {
    const statusResult = await client.setStatus({
      owner: changeResult.githubOwner,
      repo: changeResult.githubRepo,
      sha: headSha,
      state: evaluationResults.passed ? "success" : "failure",
      description: `Stratum evaluation: ${evaluationResults.compositeScore.toFixed(2)}`,
      context: "stratum/evaluation",
    });

    if (!statusResult.success) {
      logger.warn("Failed to set commit status", { error: statusResult.error });
    }
  }

  logger.info("Posted evaluation comment", { changeId, commentId: commentResult.id });
  return ok({ commentId: commentResult.id });
}

/**
 * Build evaluation results comment
 */
function buildEvaluationComment(evaluation: {
  compositeScore: number;
  passed: boolean;
  results: Array<{
    evaluatorId: string;
    evaluatorType: string;
    passed: boolean;
    score: number;
    summary: string;
  }>;
}): string {
  const status = evaluation.passed ? "✅" : "❌";
  const statusText = evaluation.passed ? "PASSED" : "FAILED";

  const lines = [
    `## ${status} Stratum Evaluation Results`,
    "",
    `**Composite Score:** ${(evaluation.compositeScore * 100).toFixed(1)}%`,
    `**Status:** ${statusText}`,
    "",
    "### Evaluator Results",
    "",
    "| Evaluator | Type | Score | Status |",
    "|-----------|------|-------|--------|",
  ];

  for (const result of evaluation.results) {
    const evaluatorStatus = result.passed ? "✅" : "❌";
    lines.push(
      `| ${result.evaluatorId} | ${result.evaluatorType} | ${(result.score * 100).toFixed(1)}% | ${evaluatorStatus} |`,
    );
  }

  lines.push("", "---", "", "_Evaluation performed by [Stratum](https://stratum.dev)_");

  return lines.join("\n");
}

/**
 * Update PR status from Stratum Change status
 */
export async function syncChangeStatusToGitHub(
  db: D1Database,
  changeId: string,
  encryptionSecret: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  logger.info("Syncing Change status to GitHub", { changeId });

  // Get Change details
  const changeResult = await db
    .prepare(
      `SELECT c.*, p.owner_id as project_owner_id
       FROM changes c
       JOIN projects p ON c.project_id = p.id
       WHERE c.id = ?`,
    )
    .bind(changeId)
    .first<Change & { project_owner_id: string }>();

  if (!changeResult) {
    return err(new NotFoundError("Change", changeId));
  }

  if (!changeResult.githubPrNumber || !changeResult.githubOwner || !changeResult.githubRepo) {
    return err(new AppError("Change has no associated GitHub PR", "INVALID_STATE", 400));
  }

  // Get project owner's GitHub token
  const tokenResult = await getGitHubToken(
    db,
    changeResult.project_owner_id,
    encryptionSecret,
    logger,
  );
  if (!tokenResult) {
    return err(new AppError("GitHub not connected", "GITHUB_NOT_CONNECTED", 400));
  }

  const client = new GitHubClient(tokenResult.accessToken, logger);

  // Map Change status to PR state
  let state: "open" | "closed" | undefined;
  if (changeResult.status === "merged" || changeResult.status === "rejected") {
    state = "closed";
  } else if (changeResult.status === "open") {
    state = "open";
  }

  if (state) {
    const updateResult = await client.updatePR({
      owner: changeResult.githubOwner,
      repo: changeResult.githubRepo,
      pull_number: changeResult.githubPrNumber,
      state,
    });

    if (!updateResult.success) {
      return err(
        new AppError(`Failed to update PR status: ${updateResult.error}`, "GITHUB_ERROR", 502),
      );
    }

    logger.info("Synced Change status to GitHub", { changeId, status: changeResult.status, state });
  }

  return ok(undefined);
}
