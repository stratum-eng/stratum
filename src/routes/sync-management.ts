import { Hono } from "hono";
import { llmProviderCatalog } from "../evaluation/llm-providers";
import { loadPolicy } from "../evaluation/policy-loader";
import { scanContentForSecrets } from "../evaluation/secret-scanner";
import { checkResolutionMergeProtection } from "../merge/protection";
import { authMiddleware } from "../middleware/auth";
import { billingContextFor, buildEvaluators, runEvaluation } from "../services/change-flow";
import { recordAudit } from "../storage/audit";
import { getChange } from "../storage/changes";
import { recordCosts, resolveBillingSubject } from "../storage/costs";
import {
  MAX_FILE_BYTES,
  buildManualResolutionDiff,
  freshRepoToken,
  resolveConflict,
} from "../storage/git-ops";
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
import { projectDefaultBranch, projectDisplayName } from "../types";
import { canWriteProject } from "../utils/authz";
import { getWaitUntil } from "../utils/execution-ctx";
import { createLogger } from "../utils/logger";
import { readJsonWithLimit } from "../utils/request-body";
import { notFound, ok } from "../utils/response";

const app = new Hono<{ Bindings: Env }>();

const MAX_SYNC_SETTINGS_BODY_BYTES = 1024 * 1024;
// Above the route's own per-file MAX_FILE_BYTES (10 MB), deliberately: a manual
// resolution may legitimately carry several files that large, and the generic
// 1 MiB default would reject them with an opaque 413 before the per-file check
// could answer 422 naming the offending file. Mirrors the workspace-commit
// route, whose ceiling likewise sits above the limit it actually enforces.
const MAX_CONFLICT_RESOLVE_BODY_BYTES = 32 * 1024 * 1024;

// Apply auth middleware
app.use("*", authMiddleware);

/**
 * Whether the caller may manage sync for `namespace/slug`. Sync mutates the
 * project, so this requires write access (owner, or org write/admin).
 */
async function verifyProjectAccess(
  env: Env,
  namespace: string,
  slug: string,
  userId: string,
  logger: ReturnType<typeof createLogger>,
): Promise<boolean> {
  const projectResult = await getProjectByPath(env.STATE, namespace, slug, logger);
  if (!projectResult.success) return false;
  return canWriteProject(env.DB, projectResult.data, userId);
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

  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
    userId,
  });

  const body = await readJsonWithLimit<{
    autoSyncEnabled?: boolean;
    syncFrequency?: number;
  }>(c, MAX_SYNC_SETTINGS_BODY_BYTES, logger);
  if (body instanceof Response) return body;

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
    // The Change whose merge attempt produced this conflict. Absent on entries
    // written before this field existed (KV entries expire after 7 days, so
    // this is a short-lived compatibility window, not a permanent case).
    changeId?: string;
  };
  try {
    conflictCtx = JSON.parse(conflictRaw);
  } catch {
    logger.error("Corrupt conflict context in KV", undefined, { conflictId });
    return c.json({ error: "Corrupt conflict context" }, 500);
  }

  const body = await readJsonWithLimit<{ strategy?: unknown; resolutions?: unknown }>(
    c,
    MAX_CONFLICT_RESOLVE_BODY_BYTES,
    logger,
  ).catch(() => ({ strategy: undefined, resolutions: undefined }));
  if (body instanceof Response) return body;

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

  // Resolving a conflict mints a write token and pushes a merge into the project
  // repo, so it requires project write access — not merely knowing the (unguessable
  // but leakable) conflict id. Collapse to 404 to avoid leaking existence.
  if (!(await canWriteProject(c.env.DB, project, userId))) {
    return c.json({ error: "Project not found" }, 404);
  }

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

  // The `manual` strategy commits caller-supplied file contents straight to the
  // project's default branch, which otherwise bypasses everything a normal
  // Change goes through. Run the mandatory, blocking secret scan first — it's
  // cheap relative to a full evaluator pass and the size guard ahead of it is
  // cheaper still — then (below, once tokens are minted) the project's full
  // evaluator suite and merge protection, so a resolution can't land content
  // no evaluator saw and no approver reviewed (#260, SA-5 follow-up).
  // accept-project / accept-workspace reuse already-committed, already-evaluated
  // trees (see the full-gate block below for why) and need none of this.
  if (strategy === "manual") {
    const resolutions = body.resolutions as Array<{ file: string; content: string }>;

    // Size first, because the scan below is the expensive step: it splits every
    // file and runs the full pattern set plus an entropy pass over each line.
    // resolveConflict enforces the same cap, but only after the scan has already
    // walked the content, so an oversized payload that is going to be rejected
    // anyway would burn the request's CPU budget on its way to that rejection.
    // Same limit and same 422 as the deeper check, so callers see no change.
    for (const { file, content } of resolutions) {
      if (new TextEncoder().encode(content).length > MAX_FILE_BYTES) {
        return c.json(
          { error: `File ${file} exceeds maximum size of 10 MB`, code: "INVALID_INPUT" },
          422,
        );
      }
    }

    // Scan the literal content, not a diff synthesised from it. Prefixing each
    // line with "+" is not reversible: a resolution line that already starts
    // with "++" would render as "+++…" and be skipped as a diff file header,
    // so a credential placed on such a line would reach main unscanned.
    const issues = scanContentForSecrets(resolutions);
    if (issues.length > 0) {
      logger.warn("Conflict resolution blocked by secret scan", {
        conflictId,
        issueCount: issues.length,
      });
      return c.json(
        {
          error: `Resolution rejected: ${issues[0]?.split(":")[0] ?? "secret detected"}`,
          code: "SECRET_DETECTED",
          issues,
        },
        422,
      );
    }
  }

  logger.info("Resolving conflict", {
    conflictId,
    strategy,
    workspaceName: conflictCtx.workspaceName,
  });

  // Conflict resolution clones the workspace fork (read) and pushes the merge to
  // the project (write). Mint both fresh; no token is persisted.
  const [projectToken, workspaceToken] = await Promise.all([
    freshRepoToken(c.env.ARTIFACTS, project.remote, "write", logger),
    freshRepoToken(c.env.ARTIFACTS, workspace.remote, "read", logger),
  ]);
  if (!projectToken.success) return c.json({ error: projectToken.error.message }, 502);
  if (!workspaceToken.success) return c.json({ error: workspaceToken.error.message }, 502);

  // One resolution for every billing site on this route. Both recording sites
  // and the manual path's meters attribute the same project, and for an
  // agent-owned one this is a `getAgent` D1 read — paid for once, and unable to
  // name two different payers for the same request.
  const billingSubject = await resolveBillingSubject(c.env.DB, logger, project);

  // Route a manual resolution through the same merge gate a normal Change goes
  // through: the project's configured evaluator suite, then merge protection
  // (required evaluators + required approvals), both run against the exact
  // content about to be committed — BEFORE resolveConflict pushes it.
  //
  // accept-project / accept-workspace are exempt: they re-stage content that
  // already exists, committed, on one side of the conflict (the project's own
  // HEAD, or the workspace fork) — content a Change already evaluated (or that
  // is already live on the default branch) on its way into this merge. `manual`
  // is the one strategy that introduces content no evaluator or approver has
  // ever seen, which is exactly what this gate exists to close.
  let manualResolutionAudit:
    | { conflictId: string; resolvedByUserId: string; evaluatedBaseSha: string; evalScore: number }
    | undefined;
  if (strategy === "manual") {
    const resolutions = body.resolutions as Array<{ file: string; content: string }>;
    const branch = projectDefaultBranch(project);

    const diffResult = await buildManualResolutionDiff(
      project.remote,
      projectToken.data,
      resolutions,
      branch,
      logger,
    );
    if (!diffResult.success) {
      logger.error("Failed to prepare manual resolution for evaluation", diffResult.error, {
        conflictId,
      });
      return c.json(
        { error: "Failed to prepare resolution for evaluation", code: "EVAL_PREP_FAILED" },
        502,
      );
    }
    const { diff, baseSha } = diffResult.data;

    const policy = await loadPolicy(
      project.remote,
      projectToken.data,
      logger,
      branch,
      llmProviderCatalog(c.env, logger),
    );
    // No workspace repo access is passed for the sandbox evaluator: the content
    // being judged here has no commit of its own yet — that's the point, it must
    // pass BEFORE resolveConflict creates one — so there is no ref a sandbox
    // could check out. A policy naming `sandbox` fails closed via
    // UnavailableEvaluator, same as any other missing prerequisite.
    const evaluators = await buildEvaluators(
      c.env,
      policy,
      project,
      logger,
      undefined,
      getWaitUntil(c),
    );
    // `buildManualResolutionDiff` resolved this base from the clone it built the
    // diff on, so it names the tree the resolution actually applies to (#274).
    // This path runs the LLM evaluator too, so it needs a payer as much as
    // change creation does.
    const { evalRuns, evalResult } = await runEvaluation(evaluators, diff, policy, logger, {
      baseSha,
      // The resolver is the actor: this route is user-credentialed, and PRD §4a
      // checks the allowance against the person who ran the suite.
      billing: billingContextFor(billingSubject, project.id, userId),
    });

    // Recorded here, BEFORE the verdict is acted on, because the spend is
    // already incurred: a resolution the suite rejects burned exactly the same
    // model tokens as one it accepts, and the early return below would drop
    // them. Mirrors the recording POST /changes/:id/evaluate does, with one
    // git_op rather than its pair — `buildManualResolutionDiff` cloned once.
    await recordCosts(
      c.env.DB,
      logger,
      {
        project: projectDisplayName(project),
        projectId: project.id,
        // The Change whose merge attempt produced this conflict, when the
        // conflict context named one — a resolution is part of landing it.
        ...(conflictCtx.changeId ? { changeId: conflictCtx.changeId } : {}),
        workspace: conflictCtx.workspaceName,
        ...(billingSubject ?? {}),
        notify: { env: c.env, actorUserId: userId, waitUntil: getWaitUntil(c) },
      },
      [{ kind: "git_ops", quantity: 1 }, ...evalRuns.flatMap(({ result }) => result.costs ?? [])],
    );

    if (!evalResult.passed) {
      logger.warn("Manual conflict resolution blocked by evaluator suite", {
        conflictId,
        evalScore: evalResult.score,
        evalReason: evalResult.reason,
      });
      return c.json(
        {
          error: `Resolution rejected: ${evalResult.reason}`,
          code: "EVALUATION_FAILED",
          issues: evalResult.issues ?? [],
        },
        422,
      );
    }

    // Approvals are checked against the Change whose merge attempt produced
    // this conflict, not a fresh review round on the resolution itself — see
    // checkResolutionMergeProtection's doc comment for why.
    let originatingChange: { id: string; createdByUserId?: string } | undefined;
    if (conflictCtx.changeId) {
      const changeResult = await getChange(c.env.DB, logger, conflictCtx.changeId);
      if (changeResult.success) {
        originatingChange = {
          id: changeResult.data.id,
          ...(changeResult.data.createdByUserId !== undefined
            ? { createdByUserId: changeResult.data.createdByUserId }
            : {}),
        };
      } else {
        // Best effort: a missing originating change (e.g. deleted) must not
        // crash the resolution — it falls through to checkResolutionMergeProtection
        // failing closed on any required approval, same as no changeId at all.
        logger.warn("Could not load originating change for resolution approvals", {
          conflictId,
          changeId: conflictCtx.changeId,
          error: changeResult.error.message,
        });
      }
    }

    const protectionResult = await checkResolutionMergeProtection(
      c.env.DB,
      logger,
      { diff, evalRuns, originatingChange },
      policy,
    );
    if (!protectionResult.success) {
      logger.error("Failed to evaluate merge protection for resolution", protectionResult.error, {
        conflictId,
      });
      return c.json({ error: protectionResult.error.message }, 500);
    }
    if (!protectionResult.data.allowed) {
      return c.json(
        {
          error: "Resolution blocked by branch protection",
          code: "PROTECTION_BLOCKED",
          reasons: protectionResult.data.reasons,
        },
        403,
      );
    }

    manualResolutionAudit = {
      conflictId,
      resolvedByUserId: userId,
      evaluatedBaseSha: baseSha,
      evalScore: evalResult.score,
    };
  }

  const startedAt = Date.now();
  const resolveResult = await resolveConflict(
    {
      projectRemote: project.remote,
      projectToken: projectToken.data,
      workspaceRemote: workspace.remote,
      workspaceToken: workspaceToken.data,
      strategy,
      branch: projectDefaultBranch(project),
      conflictingFiles: conflictCtx.conflictingFiles,
      manualResolutions:
        strategy === "manual"
          ? (body.resolutions as Array<{ file: string; content: string }>)
          : undefined,
    },
    logger,
  );

  // `resolveConflict` runs for EVERY strategy, so this is recorded here rather
  // than in the `manual` branch above, which only ever sees the evaluator
  // suite's spend. Without it, accept-project and accept-workspace resolutions
  // record nothing at all, and manual under-records the git work it paid for.
  //
  // Recorded before the failure branch below, for the same reason the manual
  // branch records before its 422: a resolution that clones and then fails to
  // push cost the operator what a successful one did, and a failure must not be
  // the cheap way to use the platform.
  //
  // The count is what the strategy WOULD do, not a measurement — `resolveConflict`
  // reports only a commit sha, so there is nothing to measure. It therefore
  // over-bills a resolution that dies before its first clone (a rejected token)
  // and is exact otherwise. Tolerable while `git_ops` maps to no meter
  // (`meterForCostKind`); if it ever gains one, `resolveConflict` has to report
  // the operations it actually completed rather than being guessed at here.
  const resolveGitOps = strategy === "accept-workspace" ? 3 : 2;
  await recordCosts(
    c.env.DB,
    logger,
    {
      project: projectDisplayName(project),
      projectId: project.id,
      ...(conflictCtx.changeId ? { changeId: conflictCtx.changeId } : {}),
      workspace: conflictCtx.workspaceName,
      ...(billingSubject ?? {}),
    },
    [{ kind: "git_ops", quantity: resolveGitOps }],
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

  // Provenance for a manual resolution commit: who resolved it, from which
  // conflict, and against which sha the evaluator suite ran (#260). Best-effort
  // by contract, same as recordSyncHistory above — an audit-log failure must
  // not undo an already-pushed, already-gated resolution.
  if (manualResolutionAudit) {
    await recordAudit(c.env.DB, logger, {
      action: "conflict.resolved_manually",
      actorType: "user",
      actorId: manualResolutionAudit.resolvedByUserId,
      subject: commitSha,
      detail: {
        conflictId: manualResolutionAudit.conflictId,
        project: `${conflictCtx.namespace}/${conflictCtx.slug}`,
        workspace: conflictCtx.workspaceName,
        evaluatedBaseSha: manualResolutionAudit.evaluatedBaseSha,
        evalScore: manualResolutionAudit.evalScore,
        commitSha,
      },
    });
  }

  logger.info("Conflict resolved", { conflictId, commitSha });
  return c.json({ status: "resolved", commitSha });
});

export { app as syncManagementRouter };
