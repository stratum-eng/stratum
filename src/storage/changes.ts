import type { Change } from "../types";
import { AppError, NotFoundError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { buildDismissApprovalsStatement } from "./change-reviews";

interface ChangeRow {
  id: string;
  project: string;
  project_id: string | null;
  workspace: string;
  status: string;
  agent_id: string | null;
  eval_score: number | null;
  eval_passed: number | null;
  eval_reason: string | null;
  base_sha: string | null;
  evaluated_sha: string | null;
  evaluated_tree_oid: string | null;
  agent_model: string | null;
  agent_prompt_hash: string | null;
  workspace_head_sha: string | null;
  touches_protected_config: number | null;
  created_by_user_id: string | null;
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
  if (row.project_id !== null) change.projectId = row.project_id;
  if (row.agent_id !== null) change.agentId = row.agent_id;
  if (row.eval_score !== null) change.evalScore = row.eval_score;
  if (row.eval_passed !== null) change.evalPassed = row.eval_passed === 1;
  if (row.eval_reason !== null) change.evalReason = row.eval_reason;
  if (row.base_sha !== null) change.baseSha = row.base_sha;
  if (row.evaluated_sha !== null) change.evaluatedSha = row.evaluated_sha;
  if (row.evaluated_tree_oid !== null) change.evaluatedTreeOid = row.evaluated_tree_oid;
  if (row.agent_model !== null) change.agentModel = row.agent_model;
  if (row.agent_prompt_hash !== null) change.agentPromptHash = row.agent_prompt_hash;
  if (row.workspace_head_sha !== null) change.workspaceHeadSha = row.workspace_head_sha;
  if (row.touches_protected_config !== null)
    change.touchesProtectedConfig = row.touches_protected_config === 1;
  if (row.created_by_user_id !== null) change.createdByUserId = row.created_by_user_id;
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
    // Globally-unique project UUID (from the KV ProjectEntry). Optional for
    // backward compatibility: callers that lack it write NULL, which the future
    // cascade-delete treats as a name-based (pre-migration) row.
    projectId?: string;
    workspace: string;
    agentId?: string;
    baseSha?: string;
    agentModel?: string;
    agentPromptHash?: string;
    /** Human author (acting user, or an agent's owner). Excluded from the
     * required-approval count so a change cannot be self-approved. */
    createdByUserId?: string;
  },
): Promise<Result<Change, AppError>> {
  const id = newId("chg");
  const createdAt = new Date().toISOString();

  try {
    await db
      .prepare(
        "INSERT INTO changes (id, project, project_id, workspace, status, agent_id, base_sha, agent_model, agent_prompt_hash, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        opts.project,
        opts.projectId ?? null,
        opts.workspace,
        "open",
        opts.agentId ?? null,
        opts.baseSha ?? null,
        opts.agentModel ?? null,
        opts.agentPromptHash ?? null,
        opts.createdByUserId ?? null,
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
    if (opts.projectId !== undefined) change.projectId = opts.projectId;
    if (opts.agentId !== undefined) change.agentId = opts.agentId;
    if (opts.baseSha !== undefined) change.baseSha = opts.baseSha;
    if (opts.agentModel !== undefined) change.agentModel = opts.agentModel;
    if (opts.agentPromptHash !== undefined) change.agentPromptHash = opts.agentPromptHash;
    if (opts.createdByUserId !== undefined) change.createdByUserId = opts.createdByUserId;

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
  opts?: { projectId?: string; limit?: number },
): Promise<Result<Change[], AppError>> {
  try {
    // Scope by the canonical project_id when known, falling back to the free-form
    // name only for legacy rows whose project_id wasn't backfilled. Matching purely
    // on `project` would list a same-named project's changes in ANOTHER namespace.
    const scope = opts?.projectId
      ? {
          clause: "(project_id = ? OR (project_id IS NULL AND project = ?))",
          binds: [opts.projectId, project],
        }
      : { clause: "project = ?", binds: [project] };
    // Bound the result when a caller asks (the API routes do). Internal callers
    // that omit `limit` still get every row, so no in-process consumer breaks.
    const limitClause = opts?.limit !== undefined ? " LIMIT ?" : "";
    const limitBind = opts?.limit !== undefined ? [opts.limit] : [];
    const result = status
      ? await db
          .prepare(
            `SELECT * FROM changes WHERE ${scope.clause} AND status = ? ORDER BY created_at DESC${limitClause}`,
          )
          .bind(...scope.binds, status, ...limitBind)
          .all<ChangeRow>()
      : await db
          .prepare(
            `SELECT * FROM changes WHERE ${scope.clause} ORDER BY created_at DESC${limitClause}`,
          )
          .bind(...scope.binds, ...limitBind)
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

export interface UpdateChangeStatusOpts {
  /** The base commit the evaluation actually ran against. Re-evaluation re-pins
   * it for the same reason it re-pins `evaluatedSha`: the merge gate compares
   * `change.baseSha` against the current project head under
   * `merge.requireFreshBase`, so leaving it at its creation-time value means a
   * re-evaluated change stays STALE_BASE forever and re-evaluation can never
   * clear it. */
  baseSha?: string;
  evalScore?: number;
  evalPassed?: boolean;
  evalReason?: string;
  evaluatedSha?: string;
  evaluatedTreeOid?: string;
  workspaceHeadSha?: string;
  touchesProtectedConfig?: boolean;
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
}

/**
 * Build (without running) the `UPDATE changes` statement for a status/opts
 * transition. Shared by `updateChangeStatus` and the atomic
 * `dismissApprovalsAndUpdateStatus` batch below (#238) so both paths update
 * with the exact same column mapping.
 */
function buildUpdateChangeStatusStatement(
  db: D1Database,
  id: string,
  status: Change["status"],
  opts?: UpdateChangeStatusOpts,
): D1PreparedStatement {
  const assignments = ["status = ?"];
  const bindings: unknown[] = [status];

  const addOptional = (column: string, value: unknown) => {
    if (value === undefined) return;
    assignments.push(`${column} = ?`);
    bindings.push(value);
  };

  addOptional("base_sha", opts?.baseSha);
  addOptional("eval_score", opts?.evalScore);
  addOptional(
    "eval_passed",
    opts?.evalPassed !== undefined ? (opts.evalPassed ? 1 : 0) : undefined,
  );
  addOptional("eval_reason", opts?.evalReason);
  addOptional("evaluated_sha", opts?.evaluatedSha);
  addOptional("evaluated_tree_oid", opts?.evaluatedTreeOid);
  addOptional("workspace_head_sha", opts?.workspaceHeadSha);
  addOptional(
    "touches_protected_config",
    opts?.touchesProtectedConfig !== undefined ? (opts.touchesProtectedConfig ? 1 : 0) : undefined,
  );
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

  return db.prepare(`UPDATE changes SET ${assignments.join(", ")} WHERE id = ?`).bind(...bindings);
}

/**
 * Update a change's status (and any optional pinned fields) as a single,
 * non-batched write. Callers that also need stale approvals dismissed in the
 * same transaction should use dismissApprovalsAndUpdateStatus below instead.
 */
export async function updateChangeStatus(
  db: D1Database,
  logger: Logger,
  id: string,
  status: Change["status"],
  opts?: UpdateChangeStatusOpts,
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

    await buildUpdateChangeStatusStatement(db, id, status, opts).run();

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

export interface DismissApprovalsAndUpdateStatusResult {
  dismissedReviewerIds: string[];
}

/**
 * Atomically dismiss any stale 'approve' verdicts on a change and re-pin its
 * evaluated sha/status, as one D1 batch (#238).
 *
 * Before this, the re-evaluate route ran `dismissApprovals` (a DELETE on
 * change_reviews) and `updateChangeStatus` (an UPDATE on changes) as two
 * separate round trips. If the DELETE landed but the UPDATE then failed
 * (e.g. a transient D1 error), the request errored out with approvals
 * already gone while the OLD evaluatedSha stayed pinned — a retry against
 * that same old sha would see zero approvals, permanently lost, even though
 * the re-pin never actually happened.
 *
 * Both statements below run against the same D1 database (`changes` and
 * `change_reviews` are both D1 tables — see rowToChange/ChangeRow above and
 * the reviews rows in storage/change-reviews.ts), so `D1Database.batch()`
 * gives real transactional atomicity here: per Cloudflare's D1 batch
 * semantics, every statement in the list commits, or none of them do, if any
 * statement throws. That makes the lost-approvals window above impossible —
 * the delete and the re-pin now land, or fail, together.
 */
export async function dismissApprovalsAndUpdateStatus(
  db: D1Database,
  logger: Logger,
  id: string,
  status: Change["status"],
  opts?: UpdateChangeStatusOpts,
): Promise<Result<DismissApprovalsAndUpdateStatusResult, NotFoundError | AppError>> {
  try {
    // First check if the change exists (matches updateChangeStatus above).
    const existingRow = await db
      .prepare("SELECT id FROM changes WHERE id = ?")
      .bind(id)
      .first<{ id: string }>();
    if (!existingRow) {
      const notFoundError = new NotFoundError("Change", id);
      logger.debug("Change not found for atomic dismiss+update", { changeId: id });
      return err(notFoundError);
    }

    const dismissStmt = buildDismissApprovalsStatement(db, id);
    const updateStmt = buildUpdateChangeStatusStatement(db, id, status, opts);

    const [dismissResult] = await db.batch<{ reviewer_id: string }>([dismissStmt, updateStmt]);
    const dismissedReviewerIds = (dismissResult?.results ?? []).map((row) => row.reviewer_id);

    if (dismissedReviewerIds.length > 0) {
      logger.info("Stale approvals dismissed", {
        changeId: id,
        dismissed: dismissedReviewerIds.length,
      });
    }
    logger.debug("Change status updated", { changeId: id, status, opts });
    return ok({ dismissedReviewerIds });
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error
              ? error.message
              : "Failed to dismiss approvals and update change status",
            "DATABASE_ERROR",
            500,
            { operation: "dismissApprovalsAndUpdateStatus", changeId: id, status },
          );
    logger.error("Failed to atomically dismiss approvals and update change status", appError, {
      changeId: id,
      status,
    });
    return err(appError);
  }
}

/**
 * Build the `markChangeMerged` options that carry a change's eval result through
 * to the merged row. Shared by all four merge call sites (cold route, merge
 * queue, and both RepoDO paths) so a new eval field is added in exactly one
 * place, not four.
 */
export function mergeTransitionOpts(
  change: Pick<Change, "evalScore" | "evalPassed" | "evalReason">,
  mergedAt: string,
): { evalScore?: number; evalPassed?: boolean; evalReason?: string; mergedAt: string } {
  return {
    ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
    ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
    ...(change.evalReason !== undefined ? { evalReason: change.evalReason } : {}),
    mergedAt,
  };
}

/**
 * Transition a change to `merged` as a single atomic compare-and-swap:
 * `UPDATE ... WHERE id = ? AND status != 'merged'`. Returns
 * `{ transitioned: false }` when the row was already `merged` — i.e. a concurrent
 * merger (another request, or an interleaved Durable Object invocation) already
 * won the transition. Callers emit `change.merged` and record post-merge
 * bookkeeping ONLY when `transitioned` is true, so exactly one merge of a change
 * fires exactly one event no matter how many requests race.
 */
export async function markChangeMerged(
  db: D1Database,
  logger: Logger,
  id: string,
  opts?: { evalScore?: number; evalPassed?: boolean; evalReason?: string; mergedAt?: string },
): Promise<Result<{ transitioned: boolean }, NotFoundError | AppError>> {
  try {
    const existingRow = await db
      .prepare("SELECT id FROM changes WHERE id = ?")
      .bind(id)
      .first<{ id: string }>();
    if (!existingRow) {
      logger.debug("Change not found for merge transition", { changeId: id });
      return err(new NotFoundError("Change", id));
    }

    const assignments = ["status = 'merged'"];
    const bindings: unknown[] = [];
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
    addOptional("merged_at", opts?.mergedAt ?? new Date().toISOString());
    bindings.push(id);

    const result = await db
      .prepare(`UPDATE changes SET ${assignments.join(", ")} WHERE id = ? AND status != 'merged'`)
      .bind(...bindings)
      .run();
    const transitioned = (result.meta?.changes ?? 0) > 0;
    logger.debug("Change merge transition", { changeId: id, transitioned });
    return ok({ transitioned });
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to mark change merged",
            "DATABASE_ERROR",
            500,
            { operation: "markChangeMerged", changeId: id },
          );
    logger.error("Failed to mark change merged", appError, { changeId: id });
    return err(appError);
  }
}
