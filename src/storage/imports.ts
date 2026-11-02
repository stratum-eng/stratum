/**
 * Import progress tracking storage
 * Uses D1 for strong consistency (previously used KV which is eventually consistent)
 */

import type { ImportProgress, ImportStatus } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

const MAX_LOGS = 100; // Prevent unbounded growth
const MAX_ERRORS = 50; // Prevent unbounded growth

/**
 * How long a job may sit in an actively-progressing status (`cloning`,
 * `processing`, `syncing`, `cancelling`) without its `updated_at` advancing
 * before it is treated as stalled.
 *
 * This MUST stay above a queue consumer's 15-minute maximum wall time. The
 * consumer writes `cloning` and then calls into the clone with no intervening
 * progress write, so a perfectly healthy import can leave `updated_at`
 * untouched for its entire run. Anything at or under that ceiling would let the
 * sweep mark live imports `failed`. Past 15 minutes the invocation is gone, so
 * silence really does mean the job was abandoned.
 *
 * Shared by the on-demand recovery in the progress route and the scheduled
 * sweep so the two cannot disagree about what "stalled" means.
 */
export const STALLED_THRESHOLD_MS = 20 * 60 * 1000;

/**
 * The grace period for `queued`, which is not a sign of progress but of a job
 * waiting to be picked up. A queue backlog is normal for seconds to minutes, so
 * this is deliberately longer than `STALLED_THRESHOLD_MS`; exceeding it means
 * the queue message was almost certainly lost.
 */
export const QUEUED_GRACE_MS = 60 * 60 * 1000;

// Valid status values for validation
const VALID_STATUSES: ImportStatus[] = [
  "queued",
  "cloning",
  "processing",
  "completed",
  "failed",
  "cancelled",
  "cancelling",
  "syncing",
  "checking",
];

interface ImportJobRow {
  id: string;
  project_id: string;
  namespace: string;
  slug: string;
  status: ImportStatus;
  source_url: string;
  branch: string;
  depth: number | null;
  progress_processed_files: number;
  progress_total_files: number | null;
  progress_current_file: string | null;
  progress_bytes_transferred: number | null;
  progress_total_bytes: number | null;
  logs: string;
  errors: string;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
  version: number;
}

/**
 * Configuration for optimistic locking retry mechanism
 */
const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 10; // Start with short delay, D1 is fast

/**
 * Conflict error for optimistic locking failures.
 * Thrown when concurrent updates detect version mismatch.
 */
class VersionConflictError extends Error {
  constructor(
    message: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(message);
    this.name = "VersionConflictError";
  }
}

function parseLogs(logsJson: string): ImportProgress["logs"] {
  try {
    const parsed = JSON.parse(logsJson);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to default
  }
  return [];
}

function parseErrors(errorsJson: string): ImportProgress["errors"] {
  try {
    const parsed = JSON.parse(errorsJson);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to default
  }
  return [];
}

function rowToImportProgress(row: ImportJobRow): ImportProgress {
  const progress: ImportProgress["progress"] = {
    processedFiles: row.progress_processed_files,
  };

  if (row.progress_total_files !== null && row.progress_total_files !== undefined) {
    progress.totalFiles = row.progress_total_files;
  }

  if (row.progress_current_file !== null && row.progress_current_file !== undefined) {
    progress.currentFile = row.progress_current_file;
  }

  const result: ImportProgress = {
    id: row.id,
    projectId: row.project_id,
    namespace: row.namespace,
    slug: row.slug,
    status: row.status,
    sourceUrl: row.source_url,
    branch: row.branch,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    version: row.version,
    progress,
    errors: parseErrors(row.errors),
    logs: parseLogs(row.logs),
  };

  // Only add completedAt if it exists (exactOptionalPropertyTypes compliance)
  if (row.completed_at !== null && row.completed_at !== undefined) {
    result.completedAt = row.completed_at;
  }

  // Left absent when NULL rather than defaulted here: NULL means "no depth was
  // ever recorded" (a row predating migration 040), which callers answer with
  // DEFAULT_CLONE_DEPTH. Defaulting at this layer would erase the difference
  // between that and a stored 0, which means full history.
  if (row.depth !== null && row.depth !== undefined) {
    result.depth = row.depth;
  }

  return result;
}

function validateStatus(status: string): ImportStatus {
  if (VALID_STATUSES.includes(status as ImportStatus)) {
    return status as ImportStatus;
  }
  throw new AppError(`Invalid import status: ${status}`, "INVALID_STATE", 400);
}

/**
 * The clone depth the project's most recent import job ran under, or
 * `undefined` when none was recorded.
 *
 * For the sync paths, which create a NEW job and have to inherit the depth the
 * project was actually imported at rather than re-deriving a literal. Callers
 * answer `undefined` with `DEFAULT_CLONE_DEPTH`; a stored `0` is full history
 * and must survive that `??` intact.
 *
 * Narrower than `getImportProgress` on purpose: this reads one integer, where
 * that returns the whole row and parses the `logs`/`errors` JSON blobs the
 * webhook sync path has no use for.
 *
 * A lookup failure is logged and treated as "not recorded" rather than
 * propagated — a sync must not fail because the previous job's depth could not
 * be read, and the fallback is exactly the behavior that preceded this column.
 */
export async function getLatestImportDepth(
  db: D1Database,
  namespace: string,
  slug: string,
  logger: Logger,
): Promise<number | undefined> {
  try {
    const row = await db
      .prepare(
        "SELECT depth FROM import_jobs WHERE namespace = ? AND slug = ? ORDER BY started_at DESC LIMIT 1",
      )
      .bind(namespace, slug)
      .first<{ depth: number | null }>();
    return row?.depth ?? undefined;
  } catch (error) {
    logger.error(
      "Failed to read the previous import job's clone depth",
      error instanceof Error ? error : undefined,
      { namespace, slug },
    );
    return undefined;
  }
}

export async function createImportJob(
  db: D1Database,
  params: {
    id: string;
    projectId: string;
    namespace: string;
    slug: string;
    sourceUrl: string;
    branch: string;
    /**
     * Clone depth this job runs under. Omitted when the caller has none to
     * record, which stores NULL and lets later jobs fall back to
     * DEFAULT_CLONE_DEPTH. `0` is full history and is NOT the same as omitted.
     */
    depth?: number;
  },
  logger: Logger,
): Promise<Result<ImportProgress, AppError>> {
  logger.debug("Creating import job", {
    importId: params.id,
    namespace: params.namespace,
    slug: params.slug,
  });

  const initialLog = [
    {
      message: "Import queued",
      level: "info" as const,
      timestamp: new Date().toISOString(),
    },
  ];

  const now = new Date().toISOString();

  try {
    await db
      .prepare(
        `INSERT INTO import_jobs (
          id, project_id, namespace, slug, status, source_url, branch, depth,
          progress_processed_files, logs, errors, version, started_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        params.id,
        params.projectId,
        params.namespace,
        params.slug,
        "queued",
        params.sourceUrl,
        params.branch,
        params.depth ?? null,
        0,
        JSON.stringify(initialLog),
        "[]",
        1, // Initial version for optimistic locking
        now,
        now,
      )
      .run();

    const progress: ImportProgress = {
      id: params.id,
      projectId: params.projectId,
      namespace: params.namespace,
      slug: params.slug,
      status: "queued",
      sourceUrl: params.sourceUrl,
      branch: params.branch,
      ...(params.depth !== undefined ? { depth: params.depth } : {}),
      startedAt: now,
      updatedAt: now,
      version: 1, // Initial version for optimistic locking
      progress: {
        processedFiles: 0,
      },
      errors: [],
      logs: initialLog,
    };

    logger.info("Import job created", { importId: params.id });
    return ok(progress);
  } catch (error) {
    logger.error("Failed to create import job", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to create import job", "STORAGE_ERROR", 500));
  }
}

export async function getImportProgress(
  db: D1Database,
  namespace: string,
  slug: string,
  logger: Logger,
): Promise<Result<ImportProgress | null, AppError>> {
  try {
    const row = await db
      .prepare(
        "SELECT * FROM import_jobs WHERE namespace = ? AND slug = ? ORDER BY started_at DESC LIMIT 1",
      )
      .bind(namespace, slug)
      .first<ImportJobRow>();

    if (!row) {
      return ok(null);
    }

    return ok(rowToImportProgress(row));
  } catch (error) {
    logger.error("Failed to get import progress", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to get import progress", "STORAGE_ERROR", 500));
  }
}

/**
 * Atomic update with optimistic locking.
 * Uses version check in WHERE clause to prevent race conditions.
 *
 * @throws VersionConflictError if version mismatch detected (another update occurred)
 */
async function atomicUpdateImportProgress(
  db: D1Database,
  namespace: string,
  slug: string,
  updates: Partial<ImportProgress>,
  expectedVersion: number,
  logger: Logger,
): Promise<ImportProgress> {
  // First, get the existing record
  const existingResult = await getImportProgress(db, namespace, slug, logger);
  if (!existingResult.success) {
    throw existingResult.error;
  }

  const existing = existingResult.data;
  if (!existing) {
    throw new AppError("Import job not found", "NOT_FOUND", 404);
  }

  // Merge progress updates
  const updatedProgress = {
    ...existing.progress,
    ...updates.progress,
  };

  // Merge logs with limit
  const updatedLogs = [...existing.logs, ...(updates.logs || [])].slice(-MAX_LOGS);

  // Merge errors with limit
  const updatedErrors = [...existing.errors, ...(updates.errors || [])].slice(-MAX_ERRORS);

  // Perform atomic update with version check
  // The WHERE clause ensures we only update if version hasn't changed
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE import_jobs SET
        status = COALESCE(?, status),
        progress_processed_files = ?,
        progress_total_files = ?,
        progress_current_file = ?,
        logs = ?,
        errors = ?,
        completed_at = ?,
        version = version + 1,
        updated_at = ?
      WHERE namespace = ? AND slug = ? AND version = ?`,
    )
    .bind(
      updates.status ?? null,
      updatedProgress.processedFiles,
      updatedProgress.totalFiles ?? null,
      updatedProgress.currentFile ?? null,
      JSON.stringify(updatedLogs),
      JSON.stringify(updatedErrors),
      updates.completedAt ?? null,
      now,
      namespace,
      slug,
      expectedVersion,
    )
    .run();

  // Check if update actually modified a row
  // If meta.changes is 0, the version didn't match (conflict)
  const changes = result.meta?.changes ?? 0;
  if (changes === 0) {
    // Fetch current version for error details
    const currentResult = await getImportProgress(db, namespace, slug, logger);
    const actualVersion =
      currentResult.success && currentResult.data ? currentResult.data.version : -1;

    throw new VersionConflictError(
      `Version conflict: expected ${expectedVersion}, found ${actualVersion}`,
      expectedVersion,
      actualVersion,
    );
  }

  // Fetch and return the updated record
  const updatedResult = await getImportProgress(db, namespace, slug, logger);
  if (!updatedResult.success || !updatedResult.data) {
    throw new AppError("Failed to fetch updated import progress", "STORAGE_ERROR", 500);
  }

  return updatedResult.data;
}

/**
 * Update import progress with optimistic locking and automatic retry.
 *
 * Race condition protection:
 * - Uses version field for optimistic locking
 * - Atomically checks version in SQL WHERE clause
 * - Retries with exponential backoff on version conflicts
 * - Guarantees only one concurrent update succeeds
 *
 * @param db - D1 database instance
 * @param namespace - Project namespace
 * @param slug - Project slug
 * @param updates - Partial updates to apply
 * @param logger - Logger instance
 * @param retryCount - Current retry attempt (internal use)
 * @returns Result with updated ImportProgress or error
 */
export async function updateImportProgress(
  db: D1Database,
  namespace: string,
  slug: string,
  updates: Partial<ImportProgress>,
  logger: Logger,
  retryCount = 0,
): Promise<Result<ImportProgress, AppError>> {
  // Get current state to determine expected version
  const existingResult = await getImportProgress(db, namespace, slug, logger);
  if (!existingResult.success) {
    return existingResult;
  }

  const existing = existingResult.data;
  if (!existing) {
    return err(new AppError("Import job not found", "NOT_FOUND", 404));
  }

  const expectedVersion = existing.version;

  try {
    const updated = await atomicUpdateImportProgress(
      db,
      namespace,
      slug,
      updates,
      expectedVersion,
      logger,
    );

    if (retryCount > 0) {
      logger.debug("Import progress update succeeded after retry", {
        namespace,
        slug,
        retries: retryCount,
      });
    }

    return ok(updated);
  } catch (error) {
    // Handle version conflicts with retry
    if (error instanceof VersionConflictError) {
      if (retryCount >= MAX_RETRIES) {
        logger.error("Max retries exceeded for import progress update", undefined, {
          namespace,
          slug,
          retries: retryCount,
          expectedVersion: error.expectedVersion,
          actualVersion: error.actualVersion,
        });
        return err(
          new AppError(
            `Concurrent update conflict: max retries (${MAX_RETRIES}) exceeded`,
            "CONFLICT",
            409,
          ),
        );
      }

      // Calculate exponential backoff delay with jitter
      const delay = BASE_RETRY_DELAY_MS * 2 ** retryCount + Math.random() * 10;
      logger.debug("Version conflict detected, retrying with backoff", {
        namespace,
        slug,
        retryCount,
        delay: Math.round(delay),
        expectedVersion: error.expectedVersion,
        actualVersion: error.actualVersion,
      });

      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, delay));

      // Retry the update (logs/errors will be re-merged with latest state)
      return updateImportProgress(db, namespace, slug, updates, logger, retryCount + 1);
    }

    // Handle other errors
    if (error instanceof AppError) {
      return err(error);
    }

    logger.error("Failed to update import progress", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to update import progress", "STORAGE_ERROR", 500));
  }
}

/**
 * Outcome of an id-scoped update. A lost optimistic-locking race is a normal,
 * expected result for a background sweep — another writer legitimately owns the
 * job — so it is reported as an outcome rather than an error.
 */
export type ImportUpdateOutcome =
  | { updated: true; job: ImportProgress }
  | { updated: false; reason: "version-conflict" | "not-found" };

/**
 * Update one specific import job, identified by its primary key.
 *
 * `updateImportProgress` resolves its target through `getImportProgress`, which
 * is `ORDER BY started_at DESC LIMIT 1` — the newest job for a namespace/slug.
 * That is correct for the request paths that own the current import, but wrong
 * for any caller that has already selected a specific row: a project
 * accumulates an `import_jobs` row per sync, so the newest row is frequently
 * not the one the caller chose. Its `WHERE namespace = ? AND slug = ? AND
 * version = ?` can also match several sibling rows at once, since fresh rows
 * all start at version 1.
 *
 * Scoping to `id` makes the update hit exactly the intended row (id is the
 * primary key) and makes the version check a true compare-and-swap.
 *
 * Unlike `updateImportProgress` this does not retry on conflict: a caller that
 * lost the race no longer holds a current view of the job, and for the stall
 * sweep a conflict means the job is being actively worked on — precisely the
 * case where it must not interfere.
 */
export async function updateImportProgressById(
  db: D1Database,
  id: string,
  expectedVersion: number,
  updates: Partial<ImportProgress>,
  logger: Logger,
): Promise<Result<ImportUpdateOutcome, AppError>> {
  const existingResult = await getImportById(db, id, logger);
  if (!existingResult.success) {
    return existingResult;
  }

  const existing = existingResult.data;
  if (!existing) {
    return ok({ updated: false, reason: "not-found" });
  }

  const updatedProgress = { ...existing.progress, ...updates.progress };
  const updatedLogs = [...existing.logs, ...(updates.logs || [])].slice(-MAX_LOGS);
  const updatedErrors = [...existing.errors, ...(updates.errors || [])].slice(-MAX_ERRORS);

  try {
    const result = await db
      .prepare(
        `UPDATE import_jobs SET
          status = COALESCE(?, status),
          progress_processed_files = ?,
          progress_total_files = ?,
          progress_current_file = ?,
          logs = ?,
          errors = ?,
          completed_at = COALESCE(?, completed_at),
          version = version + 1,
          updated_at = ?
        WHERE id = ? AND version = ?`,
      )
      .bind(
        updates.status ?? null,
        updatedProgress.processedFiles,
        updatedProgress.totalFiles ?? null,
        updatedProgress.currentFile ?? null,
        JSON.stringify(updatedLogs),
        JSON.stringify(updatedErrors),
        updates.completedAt ?? null,
        new Date().toISOString(),
        id,
        expectedVersion,
      )
      .run();

    if ((result.meta?.changes ?? 0) === 0) {
      return ok({ updated: false, reason: "version-conflict" });
    }

    const refreshed = await getImportById(db, id, logger);
    if (!refreshed.success) {
      return refreshed;
    }
    if (!refreshed.data) {
      return err(new AppError("Import job vanished after update", "STORAGE_ERROR", 500));
    }

    return ok({ updated: true, job: refreshed.data });
  } catch (error) {
    logger.error(
      "Failed to update import progress by id",
      error instanceof Error ? error : undefined,
      { importId: id },
    );
    return err(new AppError("Failed to update import progress", "STORAGE_ERROR", 500));
  }
}

/**
 * Delete one specific import job by primary key.
 *
 * Distinct from `deleteImportJob`, which removes *every* row for a
 * namespace/slug — correct for the cancellation path that tears down a
 * project's import state, but far too broad for a user deleting a single
 * finished job. Wiping the history would also strip the depth record that
 * `getLatestImportDepth` reads, silently downgrading the project's next sync to
 * `DEFAULT_CLONE_DEPTH`.
 *
 * @returns whether a row was actually removed
 */
export async function deleteImportJobById(
  db: D1Database,
  id: string,
  allowedStatuses: readonly ImportStatus[],
  logger: Logger,
): Promise<Result<boolean, AppError>> {
  try {
    // The status is re-checked here rather than trusted from the caller's
    // earlier read: between that read and this delete the job can be re-queued
    // by a retry, and removing a row a consumer has just picked up would orphan
    // a live import.
    const placeholders = allowedStatuses.map(() => "?").join(", ");
    const result = await db
      .prepare(`DELETE FROM import_jobs WHERE id = ? AND status IN (${placeholders})`)
      .bind(id, ...allowedStatuses)
      .run();
    const deleted = (result.meta?.changes ?? 0) > 0;

    logger.debug("Import job delete by id", { importId: id, deleted });
    return ok(deleted);
  } catch (error) {
    logger.error("Failed to delete import job by id", error instanceof Error ? error : undefined, {
      importId: id,
    });
    return err(new AppError("Failed to delete import job", "STORAGE_ERROR", 500));
  }
}

export async function updateImportStatus(
  db: D1Database,
  namespace: string,
  slug: string,
  status: ImportStatus,
  logger: Logger,
  message?: string,
): Promise<Result<ImportProgress, AppError>> {
  // Validate status
  try {
    validateStatus(status);
  } catch (error) {
    if (error instanceof AppError) {
      return err(error);
    }
    throw error;
  }

  const updates: Partial<ImportProgress> = { status };

  if (status === "completed" || status === "failed" || status === "cancelled") {
    updates.completedAt = new Date().toISOString();
  }

  if (message) {
    updates.logs = [
      {
        message,
        level: status === "failed" ? "error" : "info",
        timestamp: new Date().toISOString(),
      },
    ];
  }

  return updateImportProgress(db, namespace, slug, updates, logger);
}

export async function cancelImportJob(
  db: D1Database,
  namespace: string,
  slug: string,
  logger: Logger,
): Promise<Result<ImportProgress, AppError>> {
  logger.info("Cancelling import job", { namespace, slug });

  const progressResult = await getImportProgress(db, namespace, slug, logger);
  if (!progressResult.success) {
    return progressResult;
  }

  if (!progressResult.data) {
    return err(new AppError("Import job not found", "NOT_FOUND", 404));
  }

  const progress = progressResult.data;

  // Can only cancel if not already completed/failed/cancelled
  if (["completed", "failed", "cancelled"].includes(progress.status)) {
    return err(
      new AppError(`Cannot cancel import with status: ${progress.status}`, "INVALID_STATE", 400),
    );
  }

  // If already cancelling (no active worker to complete it), finalize immediately.
  if (progress.status === "cancelling") {
    return updateImportStatus(db, namespace, slug, "cancelled", logger, "Import cancelled");
  }

  return updateImportStatus(
    db,
    namespace,
    slug,
    "cancelling",
    logger,
    "Import cancellation requested",
  );
}

export async function isImportCancelled(
  db: D1Database,
  namespace: string,
  slug: string,
  logger: Logger,
): Promise<boolean> {
  const progressResult = await getImportProgress(db, namespace, slug, logger);
  if (!progressResult.success || !progressResult.data) {
    return false;
  }
  // `cancelled` counts, not just `cancelling`. The stall sweep terminalises a
  // quiet `cancelling` job, and a consumer that was merely slow rather than
  // dead would otherwise see a status it does not recognise as a cancellation,
  // take its failure branch instead, overwrite `cancelled` with `failed`, email
  // the user about a failure they never had, and — on the sync path — call
  // msg.retry(), restarting the very work they cancelled.
  return progressResult.data.status === "cancelling" || progressResult.data.status === "cancelled";
}

export async function deleteImportJob(
  db: D1Database,
  namespace: string,
  slug: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare("DELETE FROM import_jobs WHERE namespace = ? AND slug = ?")
      .bind(namespace, slug)
      .run();

    logger.debug("Import job deleted", { namespace, slug });
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to delete import job", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to delete import job", "STORAGE_ERROR", 500));
  }
}

export async function listActiveImports(
  db: D1Database,
  logger: Logger,
): Promise<Result<ImportProgress[], AppError>> {
  try {
    const { results } = await db
      .prepare(
        `SELECT * FROM import_jobs 
         WHERE status IN ('queued', 'cloning', 'processing', 'cancelling')
         ORDER BY started_at DESC`,
      )
      .all<ImportJobRow>();

    const imports = (results || []).map(rowToImportProgress);
    return ok(imports);
  } catch (error) {
    logger.error("Failed to list active imports", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to list active imports", "STORAGE_ERROR", 500));
  }
}

/**
 * Cleanup old completed imports
 * Should be called periodically (e.g., via cron trigger)
 * @param db D1 database instance
 * @param olderThanDays Delete imports completed more than this many days ago (default: 7)
 * @param logger Logger instance
 */
export async function cleanupOldImports(
  db: D1Database,
  olderThanDays: number,
  logger: Logger,
): Promise<Result<number, AppError>> {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    // The newest job per project is retained regardless of age — deliberately
    // "newest", not "newest finished", because that is precisely the row
    // `getLatestImportDepth` selects (ORDER BY started_at DESC LIMIT 1, no
    // status filter). Protecting a different row than the reader reads would
    // let the clone depth be pruned out from under it, silently re-deriving
    // DEFAULT_CLONE_DEPTH and turning a full-history project into a shallow
    // clone. Depth propagates forward — each sync writes the depth it read onto
    // the row it creates — so keeping the newest row keeps the depth reachable.
    // Only finished rows are candidates, so an in-flight job is never at risk.
    const result = await db
      .prepare(
        `DELETE FROM import_jobs
         WHERE completed_at IS NOT NULL
         AND completed_at < ?
         AND id NOT IN (
           SELECT id FROM import_jobs AS newest
           WHERE newest.namespace = import_jobs.namespace
             AND newest.slug = import_jobs.slug
           ORDER BY newest.started_at DESC
           LIMIT 1
         )`,
      )
      .bind(cutoffDate.toISOString())
      .run();

    const deletedCount = result.meta?.changes ?? 0;
    logger.info("Cleaned up old import jobs", { deletedCount, olderThanDays });
    return ok(deletedCount);
  } catch (error) {
    logger.error("Failed to cleanup old imports", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to cleanup old imports", "STORAGE_ERROR", 500));
  }
}

/**
 * Get import by ID (for admin/debugging purposes)
 */
export async function getImportById(
  db: D1Database,
  id: string,
  logger: Logger,
): Promise<Result<ImportProgress | null, AppError>> {
  try {
    const row = await db
      .prepare("SELECT * FROM import_jobs WHERE id = ?")
      .bind(id)
      .first<ImportJobRow>();

    if (!row) {
      return ok(null);
    }

    return ok(rowToImportProgress(row));
  } catch (error) {
    logger.error("Failed to get import by ID", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to get import by ID", "STORAGE_ERROR", 500));
  }
}

/**
 * Detect and recover from stalled imports.
 * Imports that have been in 'cloning' or 'processing' state for too long
 * are likely stuck and should be marked as failed.
 *
 * @param db D1 database instance
 * @param namespace Project namespace
 * @param slug Project slug
 * @param maxStallMs Maximum time allowed in active state before considered stalled (default: 5 minutes)
 * @param logger Logger instance
 * @returns Result indicating if the import was recovered (marked as failed)
 */
export async function recoverStalledImport(
  db: D1Database,
  namespace: string,
  slug: string,
  maxStallMs: number,
  logger: Logger,
): Promise<Result<boolean, AppError>> {
  try {
    const row = await db
      .prepare(
        // The cutoff is an ISO string, not `datetime('now', ?)`: `updated_at`
        // stores `new Date().toISOString()`, and TEXT comparison puts an ISO
        // value after a same-day `datetime()` value ('T' > ' '). Comparing the
        // two formats made this predicate false for every row until the UTC
        // date rolled over, so on-demand recovery silently never fired.
        `SELECT * FROM import_jobs
         WHERE namespace = ? AND slug = ?
         AND status IN ('cloning', 'processing', 'syncing', 'cancelling')
         AND updated_at < ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(namespace, slug, new Date(Date.now() - maxStallMs).toISOString())
      .first<ImportJobRow>();

    if (!row) {
      return ok(false); // No stalled import found
    }

    const targetStatus = row.status === "cancelling" ? "cancelled" : "failed";

    logger.warn(`Detected stalled import, marking as ${targetStatus}`, {
      namespace,
      slug,
      importId: row.id,
      status: row.status,
      updatedAt: row.updated_at,
    });

    // Written by id, not by namespace+slug. The SELECT above picks the stalest
    // matching row, but `updateImportProgress` re-resolves its target through
    // `getImportProgress` (ORDER BY started_at DESC) — the NEWEST row for the
    // project. A project owns one row per sync, so those are routinely
    // different rows, and the namespace-scoped write would fail a healthy
    // in-flight job while leaving the wedged one exactly as it was.
    const now = new Date().toISOString();
    const updateResult = await updateImportProgressById(
      db,
      row.id,
      row.version,
      {
        status: targetStatus,
        completedAt: now,
        ...(targetStatus === "failed"
          ? {
              errors: [
                {
                  file: "_import",
                  error: `Import stalled: no progress for longer than ${Math.round(maxStallMs / 1000)} seconds. This may indicate a network issue or timeout with the git provider.`,
                  timestamp: now,
                },
              ],
            }
          : {}),
      },
      logger,
    );

    if (!updateResult.success) {
      return err(updateResult.error);
    }

    if (!updateResult.data.updated) {
      // Another writer owns the row (or it has since been removed) — the job is
      // not abandoned after all, so recovery correctly stands down.
      logger.debug("Stalled import was updated elsewhere, skipping recovery", {
        namespace,
        slug,
        importId: row.id,
        reason: updateResult.data.reason,
      });
      return ok(false);
    }

    logger.info("Successfully recovered stalled import", {
      namespace,
      slug,
      importId: row.id,
    });
    return ok(true);
  } catch (error) {
    logger.error("Failed to recover stalled import", error instanceof Error ? error : undefined, {
      namespace,
      slug,
    });
    return err(new AppError("Failed to recover stalled import", "STORAGE_ERROR", 500));
  }
}
