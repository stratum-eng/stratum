/**
 * Metrics Dashboard API
 * Admin endpoint for viewing import metrics
 */

import { Hono } from "hono";
import { getMetricsSummary, getQueueDepth } from "../storage/metrics";
import type { Env } from "../types";
import { isAdminRequest } from "../utils/admin";
import { createLogger } from "../utils/logger";
import { internalError, ok, unauthorized } from "../utils/response";

const app = new Hono<{ Bindings: Env }>();

async function isAdmin(c: {
  env: Env;
  req: { header: (name: string) => string | undefined };
  get: <T>(key: string) => T | undefined;
}): Promise<boolean> {
  const logger = createLogger({ component: "MetricsAdmin" });
  return isAdminRequest(
    c.env,
    {
      ...(c.req.header("X-Admin-API-Key") !== undefined
        ? { adminApiKeyHeader: c.req.header("X-Admin-API-Key") }
        : {}),
      ...(c.get<string>("userId") !== undefined ? { userId: c.get<string>("userId") } : {}),
    },
    logger,
  );
}

// GET /api/admin/metrics - Get import metrics dashboard data
app.get("/", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  // Check admin access
  const hasAccess = await isAdmin(c);
  if (!hasAccess) {
    return unauthorized("Admin access required");
  }

  logger.info("Metrics dashboard requested");

  // Get metrics summary
  const summaryResult = await getMetricsSummary(c.env.DB, logger);
  if (!summaryResult.success) {
    logger.error("Failed to get metrics summary", summaryResult.error);
    return internalError("Failed to retrieve metrics");
  }

  // Get current queue depth
  const queueDepthResult = await getQueueDepth(c.env.DB, logger);
  if (!queueDepthResult.success) {
    logger.error("Failed to get queue depth", queueDepthResult.error);
    return internalError("Failed to retrieve queue depth");
  }

  // Get queue metrics from IMPORT_QUEUE if available
  let queueMetrics: {
    backlogCount: number;
    backlogBytes: number;
    oldestMessageAge?: number;
  } | null = null;
  if (c.env.IMPORT_QUEUE) {
    try {
      const metrics = await c.env.IMPORT_QUEUE.metrics();
      queueMetrics = {
        backlogCount: metrics.backlogCount,
        backlogBytes: metrics.backlogBytes,
        oldestMessageAge: metrics.oldestMessageTimestamp
          ? Math.round((Date.now() - metrics.oldestMessageTimestamp.getTime()) / 1000)
          : undefined,
      };
    } catch (error) {
      logger.warn("Failed to get queue metrics from IMPORT_QUEUE", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const summary = summaryResult.data;
  const queueDepth = queueDepthResult.data;

  const response = {
    timestamp: new Date().toISOString(),

    // Overall stats
    totals: {
      started: summary.totalStarted,
      completed: summary.totalCompleted,
      failed: summary.totalFailed,
      cancelled: summary.totalCancelled,
    },

    // Success rates
    rates: {
      success: summary.successRate,
      failure: summary.failureRate,
    },

    // Performance
    performance: {
      averageDurationMs: summary.averageDurationMs,
      averageDurationFormatted: formatDuration(summary.averageDurationMs),
    },

    // Time windows
    timeWindows: {
      last24h: summary.last24h,
      last7d: summary.last7d,
      last30d: summary.last30d,
    },

    // Queue status
    queue: {
      activeImports: queueDepth,
      ...(queueMetrics && {
        backlogCount: queueMetrics.backlogCount,
        backlogBytes: queueMetrics.backlogBytes,
        oldestMessageAgeSeconds: queueMetrics.oldestMessageAge,
      }),
    },

    // Error breakdown
    errors: {
      byType: summary.errorTypes,
      totalRecentErrors: summary.errorTypes.reduce((sum, e) => sum + e.count, 0),
    },
  };

  logger.info("Metrics dashboard served", {
    totalStarted: summary.totalStarted,
    totalFailed: summary.totalFailed,
    queueDepth,
  });

  return ok(response);
});

// GET /api/admin/metrics/health - Quick health check with key metrics
app.get("/health", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  // Check admin access
  const hasAccess = await isAdmin(c);
  if (!hasAccess) {
    return unauthorized("Admin access required");
  }

  try {
    // Get recent failure count
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const failuresResult = await c.env.DB.prepare(
      `SELECT COUNT(*) as count
         FROM import_metrics
         WHERE metric_type = 'import_failed'
         AND recorded_at >= ?`,
    )
      .bind(last24h)
      .first<{ count: number }>();

    const queueDepthResult = await getQueueDepth(c.env.DB, logger);

    const response = {
      status: "ok",
      timestamp: new Date().toISOString(),
      recentFailures24h: failuresResult?.count || 0,
      activeImports: queueDepthResult.success ? queueDepthResult.data : 0,
    };

    return ok(response);
  } catch (error) {
    logger.error("Failed to get health metrics", error instanceof Error ? error : undefined);
    return internalError("Failed to retrieve health metrics");
  }
});

/**
 * Format duration in milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60 * 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  if (ms < 60 * 60 * 1000) {
    return `${(ms / (60 * 1000)).toFixed(1)}m`;
  }
  return `${(ms / (60 * 60 * 1000)).toFixed(1)}h`;
}

export const metricsRouter = app;
