import { type AppError, toAppError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import type { DeletionTarget } from "./deletion";

export type DeletionJobKind = "project" | "account";
export type DeletionJobState = "pending" | "running" | "verifying" | "completed" | "incomplete";

export interface DeletionJob {
  id: string;
  kind: DeletionJobKind;
  /** Raw JSON of the captured DeletionTarget (or account target). */
  target: string;
  state: DeletionJobState;
  checkpoint: string | null;
  heartbeatAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  residuals: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface DeletionJobRow {
  id: string;
  kind: string;
  target: string;
  state: string;
  checkpoint: string | null;
  heartbeat_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  residuals: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function rowToJob(row: DeletionJobRow, logger: Logger): DeletionJob {
  let residuals: string[] = [];
  if (row.residuals) {
    try {
      const parsed: unknown = JSON.parse(row.residuals);
      if (Array.isArray(parsed)) {
        residuals = parsed.filter((item): item is string => typeof item === "string");
      }
    } catch (error) {
      // A malformed residual list must not hide the job itself; the row's
      // state still tells the sweep whether it needs re-driving.
      logger.error(
        "Failed to parse deletion job residuals",
        error instanceof Error ? error : undefined,
        { jobId: row.id },
      );
    }
  }
  return {
    id: row.id,
    kind: row.kind as DeletionJobKind,
    target: row.target,
    state: row.state as DeletionJobState,
    checkpoint: row.checkpoint,
    heartbeatAt: row.heartbeat_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    residuals,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function toDbError(error: unknown, operation: string, logger: Logger, jobId?: string): AppError {
  const appError = toAppError(error);
  logger.error(`Deletion job ${operation} failed`, appError, { jobId });
  return appError;
}

export async function createDeletionJob(
  db: D1Database,
  logger: Logger,
  opts: { kind: DeletionJobKind; target: DeletionTarget | Record<string, unknown> },
): Promise<Result<DeletionJob, AppError>> {
  const now = new Date().toISOString();
  const job: DeletionJob = {
    id: newId("del"),
    kind: opts.kind,
    target: JSON.stringify(opts.target),
    state: "pending",
    checkpoint: null,
    heartbeatAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    residuals: [],
    createdAt: now,
    startedAt: null,
    finishedAt: null,
  };
  try {
    await db
      .prepare(
        "INSERT INTO deletion_jobs (id, kind, target, state, created_at) VALUES (?, ?, ?, 'pending', ?)",
      )
      .bind(job.id, job.kind, job.target, job.createdAt)
      .run();
    return ok(job);
  } catch (error) {
    return err(toDbError(error, "create", logger, job.id));
  }
}

export async function getDeletionJob(
  db: D1Database,
  logger: Logger,
  id: string,
): Promise<Result<DeletionJob | null, AppError>> {
  try {
    const row = await db
      .prepare("SELECT * FROM deletion_jobs WHERE id = ?")
      .bind(id)
      .first<DeletionJobRow>();
    return ok(row ? rowToJob(row, logger) : null);
  } catch (error) {
    return err(toDbError(error, "get", logger, id));
  }
}

/**
 * Try to take (or steal an expired) lease on a job. Atomic-ish: the guarded
 * UPDATE only matches when no live lease exists, and D1 serializes writes, so
 * exactly one of two concurrent drivers sees `meta.changes === 1`.
 */
export async function acquireLease(
  db: D1Database,
  logger: Logger,
  id: string,
  owner: string,
  ttlMs: number,
): Promise<Result<boolean, AppError>> {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + ttlMs).toISOString();
  try {
    const result = await db
      .prepare(
        "UPDATE deletion_jobs SET lease_owner = ?, lease_expires_at = ?, heartbeat_at = ? " +
          "WHERE id = ? AND state IN ('pending','running','verifying') " +
          "AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ?)",
      )
      .bind(owner, expiresIso, nowIso, id, nowIso)
      .run();
    return ok((result.meta?.changes ?? 0) > 0);
  } catch (error) {
    return err(toDbError(error, "lease acquire", logger, id));
  }
}

/**
 * Refresh the heartbeat, extend the lease, and optionally record the last
 * completed step — fenced on `owner` so only the current lease holder advances
 * the job. Returns `false` when the caller no longer owns the lease (0 rows
 * changed); the runner treats that as "lost the lease, abort".
 */
export async function heartbeat(
  db: D1Database,
  logger: Logger,
  id: string,
  owner: string,
  leaseTtlMs: number,
  checkpoint?: string,
): Promise<Result<boolean, AppError>> {
  const now = new Date();
  try {
    const result = await db
      .prepare(
        "UPDATE deletion_jobs SET heartbeat_at = ?, lease_expires_at = ?, " +
          "checkpoint = COALESCE(?, checkpoint) WHERE id = ? AND lease_owner = ?",
      )
      .bind(
        now.toISOString(),
        new Date(now.getTime() + leaseTtlMs).toISOString(),
        checkpoint ?? null,
        id,
        owner,
      )
      .run();
    return ok((result.meta?.changes ?? 0) > 0);
  } catch (error) {
    return err(toDbError(error, "heartbeat", logger, id));
  }
}

/** Advance an in-flight job's state (fenced on owner); records started_at once. */
export async function setJobState(
  db: D1Database,
  logger: Logger,
  id: string,
  owner: string,
  state: "running" | "verifying",
): Promise<Result<boolean, AppError>> {
  try {
    const result = await db
      .prepare(
        "UPDATE deletion_jobs SET state = ?, started_at = COALESCE(started_at, ?) " +
          "WHERE id = ? AND lease_owner = ?",
      )
      .bind(state, new Date().toISOString(), id, owner)
      .run();
    return ok((result.meta?.changes ?? 0) > 0);
  } catch (error) {
    return err(toDbError(error, "state update", logger, id));
  }
}

/**
 * Terminal transition (fenced on owner); releases the lease so a finished job is
 * never re-driven. Returns `false` when the caller lost the lease — a stolen
 * driver must not terminalize a job another driver now owns.
 */
export async function finishJob(
  db: D1Database,
  logger: Logger,
  id: string,
  owner: string,
  state: "completed" | "incomplete",
  residuals: string[],
): Promise<Result<boolean, AppError>> {
  try {
    const result = await db
      .prepare(
        "UPDATE deletion_jobs SET state = ?, residuals = ?, finished_at = ?, " +
          "lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?",
      )
      .bind(state, JSON.stringify(residuals), new Date().toISOString(), id, owner)
      .run();
    return ok((result.meta?.changes ?? 0) > 0);
  } catch (error) {
    return err(toDbError(error, "finish", logger, id));
  }
}

/**
 * Unfinished jobs whose heartbeat is stale (or missing). "Stuck" means no
 * heartbeat progress — not merely "still running" — so a legitimately long
 * cascade isn't double-driven by the sweep.
 */
export async function listUnfinishedJobs(
  db: D1Database,
  logger: Logger,
  staleBeforeIso: string,
): Promise<Result<DeletionJob[], AppError>> {
  try {
    const result = await db
      .prepare(
        "SELECT * FROM deletion_jobs WHERE state IN ('pending','running','verifying') " +
          "AND (heartbeat_at IS NULL OR heartbeat_at < ?)",
      )
      .bind(staleBeforeIso)
      .all<DeletionJobRow>();
    return ok(result.results.map((row) => rowToJob(row, logger)));
  } catch (error) {
    return err(toDbError(error, "list", logger));
  }
}
