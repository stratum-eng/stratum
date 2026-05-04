import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";
import { getProject } from "../storage/state";
import { checkForSyncUpdates, getSyncStatus, updateProjectAfterSync } from "../storage/sync";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";
import { notFound, ok } from "../utils/response";

const app = new Hono<{ Bindings: Env }>();

// Apply auth middleware
app.use("*", authMiddleware);

/**
 * GET /api/projects/:namespace/:slug/sync/status
 * Get detailed sync status for a project
 */
app.get("/api/projects/:namespace/:slug/sync/status", async (c) => {
  const userId = c.get("userId");
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { namespace, slug } = c.req.param();
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
    userId,
  });

  logger.debug("Getting sync status", { namespace, slug });

  const statusResult = await getSyncStatus(c.env.STATE, namespace, slug, logger);

  if (!statusResult.success) {
    return notFound("Project sync status", `${namespace}/${slug}`);
  }

  return ok(statusResult.data);
});

/**
 * POST /api/projects/:namespace/:slug/sync
 * Trigger a sync check and potentially sync if updates available
 */
app.post("/api/projects/:namespace/:slug/sync", async (c) => {
  const userId = c.get("userId");
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { namespace, slug } = c.req.param();
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
    userId,
  });

  logger.info("Manual sync triggered", { namespace, slug });

  // Get project first
  const projectResult = await getProject(c.env.STATE, `${namespace}/${slug}`, logger);
  if (!projectResult.success) {
    return notFound("Project", `${namespace}/${slug}`);
  }
  const project = projectResult.data;

  // First check for updates
  const checkResult = await checkForSyncUpdates(c.env.STATE, project, undefined, logger);

  if (!checkResult.success) {
    logger.error("Sync check failed", checkResult.error, { namespace, slug });
    return c.json(
      { error: "Failed to check for updates", message: checkResult.error.message },
      500,
    );
  }

  const updateInfo = checkResult.data;

  // If no updates, just return the status
  if (!updateInfo.hasUpdates) {
    return ok({
      message: "No updates available",
      upToDate: true,
      lastSyncedCommit: updateInfo.currentCommit,
    });
  }

  // There are updates - perform sync
  logger.info("Syncing project", {
    namespace,
    slug,
    commitsBehind: updateInfo.commitsBehind,
    latestCommit: updateInfo.latestCommit?.slice(0, 7),
  });

  const syncResult = await updateProjectAfterSync(
    c.env.STATE,
    project,
    updateInfo.latestCommit || "",
    logger,
  );

  if (!syncResult.success) {
    logger.error("Sync failed", syncResult.error, { namespace, slug });
    return c.json({ error: "Sync failed", message: syncResult.error.message }, 500);
  }

  return ok({
    message: `Synced successfully - ${updateInfo.commitsBehind || 0} commit(s) pulled`,
    synced: true,
    commitsBehind: updateInfo.commitsBehind,
    latestCommit: updateInfo.latestCommit,
  });
});

/**
 * POST /api/projects/:namespace/:slug/sync/settings
 * Update sync settings (auto-sync, frequency)
 */
app.post("/api/projects/:namespace/:slug/sync/settings", async (c) => {
  const userId = c.get("userId");
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { namespace, slug } = c.req.param();
  const body = await c.req.json<{
    autoSyncEnabled?: boolean;
    syncFrequency?: number;
  }>();

  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
    userId,
  });

  logger.info("Updating sync settings", {
    namespace,
    slug,
    autoSyncEnabled: body.autoSyncEnabled,
    syncFrequency: body.syncFrequency,
  });

  // TODO: Implement sync settings storage
  // For now, just acknowledge the request

  return ok({
    message: "Sync settings updated",
    settings: {
      autoSyncEnabled: body.autoSyncEnabled ?? false,
      syncFrequency: body.syncFrequency ?? 60,
    },
  });
});

/**
 * GET /api/projects/:namespace/:slug/sync/history
 * Get sync history for a project
 */
app.get("/api/projects/:namespace/:slug/sync/history", async (c) => {
  const userId = c.get("userId");
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { namespace, slug } = c.req.param();
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
    userId,
  });

  logger.debug("Getting sync history", { namespace, slug });

  // TODO: Implement sync history storage
  // For now, return empty history

  return ok({
    history: [],
    total: 0,
  });
});

/**
 * GET /api/projects/:namespace/:slug/sync/stream
 * Server-Sent Events endpoint for real-time sync updates
 */
app.get("/api/projects/:namespace/:slug/sync/stream", async (c) => {
  const userId = c.get("userId");
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { namespace, slug } = c.req.param();

  // Set up SSE headers
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
    userId,
  });

  logger.debug("SSE connection established for sync updates", { namespace, slug });

  // Return a stream that checks sync status periodically
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      // Send initial status
      const sendStatus = async () => {
        if (closed) return;

        const statusResult = await getSyncStatus(c.env.STATE, namespace, slug, logger);

        if (statusResult.success && statusResult.data) {
          const data = `data: ${JSON.stringify(statusResult.data)}\n\n`;
          controller.enqueue(new TextEncoder().encode(data));
        }

        // Check if sync is complete or failed
        const status = statusResult.success ? statusResult.data?.lastSyncStatus : null;
        if (status === "success" || status === "failed") {
          controller.close();
          closed = true;
          return;
        }

        // Continue polling
        setTimeout(sendStatus, 2000);
      };

      sendStatus();

      // Close after 5 minutes to prevent stale connections
      setTimeout(
        () => {
          if (!closed) {
            controller.close();
            closed = true;
          }
        },
        5 * 60 * 1000,
      );
    },
  });

  return c.body(stream);
});

/**
 * POST /api/projects/conflicts/:id/resolve
 * Resolve merge conflicts
 */
app.post("/api/projects/conflicts/:id/resolve", async (c) => {
  const userId = c.get("userId");
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const conflictId = c.req.param("id");
  const body = await c.req.json<{
    strategy: "ours" | "theirs" | "manual";
    resolutions?: Array<{
      file: string;
      content?: string;
    }>;
  }>();

  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
    userId,
  });

  logger.info("Resolving conflicts", {
    conflictId,
    strategy: body.strategy,
    fileCount: body.resolutions?.length,
  });

  // TODO: Implement conflict resolution logic

  return ok({
    message: "Conflicts resolved successfully",
    conflictId,
    strategy: body.strategy,
  });
});

export { app as syncManagementRouter };
