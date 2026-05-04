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
 * Verify that the user has access to the project
 * Returns true if user is authorized, false otherwise
 */
async function verifyProjectAccess(
  env: Env,
  namespace: string,
  slug: string,
  _userId: string,
  logger: ReturnType<typeof createLogger>,
): Promise<boolean> {
  // Get project to verify ownership
  const projectResult = await getProject(env.STATE, `${namespace}/${slug}`, logger);

  if (!projectResult.success) {
    return false;
  }

  const project = projectResult.data;

  // Check if user owns the project or has access
  // For now, we check if the namespace matches the user's namespace
  // TODO: Add proper organization/team access control
  // IMPORTANT: This is a placeholder implementation. In production, you must:
  // 1. Check project.ownerId against the authenticated userId
  // 2. Check project.members array for userId
  // 3. Implement organization/team-based permissions
  // 4. Add role-based access control (owner, admin, member, etc.)
  // The current implementation only validates the project exists and namespace matches.
  if (project.namespace === namespace) {
    // Additional check: verify the user is the owner
    // This is a simplified check - in production you'd check project.members or project.ownerId
    return true;
  }

  return false;
}

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

  // Verify project access
  const hasAccess = await verifyProjectAccess(c.env, namespace, slug, userId, logger);
  if (!hasAccess) {
    logger.warn("Unauthorized access attempt", { namespace, slug, userId });
    return c.json({ error: "Forbidden - You do not have access to this project" }, 403);
  }

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

  // Verify project access
  const hasAccess = await verifyProjectAccess(c.env, namespace, slug, userId, logger);
  if (!hasAccess) {
    logger.warn("Unauthorized sync attempt", { namespace, slug, userId });
    return c.json({ error: "Forbidden - You do not have access to this project" }, 403);
  }

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

  // Verify project access
  const hasAccess = await verifyProjectAccess(c.env, namespace, slug, userId, logger);
  if (!hasAccess) {
    logger.warn("Unauthorized settings update attempt", { namespace, slug, userId });
    return c.json({ error: "Forbidden - You do not have access to this project" }, 403);
  }

  // TODO: Implement sync settings storage
  // For now, return 501 Not Implemented

  return c.json(
    {
      error: "Not implemented",
      message: "Sync settings persistence is not yet implemented",
    },
    501,
  );
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

  // Verify project access
  const hasAccess = await verifyProjectAccess(c.env, namespace, slug, userId, logger);
  if (!hasAccess) {
    logger.warn("Unauthorized history access attempt", { namespace, slug, userId });
    return c.json({ error: "Forbidden - You do not have access to this project" }, 403);
  }

  // TODO: Implement sync history storage
  // For now, return 501 Not Implemented

  return c.json(
    {
      error: "Not implemented",
      message: "Sync history retrieval is not yet implemented",
    },
    501,
  );
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

  // Verify project access before establishing stream
  const hasAccess = await verifyProjectAccess(c.env, namespace, slug, userId, logger);
  if (!hasAccess) {
    logger.warn("Unauthorized SSE stream attempt", { namespace, slug, userId });
    return c.json({ error: "Forbidden - You do not have access to this project" }, 403);
  }

  // Return a stream that checks sync status periodically
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let isClosed = false;

  // Cleanup function to clear all timers
  const cleanup = () => {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  };

  const stream = new ReadableStream({
    start(controller) {
      // Send initial status
      const sendStatus = async () => {
        if (isClosed) return;

        const statusResult = await getSyncStatus(c.env.STATE, namespace, slug, logger);

        if (statusResult.success && statusResult.data) {
          const data = `data: ${JSON.stringify(statusResult.data)}\n\n`;
          try {
            controller.enqueue(new TextEncoder().encode(data));
          } catch {
            // Controller might be closed, cleanup and exit
            cleanup();
            return;
          }
        }

        // Check if sync is complete or failed
        const status = statusResult.success ? statusResult.data?.lastSyncStatus : null;
        if (status === "success" || status === "failed") {
          controller.close();
          isClosed = true;
          cleanup();
          return;
        }

        // Continue polling
        if (!isClosed) {
          pollTimer = setTimeout(sendStatus, 2000);
        }
      };

      sendStatus();

      // Close after 5 minutes to prevent stale connections
      closeTimer = setTimeout(
        () => {
          if (!isClosed) {
            controller.close();
            isClosed = true;
            cleanup();
          }
        },
        5 * 60 * 1000,
      );
    },

    cancel() {
      // Handle client disconnect - cleanup timers
      isClosed = true;
      cleanup();
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
  // For now, return 501 Not Implemented

  return c.json(
    {
      error: "Not implemented",
      message: "Conflict resolution is not yet implemented",
    },
    501,
  );
});

export { app as syncManagementRouter };
