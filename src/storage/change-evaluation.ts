/**
 * Run-keyed writes for asynchronous evaluation (#412, ADR 009).
 *
 * Every write here that records a verdict is conditional on the change still
 * waiting on the SAME run: `WHERE id = ? AND eval_run_id = ? AND status =
 * 'evaluating'`. That predicate is the whole stale-run defence. A run is
 * superseded the moment anything writes a new `eval_run_id` (a re-evaluation,
 * or the sweep re-dispatching a stuck run) or moves the change out of
 * `evaluating` (a reject, a merge), and a superseded run's write then matches
 * no row — it can neither overwrite a newer revision's verdict nor resurrect a
 * change someone has since closed.
 */
import type { EvalResult } from "../evaluation/types";
import type { Change } from "../types";
import { AppError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import type { UpdateChangeStatusOpts } from "./changes";
import type { EvalRun } from "./eval-runs";

/** Statuses a change can no longer be (re-)evaluated from. */
export const TERMINAL_CHANGE_STATUSES: readonly Change["status"][] = [
  "merged",
  "rejected",
  "promoted",
  "reverted",
];

/** A fresh run id. Prefixed so a log line names what it is. */
export function newEvaluationRunId(): string {
  return newId("erun");
}

function dbError(error: unknown, operation: string, changeId?: string): AppError {
  return error instanceof AppError
    ? error
    : new AppError(
        error instanceof Error ? error.message : `Failed to ${operation}`,
        "DATABASE_ERROR",
        500,
        { operation, ...(changeId !== undefined ? { changeId } : {}) },
      );
}

/** The predicate every run-keyed write shares. Two binds: change id, run id. */
const SAME_RUN = "id = ? AND eval_run_id = ? AND status = 'evaluating'";

/**
 * Move an existing change into `evaluating` under a new run, superseding any
 * run it was already waiting on. Refused for a terminal change.
 *
 * @returns `started: false` when the change is terminal or gone — nothing was
 *   written, and no message should be sent.
 */
export async function beginEvaluationRun(
  db: D1Database,
  logger: Logger,
  args: { changeId: string; runId: string; requestedBy?: string; now?: string },
): Promise<Result<{ started: boolean; requestedAt: string }, AppError>> {
  const requestedAt = args.now ?? new Date().toISOString();
  try {
    const placeholders = TERMINAL_CHANGE_STATUSES.map(() => "?").join(", ");
    const result = await db
      .prepare(
        `UPDATE changes SET status = 'evaluating', eval_run_id = ?, eval_requested_at = ?, eval_requested_by = ?, eval_attempts = 0, changes_requested_during_eval = 0 WHERE id = ? AND status NOT IN (${placeholders})`,
      )
      .bind(
        args.runId,
        requestedAt,
        args.requestedBy ?? null,
        args.changeId,
        ...TERMINAL_CHANGE_STATUSES,
      )
      .run();
    const started = (result.meta?.changes ?? 0) > 0;
    logger.debug("Evaluation run begun", { changeId: args.changeId, runId: args.runId, started });
    return ok({ started, requestedAt });
  } catch (error) {
    const appError = dbError(error, "beginEvaluationRun", args.changeId);
    logger.error("Failed to begin evaluation run", appError, { changeId: args.changeId });
    return err(appError);
  }
}

/** Who asked for the run a change is waiting on, read off the row. */
export async function getEvaluationRequester(
  db: D1Database,
  logger: Logger,
  changeId: string,
): Promise<Result<string | undefined, AppError>> {
  try {
    const row = await db
      .prepare("SELECT eval_requested_by FROM changes WHERE id = ?")
      .bind(changeId)
      .first<{ eval_requested_by: string | null }>();
    return ok(row?.eval_requested_by ?? undefined);
  } catch (error) {
    const appError = dbError(error, "getEvaluationRequester", changeId);
    logger.error("Failed to read evaluation requester", appError, { changeId });
    return err(appError);
  }
}

export interface FinalizeEvaluationRunArgs {
  changeId: string;
  runId: string;
  status: "accepted" | "needs_changes";
  opts: UpdateChangeStatusOpts;
  evalRuns: Array<{ evaluatorType: string; result: EvalResult }>;
  /** Delete standing approvals in the same transaction (#193, #238). */
  dismissApprovals: boolean;
}

export interface FinalizeEvaluationRunResult {
  /** False when the run was superseded: nothing was written. */
  applied: boolean;
  /**
   * The status the change landed on, when applied. `needs_changes` for a
   * passing run if a reviewer requested changes while it was pending.
   */
  status?: "accepted" | "needs_changes";
  runs: EvalRun[];
  dismissedReviewerIds: string[];
}

/**
 * Record a run's verdict — its `eval_runs` rows, any approval dismissal, and
 * the change's status and pins — as ONE D1 batch, every statement guarded by
 * the same-run predicate.
 *
 * One batch rather than three writes for the reason `dismissApprovalsAndUpdateStatus`
 * is one: a partial landing would record a round's rows with no verdict on the
 * change, or dismiss approvals for a re-pin that never happened. The guards sit
 * on the INSERTs and the DELETE as well as the UPDATE because the predicate has
 * to be evaluated before the UPDATE moves the row out of `evaluating`; the batch
 * runs its statements in order inside one transaction, so all of them see the
 * same answer.
 */
export async function finalizeEvaluationRun(
  db: D1Database,
  logger: Logger,
  args: FinalizeEvaluationRunArgs,
): Promise<Result<FinalizeEvaluationRunResult, AppError>> {
  const { changeId, runId } = args;
  try {
    const ranAt = new Date().toISOString();
    // Same shape `recordEvalRuns` writes, so the merge gate's newest-round
    // logic reads a queued round exactly as it reads an inline one.
    const roundId = `${ranAt}#${newId("evr")}`;
    const insert = db.prepare(
      `INSERT INTO eval_runs (id, change_id, evaluator_type, score, passed, reason, issues, ran_at, round_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM changes WHERE ${SAME_RUN})`,
    );
    const runs: EvalRun[] = [];
    const statements: D1PreparedStatement[] = [];
    for (const { evaluatorType, result } of args.evalRuns) {
      const id = newId("evl");
      const run: EvalRun = {
        id,
        changeId,
        evaluatorType,
        score: result.score,
        passed: result.passed,
        reason: result.reason,
        ranAt,
        roundId,
      };
      if (result.issues !== undefined) run.issues = result.issues;
      runs.push(run);
      statements.push(
        insert.bind(
          id,
          changeId,
          evaluatorType,
          result.score,
          result.passed ? 1 : 0,
          result.reason,
          result.issues !== undefined ? JSON.stringify(result.issues) : null,
          ranAt,
          roundId,
          changeId,
          runId,
        ),
      );
    }

    const dismissIndex = args.dismissApprovals ? statements.length : -1;
    if (args.dismissApprovals) {
      statements.push(
        db
          .prepare(
            `DELETE FROM change_reviews WHERE change_id = ? AND verdict = 'approve' AND EXISTS (SELECT 1 FROM changes WHERE ${SAME_RUN}) RETURNING reviewer_id`,
          )
          .bind(changeId, changeId, runId),
      );
    }

    // A request for changes made while this run was pending outranks a pass:
    // the review would have moved an accepted change to needs_changes had it
    // landed after the verdict, so it must not be erased by landing before.
    // The flag is consumed here; the next run starts with it clear.
    const assignments = [
      "status = CASE WHEN ? = 'accepted' AND changes_requested_during_eval = 1 THEN 'needs_changes' ELSE ? END",
      "changes_requested_during_eval = 0",
    ];
    const bindings: unknown[] = [args.status, args.status];
    const set = (column: string, value: unknown) => {
      if (value === undefined) return;
      assignments.push(`${column} = ?`);
      bindings.push(value);
    };
    const { opts } = args;
    set("base_sha", opts.baseSha);
    set("fork_point_sha", opts.forkPointSha);
    set("eval_score", opts.evalScore);
    set("eval_passed", opts.evalPassed !== undefined ? (opts.evalPassed ? 1 : 0) : undefined);
    set("eval_reason", opts.evalReason);
    set("evaluated_sha", opts.evaluatedSha);
    set("evaluated_tree_oid", opts.evaluatedTreeOid);
    set("workspace_head_sha", opts.workspaceHeadSha);
    set(
      "touches_protected_config",
      opts.touchesProtectedConfig !== undefined ? (opts.touchesProtectedConfig ? 1 : 0) : undefined,
    );
    const updateIndex = statements.length;
    statements.push(
      db
        .prepare(`UPDATE changes SET ${assignments.join(", ")} WHERE ${SAME_RUN} RETURNING status`)
        .bind(...bindings, changeId, runId),
    );

    const results = await db.batch<{ reviewer_id?: string; status?: string }>(statements);
    const applied = (results[updateIndex]?.meta?.changes ?? 0) > 0;
    const landed = results[updateIndex]?.results?.[0]?.status;
    const status: FinalizeEvaluationRunResult["status"] = !applied
      ? undefined
      : landed === "needs_changes" || landed === "accepted"
        ? landed
        : args.status;
    const dismissedReviewerIds =
      dismissIndex >= 0
        ? (results[dismissIndex]?.results ?? []).flatMap((r) =>
            r.reviewer_id !== undefined ? [r.reviewer_id] : [],
          )
        : [];

    logger.info("Evaluation run finalized", {
      changeId,
      runId,
      applied,
      status,
      dismissed: dismissedReviewerIds.length,
    });
    return ok({
      applied,
      ...(status !== undefined ? { status } : {}),
      runs: applied ? runs : [],
      dismissedReviewerIds,
    });
  } catch (error) {
    const appError = dbError(error, "finalizeEvaluationRun", changeId);
    logger.error("Failed to finalize evaluation run", appError, { changeId, runId });
    return err(appError);
  }
}

/**
 * Fail a run closed: the change leaves `evaluating` as `needs_changes`, score
 * 0, with the reason recorded where the verdict would have been. Used when a
 * run cannot produce a verdict at all — retries exhausted, a permanent error,
 * a run the sweep found stuck past its last re-dispatch.
 *
 * A gate that could not run is a gate that did not pass, so this is never a
 * return to a mergeable status, and it records no `eval_runs` rows: a
 * `requiredEvaluators` check then reports "has not run", which is the truth.
 */
export async function failEvaluationRun(
  db: D1Database,
  logger: Logger,
  /** `runId: null` matches a row stuck in `evaluating` with no run id. */
  args: { changeId: string; runId: string | null; reason: string },
): Promise<Result<{ applied: boolean }, AppError>> {
  try {
    const runClause = args.runId === null ? "eval_run_id IS NULL" : "eval_run_id = ?";
    const runBind = args.runId === null ? [] : [args.runId];
    const result = await db
      .prepare(
        `UPDATE changes SET status = 'needs_changes', eval_score = 0, eval_passed = 0, eval_reason = ?, changes_requested_during_eval = 0 WHERE id = ? AND ${runClause} AND status = 'evaluating'`,
      )
      .bind(args.reason, args.changeId, ...runBind)
      .run();
    const applied = (result.meta?.changes ?? 0) > 0;
    logger.warn("Evaluation run failed closed", { ...args, applied });
    return ok({ applied });
  } catch (error) {
    const appError = dbError(error, "failEvaluationRun", args.changeId);
    logger.error("Failed to fail evaluation run", appError, { changeId: args.changeId });
    return err(appError);
  }
}

export interface StuckEvaluation {
  changeId: string;
  runId: string | null;
  attempts: number;
}

/** Changes still `evaluating` whose run was dispatched before `cutoff`. */
export async function listStuckEvaluations(
  db: D1Database,
  logger: Logger,
  args: { cutoff: string; limit: number },
): Promise<Result<StuckEvaluation[], AppError>> {
  try {
    const rows = await db
      .prepare(
        "SELECT id, eval_run_id, eval_attempts FROM changes WHERE status = 'evaluating' AND (eval_requested_at IS NULL OR eval_requested_at < ?) ORDER BY eval_requested_at ASC LIMIT ?",
      )
      .bind(args.cutoff, args.limit)
      .all<{ id: string; eval_run_id: string | null; eval_attempts: number | null }>();
    return ok(
      (rows.results ?? []).map((row) => ({
        changeId: row.id,
        runId: row.eval_run_id,
        attempts: row.eval_attempts ?? 0,
      })),
    );
  } catch (error) {
    const appError = dbError(error, "listStuckEvaluations");
    logger.error("Failed to list stuck evaluations", appError);
    return err(appError);
  }
}

/**
 * Replace a stuck run with a fresh one, counting the attempt. Conditional on
 * the stuck run still being current, so a consumer that finishes while the
 * sweep is deciding wins and the re-dispatch becomes a no-op.
 *
 * A row with no run id at all (none should exist; every path that writes
 * `evaluating` writes one) is matched by `eval_run_id IS NULL`.
 */
export async function redispatchEvaluationRun(
  db: D1Database,
  logger: Logger,
  args: { changeId: string; previousRunId: string | null; runId: string; now?: string },
): Promise<Result<{ applied: boolean }, AppError>> {
  const now = args.now ?? new Date().toISOString();
  try {
    const runClause = args.previousRunId === null ? "eval_run_id IS NULL" : "eval_run_id = ?";
    const runBind = args.previousRunId === null ? [] : [args.previousRunId];
    const result = await db
      .prepare(
        `UPDATE changes SET eval_run_id = ?, eval_requested_at = ?, eval_attempts = eval_attempts + 1 WHERE id = ? AND ${runClause} AND status = 'evaluating'`,
      )
      .bind(args.runId, now, args.changeId, ...runBind)
      .run();
    return ok({ applied: (result.meta?.changes ?? 0) > 0 });
  } catch (error) {
    const appError = dbError(error, "redispatchEvaluationRun", args.changeId);
    logger.error("Failed to re-dispatch evaluation run", appError, { changeId: args.changeId });
    return err(appError);
  }
}
