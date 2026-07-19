import { Hono } from "hono";
import { type EventActor, emitEvent } from "../queue/events";
import {
  artifactsRepoNameFromRemote,
  cloneRepo,
  commitAndPush,
  freshRepoToken,
  stageWorkspaceTree,
} from "../storage/git-ops";
import {
  deleteWorkspace,
  getProjectById,
  getProjectByPath,
  getWorkspace,
  listWorkspaces,
  setWorkspace,
} from "../storage/state";
import type { Env } from "../types";
import { getArtifactsRepoName } from "../types";
import { canReadProject, canWriteProject, canWriteWorkspace } from "../utils/authz";
import { createLogger } from "../utils/logger";
import {
  badRequest,
  created,
  forbidden,
  internalError,
  notFound,
  ok,
  unauthorized,
} from "../utils/response";
import { isStringRecord, isValidSlug } from "../utils/validation";

const app = new Hono<{ Bindings: Env }>();

// POST /projects/:namespace/:slug/workspaces - Create a workspace
app.post("/:namespace/:slug/workspaces", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentId = c.get("agentId");
  const agentOwnerId = c.get("agentOwnerId");
  if (!userId && !agentId) return unauthorized("Authentication required");

  const { namespace, slug } = c.req.param();

  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") {
      return notFound("Project", `${namespace}/${slug}`);
    }
    logger.error("Failed to get project", projectResult.error);
    return badRequest(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!(await canWriteProject(c.env.DB, project, userId, agentOwnerId)))
    return forbidden("Project access denied");

  const body = await c.req.json<{ name?: unknown }>().catch(() => ({ name: undefined }));
  const workspaceName = isValidSlug(body.name) ? body.name : `ws-${Date.now()}`;

  // Get the Artifacts repo using the namespaced name
  const artifactsRepoName = getArtifactsRepoName(namespace, slug);
  const projectRepo = await c.env.ARTIFACTS.get(artifactsRepoName);
  const forked = await projectRepo.fork(workspaceName);

  const setResult = await setWorkspace(
    c.env.STATE,
    project.id, // Use project ID as namespace
    {
      name: workspaceName,
      remote: forked.remote,
      parent: project.id, // Store project ID instead of name
      createdAt: new Date().toISOString(),
      branchName: workspaceName, // Artifacts fork name IS the branch ref
      // Record the owning principal so write-authz can restrict push/commit to
      // the creator (or a project admin). For an agent, the effective owner is
      // its owning user; the agent id is kept as provenance only.
      createdByUserId: userId ?? agentOwnerId,
      ...(agentId !== undefined ? { createdByAgentId: agentId } : {}),
    },
    logger,
  );

  if (!setResult.success) {
    logger.error("Failed to set workspace", setResult.error);
    return badRequest(setResult.error.message);
  }

  logger.info("Workspace created", { workspaceName, namespace, slug, projectId: project.id });

  const actor: EventActor = agentId
    ? { type: "agent", id: agentId }
    : { type: "user", ...(userId !== undefined ? { id: userId } : {}) };
  await emitEvent(
    c.env.DB,
    c.env.EVENTS_QUEUE,
    { type: "workspace.created", project: project.name, workspace: workspaceName },
    actor,
    logger,
    project.id,
  );

  return created({
    workspace: workspaceName,
    remote: forked.remote,
    namespace,
    slug,
    path: `/${namespace}/${slug}/workspaces/${workspaceName}`,
  });
});

// GET /projects/:namespace/:slug/workspaces - List workspaces
app.get("/:namespace/:slug/workspaces", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { namespace, slug } = c.req.param();

  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") {
      return notFound("Project", `${namespace}/${slug}`);
    }
    logger.error("Failed to get project", projectResult.error);
    return badRequest(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId)))
    return notFound("Project", `${project.namespace}/${project.slug}`);

  const workspacesResult = await listWorkspaces(c.env.STATE, project.id, logger);
  if (!workspacesResult.success) {
    logger.error("Failed to list workspaces", workspacesResult.error);
    return badRequest(workspacesResult.error.message);
  }

  logger.info("Workspaces listed", {
    namespace,
    slug,
    projectId: project.id,
    count: workspacesResult.data.length,
  });
  return ok({
    namespace,
    slug,
    path: `/${namespace}/${slug}`,
    workspaces: workspacesResult.data.map(({ name, createdAt }) => ({
      name,
      createdAt,
      path: `/${namespace}/${slug}/workspaces/${name}`,
    })),
  });
});

// POST /workspaces/:workspaceName/commit - Commit changes
// Note: Workspaces are still identified by name since they're scoped by project
app.post("/:name/commit", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentId = c.get("agentId");
  const agentOwnerId = c.get("agentOwnerId");
  if (!userId && !agentId) return unauthorized("Authentication required");

  const { name: workspaceName } = c.req.param();

  const body = await c.req.json<{ files?: unknown; message?: unknown; projectId?: unknown }>();
  if (!isStringRecord(body.files))
    return badRequest("files must be an object of string paths to string contents");
  if (typeof body.message !== "string" || !body.message.trim())
    return badRequest("message is required");
  if (typeof body.projectId !== "string") return badRequest("projectId is required");

  const workspaceResult = await getWorkspace(c.env.STATE, body.projectId, workspaceName, logger);
  if (!workspaceResult.success) {
    if (workspaceResult.error.code === "NOT_FOUND") {
      return notFound("Workspace", workspaceName);
    }
    logger.error("Failed to get workspace", workspaceResult.error);
    return badRequest(workspaceResult.error.message);
  }
  const workspace = workspaceResult.data;

  // Authorization: resolve the project from the workspace's authoritative parent
  // id (never trust the body's projectId for authz beyond the KV lookup key), and
  // require BOTH project-level write and workspace-level write (creator or admin).
  // Any failure collapses to the same 404 as a missing workspace so an
  // unauthorized caller cannot distinguish "denied" from "does not exist".
  const projectResult = await getProjectById(c.env.STATE, workspace.parent, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") return notFound("Workspace", workspaceName);
    logger.error("Failed to resolve project for commit authz", projectResult.error);
    return badRequest(projectResult.error.message);
  }
  const project = projectResult.data;

  const canWriteProj = await canWriteProject(c.env.DB, project, userId, agentOwnerId);
  const canWriteWs = await canWriteWorkspace(c.env.DB, project, workspace, userId, agentOwnerId);
  if (!canWriteProj || !canWriteWs) {
    logger.warn("Commit denied — insufficient workspace write access", {
      workspaceName,
      projectId: project.id,
    });
    return notFound("Workspace", workspaceName);
  }

  // Committing clones then pushes to the workspace fork. Mint a fresh write token.
  const tokenResult = await freshRepoToken(c.env.ARTIFACTS, workspace.remote, "write", logger);
  if (!tokenResult.success) {
    logger.error("Failed to mint workspace token", tokenResult.error);
    return internalError(tokenResult.error.message);
  }
  const workspaceToken = tokenResult.data;

  const cloneResult = await cloneRepo(workspace.remote, workspaceToken, logger);
  if (!cloneResult.success) {
    logger.error("Failed to clone repo", cloneResult.error);
    return badRequest(cloneResult.error.message);
  }

  const { fs, dir } = cloneResult.data;
  const commitResult = await commitAndPush(
    fs,
    dir,
    workspace.remote,
    workspaceToken,
    body.files,
    body.message,
    logger,
  );
  if (!commitResult.success) {
    logger.error("Failed to commit and push", commitResult.error);
    return badRequest(commitResult.error.message);
  }

  // Stage the tip tree to R2 for the fetch-free merge path (ADR 004). Best-effort:
  // a staging failure must not fail the commit — the merge falls back to the cold
  // path when no staged tree is present.
  if (c.env.REPO_DO_ENABLED === "true" && c.env.REPO_OBJECTS) {
    const stageResult = await stageWorkspaceTree(
      c.env.REPO_OBJECTS,
      `repos/${project.id}/ws/${workspaceName}`,
      fs,
      dir,
      commitResult.data,
      logger,
    );
    if (!stageResult.success) {
      logger.warn("Failed to stage workspace tree to R2; merge will use cold path", {
        workspaceName,
      });
    } else if (c.env.REPO_DO) {
      // Also seed the per-repo DO's local hot index so the batch-merge path reads
      // staged trees from SQLite (microseconds) instead of R2 (~30ms/change).
      const stub = c.env.REPO_DO.get(c.env.REPO_DO.idFromName(project.id)) as unknown as {
        stageTree(workspace: string, value: ArrayBuffer): Promise<void>;
      };
      await stub
        .stageTree(workspaceName, stageResult.data.value.buffer as ArrayBuffer)
        .catch((error) => {
          logger.warn("Failed to seed DO hot index; batch merge will skip this change", {
            workspaceName,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }

  logger.info("Changes committed", { workspaceName, commit: commitResult.data });
  return ok({
    workspace: workspaceName,
    commit: commitResult.data,
    filesChanged: Object.keys(body.files),
  });
});

app.post("/:name/merge", (c) => {
  return c.json(
    {
      error:
        "This endpoint is deprecated. Use POST /api/projects/:namespace/:slug/changes instead.",
    },
    410,
  );
});

// DELETE /workspaces/:name - Delete a workspace
app.delete("/:name", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentId = c.get("agentId");
  const agentOwnerId = c.get("agentOwnerId");
  if (!userId && !agentId) return unauthorized("Authentication required");

  const { name: workspaceName } = c.req.param();

  // Get projectId from query param
  const projectId = c.req.query("projectId");
  if (!projectId) {
    return badRequest("projectId query parameter is required");
  }

  const workspaceResult = await getWorkspace(c.env.STATE, projectId, workspaceName, logger);
  if (!workspaceResult.success) {
    if (workspaceResult.error.code === "NOT_FOUND") {
      return notFound("Workspace", workspaceName);
    }
    logger.error("Failed to get workspace", workspaceResult.error);
    return badRequest(workspaceResult.error.message);
  }
  const workspace = workspaceResult.data;

  // Authorization: same rule as commit — resolve the project from the workspace's
  // authoritative parent id and require project-write AND workspace-write (creator
  // or admin). Failures collapse to a 404 (no leak of existence/ownership).
  const projectResult = await getProjectById(c.env.STATE, workspace.parent, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") return notFound("Workspace", workspaceName);
    logger.error("Failed to resolve project for delete authz", projectResult.error);
    return badRequest(projectResult.error.message);
  }
  const project = projectResult.data;

  const canWriteProj = await canWriteProject(c.env.DB, project, userId, agentOwnerId);
  const canWriteWs = await canWriteWorkspace(c.env.DB, project, workspace, userId, agentOwnerId);
  if (!canWriteProj || !canWriteWs) {
    logger.warn("Delete denied — insufficient workspace write access", {
      workspaceName,
      projectId: project.id,
    });
    return notFound("Workspace", workspaceName);
  }

  // Delete the Artifacts fork by its remote-derived repo name (the workspace name
  // is NOT the Artifacts repo id). If the remote isn't a recognizable Artifacts
  // host, skip the delete rather than blindly deleting a bare name.
  const artifactsRepoName = artifactsRepoNameFromRemote(workspace.remote);
  if (artifactsRepoName) {
    await c.env.ARTIFACTS.delete(artifactsRepoName).catch((err: unknown) => {
      logger.warn(`[workspaces] Failed to delete Artifacts repo "${artifactsRepoName}"`, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  } else {
    logger.warn("[workspaces] Skipping Artifacts delete — remote is not an Artifacts host", {
      workspaceName,
      remote: workspace.remote,
    });
  }

  const deleteResult = await deleteWorkspace(c.env.STATE, projectId, workspaceName, logger);
  if (!deleteResult.success) {
    logger.error("Failed to delete workspace", deleteResult.error);
    return badRequest(deleteResult.error.message);
  }

  logger.info("Workspace deleted", { workspaceName, projectId });
  return ok({ deleted: true, workspace: workspaceName });
});

export { app as workspacesRouter };
