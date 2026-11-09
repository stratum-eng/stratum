/**
 * Storage for the push mirror (#417), migration 075.
 *
 * One row per mirrored project: its configuration, the status people see, and
 * the outstanding-work marker. Every transition is a single conditional
 * statement, because the things that race here — two merges, a queue redelivery
 * and the five-minute sweep — are separate Worker invocations with nothing but
 * this table between them.
 *
 * `requestedSeq` versus `pushedSeq` is the whole queueing model. A request bumps
 * the first; a completed push records the value it started from as the second;
 * a mirror has work exactly while they differ. See the migration for why.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export const PUSH_MIRROR_STATES = [
  "idle",
  "pushing",
  "ok",
  "retrying",
  "failed",
  "diverged",
] as const;

/**
 * - `idle` — configured, nothing pushed yet (or disabled).
 * - `pushing` — a run holds the lease.
 * - `ok` — the mirror matched the project when the last run finished.
 * - `retrying` — the last attempt failed and another is scheduled.
 * - `failed` — retries are exhausted, or the failure is one no retry fixes.
 *   The next merge, or an admin's resume, starts over.
 * - `diverged` — the target holds history the project does not. Nothing is
 *   pushed until an admin resumes the mirror.
 */
export type PushMirrorState = (typeof PUSH_MIRROR_STATES)[number];

export interface PushMirror {
  projectId: string;
  namespace: string;
  slug: string;
  repoOwner: string;
  repoName: string;
  enabled: boolean;
  state: PushMirrorState;
  requestedSeq: number;
  pushedSeq: number;
  attempts: number;
  nextAttemptAt?: string;
  leaseExpiresAt?: string;
  lastPushedSha?: string;
  lastPushedAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
  configuredBy?: string;
  createdAt: string;
  updatedAt: string;
}

interface PushMirrorRow {
  project_id: string;
  namespace: string;
  slug: string;
  repo_owner: string;
  repo_name: string;
  enabled: number;
  state: string;
  requested_seq: number;
  pushed_seq: number;
  attempts: number;
  next_attempt_at: string | null;
  lease_expires_at: string | null;
  last_pushed_sha: string | null;
  last_pushed_at: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
  configured_by: string | null;
  created_at: string;
  updated_at: string;
}

function isState(value: string): value is PushMirrorState {
  return (PUSH_MIRROR_STATES as readonly string[]).includes(value);
}

function fromRow(row: PushMirrorRow): PushMirror {
  return {
    projectId: row.project_id,
    namespace: row.namespace,
    slug: row.slug,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    enabled: row.enabled === 1,
    state: isState(row.state) ? row.state : "idle",
    requestedSeq: row.requested_seq,
    pushedSeq: row.pushed_seq,
    attempts: row.attempts,
    ...(row.next_attempt_at !== null ? { nextAttemptAt: row.next_attempt_at } : {}),
    ...(row.lease_expires_at !== null ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.last_pushed_sha !== null ? { lastPushedSha: row.last_pushed_sha } : {}),
    ...(row.last_pushed_at !== null ? { lastPushedAt: row.last_pushed_at } : {}),
    ...(row.last_attempt_at !== null ? { lastAttemptAt: row.last_attempt_at } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    ...(row.configured_by !== null ? { configuredBy: row.configured_by } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function storageError(message: string, error: unknown, logger: Logger): AppError {
  logger.error(message, error instanceof Error ? error : undefined);
  return new AppError(message, "DATABASE_ERROR", 500);
}

/** Errors are trimmed before they are stored: this column is rendered to people. */
const MAX_ERROR_LENGTH = 500;
const trimError = (message: string): string =>
  message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message;

/**
 * Whether work is outstanding for a mirror: enabled, not stopped on divergence,
 * and asked for something its last completed push did not cover.
 */
export function hasPendingPush(mirror: PushMirror): boolean {
  return mirror.enabled && mirror.state !== "diverged" && mirror.requestedSeq > mirror.pushedSeq;
}

/**
 * Reads a project's mirror.
 *
 * @returns The mirror, or null when the project has none
 */
export async function getPushMirror(
  db: D1Database,
  logger: Logger,
  projectId: string,
): Promise<Result<PushMirror | null, AppError>> {
  try {
    const row = await db
      .prepare("SELECT * FROM push_mirrors WHERE project_id = ?")
      .bind(projectId)
      .first<PushMirrorRow>();
    return ok(row ? fromRow(row) : null);
  } catch (error) {
    return err(storageError("Failed to read push mirror", error, logger));
  }
}

/**
 * Is this project a forge-mode project — one whose GitHub copy is a mirror it
 * pushes to, rather than an upstream it follows?
 *
 * The answer gates every layer-mode path (inbound sync, PR promotion). It fails
 * OPEN to `false` on a storage error: those paths predate the mirror, and a D1
 * blip must not start refusing every sync on the instance.
 */
export async function isPushMirrorEnabled(
  db: D1Database,
  logger: Logger,
  projectId: string,
): Promise<boolean> {
  const mirror = await getPushMirror(db, logger, projectId);
  return mirror.success && mirror.data !== null && mirror.data.enabled;
}

/**
 * Does `projectId` have an enabled mirror to `owner/repo`? Used by the
 * canonical repo link: a mirroring project points at its target as surely as
 * an imported one points at its source.
 *
 * A disabled mirror does not count — the project is back in layer mode and
 * pushes nothing there. A storage failure is returned as an error rather than
 * read as "no": the caller decides whether a repository changes hands, and
 * must not do that on the strength of a lookup that did not answer.
 */
export async function mirrorTargetsRepo(
  db: D1Database,
  logger: Logger,
  projectId: string,
  owner: string,
  repo: string,
): Promise<Result<boolean, AppError>> {
  const mirror = await getPushMirror(db, logger, projectId);
  if (!mirror.success) return mirror;
  return ok(
    mirror.data !== null &&
      mirror.data.enabled &&
      mirror.data.repoOwner.toLowerCase() === owner.toLowerCase() &&
      mirror.data.repoName.toLowerCase() === repo.toLowerCase(),
  );
}

export interface UpsertPushMirrorInput {
  projectId: string;
  namespace: string;
  slug: string;
  repoOwner: string;
  repoName: string;
  enabled: boolean;
  configuredBy: string;
}

/**
 * Creates or replaces a project's mirror configuration.
 *
 * Pointing the mirror at a different repository resets its status: the last
 * pushed commit and any divergence describe the old target, not the new one.
 * Re-saving the same target keeps them — in particular it does not clear
 * `diverged`, which only {@link resumePushMirror} may do.
 *
 * @returns The stored mirror; `MIRROR_TARGET_TAKEN` (409) when another project
 *   already mirrors to that repository
 */
export async function upsertPushMirror(
  db: D1Database,
  logger: Logger,
  input: UpsertPushMirrorInput,
): Promise<Result<PushMirror, AppError>> {
  const now = new Date().toISOString();
  // Stored as given; the columns are NOCASE, so the "same target?" comparisons
  // below and the one-mirror-per-repository index ignore case on their own.
  const owner = input.repoOwner;
  const repo = input.repoName;
  try {
    const row = await db
      .prepare(
        `INSERT INTO push_mirrors
           (project_id, namespace, slug, repo_owner, repo_name, enabled, state,
            configured_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?)
         ON CONFLICT (project_id) DO UPDATE SET
           namespace = excluded.namespace,
           slug = excluded.slug,
           enabled = excluded.enabled,
           configured_by = excluded.configured_by,
           updated_at = excluded.updated_at,
           state = CASE
             WHEN push_mirrors.repo_owner = excluded.repo_owner
              AND push_mirrors.repo_name = excluded.repo_name THEN push_mirrors.state
             ELSE 'idle' END,
           last_pushed_sha = CASE
             WHEN push_mirrors.repo_owner = excluded.repo_owner
              AND push_mirrors.repo_name = excluded.repo_name THEN push_mirrors.last_pushed_sha
             ELSE NULL END,
           last_pushed_at = CASE
             WHEN push_mirrors.repo_owner = excluded.repo_owner
              AND push_mirrors.repo_name = excluded.repo_name THEN push_mirrors.last_pushed_at
             ELSE NULL END,
           last_error = CASE
             WHEN push_mirrors.repo_owner = excluded.repo_owner
              AND push_mirrors.repo_name = excluded.repo_name THEN push_mirrors.last_error
             ELSE NULL END,
           attempts = CASE
             WHEN push_mirrors.repo_owner = excluded.repo_owner
              AND push_mirrors.repo_name = excluded.repo_name THEN push_mirrors.attempts
             ELSE 0 END,
           next_attempt_at = CASE
             WHEN push_mirrors.repo_owner = excluded.repo_owner
              AND push_mirrors.repo_name = excluded.repo_name THEN push_mirrors.next_attempt_at
             ELSE NULL END,
           repo_owner = excluded.repo_owner,
           repo_name = excluded.repo_name
         RETURNING *`,
      )
      .bind(
        input.projectId,
        input.namespace,
        input.slug,
        owner,
        repo,
        input.enabled ? 1 : 0,
        input.configuredBy,
        now,
        now,
      )
      .first<PushMirrorRow>();
    if (!row) return err(new AppError("Push mirror vanished after save", "DATABASE_ERROR", 500));
    return ok(fromRow(row));
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      return err(
        new AppError(
          `${owner}/${repo} is already the mirror of another project`,
          "MIRROR_TARGET_TAKEN",
          409,
        ),
      );
    }
    return err(storageError("Failed to save push mirror", error, logger));
  }
}

/**
 * Removes a project's mirror configuration and status.
 *
 * @returns Whether a mirror existed
 */
export async function deletePushMirror(
  db: D1Database,
  logger: Logger,
  projectId: string,
): Promise<Result<boolean, AppError>> {
  try {
    const result = await db
      .prepare("DELETE FROM push_mirrors WHERE project_id = ?")
      .bind(projectId)
      .run();
    return ok(result.meta.changes > 0);
  } catch (error) {
    return err(storageError("Failed to delete push mirror", error, logger));
  }
}

/**
 * Records that the project's refs moved and the mirror has something to push.
 *
 * A fresh request also restarts the retry budget: `failed` means "the last
 * commit could not be delivered", and a new commit is a new reason to try.
 * `diverged` is deliberately left alone — the request is counted, so a later
 * resume pushes everything that accumulated, but nothing restarts on its own.
 *
 * @returns The mirror after the bump, or null when the project has no enabled
 *   mirror (the overwhelmingly common case, and one statement to find out)
 */
export async function requestPush(
  db: D1Database,
  logger: Logger,
  projectId: string,
): Promise<Result<PushMirror | null, AppError>> {
  try {
    const row = await db
      .prepare(
        `UPDATE push_mirrors
            SET requested_seq = requested_seq + 1,
                state = CASE WHEN state IN ('failed', 'retrying') THEN 'idle' ELSE state END,
                attempts = CASE WHEN state = 'diverged' THEN attempts ELSE 0 END,
                next_attempt_at = CASE WHEN state = 'diverged' THEN next_attempt_at ELSE NULL END,
                updated_at = ?
          WHERE project_id = ? AND enabled = 1
          RETURNING *`,
      )
      .bind(new Date().toISOString(), projectId)
      .first<PushMirrorRow>();
    return ok(row ? fromRow(row) : null);
  } catch (error) {
    return err(storageError("Failed to request a mirror push", error, logger));
  }
}

/**
 * Clears `failed` or `diverged` and asks for a push. The one way out of
 * `diverged`.
 *
 * @returns The mirror after the reset, or null when the project has none
 */
export async function resumePushMirror(
  db: D1Database,
  logger: Logger,
  projectId: string,
): Promise<Result<PushMirror | null, AppError>> {
  try {
    const row = await db
      .prepare(
        `UPDATE push_mirrors
            SET requested_seq = requested_seq + 1,
                state = CASE WHEN state = 'pushing' THEN 'pushing' ELSE 'idle' END,
                attempts = 0,
                next_attempt_at = NULL,
                last_error = NULL,
                updated_at = ?
          WHERE project_id = ?
          RETURNING *`,
      )
      .bind(new Date().toISOString(), projectId)
      .first<PushMirrorRow>();
    return ok(row ? fromRow(row) : null);
  } catch (error) {
    return err(storageError("Failed to resume push mirror", error, logger));
  }
}

/**
 * Takes the per-project push lease, or reports that someone else holds it.
 *
 * The lease is what makes pushes for one project serial. It expires, so a run
 * that died mid-push (an isolate eviction never reaches its `finally`) blocks
 * the mirror for `leaseMs` and no longer.
 *
 * @returns The claimed mirror, or null when the lease is held, the mirror is
 *   disabled or diverged, or it no longer exists
 */
export async function claimPushLease(
  db: D1Database,
  logger: Logger,
  projectId: string,
  leaseMs: number,
  nowMs: number = Date.now(),
): Promise<Result<PushMirror | null, AppError>> {
  const now = new Date(nowMs).toISOString();
  try {
    const row = await db
      .prepare(
        `UPDATE push_mirrors
            SET state = 'pushing',
                lease_expires_at = ?,
                last_attempt_at = ?,
                updated_at = ?
          WHERE project_id = ?
            AND enabled = 1
            AND state != 'diverged'
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
          RETURNING *`,
      )
      .bind(new Date(nowMs + leaseMs).toISOString(), now, now, projectId, now)
      .first<PushMirrorRow>();
    return ok(row ? fromRow(row) : null);
  } catch (error) {
    return err(storageError("Failed to claim the mirror push lease", error, logger));
  }
}

/**
 * Records a completed push that started from request `seq`.
 *
 * The lease is released only if no request arrived while the push ran. When one
 * did, the lease is kept and `released` is false: the caller pushes again, so
 * the request that found the lease taken is not lost.
 *
 * @returns Whether the lease was released (nothing further to push)
 */
export async function recordPushSuccess(
  db: D1Database,
  logger: Logger,
  input: { projectId: string; seq: number; sha: string; leaseMs: number },
): Promise<Result<{ released: boolean }, AppError>> {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  try {
    const row = await db
      .prepare(
        `UPDATE push_mirrors
            SET pushed_seq = ?,
                last_pushed_sha = ?,
                last_pushed_at = ?,
                last_error = NULL,
                attempts = 0,
                next_attempt_at = NULL,
                state = CASE WHEN requested_seq > ? THEN 'pushing' ELSE 'ok' END,
                lease_expires_at = CASE WHEN requested_seq > ? THEN ? ELSE NULL END,
                updated_at = ?
          WHERE project_id = ?
          RETURNING requested_seq`,
      )
      .bind(
        input.seq,
        input.sha,
        now,
        input.seq,
        input.seq,
        new Date(nowMs + input.leaseMs).toISOString(),
        now,
        input.projectId,
      )
      .first<{ requested_seq: number }>();
    return ok({ released: !row || row.requested_seq <= input.seq });
  } catch (error) {
    return err(storageError("Failed to record a mirror push", error, logger));
  }
}

/**
 * Records a failed attempt and releases the lease.
 *
 * @param input.nextAttemptAt - When the retry is due; omit to give up (`failed`)
 */
export async function recordPushFailure(
  db: D1Database,
  logger: Logger,
  input: { projectId: string; error: string; nextAttemptAt?: string },
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare(
        `UPDATE push_mirrors
            SET state = ?,
                attempts = attempts + 1,
                next_attempt_at = ?,
                last_error = ?,
                lease_expires_at = NULL,
                updated_at = ?
          WHERE project_id = ?`,
      )
      .bind(
        input.nextAttemptAt !== undefined ? "retrying" : "failed",
        input.nextAttemptAt ?? null,
        trimError(input.error),
        new Date().toISOString(),
        input.projectId,
      )
      .run();
    return ok(undefined);
  } catch (error) {
    return err(storageError("Failed to record a mirror push failure", error, logger));
  }
}

/** Marks the mirror diverged and releases the lease. Sticky until resumed. */
export async function recordPushDiverged(
  db: D1Database,
  logger: Logger,
  input: { projectId: string; reason: string },
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare(
        `UPDATE push_mirrors
            SET state = 'diverged',
                next_attempt_at = NULL,
                last_error = ?,
                lease_expires_at = NULL,
                updated_at = ?
          WHERE project_id = ?`,
      )
      .bind(trimError(input.reason), new Date().toISOString(), input.projectId)
      .run();
    return ok(undefined);
  } catch (error) {
    return err(storageError("Failed to record mirror divergence", error, logger));
  }
}

/**
 * Releases the lease without recording an outcome, leaving the request
 * outstanding for the next delivery or the sweep.
 */
export async function releasePushLease(
  db: D1Database,
  logger: Logger,
  projectId: string,
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare(
        `UPDATE push_mirrors
            SET lease_expires_at = NULL,
                state = CASE WHEN state = 'pushing' THEN 'idle' ELSE state END,
                updated_at = ?
          WHERE project_id = ?`,
      )
      .bind(new Date().toISOString(), projectId)
      .run();
    return ok(undefined);
  } catch (error) {
    return err(storageError("Failed to release the mirror push lease", error, logger));
  }
}

/**
 * Mirrors the sweep should nudge: work outstanding, no live lease, not waiting
 * out a backoff, and not given up on.
 *
 * `failed` is excluded on purpose. It means the retry budget is spent; only a
 * new request (which resets `attempts`, and with it the state the run sees) or
 * an admin's resume restarts it, and both send their own queue message.
 */
export async function listDuePushMirrors(
  db: D1Database,
  logger: Logger,
  limit: number,
  nowMs: number = Date.now(),
): Promise<Result<PushMirror[], AppError>> {
  const now = new Date(nowMs).toISOString();
  try {
    const rows = await db
      .prepare(
        `SELECT * FROM push_mirrors
          WHERE enabled = 1
            AND state NOT IN ('diverged', 'failed')
            AND requested_seq > pushed_seq
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY updated_at ASC
          LIMIT ?`,
      )
      .bind(now, now, limit)
      .all<PushMirrorRow>();
    return ok(rows.results.map(fromRow));
  } catch (error) {
    return err(storageError("Failed to list due push mirrors", error, logger));
  }
}
