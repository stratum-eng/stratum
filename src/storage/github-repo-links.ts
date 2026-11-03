/**
 * The canonical Stratum project for each GitHub repository (migration 060).
 * Owner and repo are stored lowercase: GitHub names are case-insensitive.
 * Callers decide authorization; this module only keeps the one-row-per-repo
 * invariant atomically.
 */

import type { D1Database } from "@cloudflare/workers-types";
import type { ProjectEntry } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export interface GitHubRepoLink {
  owner: string;
  repo: string;
  projectId: string;
  namespace: string;
  slug: string;
}

interface RepoLinkRow {
  owner: string;
  repo: string;
  project_id: string;
  namespace: string;
  slug: string;
}

export type RepoLinkProject = Pick<ProjectEntry, "id" | "namespace" | "slug">;

function fromRow(row: RepoLinkRow): GitHubRepoLink {
  return {
    owner: row.owner,
    repo: row.repo,
    projectId: row.project_id,
    namespace: row.namespace,
    slug: row.slug,
  };
}

function storageError(message: string, error: unknown, logger: Logger): AppError {
  logger.error(message, error instanceof Error ? error : undefined);
  return new AppError(message, "DATABASE_ERROR", 500);
}

/**
 * Reads the canonical project for a repo.
 *
 * @param db - D1 database
 * @param owner - GitHub owner (any case)
 * @param repo - GitHub repo name (any case)
 * @param logger - Request logger
 * @returns The link, or null when no project holds the repo
 */
export async function getRepoLink(
  db: D1Database,
  owner: string,
  repo: string,
  logger: Logger,
): Promise<Result<GitHubRepoLink | null, AppError>> {
  try {
    const row = await db
      .prepare("SELECT * FROM github_repo_links WHERE owner = ? AND repo = ?")
      .bind(owner.toLowerCase(), repo.toLowerCase())
      .first<RepoLinkRow>();
    return ok(row ? fromRow(row) : null);
  } catch (error) {
    return err(storageError("Failed to read GitHub repo link", error, logger));
  }
}

/**
 * Claims a repo for a project if nobody holds it. Atomic: of two concurrent
 * claims exactly one row is written, and both callers read back the winner.
 *
 * @param db - D1 database
 * @param owner - GitHub owner
 * @param repo - GitHub repo name
 * @param project - The claimant
 * @param logger - Request logger
 * @returns The project id that holds the repo after the claim
 */
export async function claimRepoLink(
  db: D1Database,
  owner: string,
  repo: string,
  project: RepoLinkProject,
  logger: Logger,
): Promise<Result<string, AppError>> {
  try {
    await db
      .prepare(
        `INSERT INTO github_repo_links (owner, repo, project_id, namespace, slug)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (owner, repo) DO NOTHING`,
      )
      .bind(owner.toLowerCase(), repo.toLowerCase(), project.id, project.namespace, project.slug)
      .run();
    const row = await db
      .prepare("SELECT project_id FROM github_repo_links WHERE owner = ? AND repo = ?")
      .bind(owner.toLowerCase(), repo.toLowerCase())
      .first<{ project_id: string }>();
    if (!row)
      return err(new AppError("GitHub repo link vanished after claim", "DATABASE_ERROR", 500));
    return ok(row.project_id);
  } catch (error) {
    return err(storageError("Failed to claim GitHub repo link", error, logger));
  }
}

/**
 * Hands a repo from a holder that is gone or no longer authorized to a new
 * project. Conditional on the old holder, so a concurrent replacement cannot
 * be overwritten.
 *
 * @param db - D1 database
 * @param owner - GitHub owner
 * @param repo - GitHub repo name
 * @param fromProjectId - The holder being displaced
 * @param to - The new holder
 * @param logger - Request logger
 * @returns Whether this call made the replacement
 */
export async function replaceRepoLink(
  db: D1Database,
  owner: string,
  repo: string,
  fromProjectId: string,
  to: RepoLinkProject,
  logger: Logger,
): Promise<Result<boolean, AppError>> {
  try {
    const result = await db
      .prepare(
        `UPDATE github_repo_links
            SET project_id = ?, namespace = ?, slug = ?, created_at = datetime('now')
          WHERE owner = ? AND repo = ? AND project_id = ?`,
      )
      .bind(to.id, to.namespace, to.slug, owner.toLowerCase(), repo.toLowerCase(), fromProjectId)
      .run();
    return ok(result.meta.changes === 1);
  } catch (error) {
    return err(storageError("Failed to replace GitHub repo link", error, logger));
  }
}
