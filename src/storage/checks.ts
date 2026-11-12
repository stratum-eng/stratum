/**
 * Check runs (#414, ADR 011, migration 074): storage.
 *
 * A check run is one attempt at one named check on one revision of one change.
 * The invariants the rest of the feature leans on are enforced HERE, in the
 * SQL, rather than by callers remembering them:
 *
 * - Rows are created only by {@link createCheckRuns}, from names the caller
 *   took out of the project's base policy. Nothing a runner sends reaches an
 *   INSERT, so a runner cannot bring a check into existence.
 * - {@link applyCheckReport} is one conditional UPDATE. It can only move a row
 *   that is still `queued` or `running`, still the newest attempt for its
 *   name, still inside its deadline, and only with a sequence number above the
 *   last one applied. Two reports racing each other cannot both win, and a
 *   terminal state is never left.
 * - "Latest" always means the highest `attempt` for (change, revision, name).
 *   {@link latestChecksForRevision} is what the merge gate reads.
 */
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export type CheckStatus = "queued" | "running" | "passed" | "failed" | "errored";

/** States a check never leaves. */
export const TERMINAL_CHECK_STATUSES: readonly CheckStatus[] = ["passed", "failed", "errored"];

/** What a runner may report. `queued` is where Stratum puts a check, not a report. */
export const REPORTABLE_CHECK_STATUSES = ["running", "passed", "failed", "errored"] as const;
export type ReportableCheckStatus = (typeof REPORTABLE_CHECK_STATUSES)[number];

/** Whether a check in this status has finished and can no longer change. */
export function isTerminalCheckStatus(status: CheckStatus): boolean {
  return TERMINAL_CHECK_STATUSES.includes(status);
}

/** Summaries Stratum writes itself when it ends a check the runner did not. */
export const CHECK_SUMMARY_DEADLINE = "The runner did not report a result before the deadline.";
export const CHECK_SUMMARY_SUPERSEDED = "Superseded by a newer run of this check.";

/** A check run as stored, including the fields no API response carries. */
export interface CheckRun {
  /** `chk_` + 128 random bits. Also the callback address. */
  id: string;
  changeId: string;
  projectId: string;
  /** The evaluated head sha this run was dispatched for. */
  revision: string;
  /** The base the dispatched diff was built against. */
  baseSha?: string;
  name: string;
  /** 1-based, per (change, revision, name). */
  attempt: number;
  status: CheckStatus;
  detailsUrl?: string;
  summary?: string;
  /** Name of the project secret callbacks are verified against. Never a key. */
  secretRef: string;
  /**
   * Set only on a run dispatched to the instance's CI executor (#415): the
   * digest of the `.stratum/ci.yaml` it was dispatched under. Its presence is
   * what marks a first-party run — the callback is then verified against the
   * executor's secret and `secretRef` is only a label.
   */
  ciConfigDigest?: string;
  lastSequence: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  deadlineAt: string;
}

/** The shape every API response, MCP tool and page uses for a check run. */
export interface CheckRunView {
  id: string;
  changeId: string;
  revision: string;
  baseSha?: string;
  name: string;
  attempt: number;
  status: CheckStatus;
  summary?: string;
  detailsUrl?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  deadlineAt: string;
}

/**
 * Drop the fields that are plumbing rather than state: which secret verifies
 * the callback, the sequence cursor, the project id.
 */
export function toCheckRunView(check: CheckRun): CheckRunView {
  return {
    id: check.id,
    changeId: check.changeId,
    revision: check.revision,
    ...(check.baseSha !== undefined ? { baseSha: check.baseSha } : {}),
    name: check.name,
    attempt: check.attempt,
    status: check.status,
    ...(check.summary !== undefined ? { summary: check.summary } : {}),
    ...(check.detailsUrl !== undefined ? { detailsUrl: check.detailsUrl } : {}),
    createdAt: check.createdAt,
    ...(check.startedAt !== undefined ? { startedAt: check.startedAt } : {}),
    ...(check.completedAt !== undefined ? { completedAt: check.completedAt } : {}),
    deadlineAt: check.deadlineAt,
  };
}

interface CheckRow {
  id: string;
  change_id: string;
  project_id: string;
  revision: string;
  base_sha: string | null;
  name: string;
  attempt: number;
  status: CheckStatus;
  details_url: string | null;
  summary: string | null;
  secret_ref: string;
  ci_config_digest: string | null;
  last_sequence: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  deadline_at: string;
}

/** Maps a `checks` row to the public `CheckRun`, omitting unset nullable columns. */
function rowToCheck(row: CheckRow): CheckRun {
  return {
    id: row.id,
    changeId: row.change_id,
    projectId: row.project_id,
    revision: row.revision,
    ...(row.base_sha !== null ? { baseSha: row.base_sha } : {}),
    name: row.name,
    attempt: row.attempt,
    status: row.status,
    ...(row.details_url !== null ? { detailsUrl: row.details_url } : {}),
    ...(row.summary !== null ? { summary: row.summary } : {}),
    secretRef: row.secret_ref,
    // `!= null` rather than `!== null`: a row read before migration 077 has no
    // such column at all, and must read as a project check.
    ...(row.ci_config_digest != null ? { ciConfigDigest: row.ci_config_digest } : {}),
    lastSequence: row.last_sequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    deadlineAt: row.deadline_at,
  };
}

/** Normalizes a thrown value so the logger always receives an `Error`. */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

const PENDING = "status IN ('queued', 'running')";

/**
 * This row is the newest attempt of its (change, revision, name). Written as a
 * correlated NOT EXISTS so it can guard an UPDATE as well as filter a SELECT.
 */
const IS_LATEST_ATTEMPT = `NOT EXISTS (
  SELECT 1 FROM checks newer
  WHERE newer.change_id = checks.change_id
    AND newer.revision = checks.revision
    AND newer.name = checks.name
    AND newer.attempt > checks.attempt
)`;

/**
 * Create one `queued` run per name, as the next attempt for that name on this
 * revision, and end whatever earlier runs they replace.
 *
 * One D1 batch, so a dispatch never leaves a superseded run pending beside its
 * replacement. The attempt number is computed inside the INSERT; two
 * dispatches racing for the same revision cannot both take the same one — the
 * unique index refuses the second, and that batch fails as a whole.
 *
 * @param args.supersede - `"all"` ends every pending run of the change (a new
 *   evaluation replaces the whole set, including runs for an older revision
 *   and for names the policy no longer declares); `"same-names"` ends only
 *   pending runs of the names being created (a re-run of one check).
 */
export async function createCheckRuns(
  db: D1Database,
  logger: Logger,
  args: {
    changeId: string;
    projectId: string;
    revision: string;
    baseSha?: string;
    names: string[];
    secretRef: string;
    /** Marks the runs as the CI executor's. See {@link CheckRun.ciConfigDigest}. */
    ciConfigDigest?: string;
    deadlineAt: string;
    supersede: "all" | "same-names";
    now?: string;
  },
): Promise<Result<CheckRun[], Error>> {
  const { changeId, projectId, revision, names, secretRef, deadlineAt } = args;
  if (names.length === 0) return ok([]);
  const now = args.now ?? new Date().toISOString();

  try {
    const supersede =
      args.supersede === "all"
        ? db
            .prepare(
              `UPDATE checks SET status = 'errored', summary = ?, completed_at = ?, updated_at = ?
               WHERE change_id = ? AND ${PENDING}`,
            )
            .bind(CHECK_SUMMARY_SUPERSEDED, now, now, changeId)
        : db
            .prepare(
              `UPDATE checks SET status = 'errored', summary = ?, completed_at = ?, updated_at = ?
               WHERE change_id = ? AND ${PENDING} AND name IN (${names.map(() => "?").join(", ")})`,
            )
            .bind(CHECK_SUMMARY_SUPERSEDED, now, now, changeId, ...names);

    const insert = db.prepare(
      `INSERT INTO checks (
         id, change_id, project_id, revision, base_sha, name, attempt, status,
         secret_ref, ci_config_digest, last_sequence, created_at, updated_at, deadline_at
       )
       SELECT ?, ?, ?, ?, ?, ?, COALESCE(MAX(attempt), 0) + 1, 'queued', ?, ?, 0, ?, ?, ?
       FROM checks WHERE change_id = ? AND revision = ? AND name = ?
       RETURNING *`,
    );
    const results = await db.batch<CheckRow>([
      supersede,
      ...names.map((name) =>
        insert.bind(
          newId("chk"),
          changeId,
          projectId,
          revision,
          args.baseSha ?? null,
          name,
          secretRef,
          args.ciConfigDigest ?? null,
          now,
          now,
          deadlineAt,
          changeId,
          revision,
          name,
        ),
      ),
    ]);
    const created = results.slice(1).flatMap((result) => result.results.map(rowToCheck));
    logger.info("Check runs created", { changeId, revision, count: created.length });
    return ok(created);
  } catch (error) {
    logger.error("Failed to create check runs", toError(error), { changeId, revision });
    return err(toError(error));
  }
}

/** One check run by id, with whether a newer attempt has replaced it. */
export async function getCheckRun(
  db: D1Database,
  logger: Logger,
  id: string,
): Promise<Result<{ check: CheckRun; superseded: boolean } | null, Error>> {
  try {
    const row = await db
      .prepare(
        `SELECT checks.*, CASE WHEN ${IS_LATEST_ATTEMPT} THEN 0 ELSE 1 END AS superseded
         FROM checks WHERE id = ?`,
      )
      .bind(id)
      .first<CheckRow & { superseded: number }>();
    if (!row) return ok(null);
    return ok({ check: rowToCheck(row), superseded: row.superseded === 1 });
  } catch (error) {
    logger.error("Failed to read check run", toError(error), { checkId: id });
    return err(toError(error));
  }
}

/** Every run recorded for a change, oldest first: all revisions, all attempts. */
export async function listChecksForChange(
  db: D1Database,
  logger: Logger,
  changeId: string,
): Promise<Result<CheckRun[], Error>> {
  try {
    const rows = await db
      .prepare(
        "SELECT * FROM checks WHERE change_id = ? ORDER BY created_at ASC, name ASC, attempt ASC",
      )
      .bind(changeId)
      .all<CheckRow>();
    return ok(rows.results.map(rowToCheck));
  } catch (error) {
    logger.error("Failed to list check runs", toError(error), { changeId });
    return err(toError(error));
  }
}

/**
 * Whether first-party CI has ever been dispatched for this change's project
 * (#415) — or, for a change that predates project ids, for the change itself.
 *
 * The merge gate asks this only when the base branch could not be read, where
 * "the project has no `.stratum/ci.yaml`" and "the file is out of reach" look
 * the same. A project that has run CI before is not one to wave through on the
 * strength of a failed read; a project that never has is unaffected.
 */
export async function projectHasCiRuns(
  db: D1Database,
  logger: Logger,
  change: { id: string; projectId?: string },
): Promise<Result<boolean, Error>> {
  try {
    const row = await db
      .prepare(
        `SELECT 1 AS found FROM checks
         WHERE ci_config_digest IS NOT NULL AND (project_id = ? OR change_id = ?)
         LIMIT 1`,
      )
      .bind(change.projectId ?? "", change.id)
      .first<{ found: number }>();
    return ok(row !== null);
  } catch (error) {
    logger.error("Failed to look for first-party check runs", toError(error), {
      changeId: change.id,
    });
    return err(toError(error));
  }
}

/**
 * The newest attempt of each check name on one revision of a change — what
 * the merge gate and the change page read. A run for any other revision is
 * simply not in the answer, which is how a new revision invalidates the old
 * one's checks without anything having to delete or rewrite them.
 */
export async function latestChecksForRevision(
  db: D1Database,
  logger: Logger,
  changeId: string,
  revision: string,
): Promise<Result<CheckRun[], Error>> {
  try {
    const rows = await db
      .prepare(
        `SELECT * FROM checks
         WHERE change_id = ? AND revision = ? AND ${IS_LATEST_ATTEMPT}
         ORDER BY name ASC`,
      )
      .bind(changeId, revision)
      .all<CheckRow>();
    return ok(rows.results.map(rowToCheck));
  } catch (error) {
    logger.error("Failed to read latest check runs", toError(error), { changeId, revision });
    return err(toError(error));
  }
}

/**
 * Apply a runner's report, if it is still allowed to land.
 *
 * `applied: false` means the guarded UPDATE matched nothing — the run is
 * terminal, superseded, past its deadline, or already at or beyond this
 * sequence. The caller re-reads to say which; this function only guarantees
 * that none of those cases can write.
 *
 * `summary` and `detailsUrl` are kept when a report omits them, so a terminal
 * report carrying only a status does not erase the link a `running` one set.
 */
export async function applyCheckReport(
  db: D1Database,
  logger: Logger,
  args: {
    id: string;
    status: ReportableCheckStatus;
    sequence: number;
    summary?: string;
    detailsUrl?: string;
    now?: string;
  },
): Promise<Result<{ applied: true; check: CheckRun } | { applied: false }, Error>> {
  const now = args.now ?? new Date().toISOString();
  const terminal = args.status !== "running";
  try {
    const row = await db
      .prepare(
        `UPDATE checks SET
           status = ?,
           summary = COALESCE(?, summary),
           details_url = COALESCE(?, details_url),
           last_sequence = ?,
           updated_at = ?,
           started_at = COALESCE(started_at, ?),
           completed_at = ?
         WHERE id = ? AND ${PENDING} AND last_sequence < ? AND deadline_at > ?
           AND ${IS_LATEST_ATTEMPT}
         RETURNING *`,
      )
      .bind(
        args.status,
        args.summary ?? null,
        args.detailsUrl ?? null,
        args.sequence,
        now,
        now,
        terminal ? now : null,
        args.id,
        args.sequence,
        now,
      )
      .first<CheckRow>();
    if (!row) return ok({ applied: false });
    return ok({ applied: true, check: rowToCheck(row) });
  } catch (error) {
    logger.error("Failed to apply check report", toError(error), { checkId: args.id });
    return err(toError(error));
  }
}

/**
 * End specific runs as `errored` with a reason, if they are still pending.
 * Used when a dispatch could not be delivered: the runner was never told, so
 * waiting for the deadline would only delay the same answer.
 */
export async function failCheckRuns(
  db: D1Database,
  logger: Logger,
  args: { ids: string[]; summary: string; now?: string },
): Promise<Result<number, Error>> {
  if (args.ids.length === 0) return ok(0);
  const now = args.now ?? new Date().toISOString();
  try {
    const result = await db
      .prepare(
        `UPDATE checks SET status = 'errored', summary = ?, completed_at = ?, updated_at = ?
         WHERE ${PENDING} AND id IN (${args.ids.map(() => "?").join(", ")})`,
      )
      .bind(args.summary, now, now, ...args.ids)
      .run();
    return ok(result.meta.changes ?? 0);
  } catch (error) {
    logger.error("Failed to mark check runs errored", toError(error), { count: args.ids.length });
    return err(toError(error));
  }
}

/**
 * How many overdue runs one sweep ends. Each can cost a GitHub status post for
 * its change, so a backlog is worked off over several five-minute ticks rather
 * than in one invocation. Runs left over stay pending, which the merge gate
 * already treats as blocking, and a late report still ends them itself.
 */
export const MAX_EXPIRED_PER_SWEEP = 100;

/**
 * Flip every pending run whose deadline has passed to `errored`. One indexed
 * statement, safe to run from the five-minute cron and idempotent across
 * overlapping invocations.
 */
export async function expireOverdueChecks(
  db: D1Database,
  logger: Logger,
  now: string,
  /** At most this many runs per call; the rest stay pending for the next. */
  limit = MAX_EXPIRED_PER_SWEEP,
): Promise<Result<{ expired: number; changeIds: string[] }, Error>> {
  try {
    const result = await db
      .prepare(
        `UPDATE checks SET status = 'errored', summary = ?, completed_at = ?, updated_at = ?
         WHERE id IN (
           SELECT id FROM checks WHERE ${PENDING} AND deadline_at <= ?
           ORDER BY deadline_at LIMIT ?
         )
         RETURNING change_id`,
      )
      .bind(CHECK_SUMMARY_DEADLINE, now, now, now, limit)
      .all<{ change_id: string }>();
    const changeIds = [...new Set(result.results.map((row) => row.change_id))];
    return ok({ expired: result.results.length, changeIds });
  } catch (error) {
    logger.error("Failed to expire overdue check runs", toError(error));
    return err(toError(error));
  }
}
