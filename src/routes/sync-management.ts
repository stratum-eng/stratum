import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";
import { resolveConflict } from "../storage/git-ops";
import { getProject, getProjectByPath, getWorkspace, setProject } from "../storage/state";
import {
  checkForSyncUpdates,
  getSyncHistory,
  getSyncStatus,
  recordSyncHistory,
  setSyncSettings,
  updateProjectAfterSync,
} from "../storage/sync";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";
import { notFound, ok } from "../utils/response";

const app = new Hono<{ Bindings: Env }>();

// Apply auth middleware
app.use("*", authMiddleware);

/**
 * Determines whether the caller is authorized to access the project identified by `namespace/slug`.
 *
 * Currently authorization succeeds only when the project exists and its `namespace` equals the requested `namespace`; storage failures or missing projects result in `false`.
 *
 * @param _userId - The authenticated user's ID (currently unused; reserved for future permission checks)
 * @returns `true` if access is allowed, `false` otherwise.
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
 * GET /projects/:namespace/:slug/sync/status
 * Get detailed sync status for a project
 */
app.get("/projects/:namespace/:slug/sync/status", async (c) => {
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
    // Storage failure - return 500
    logger.error("Failed to get sync status", statusResult.error, { namespace, slug });
    return c.json({ error: "Failed to get sync status", message: statusResult.error.message }, 500);
  }

  if (statusResult.data === null) {
    // Status not found - return 404
    return notFound("Project sync status", `${namespace}/${slug}`);
  }

  return ok(statusResult.data);
});

/**
 * POST /projects/:namespace/:slug/sync
 * Trigger a sync check and potentially sync if updates available
 */
app.post("/projects/:namespace/:slug/sync", async (c) => {
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
    // Propagate the error status code from the underlying error (e.g., 400 for INVALID_STATE)
    const statusCode = (checkResult.error.statusCode || 500) as 400 | 401 | 403 | 404 | 500 | 502;
    return c.json(
      {
        error: "Failed to check for updates",
        message: checkResult.error.message,
        code: checkResult.error.code,
      },
      statusCode,
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
 * POST /projects/:namespace/:slug/sync/settings
 * Update sync settings (auto-sync, frequency)
 */
app.post("/projects/:namespace/:slug/sync/settings", async (c) => {
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

  const settingsResult = await setSyncSettings(
    c.env.STATE,
    namespace,
    slug,
    {
      autoSyncEnabled: body.autoSyncEnabled,
      syncFrequency: body.syncFrequency,
    },
    logger,
  );
  if (!settingsResult.success) {
    logger.error("Failed to persist sync settings", settingsResult.error);
    return c.json({ error: "Failed to save sync settings" }, 500);
  }

  // Mirror autoSyncEnabled onto ProjectEntry so the scheduled runner picks it up.
  // syncFrequency is intentionally NOT mirrored — the runner reads the sync-status blob.
  if (body.autoSyncEnabled !== undefined) {
    const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
    if (projectResult.success) {
      const project = projectResult.data;
      await setProject(c.env.STATE, { ...project, autoSyncEnabled: body.autoSyncEnabled }, logger);
    }
  }

  logger.info("Sync settings saved", { namespace, slug });
  return c.json({
    success: true,
    autoSyncEnabled: body.autoSyncEnabled,
    syncFrequency: body.syncFrequency,
  });
});

/**
 * GET /projects/:namespace/:slug/sync/history
 * Get sync history for a project
 */
app.get("/projects/:namespace/:slug/sync/history", async (c) => {
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

  const rawLimit = Number(c.req.query("limit") ?? "50");
  const rawOffset = Number(c.req.query("offset") ?? "0");
  const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
  const offset = Number.isFinite(rawOffset) ? rawOffset : 0;

  const history = await getSyncHistory(c.env.DB, namespace, slug, limit, offset, logger);
  logger.debug("Sync history retrieved", { namespace, slug, count: history.length });
  return c.json({ history });
});

/**
 * GET /projects/:namespace/:slug/sync/stream
 * Server-Sent Events endpoint for real-time sync updates
 */
app.get("/projects/:namespace/:slug/sync/stream", async (c) => {
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

        // Handle storage failure - stop the SSE loop
        if (!statusResult.success) {
          logger.error("SSE: Failed to get sync status, closing stream", statusResult.error, {
            namespace,
            slug,
          });
          const errorData = `data: ${JSON.stringify({ error: "Failed to get sync status", message: statusResult.error.message })}\n\n`;
          try {
            controller.enqueue(new TextEncoder().encode(errorData));
          } catch {
            // Controller might already be closed
          }
          controller.close();
          isClosed = true;
          cleanup();
          return;
        }

        // Handle not found case
        if (statusResult.data === null) {
          logger.warn("SSE: Sync status not found, closing stream", { namespace, slug });
          const errorData = `data: ${JSON.stringify({ error: "Sync status not found" })}\n\n`;
          try {
            controller.enqueue(new TextEncoder().encode(errorData));
          } catch {
            // Controller might already be closed
          }
          controller.close();
          isClosed = true;
          cleanup();
          return;
        }

        // Send the status data
        const data = `data: ${JSON.stringify(statusResult.data)}\n\n`;
        try {
          controller.enqueue(new TextEncoder().encode(data));
        } catch {
          // Controller might be closed, cleanup and exit
          cleanup();
          return;
        }

        // Check if sync is complete or failed
        const status = statusResult.data.lastSyncStatus;
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
 * POST /projects/conflicts/:id/resolve
 * Resolve a merge conflict by applying a strategy and committing the result.
 */
app.post("/projects/conflicts/:id/resolve", async (c) => {
  const userId = c.get("userId");
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const conflictId = c.req.param("id");

  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
    userId,
  });

  // Read conflict context from KV
  const conflictRaw = await c.env.STATE.get(`conflict:${conflictId}`);
  if (!conflictRaw) {
    return c.json({ error: "Conflict not found or already resolved", code: "GONE" }, 410);
  }

  let conflictCtx: {
    conflictId: string;
    namespace: string;
    slug: string;
    workspaceName: string;
    conflictingFiles: string[];
    detectedAt: string;
  };
  try {
    conflictCtx = JSON.parse(conflictRaw);
  } catch {
    logger.error("Corrupt conflict context in KV", undefined, { conflictId });
    return c.json({ error: "Corrupt conflict context" }, 500);
  }

  const body: { strategy?: unknown; resolutions?: unknown } = await c.req
    .json<{ strategy?: unknown; resolutions?: unknown }>()
    .catch(() => ({ strategy: undefined, resolutions: undefined }));

  const VALID_STRATEGIES = ["accept-project", "accept-workspace", "manual"] as const;
  type Strategy = (typeof VALID_STRATEGIES)[number];

  if (!body.strategy || !VALID_STRATEGIES.includes(body.strategy as Strategy)) {
    return c.json(
      { error: "Invalid strategy. Must be 'accept-project', 'accept-workspace', or 'manual'" },
      400,
    );
  }

  const strategy = body.strategy as Strategy;

  if (strategy === "manual") {
    if (!Array.isArray(body.resolutions) || body.resolutions.length === 0) {
      return c.json({ error: "manual strategy requires a non-empty resolutions array" }, 400);
    }
    for (const r of body.resolutions as Array<{ file?: unknown; content?: unknown }>) {
      if (typeof r.file !== "string" || typeof r.content !== "string") {
        return c.json(
          { error: "Each resolution must have string 'file' and 'content' fields" },
          400,
        );
      }
      if ((r.file as string).includes("../") || (r.file as string).startsWith("/")) {
        return c.json(
          {
            error: `Invalid file path: ${r.file} — path traversal is not allowed`,
            code: "INVALID_PATH",
          },
          422,
        );
      }
    }
  }

  // Re-fetch project and workspace for tokens — never use tokens from conflict context
  const projectResult = await getProjectByPath(
    c.env.STATE,
    conflictCtx.namespace,
    conflictCtx.slug,
    logger,
  );
  if (!projectResult.success) {
    return c.json({ error: "Project not found" }, 404);
  }
  const project = projectResult.data;

  const workspaceResult = await getWorkspace(
    c.env.STATE,
    project.id,
    conflictCtx.workspaceName,
    logger,
  );
  if (!workspaceResult.success) {
    return c.json({ error: "Workspace not found" }, 404);
  }
  const workspace = workspaceResult.data;

  logger.info("Resolving conflict", {
    conflictId,
    strategy,
    workspaceName: conflictCtx.workspaceName,
  });

  const startedAt = Date.now();
  const resolveResult = await resolveConflict(
    {
      projectRemote: project.remote,
      projectToken: project.token,
      workspaceRemote: workspace.remote,
      workspaceToken: workspace.token,
      strategy,
      conflictingFiles: conflictCtx.conflictingFiles,
      manualResolutions:
        strategy === "manual"
          ? (body.resolutions as Array<{ file: string; content: string }>)
          : undefined,
    },
    logger,
  );

  if (!resolveResult.success) {
    const status = resolveResult.error.statusCode === 401 ? 401 : 422;
    return c.json({ error: resolveResult.error.message, code: resolveResult.error.code }, status);
  }

  const { commitSha } = resolveResult.data;

  // Record history (non-throwing); delete conflict key regardless of history outcome
  await recordSyncHistory(
    c.env.DB,
    {
      namespace: conflictCtx.namespace,
      slug: conflictCtx.slug,
      trigger: "manual",
      status: "success",
      syncedCommit: commitSha,
      durationMs: Date.now() - startedAt,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
    },
    logger,
  );

  await c.env.STATE.delete(`conflict:${conflictId}`);

  logger.info("Conflict resolved", { conflictId, commitSha });
  return c.json({ status: "resolved", commitSha });
});

export { app as syncManagementRouter };
