import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

// Metric types for import tracking
export type ImportMetricType =
  | "import_started"
  | "import_completed"
  | "import_failed"
  | "import_cancelled"
  | "import_duration_ms"
  | "import_queue_depth";

export interface ImportMetric {
  id?: number;
  metricType: ImportMetricType;
  namespace?: string;
  slug?: string;
  value: number;
  recordedAt: string;
}

export interface ImportMetricsSummary {
  // Counts
  totalStarted: number;
  totalCompleted: number;
  totalFailed: number;
  totalCancelled: number;

  // Rates
  successRate: number; // percentage
  failureRate: number; // percentage

  // Duration
  averageDurationMs: number;

  // Time windows
  last24h: {
    started: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
  last7d: {
    started: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
  last30d: {
    started: number;
    completed: number;
    failed: number;
    cancelled: number;
  };

  // Error breakdown
  errorTypes: Array<{
    errorType: string;
    count: number;
  }>;
}

/**
 * Record an import metric
 */
export async function recordMetric(
  db: D1Database,
  metric: Omit<ImportMetric, "id" | "recordedAt">,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare(
        `INSERT INTO import_metrics (metric_type, namespace, slug, value, recorded_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      )
      .bind(metric.metricType, metric.namespace ?? null, metric.slug ?? null, metric.value)
      .run();

    logger.debug("Import metric recorded", {
      type: metric.metricType,
      namespace: metric.namespace,
      slug: metric.slug,
      value: metric.value,
    });

    return ok(undefined);
  } catch (error) {
    logger.error("Failed to record import metric", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to record import metric", "STORAGE_ERROR", 500));
  }
}

/**
 * Record that an import was started
 */
export async function recordImportStarted(
  db: D1Database,
  namespace: string,
  slug: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  return recordMetric(
    db,
    {
      metricType: "import_started",
      namespace,
      slug,
      value: 1,
    },
    logger,
  );
}

/**
 * Record that an import was completed
 */
export async function recordImportCompleted(
  db: D1Database,
  namespace: string,
  slug: string,
  durationMs: number,
  logger: Logger,
): Promise<Result<void, AppError>> {
  // Record completion
  const completionResult = await recordMetric(
    db,
    {
      metricType: "import_completed",
      namespace,
      slug,
      value: 1,
    },
    logger,
  );

  if (!completionResult.success) {
    return completionResult;
  }

  // Record duration
  return recordMetric(
    db,
    {
      metricType: "import_duration_ms",
      namespace,
      slug,
      value: durationMs,
    },
    logger,
  );
}

/**
 * Record that an import failed
 */
export async function recordImportFailed(
  db: D1Database,
  namespace: string,
  slug: string,
  _errorType: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  return recordMetric(
    db,
    {
      metricType: "import_failed",
      namespace,
      slug,
      value: 1,
      // Store error type in a separate field if needed
      // For now, we'll track it in the failed_imports table
    },
    logger,
  );
}

/**
 * Record that an import was cancelled
 */
export async function recordImportCancelled(
  db: D1Database,
  namespace: string,
  slug: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  return recordMetric(
    db,
    {
      metricType: "import_cancelled",
      namespace,
      slug,
      value: 1,
    },
    logger,
  );
}

/**
 * Get metrics summary for a time period
 */
export async function getMetricsSummary(
  db: D1Database,
  logger: Logger,
): Promise<Result<ImportMetricsSummary, AppError>> {
  try {
    // Calculate time boundaries
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Get total counts
    const totalsResult = await db
      .prepare(
        `SELECT 
          metric_type,
          COUNT(*) as count
         FROM import_metrics
         WHERE metric_type IN ('import_started', 'import_completed', 'import_failed', 'import_cancelled')
         GROUP BY metric_type`,
      )
      .all<{ metric_type: ImportMetricType; count: number }>();

    if (!totalsResult.success) {
      throw new Error("Failed to fetch totals");
    }

    const totals = new Map<ImportMetricType, number>();
    for (const row of totalsResult.results || []) {
      totals.set(row.metric_type, row.count);
    }

    const totalStarted = totals.get("import_started") || 0;
    const totalCompleted = totals.get("import_completed") || 0;
    const totalFailed = totals.get("import_failed") || 0;
    const totalCancelled = totals.get("import_cancelled") || 0;

    // Get time-windowed counts
    const getWindowCounts = async (since: string) => {
      const result = await db
        .prepare(
          `SELECT 
            metric_type,
            COUNT(*) as count
           FROM import_metrics
           WHERE metric_type IN ('import_started', 'import_completed', 'import_failed', 'import_cancelled')
           AND recorded_at >= ?
           GROUP BY metric_type`,
        )
        .bind(since)
        .all<{ metric_type: ImportMetricType; count: number }>();

      const counts = new Map<ImportMetricType, number>();
      for (const row of result.results || []) {
        counts.set(row.metric_type, row.count);
      }

      return {
        started: counts.get("import_started") || 0,
        completed: counts.get("import_completed") || 0,
        failed: counts.get("import_failed") || 0,
        cancelled: counts.get("import_cancelled") || 0,
      };
    };

    const [counts24h, counts7d, counts30d] = await Promise.all([
      getWindowCounts(last24h),
      getWindowCounts(last7d),
      getWindowCounts(last30d),
    ]);

    // Calculate average duration
    const durationResult = await db
      .prepare(
        `SELECT AVG(value) as avg_duration
         FROM import_metrics
         WHERE metric_type = 'import_duration_ms'`,
      )
      .first<{ avg_duration: number | null }>();

    const averageDurationMs = Math.round(durationResult?.avg_duration || 0);

    // Get error breakdown from failed_imports table
    const errorTypesResult = await db
      .prepare(
        `SELECT 
          error_type,
          COUNT(*) as count
         FROM failed_imports
         WHERE created_at >= ?
         GROUP BY error_type
         ORDER BY count DESC
         LIMIT 10`,
      )
      .bind(last30d)
      .all<{ error_type: string; count: number }>();

    const errorTypes = (errorTypesResult.results || []).map((row) => ({
      errorType: row.error_type,
      count: row.count,
    }));

    // Calculate rates
    const totalFinished = totalCompleted + totalFailed + totalCancelled;
    const successRate = totalFinished > 0 ? Math.round((totalCompleted / totalFinished) * 100) : 0;
    const failureRate = totalFinished > 0 ? Math.round((totalFailed / totalFinished) * 100) : 0;

    const summary: ImportMetricsSummary = {
      totalStarted,
      totalCompleted,
      totalFailed,
      totalCancelled,
      successRate,
      failureRate,
      averageDurationMs,
      last24h: counts24h,
      last7d: counts7d,
      last30d: counts30d,
      errorTypes,
    };

    return ok(summary);
  } catch (error) {
    logger.error("Failed to get metrics summary", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to get metrics summary", "STORAGE_ERROR", 500));
  }
}

// ---------------------------------------------------------------------------
// Commit/merge hot-path metrics (ADR 004, Phase 0)
// ---------------------------------------------------------------------------

export type CommitOutcome = "fast_forward" | "cold_fallback" | "squash";

/** Per-phase wall-clock spans (ms). Undefined when a phase did not run. */
export interface CommitPhaseSpans {
  tokenMintMs?: number;
  projectCloneMs?: number;
  workspaceFetchMs?: number;
  mergeMs?: number;
  pushMs?: number;
  refAdvanceMs?: number;
  d1UpdateMs?: number;
  provenanceMs?: number;
}

export interface CommitMetricInput {
  project: string;
  /** Globally-unique project UUID; NULL on rows written before dual-write. */
  projectId?: string;
  changeId: string;
  outcome: CommitOutcome;
  /** Benchmark context; omit outside the load harness. */
  conflictMode?: "none" | "same";
  concurrencyN?: number;
  phases: CommitPhaseSpans;
  totalMs: number;
}

export interface PhaseStat {
  avg: number;
  p50: number;
  p95: number;
  count: number;
}

export interface CommitMetricsSummary {
  count: number;
  outcomes: Record<CommitOutcome, number>;
  total: PhaseStat;
  phases: Record<keyof CommitPhaseSpans, PhaseStat>;
}

const COMMIT_PHASE_COLUMNS: Array<[keyof CommitPhaseSpans, string]> = [
  ["tokenMintMs", "token_mint_ms"],
  ["projectCloneMs", "project_clone_ms"],
  ["workspaceFetchMs", "workspace_fetch_ms"],
  ["mergeMs", "merge_ms"],
  ["pushMs", "push_ms"],
  ["refAdvanceMs", "ref_advance_ms"],
  ["d1UpdateMs", "d1_update_ms"],
  ["provenanceMs", "provenance_ms"],
];

/** Map a PhaseTimer's raw spans to the typed phase fields (drops unknown keys). */
export function commitPhasesFromSpans(spans: Record<string, number>): CommitPhaseSpans {
  const out: CommitPhaseSpans = {};
  for (const [key] of COMMIT_PHASE_COLUMNS) {
    const value = spans[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Record one row of commit/merge phase timings. A single batched INSERT (not
 * one row per phase) keeps D1 write pressure to one statement per merge — D1 is
 * a single writer, so the hot path must not fan out writes.
 */
export async function recordCommitMetrics(
  db: D1Database,
  metric: CommitMetricInput,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare(
        `INSERT INTO commit_metrics (
          project, project_id, change_id, outcome, conflict_mode, concurrency_n,
          token_mint_ms, project_clone_ms, workspace_fetch_ms, merge_ms,
          push_ms, ref_advance_ms, d1_update_ms, provenance_ms, total_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        metric.project,
        metric.projectId ?? null,
        metric.changeId,
        metric.outcome,
        metric.conflictMode ?? null,
        metric.concurrencyN ?? null,
        metric.phases.tokenMintMs ?? null,
        metric.phases.projectCloneMs ?? null,
        metric.phases.workspaceFetchMs ?? null,
        metric.phases.mergeMs ?? null,
        metric.phases.pushMs ?? null,
        metric.phases.refAdvanceMs ?? null,
        metric.phases.d1UpdateMs ?? null,
        metric.phases.provenanceMs ?? null,
        metric.totalMs,
      )
      .run();

    return ok(undefined);
  } catch (error) {
    logger.error("Failed to record commit metric", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to record commit metric", "STORAGE_ERROR", 500));
  }
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length) - 1;
  const idx = Math.min(Math.max(rank, 0), sortedAsc.length - 1);
  return sortedAsc[idx] ?? 0;
}

function statOf(values: number[]): PhaseStat {
  const present = values.filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
  if (present.length === 0) return { avg: 0, p50: 0, p95: 0, count: 0 };
  const sorted = [...present].sort((a, b) => a - b);
  const sum = present.reduce((acc, v) => acc + v, 0);
  return {
    avg: Math.round((sum / present.length) * 100) / 100,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    count: present.length,
  };
}

interface CommitMetricRow {
  outcome: CommitOutcome;
  total_ms: number;
  token_mint_ms: number | null;
  project_clone_ms: number | null;
  workspace_fetch_ms: number | null;
  merge_ms: number | null;
  push_ms: number | null;
  ref_advance_ms: number | null;
  d1_update_ms: number | null;
  provenance_ms: number | null;
}

/**
 * Summarize recent commit metrics: per-phase avg/p50/p95 + outcome counts.
 * Percentiles are computed in JS over a bounded recent window rather than in
 * SQL (D1/SQLite has no native percentile and an unbounded scan would grow with
 * commit volume — exactly the high-frequency workload this measures).
 */
export async function getCommitMetrics(
  db: D1Database,
  logger: Logger,
  limit = 5000,
): Promise<Result<CommitMetricsSummary, AppError>> {
  try {
    const result = await db
      .prepare(
        `SELECT outcome, total_ms, token_mint_ms, project_clone_ms, workspace_fetch_ms,
                merge_ms, push_ms, ref_advance_ms, d1_update_ms, provenance_ms
         FROM commit_metrics
         ORDER BY recorded_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(limit)
      .all<CommitMetricRow>();

    const rows = result.results ?? [];

    const outcomes: Record<CommitOutcome, number> = {
      fast_forward: 0,
      cold_fallback: 0,
      squash: 0,
    };
    for (const row of rows) {
      if (row.outcome in outcomes) outcomes[row.outcome] += 1;
    }

    const phases = {} as Record<keyof CommitPhaseSpans, PhaseStat>;
    for (const [key, column] of COMMIT_PHASE_COLUMNS) {
      phases[key] = statOf(
        rows
          .map((r) => r[column as keyof CommitMetricRow] as number | null)
          .filter((v): v is number => v !== null),
      );
    }

    return ok({
      count: rows.length,
      outcomes,
      total: statOf(rows.map((r) => r.total_ms)),
      phases,
    });
  } catch (error) {
    logger.error("Failed to get commit metrics", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to get commit metrics", "STORAGE_ERROR", 500));
  }
}

/**
 * Get current queue depth (active imports)
 */
export async function getQueueDepth(
  db: D1Database,
  logger: Logger,
): Promise<Result<number, AppError>> {
  try {
    const result = await db
      .prepare(
        `SELECT COUNT(*) as count
         FROM import_jobs
         WHERE status IN ('queued', 'cloning', 'processing', 'cancelling')`,
      )
      .first<{ count: number }>();

    return ok(result?.count || 0);
  } catch (error) {
    logger.error("Failed to get queue depth", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to get queue depth", "STORAGE_ERROR", 500));
  }
}
