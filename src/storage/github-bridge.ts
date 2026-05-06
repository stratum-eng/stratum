/**
 * GitHub Bridge Storage
 * Storage functions for GitHub integration
 */

import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import type { ProjectEntry } from "../types";
import { decryptToken, encryptToken } from "../utils/crypto";
import { AppError, NotFoundError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { listProjects } from "./state";

/**
 * Get project by GitHub owner/repo
 * Scans all projects to find matching GitHub repo
 */
export async function getProjectByGitHubRepo(
  kv: KVNamespace,
  owner: string,
  repo: string,
  logger: Logger,
): Promise<Result<ProjectEntry, AppError>> {
  logger.debug("Looking up project by GitHub repo", { owner, repo });

  try {
    // List all projects and find matching GitHub repo
    // This is not efficient for large numbers of projects, but works for now
    // TODO: Add index by GitHub repo for better performance
    const projectsResult = await listProjects(kv, logger);

    if (!projectsResult.success) {
      return err(projectsResult.error);
    }

    const projects = projectsResult.data;

    // Find project matching the GitHub owner/repo
    const project = projects.find((p) => {
      const sourceUrl = p.sourceUrl || p.githubUrl;
      if (!sourceUrl) return false;

      // Parse source URL to extract owner/repo
      const match = sourceUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
      if (!match) return false;

      const [, projectOwner, projectRepo] = match;
      return (
        projectOwner?.toLowerCase() === owner.toLowerCase() &&
        projectRepo?.toLowerCase() === repo.toLowerCase()
      );
    });

    if (!project) {
      return err(new NotFoundError("Project", `${owner}/${repo}`));
    }

    return ok(project);
  } catch (error) {
    logger.error(
      "Failed to get project by GitHub repo",
      error instanceof Error ? error : undefined,
      { owner, repo },
    );
    return err(new AppError("Failed to lookup project", "STORAGE_ERROR", 500));
  }
}

/**
 * Get user's GitHub access token (decrypted)
 */
export async function getGitHubAccessToken(
  db: D1Database,
  userId: string,
  encryptionSecret: string,
  logger: Logger,
): Promise<Result<string, AppError>> {
  logger.debug("Fetching GitHub access token", { userId });

  try {
    const row = await db
      .prepare(
        "SELECT github_access_token FROM users WHERE id = ? AND github_access_token IS NOT NULL",
      )
      .bind(userId)
      .first<{ github_access_token: string }>();

    if (!row) {
      return err(new NotFoundError("GitHub token", userId));
    }

    // Decrypt the token
    const decryptedToken = await decryptToken(row.github_access_token, encryptionSecret);
    if (!decryptedToken) {
      logger.error("Failed to decrypt GitHub token", undefined, { userId });
      return err(new AppError("Failed to decrypt GitHub token", "STORAGE_ERROR", 500));
    }

    return ok(decryptedToken);
  } catch (error) {
    logger.error("Failed to get GitHub token", error instanceof Error ? error : undefined, {
      userId,
    });
    return err(new AppError("Failed to get GitHub token", "STORAGE_ERROR", 500));
  }
}

/**
 * Store user's GitHub access token (encrypted)
 */
export async function storeGitHubAccessToken(
  db: D1Database,
  userId: string,
  accessToken: string,
  githubUserId: string,
  githubUsername: string,
  encryptionSecret: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  logger.debug("Storing GitHub access token", { userId, githubUsername });

  try {
    // Encrypt the token before storing
    const encryptedToken = await encryptToken(accessToken, encryptionSecret);

    await db
      .prepare(
        `UPDATE users
         SET github_access_token = ?,
             github_id = ?,
             github_username = ?
         WHERE id = ?`,
      )
      .bind(encryptedToken, githubUserId, githubUsername, userId)
      .run();

    logger.info("GitHub access token stored", { userId, githubUsername });
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to store GitHub token", error instanceof Error ? error : undefined, {
      userId,
    });
    return err(new AppError("Failed to store GitHub token", "STORAGE_ERROR", 500));
  }
}

/**
 * Create or update Change from GitHub PR data
 */
export async function upsertChangeFromGitHubPR(
  db: D1Database,
  projectId: string,
  workspaceId: string,
  userId: string,
  owner: string,
  repo: string,
  prData: {
    number: number;
    title: string;
    body: string;
    state: string;
    html_url: string;
    head_branch: string;
    head_sha: string;
    base_branch: string;
  },
  logger: Logger,
): Promise<Result<{ id: string; created: boolean }, AppError>> {
  logger.debug("Upserting Change from GitHub PR", { projectId, prNumber: prData.number });

  try {
    // Check if Change already exists for this PR
    const existing = await db
      .prepare("SELECT id FROM changes WHERE project_id = ? AND github_pr_number = ?")
      .bind(projectId, prData.number)
      .first<{ id: string }>();

    if (existing) {
      // Update existing Change
      await db
        .prepare(
          `UPDATE changes
           SET title = ?,
               description = ?,
               github_pr_state = ?,
               github_pr_url = ?,
               github_branch = ?,
               github_head_sha = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .bind(
          prData.title,
          prData.body,
          prData.state,
          prData.html_url,
          prData.head_branch,
          prData.head_sha,
          existing.id,
        )
        .run();

      logger.info("Updated Change from GitHub PR", {
        changeId: existing.id,
        prNumber: prData.number,
      });
      return ok({ id: existing.id, created: false });
    }

    // Create new Change
    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO changes (
          id, project_id, workspace_id, title, description,
          author_type, author_id, status,
          github_owner, github_repo, github_branch, github_pr_number, github_pr_url, github_pr_state, github_head_sha
        ) VALUES (?, ?, ?, ?, ?, 'human', ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        projectId,
        workspaceId,
        prData.title,
        prData.body,
        userId,
        owner,
        repo,
        prData.head_branch,
        prData.number,
        prData.html_url,
        prData.state,
        prData.head_sha,
      )
      .run();

    logger.info("Created Change from GitHub PR", { changeId: id, prNumber: prData.number });
    return ok({ id, created: true });
  } catch (error) {
    logger.error("Failed to upsert Change from PR", error instanceof Error ? error : undefined, {
      projectId,
      prNumber: prData.number,
    });
    return err(new AppError("Failed to create/update Change", "STORAGE_ERROR", 500));
  }
}

/**
 * Store GitHub PR comment ID for a Change
 */
export async function storeChangeGitHubComment(
  db: D1Database,
  changeId: string,
  commentId: number,
  logger: Logger,
): Promise<Result<void, AppError>> {
  logger.debug("Storing GitHub comment ID", { changeId, commentId });

  try {
    await db
      .prepare("UPDATE changes SET github_comment_id = ? WHERE id = ?")
      .bind(commentId, changeId)
      .run();

    return ok(undefined);
  } catch (error) {
    logger.error("Failed to store GitHub comment ID", error instanceof Error ? error : undefined, {
      changeId,
    });
    return err(new AppError("Failed to store comment ID", "STORAGE_ERROR", 500));
  }
}

/**
 * Get Change by GitHub PR number
 */
export async function getChangeByGitHubPR(
  db: D1Database,
  projectId: string,
  prNumber: number,
  logger: Logger,
): Promise<Result<{ id: string; workspaceId: string }, AppError>> {
  logger.debug("Fetching Change by GitHub PR", { projectId, prNumber });

  try {
    const row = await db
      .prepare("SELECT id, workspace_id FROM changes WHERE project_id = ? AND github_pr_number = ?")
      .bind(projectId, prNumber)
      .first<{ id: string; workspace_id: string }>();

    if (!row) {
      return err(new NotFoundError("Change", `PR #${prNumber}`));
    }

    return ok({ id: row.id, workspaceId: row.workspace_id });
  } catch (error) {
    logger.error("Failed to get Change by PR", error instanceof Error ? error : undefined, {
      projectId,
      prNumber,
    });
    return err(new AppError("Failed to get Change", "STORAGE_ERROR", 500));
  }
}
