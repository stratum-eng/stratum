import type { Change } from "../types";
import { AppError, NotFoundError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

interface ChangeRow {
  id: string;
  project: string;
  workspace: string;
  status: string;
  agent_id: string | null;
  eval_score: number | null;
  eval_passed: number | null;
  eval_reason: string | null;
  base_sha: string | null;
  created_at: string;
  merged_at: string | null;
  github_owner: string | null;
  github_repo: string | null;
  github_branch: string | null;
  github_pr_number: number | null;
  github_pr_url: string | null;
  github_pr_state: string | null;
  github_head_sha: string | null;
  github_comment_id: number | null;
  promoted_at: string | null;
  promoted_by: string | null;
}

function rowToChange(row: ChangeRow): Change {
  const change: Change = {
    id: row.id,
    project: row.project,
    workspace: row.workspace,
    status: row.status as Change["status"],
    createdAt: row.created_at,
  };
  if (row.agent_id !== null) change.agentId = row.agent_id;
  if (row.eval_score !== null) change.evalScore = row.eval_score;
  if (row.eval_passed !== null) change.evalPassed = row.eval_passed === 1;
  if (row.eval_reason !== null) change.evalReason = row.eval_reason;
  if (row.base_sha !== null) change.baseSha = row.base_sha;
  if (row.merged_at !== null) change.mergedAt = row.merged_at;
  if (row.github_owner !== null) change.githubOwner = row.github_owner;
  if (row.github_repo !== null) change.githubRepo = row.github_repo;
  if (row.github_branch !== null) change.githubBranch = row.github_branch;
  if (row.github_pr_number !== null) change.githubPrNumber = row.github_pr_number;
  if (row.github_pr_url !== null) change.githubPrUrl = row.github_pr_url;
  if (row.github_pr_state !== null) change.githubPrState = row.github_pr_state;
  if (row.github_head_sha !== null) change.githubHeadSha = row.github_head_sha;
  if (row.github_comment_id !== null) change.githubCommentId = row.github_comment_id;
  if (row.promoted_at !== null) change.promotedAt = row.promoted_at;
  if (row.promoted_by !== null) change.promotedBy = row.promoted_by;
  return change;
}

export async function createChange(
  db: D1Database,
  logger: Logger,
  opts: {
    project: string;
    workspace: string;
    agentId?: string;
    baseSha?: string;
  },
): Promise<Result<Change, AppError>> {
  const id = newId("chg");
  const createdAt = new Date().toISOString();

  try {
    await db
      .prepare(
        "INSERT INTO changes (id, project, workspace, status, agent_id, base_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        opts.project,
        opts.workspace,
        "open",
        opts.agentId ?? null,
        opts.baseSha ?? null,
        createdAt,
      )
      .run();

    const change: Change = {
      id,
      project: opts.project,
      workspace: opts.workspace,
      status: "open",
      createdAt,
    };
    if (opts.agentId !== undefined) change.agentId = opts.agentId;
    if (opts.baseSha !== undefined) change.baseSha = opts.baseSha;

    logger.debug("Change created", {
      changeId: id,
      project: opts.project,
      workspace: opts.workspace,
    });
    return ok(change);
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to create change",
            "DATABASE_ERROR",
            500,
            { operation: "createChange", project: opts.project },
          );
    logger.error("Failed to create change", appError, {
      project: opts.project,
      workspace: opts.workspace,
    });
    return err(appError);
  }
}

/** Fetch many changes in ONE query (avoids N round-trips for batch merge). */
export async function getChangesByIds(
  db: D1Database,
  logger: Logger,
  ids: string[],
): Promise<Result<Change[], AppError>> {
  if (ids.length === 0) return ok([]);
  try {
    const placeholders = ids.map(() => "?").join(", ");
    const result = await db
      .prepare(`SELECT * FROM changes WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<ChangeRow>();
    return ok((result.results ?? []).map(rowToChange));
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to get changes",
            "DATABASE_ERROR",
            500,
            { operation: "getChangesByIds" },
          );
    logger.error("Failed to get changes by ids", appError);
    return err(appError);
  }
}

export async function getChange(
  db: D1Database,
  logger: Logger,
  id: string,
): Promise<Result<Change, NotFoundError | AppError>> {
  try {
    const row = await db.prepare("SELECT * FROM changes WHERE id = ?").bind(id).first<ChangeRow>();

    if (!row) {
      const notFoundError = new NotFoundError("Change", id);
      logger.debug("Change not found", { changeId: id });
      return err(notFoundError);
    }

    logger.debug("Change retrieved", { changeId: id });
    return ok(rowToChange(row));
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to get change",
            "DATABASE_ERROR",
            500,
            { operation: "getChange", changeId: id },
          );
    logger.error("Failed to get change", appError, { changeId: id });
    return err(appError);
  }
}

export async function listChanges(
  db: D1Database,
  logger: Logger,
  project: string,
  status?: Change["status"],
): Promise<Result<Change[], AppError>> {
  try {
    const result = status
      ? await db
          .prepare(
            "SELECT * FROM changes WHERE project = ? AND status = ? ORDER BY created_at DESC",
          )
          .bind(project, status)
          .all<ChangeRow>()
      : await db
          .prepare("SELECT * FROM changes WHERE project = ? ORDER BY created_at DESC")
          .bind(project)
          .all<ChangeRow>();

    const changes = result.results.map(rowToChange);
    logger.debug("Changes listed", { project, status, count: changes.length });
    return ok(changes);
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to list changes",
            "DATABASE_ERROR",
            500,
            { operation: "listChanges", project, status },
          );
    logger.error("Failed to list changes", appError, { project, status });
    return err(appError);
  }
}

export async function getChangeByGitHubBranch(
  db: D1Database,
  logger: Logger,
  projectId: string,
  branchName: string,
): Promise<Change | null> {
  try {
    const row = await db
      .prepare("SELECT * FROM changes WHERE project = ? AND github_branch = ? LIMIT 1")
      .bind(projectId, branchName)
      .first<ChangeRow>();
    if (!row) return null;
    logger.debug("Change found by GitHub branch", { projectId, branchName, changeId: row.id });
    return rowToChange(row);
  } catch (error) {
    logger.error(
      "Failed to look up change by GitHub branch",
      error instanceof Error ? error : undefined,
      { projectId, branchName },
    );
    return null;
  }
}

export async function updateChangeStatus(
  db: D1Database,
  logger: Logger,
  id: string,
  status: Change["status"],
  opts?: {
    evalScore?: number;
    evalPassed?: boolean;
    evalReason?: string;
    mergedAt?: string;
    githubOwner?: string;
    githubRepo?: string;
    githubBranch?: string;
    githubPrNumber?: number;
    githubPrUrl?: string;
    githubPrState?: string;
    githubHeadSha?: string;
    promotedAt?: string;
    promotedBy?: string;
  },
): Promise<Result<void, NotFoundError | AppError>> {
  try {
    // First check if the change exists
    const existingRow = await db
      .prepare("SELECT id FROM changes WHERE id = ?")
      .bind(id)
      .first<{ id: string }>();
    if (!existingRow) {
      const notFoundError = new NotFoundError("Change", id);
      logger.debug("Change not found for update", { changeId: id });
      return err(notFoundError);
    }

    const assignments = ["status = ?"];
    const bindings: unknown[] = [status];

    const addOptional = (column: string, value: unknown) => {
      if (value === undefined) return;
      assignments.push(`${column} = ?`);
      bindings.push(value);
    };

    addOptional("eval_score", opts?.evalScore);
    addOptional(
      "eval_passed",
      opts?.evalPassed !== undefined ? (opts.evalPassed ? 1 : 0) : undefined,
    );
    addOptional("eval_reason", opts?.evalReason);
    addOptional("merged_at", opts?.mergedAt);
    addOptional("github_owner", opts?.githubOwner);
    addOptional("github_repo", opts?.githubRepo);
    addOptional("github_branch", opts?.githubBranch);
    addOptional("github_pr_number", opts?.githubPrNumber);
    addOptional("github_pr_url", opts?.githubPrUrl);
    addOptional("github_pr_state", opts?.githubPrState);
    addOptional("github_head_sha", opts?.githubHeadSha);
    addOptional("promoted_at", opts?.promotedAt);
    addOptional("promoted_by", opts?.promotedBy);

    bindings.push(id);

    await db
      .prepare(`UPDATE changes SET ${assignments.join(", ")} WHERE id = ?`)
      .bind(...bindings)
      .run();

    logger.debug("Change status updated", { changeId: id, status, opts });
    return ok(undefined);
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to update change status",
            "DATABASE_ERROR",
            500,
            { operation: "updateChangeStatus", changeId: id, status },
          );
    logger.error("Failed to update change status", appError, { changeId: id, status });
    return err(appError);
  }
}
