/**
 * GitHub Sync — Outbound evaluation reporting ("layer over GitHub" mode).
 *
 * After an evaluation completes for a change whose project is GitHub-connected
 * and which has a linked PR, the verdict is reported to GitHub as:
 *   - a PR comment (upserted — a re-evaluation edits the prior comment via the
 *     stored `changes.github_comment_id` instead of posting a new one), and
 *   - a commit status with context "stratum/evaluation".
 *
 * Project identity lives in KV (`ProjectEntry`) — there is no `projects` D1
 * table — so callers pass the resolved project entry / owner+repo instead of
 * this module joining a phantom table. The credential is the instance-wide
 * `env.GITHUB_TOKEN`, the same decision the PR-promotion route made (the
 * per-user OAuth tokens in the `users` table are not used here).
 *
 * Reporting is best-effort by contract (like `recordAudit`): a GitHub failure
 * must never fail the evaluation that produced the verdict.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { parseRepoUrl } from "../storage/git-providers";
import type { Change, Env, ProjectEntry } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { GitHubClient } from "./client";

/** The commit-status context Stratum reports evaluation verdicts under. */
export const EVALUATION_STATUS_CONTEXT = "stratum/evaluation";

export interface EvaluatorRunReport {
  evaluatorType: string;
  score: number;
  passed: boolean;
  reason: string;
}

export interface EvaluationReport {
  score: number;
  passed: boolean;
  results: EvaluatorRunReport[];
}

/**
 * Shape an aggregate verdict + per-evaluator runs (as produced by
 * `runEvaluation` in the change flow) into the report the GitHub sync posts.
 */
export function buildEvaluationReport(
  evalResult: { score: number; passed: boolean },
  evalRuns: Array<{
    evaluatorType: string;
    result: { score: number; passed: boolean; reason: string };
  }>,
): EvaluationReport {
  return {
    score: evalResult.score,
    passed: evalResult.passed,
    results: evalRuns.map(({ evaluatorType, result }) => ({
      evaluatorType,
      score: result.score,
      passed: result.passed,
      reason: result.reason,
    })),
  };
}

/**
 * Resolve the GitHub owner/repo a project is connected to, or null when the
 * project has no GitHub source (pure-Stratum projects, or projects on another
 * provider). Identity comes from the KV project entry, never from D1.
 */
export function resolveGitHubRepo(project: ProjectEntry): { owner: string; repo: string } | null {
  if (project.sourceProvider !== undefined && project.sourceProvider !== "github") {
    return null;
  }

  const url = project.sourceUrl ?? project.githubUrl;
  if (url) {
    const parsed = parseRepoUrl(url);
    // A URL that parses to a non-GitHub provider (e.g. GitLab, Bitbucket) means
    // this project's actual source isn't GitHub — don't fall through to the
    // owner/repo fields below, which could be stale data from a prior provider.
    if (parsed) {
      return parsed.provider === "github"
        ? { owner: parsed.info.owner, repo: parsed.info.repo }
        : null;
    }
  }

  // Fall back to explicit owner/repo fields (set by imports) when no parseable
  // URL is present.
  const owner = project.sourceOwner ?? project.githubOwner;
  const repo = project.sourceRepo ?? project.githubRepo;
  if (owner && repo) return { owner, repo };

  return null;
}

export interface PostEvaluationCommentOpts {
  change: Change;
  owner: string;
  repo: string;
  /** Instance-wide GitHub credential (env.GITHUB_TOKEN). */
  githubToken: string;
  evaluation: EvaluationReport;
}

/**
 * Post the evaluation verdict as a comment on the change's linked PR.
 * Upserts: when `change.githubCommentId` is set, the existing comment is
 * edited; otherwise a new comment is created and its id stored on the change
 * row so the next evaluation edits it instead of spamming a new comment.
 */
export async function postEvaluationComment(
  db: D1Database,
  opts: PostEvaluationCommentOpts,
  logger: Logger,
): Promise<Result<{ commentId: number }, AppError>> {
  const { change, owner, repo, githubToken, evaluation } = opts;

  if (!change.githubPrNumber) {
    return err(new AppError("Change has no associated GitHub PR", "INVALID_STATE", 400));
  }

  const client = new GitHubClient(githubToken, logger);
  const body = buildEvaluationComment(evaluation);

  // Upsert: edit the prior verdict comment on re-evaluation.
  if (change.githubCommentId !== undefined) {
    const updateResult = await client.updateComment({
      owner,
      repo,
      comment_id: change.githubCommentId,
      body,
    });
    if (updateResult.success) {
      logger.info("Updated evaluation comment on GitHub PR", {
        changeId: change.id,
        commentId: change.githubCommentId,
      });
      return ok({ commentId: change.githubCommentId });
    }
    // The stored comment may have been deleted on GitHub — fall through and
    // post a fresh one rather than losing the verdict.
    logger.warn("Could not update existing evaluation comment; posting a new one", {
      changeId: change.id,
      commentId: change.githubCommentId,
      error: updateResult.error,
    });
  }

  const createResult = await client.postComment({
    owner,
    repo,
    issue_number: change.githubPrNumber,
    body,
  });
  if (!createResult.success) {
    return err(new AppError(`Failed to post comment: ${createResult.error}`, "GITHUB_ERROR", 502));
  }

  // Best-effort: losing the id only means the next evaluation posts a fresh
  // comment instead of editing this one.
  try {
    await db
      .prepare("UPDATE changes SET github_comment_id = ? WHERE id = ?")
      .bind(createResult.id, change.id)
      .run();
  } catch (error) {
    logger.warn("Failed to store GitHub comment id on change", {
      changeId: change.id,
      commentId: createResult.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logger.info("Posted evaluation comment on GitHub PR", {
    changeId: change.id,
    commentId: createResult.id,
  });
  return ok({ commentId: createResult.id });
}

export interface SyncChangeStatusOpts {
  change: Change;
  owner: string;
  repo: string;
  /** Instance-wide GitHub credential (env.GITHUB_TOKEN). */
  githubToken: string;
  evaluation: Pick<EvaluationReport, "score" | "passed">;
  targetUrl?: string;
}

/**
 * Sync the change's evaluation verdict to GitHub as a commit status
 * (context "stratum/evaluation") on the evaluated commit. Prefers the PR head
 * sha GitHub reported (`githubHeadSha`, kept current by the PR webhook) since a
 * status can only be set on a sha that exists in the GitHub repo; falls back to
 * the evaluated workspace sha for changes whose branch was mirrored verbatim.
 */
export async function syncChangeStatusToGitHub(
  opts: SyncChangeStatusOpts,
  logger: Logger,
): Promise<Result<{ sha: string }, AppError>> {
  const { change, owner, repo, githubToken, evaluation, targetUrl } = opts;

  const sha = change.githubHeadSha ?? change.evaluatedSha;
  if (!sha) {
    return err(new AppError("Change has no evaluated commit sha", "INVALID_STATE", 400));
  }

  const client = new GitHubClient(githubToken, logger);
  const statusResult = await client.setStatus({
    owner,
    repo,
    sha,
    state: evaluation.passed ? "success" : "failure",
    description: `Stratum evaluation ${evaluation.passed ? "passed" : "failed"}: score ${(evaluation.score * 100).toFixed(1)}%`,
    context: EVALUATION_STATUS_CONTEXT,
    ...(targetUrl !== undefined ? { target_url: targetUrl } : {}),
  });

  if (!statusResult.success) {
    return err(
      new AppError(`Failed to set commit status: ${statusResult.error}`, "GITHUB_ERROR", 502),
    );
  }

  logger.info("Set evaluation commit status on GitHub", {
    changeId: change.id,
    sha,
    passed: evaluation.passed,
  });
  return ok({ sha });
}

/**
 * Report an evaluation verdict to the change's linked GitHub PR: comment
 * (upserted) + commit status. No-op unless the project has a GitHub source AND
 * the change has a linked PR — pure-Stratum projects are untouched.
 *
 * Best-effort: every failure path logs and returns; nothing here may fail the
 * evaluation that produced the verdict.
 */
export async function reportEvaluationToGitHub(
  env: Pick<Env, "DB" | "GITHUB_TOKEN">,
  change: Change,
  project: ProjectEntry,
  evaluation: EvaluationReport,
  logger: Logger,
): Promise<void> {
  if (!change.githubPrNumber) return;

  const projectRepo = resolveGitHubRepo(project);
  if (!projectRepo) return;

  // Prefer the PR's actual coordinates recorded on the change row (set by the
  // promotion route / PR webhook); fall back to the project's source repo.
  const owner = change.githubOwner ?? projectRepo.owner;
  const repo = change.githubRepo ?? projectRepo.repo;

  const githubToken = env.GITHUB_TOKEN;
  if (!githubToken) {
    logger.warn("GITHUB_TOKEN not configured — skipping evaluation report to GitHub", {
      changeId: change.id,
    });
    return;
  }

  try {
    const commentResult = await postEvaluationComment(
      env.DB,
      { change, owner, repo, githubToken, evaluation },
      logger,
    );
    if (!commentResult.success) {
      logger.warn("Failed to post evaluation comment to GitHub", {
        changeId: change.id,
        error: commentResult.error.message,
      });
    }

    const statusResult = await syncChangeStatusToGitHub(
      { change, owner, repo, githubToken, evaluation },
      logger,
    );
    if (!statusResult.success) {
      logger.warn("Failed to set evaluation commit status on GitHub", {
        changeId: change.id,
        error: statusResult.error.message,
      });
    }
  } catch (error) {
    logger.warn("GitHub evaluation report threw; evaluation unaffected", {
      changeId: change.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Escape markdown table cell content and keep it to one line. */
function tableCell(text: string, maxLength = 200): string {
  const oneLine = text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1)}…` : oneLine;
}

/** Build the evaluation verdict comment body. */
export function buildEvaluationComment(evaluation: EvaluationReport): string {
  const status = evaluation.passed ? "✅" : "❌";
  const statusText = evaluation.passed ? "PASSED" : "FAILED";

  const lines = [
    `## ${status} Stratum Evaluation Results`,
    "",
    `**Composite Score:** ${(evaluation.score * 100).toFixed(1)}%`,
    `**Status:** ${statusText}`,
    "",
    "### Evaluator Results",
    "",
    "| Evaluator | Score | Status | Details |",
    "|-----------|-------|--------|---------|",
  ];

  for (const result of evaluation.results) {
    const evaluatorStatus = result.passed ? "✅" : "❌";
    lines.push(
      `| ${tableCell(result.evaluatorType)} | ${(result.score * 100).toFixed(1)}% | ${evaluatorStatus} | ${tableCell(result.reason)} |`,
    );
  }

  lines.push("", "---", "", "_Evaluation performed by [Stratum](https://stratum.dev)_");

  return lines.join("\n");
}
