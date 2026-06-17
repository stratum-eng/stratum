/**
 * Metrics Dashboard API
 * Admin endpoint for viewing import metrics and commit/merge phase metrics (ADR 004).
 */

import { Hono } from "hono";
import { blobObject, commitObject, treeObject } from "../storage/git-objects";
import {
  type BatchWorkspace,
  type NodeFS,
  batchMergeWorkspaces,
  cloneRepo,
  commitAndPush,
  initAndPush,
  mergeStagedCommits,
} from "../storage/git-ops";
import { getCommitMetrics, getMetricsSummary, getQueueDepth } from "../storage/metrics";
import { packObjects, placeLooseObject, unpackObjects } from "../storage/object-loader";
import { putObject } from "../storage/object-store";
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

// GET /api/admin/metrics - Get import + commit/merge metrics dashboard data
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

  // Commit/merge phase metrics (ADR 004). Best-effort: a failure here omits the
  // block rather than failing the whole dashboard.
  const commitMetricsResult = await getCommitMetrics(c.env.DB, logger);
  if (!commitMetricsResult.success) {
    logger.warn("Commit metrics unavailable; omitting from dashboard", {
      error: commitMetricsResult.error.message,
    });
  }
  const commits = commitMetricsResult.success ? commitMetricsResult.data : null;

  const response = {
    timestamp: new Date().toISOString(),

    ...(commits ? { commits } : {}),

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

// POST /api/admin/metrics/bench - Phase 2 throughput probe (ADR 004). Drives one
// R2 object write + group-commit ref advance through the RepoDO. Admin-only;
// intended to be hit concurrently by scripts/bench-commit-throughput.ts --r2-bench.
app.post("/bench", async (c) => {
  const logger = createLogger({ requestId: crypto.randomUUID(), path: c.req.path });
  if (!(await isAdmin(c))) return unauthorized("Admin access required");
  if (!c.env.REPO_DO) return internalError("REPO_DO not bound");

  if (!c.env.REPO_OBJECTS) return internalError("REPO_OBJECTS not bound");
  const repo = c.req.query("repo") ?? "bench-repo";
  const path = c.req.query("path") ?? "shared.txt";
  const bytes = Number.parseInt(c.req.query("bytes") ?? "256", 10);
  try {
    // Object plane: build + write the real git blob HERE, in the Worker — this
    // parallelizes across requests instead of serializing through the single DO.
    const content = crypto.getRandomValues(
      new Uint8Array(Math.max(1, Number.isFinite(bytes) ? bytes : 256)),
    );
    const blob = await blobObject(content);
    const put = await putObject(c.env.REPO_OBJECTS, blob.oid, blob.bytes, logger);
    if (!put.success) return internalError("object write failed");
    // Ref plane: only the advance hits the DO (group-commit batches it).
    const stub = c.env.REPO_DO.get(c.env.REPO_DO.idFromName(repo));
    await (
      stub as unknown as { benchAdvance(path: string, blobOid: string): Promise<{ ok: true }> }
    ).benchAdvance(path, blob.oid);
    return ok({ blob: blob.oid });
  } catch (error) {
    logger.error("bench commit failed", error instanceof Error ? error : undefined);
    return internalError("bench commit failed");
  }
});

// GET /api/admin/metrics/bench-stats?repo=... - read the bench DO's counters.
app.get("/bench-stats", async (c) => {
  if (!(await isAdmin(c))) return unauthorized("Admin access required");
  if (!c.env.REPO_DO) return internalError("REPO_DO not bound");
  const repo = c.req.query("repo") ?? "bench-repo";
  const stub = c.env.REPO_DO.get(c.env.REPO_DO.idFromName(repo));
  const stats = await (
    stub as unknown as {
      benchStats(): Promise<{
        head: string | undefined;
        batches: number;
        landed: number;
        conflictsResolved: number;
        treeSize: number;
      }>;
    }
  ).benchStats();
  return ok(stats);
});

// POST /api/admin/artifacts-bench - measure Cloudflare Artifacts' REAL single-repo
// ceiling with the group-commit pattern applied to Artifacts: warm-clone once, then
// land `batch` file-changes per push (one push per batch) sequentially through one
// authority. Serial warm-push rate is the ceiling a single-authority DO would hit.
// Decides whether owning the object store (ADR 004 Option A) is actually necessary.
app.post("/artifacts-bench", async (c) => {
  const logger = createLogger({ requestId: crypto.randomUUID(), path: c.req.path });
  if (!(await isAdmin(c))) return unauthorized("Admin access required");

  const iterations = clampInt(c.req.query("iterations"), 20, 1, 200);
  const batch = clampInt(c.req.query("batch"), 1, 1, 256);
  const bytes = clampInt(c.req.query("bytes"), 256, 1, 100_000);
  const name = `artifacts-bench-${crypto.randomUUID().slice(0, 8)}`;

  let repo: { remote: string; token: string };
  try {
    repo = await c.env.ARTIFACTS.create(name);
  } catch (error) {
    return internalError(
      `Artifacts create failed: ${error instanceof Error ? error.message : error}`,
    );
  }

  try {
    const seed = await initAndPush(
      repo.remote,
      repo.token,
      { "README.md": "bench\n" },
      "init",
      logger,
    );
    if (!seed.success) return internalError(`seed failed: ${seed.error.message}`);

    const cloneStart = Date.now();
    const cloned = await cloneRepo(repo.remote, repo.token, logger);
    if (!cloned.success) return internalError(`warm clone failed: ${cloned.error.message}`);
    const cloneMs = Date.now() - cloneStart;
    const { fs, dir } = cloned.data;

    const pushMs: number[] = [];
    const loopStart = Date.now();
    for (let i = 0; i < iterations; i++) {
      const changes: Record<string, string> = {};
      for (let b = 0; b < batch; b++)
        changes[`benchf${b}.txt`] = `i=${i} b=${b} ${"x".repeat(bytes)}`;
      const t0 = Date.now();
      const pushed = await commitAndPush(
        fs,
        dir,
        repo.remote,
        repo.token,
        changes,
        `c${i}`,
        logger,
      );
      if (!pushed.success) {
        return ok({ aborted: true, error: pushed.error.message, completed: i, pushMs });
      }
      pushMs.push(Date.now() - t0);
    }
    const totalMs = Date.now() - loopStart;
    const sorted = [...pushMs].sort((a, b) => a - b);
    const pct = (p: number) =>
      sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ??
      0;
    const round = (n: number) => Math.round(n * 100) / 100;

    return ok({
      iterations,
      batch,
      bytes,
      cloneMs,
      totalMs,
      pushLatencyMs: { p50: pct(50), p95: pct(95), p99: pct(99), min: sorted[0] ?? 0 },
      pushesPerSec: round(pushMs.length / (totalMs / 1000)),
      // One push lands `batch` logical commits -> effective single-repo commits/sec.
      effectiveCommitsPerSec: round((iterations * batch) / (totalMs / 1000)),
    });
  } finally {
    try {
      await c.env.ARTIFACTS.delete(name);
    } catch {
      // best-effort cleanup of the disposable bench repo
    }
  }
});

// POST /api/admin/metrics/realflow-bench?n=25 - ADR 004 Task 1 GATE. Sets up a
// project + N independent workspace forks (each base + one distinct-file commit),
// then runs ONE batched merge: clone once, fetch the N workspaces CONCURRENTLY,
// sequential 3-way merge, one push. Reports the fetch/merge/push breakdown so we
// can see if the read side (concurrent fetch) overlaps — the question that decides
// whether Option B on Artifacts is viable or we pivot to R2.
app.post("/realflow-bench", async (c) => {
  const logger = createLogger({ requestId: crypto.randomUUID(), path: c.req.path });
  if (!(await isAdmin(c))) return unauthorized("Admin access required");

  const n = clampInt(c.req.query("n"), 25, 1, 50);
  const created: string[] = [];
  const projectName = `realflow-p-${crypto.randomUUID().slice(0, 8)}`;

  try {
    const project = await c.env.ARTIFACTS.create(projectName);
    created.push(projectName);
    const seed = await initAndPush(
      project.remote,
      project.token,
      { "README.md": "base\n" },
      "base",
      logger,
    );
    if (!seed.success) return internalError(`seed failed: ${seed.error.message}`);

    // Setup (excluded from timings): N independent forks, each = base + 1 commit.
    const workspaces = await Promise.all(
      Array.from({ length: n }, async (_u, i): Promise<BatchWorkspace | null> => {
        const wsName = `realflow-w-${crypto.randomUUID().slice(0, 8)}`;
        const ws = await c.env.ARTIFACTS.create(wsName);
        created.push(wsName);
        const cloned = await cloneRepo(project.remote, project.token, logger);
        if (!cloned.success) return null;
        const pushed = await commitAndPush(
          cloned.data.fs,
          cloned.data.dir,
          ws.remote,
          ws.token,
          { [`f${i}.txt`]: `change ${i}\n` },
          `ws ${i}`,
          logger,
        );
        if (!pushed.success) return null;
        return { changeId: `c${i}`, remote: ws.remote, token: ws.token };
      }),
    );
    const ready = workspaces.filter((w): w is BatchWorkspace => w !== null);
    if (ready.length === 0) return internalError("workspace setup failed");

    const result = await batchMergeWorkspaces(project.remote, project.token, ready, logger);
    if (!result.success) return internalError(`batch merge failed: ${result.error.message}`);

    const { timings, landed, conflicted } = result.data;
    const round = (x: number) => Math.round(x * 100) / 100;
    return ok({
      n: ready.length,
      landed: landed.length,
      conflicted: conflicted.length,
      timings,
      // One batch of `landed` commits in `totalMs`: effective single-repo c/s.
      effectiveCommitsPerSec: round(landed.length / (timings.totalMs / 1000)),
      // If fetch overlapped, fetchMs ≈ one fetch, NOT n × one fetch.
      fetchMsPerWorkspace: round(timings.fetchMs / ready.length),
    });
  } catch (error) {
    return internalError(`realflow-bench: ${error instanceof Error ? error.message : error}`);
  } finally {
    for (const name of created) {
      try {
        await c.env.ARTIFACTS.delete(name);
      } catch {
        // best-effort cleanup
      }
    }
  }
});

// POST /api/admin/metrics/r2flow-bench?n=25 - ADR 004 Task 1c. The R2-fed real
// flow: stage N changes' objects to R2 (parallel), then clone the project once,
// load the staged objects FROM R2 (concurrent — the read side that avoids the
// connection-capped fork fetch), 3-way merge each, one push to Artifacts. Reports
// the clone/load/merge/push breakdown + c/s. Answers whether R2 reads overlap (1a)
// and whether the real flow clears the target (1c).
app.post("/r2flow-bench", async (c) => {
  const logger = createLogger({ requestId: crypto.randomUUID(), path: c.req.path });
  if (!(await isAdmin(c))) return unauthorized("Admin access required");
  if (!c.env.REPO_OBJECTS) return internalError("REPO_OBJECTS not bound");
  const bucket = c.env.REPO_OBJECTS;
  const n = clampInt(c.req.query("n"), 25, 1, 50);
  const projectName = `r2flow-${crypto.randomUUID().slice(0, 8)}`;

  try {
    const project = await c.env.ARTIFACTS.create(projectName);
    const baseBlob = await blobObject(new TextEncoder().encode("base\n"));
    const seed = await initAndPush(
      project.remote,
      project.token,
      { "README.md": "base\n" },
      "base",
      logger,
    );
    if (!seed.success) return internalError(`seed failed: ${seed.error.message}`);
    const baseCommitOid = seed.data;

    // Build + stage N changes. The diagnosis showed the load cost is R2 GET COUNT
    // (~21ms/get, not overlapping), NOT deflate — so stage each change's 3 objects
    // as ONE packed R2 value => N gets at load, not 3N.
    const packKey = (i: number) => `r2flowpack/${projectName}/${i}`;
    const staged: { commitOid: string; objectCount: number }[] = await Promise.all(
      Array.from({ length: n }, async (_u, i) => {
        const blob = await blobObject(new TextEncoder().encode(`change ${i}\n`));
        const tree = await treeObject([
          { mode: "100644", name: "README.md", oid: baseBlob.oid },
          { mode: "100644", name: `f${i}.txt`, oid: blob.oid },
        ]);
        const commit = await commitObject({
          tree: tree.oid,
          parents: [baseCommitOid],
          message: `change ${i}`,
          timestamp: 1700000000 + i,
        });
        await bucket.put(packKey(i), packObjects([blob, tree, commit]));
        return { commitOid: commit.oid, objectCount: 3 };
      }),
    );

    const objectsLoaded = staged.reduce((s, c) => s + c.objectCount, 0);
    let r2GetMs = 0;
    let placeMs = 0;
    const loadStaged = async (fs: NodeFS, gitdir: string) => {
      const getStart = Date.now();
      const packs = await Promise.all(
        staged.map(async (_s, i) => {
          const obj = await bucket.get(packKey(i));
          return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
        }),
      );
      r2GetMs = Date.now() - getStart;
      const placeStart = Date.now();
      for (const pack of packs) {
        if (!pack) continue;
        for (const { oid, bytes } of unpackObjects(pack)) {
          await placeLooseObject(fs, gitdir, oid, bytes);
        }
      }
      placeMs = Date.now() - placeStart;
    };

    const result = await mergeStagedCommits(
      project.remote,
      project.token,
      staged.map((s) => s.commitOid),
      loadStaged,
      logger,
    );
    if (!result.success) return internalError(`staged merge failed: ${result.error.message}`);

    const { timings, landed, conflicted } = result.data;
    const round = (x: number) => Math.round(x * 100) / 100;
    return ok({
      n,
      landed: landed.length,
      conflicted: conflicted.length,
      objectsLoaded,
      r2GetsAtLoad: staged.length,
      timings: { ...timings, r2GetMs, placeMs },
      loadBreakdown: {
        r2GetMsPerGet: round(r2GetMs / staged.length),
        placeMsPerObject: round(placeMs / objectsLoaded),
      },
      effectiveCommitsPerSec: round(landed.length / (timings.totalMs / 1000)),
    });
  } catch (error) {
    return internalError(`r2flow-bench: ${error instanceof Error ? error.message : error}`);
  } finally {
    try {
      await c.env.ARTIFACTS.delete(projectName);
      await Promise.all(
        Array.from({ length: n }, (_u, i) =>
          bucket.delete(`r2flowpack/${projectName}/${i}`).catch(() => {}),
        ),
      );
    } catch {
      // best-effort
    }
  }
});

function clampInt(raw: string | undefined, fallback: number, lo: number, hi: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

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
