import {
  QUEUED_GRACE_MS,
  STALLED_THRESHOLD_MS,
  updateImportProgressById,
} from "../storage/imports";
import type { Env, ImportStatus } from "../types";
import type { Logger } from "../utils/logger";
import { createLogger } from "../utils/logger";

/**
 * Most jobs a single sweep will reap. A backlog drains over successive crons
 * rather than risking the Worker's wall-clock budget in one invocation.
 */
const SWEEP_BATCH_LIMIT = 100;

/** Statuses that indicate active work, and so are judged by silence. */
const ACTIVE_STATUSES: readonly ImportStatus[] = [
  "cloning",
  "processing",
  "syncing",
  "checking",
  "cancelling",
];

export interface ImportSweepResult {
  /** Rows that matched the stale predicate and were considered. */
  scanned: number;
  /** Rows successfully moved to a terminal status. */
  reaped: number;
  /** Rows another writer owned — the sweep deliberately stood down. */
  conflicted: number;
  /** Rows that threw; counted and skipped so one bad row cannot end the batch. */
  errored: number;
}

interface StaleJobRow {
  id: string;
  namespace: string;
  slug: string;
  status: ImportStatus;
  version: number;
  updated_at: string;
}

/**
 * A cancel that the consumer never finished should land in `cancelled`, not
 * `failed` — the user asked for it and it did happen, however untidily. Anything
 * else that stopped progressing is a failure.
 */
function terminalStatusFor(status: ImportStatus): "cancelled" | "failed" {
  return status === "cancelling" ? "cancelled" : "failed";
}

function stalledMessage(status: ImportStatus, thresholdMs: number): string {
  const minutes = Math.round(thresholdMs / 60_000);
  return status === "queued"
    ? `Import was never picked up by a worker after ${minutes} minutes. The queue message was likely lost; retry to re-queue it.`
    : `Import stalled: no progress for longer than ${minutes} minutes. This may indicate a network issue or timeout with the git provider.`;
}

/**
 * Move wedged import jobs to a terminal status.
 *
 * Without this, a job whose consumer died mid-run stayed non-terminal forever:
 * `recoverStalledImport` only ever ran on demand, for a single project, when
 * somebody happened to load its progress page. A project nobody opened kept
 * claiming an import was in progress indefinitely — the four-month CANCELLING
 * badge in #304.
 *
 * `queued` is held to a much longer grace period than the active statuses: it
 * means "not yet picked up", and a queue backlog of a few minutes is ordinary.
 */
export async function runImportSweep(
  env: Env,
  logger: Logger = createLogger({ component: "ImportSweep" }),
): Promise<ImportSweepResult> {
  const result: ImportSweepResult = { scanned: 0, reaped: 0, conflicted: 0, errored: 0 };

  // Cutoffs are ISO strings, NOT `datetime('now', ...)`. `updated_at` holds
  // `new Date().toISOString()`, and SQLite compares these as TEXT: an ISO value
  // ('...T23:04:29.798Z') always sorts after a same-day `datetime()` value
  // ('... 23:04:29') because 'T' (0x54) > ' ' (0x20). Comparing the two formats
  // makes the predicate false for every row until the UTC date itself rolls
  // over, which silently delayed reaping by up to a day. Binding an ISO string
  // also keeps `idx_import_jobs_status_updated_at` usable, which wrapping the
  // column in datetime()/julianday() would not.
  const now = Date.now();
  const activeCutoff = new Date(now - STALLED_THRESHOLD_MS).toISOString();
  const queuedCutoff = new Date(now - QUEUED_GRACE_MS).toISOString();
  const activePlaceholders = ACTIVE_STATUSES.map(() => "?").join(", ");

  let staleJobs: StaleJobRow[];
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, namespace, slug, status, version, updated_at
       FROM import_jobs
       WHERE (status IN (${activePlaceholders}) AND updated_at < ?)
          OR (status = 'queued' AND updated_at < ?)
       ORDER BY updated_at ASC
       LIMIT ?`,
    )
      .bind(...ACTIVE_STATUSES, activeCutoff, queuedCutoff, SWEEP_BATCH_LIMIT)
      .all<StaleJobRow>();
    staleJobs = results ?? [];
  } catch (error) {
    logger.error("Import sweep query failed", error instanceof Error ? error : undefined);
    return result;
  }

  result.scanned = staleJobs.length;

  for (const job of staleJobs) {
    const targetStatus = terminalStatusFor(job.status);
    const thresholdMs = job.status === "queued" ? QUEUED_GRACE_MS : STALLED_THRESHOLD_MS;

    try {
      const now = new Date().toISOString();
      const updated = await updateImportProgressById(
        env.DB,
        job.id,
        job.version,
        {
          status: targetStatus,
          completedAt: now,
          ...(targetStatus === "failed"
            ? {
                errors: [
                  {
                    file: "_import",
                    error: stalledMessage(job.status, thresholdMs),
                    timestamp: now,
                  },
                ],
              }
            : {}),
        },
        logger,
      );

      if (!updated.success) {
        result.errored++;
        logger.warn("Failed to reap stalled import", {
          importId: job.id,
          namespace: job.namespace,
          slug: job.slug,
          error: updated.error.message,
        });
        continue;
      }

      if (!updated.data.updated) {
        // Another writer owns this row (or the cancellation path already
        // removed it). Standing down is the correct outcome, not a failure.
        result.conflicted++;
        continue;
      }

      result.reaped++;
      logger.info("Reaped stalled import", {
        importId: job.id,
        namespace: job.namespace,
        slug: job.slug,
        from: job.status,
        to: targetStatus,
        updatedAt: job.updated_at,
      });
    } catch (error) {
      result.errored++;
      logger.error("Error reaping stalled import", error instanceof Error ? error : undefined, {
        importId: job.id,
      });
    }
  }

  if (result.scanned > 0) {
    logger.info("Import sweep completed", { ...result });
  }

  return result;
}
