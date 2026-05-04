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
    version: row.version,
    progress,
    errors: parseErrors(row.errors),
    logs: parseLogs(row.logs),
  };

  // Only add completedAt if it exists (exactOptionalPropertyTypes compliance)
  if (row.completed_at !== null && row.completed_at !== undefined) {
    result.completedAt = row.completed_at;
  }

  return result;
}

function validateStatus(status: string): ImportStatus {
  if (VALID_STATUSES.includes(status as ImportStatus)) {
    return status as ImportStatus;
  }
  throw new AppError(`Invalid import status: ${status}`, "INVALID_STATE", 400);
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

  try {
    await db
      .prepare(
        `INSERT INTO import_jobs (
          id, project_id, namespace, slug, status, source_url, branch,
          progress_processed_files, logs, errors, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        params.id,
        params.projectId,
        params.namespace,
        params.slug,
        "queued",
        params.sourceUrl,
        params.branch,
        0,
        JSON.stringify(initialLog),
        "[]",
        1, // Initial version for optimistic locking
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
      startedAt: new Date().toISOString(),
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
        updated_at = CURRENT_TIMESTAMP
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
  return progressResult.data.status === "cancelling";
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

    const result = await db
      .prepare(
        `DELETE FROM import_jobs 
         WHERE completed_at IS NOT NULL 
         AND completed_at < ?`,
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
