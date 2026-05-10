import { Hono } from "hono";
import { cloneRepo, commitAndPush } from "../storage/git-ops";
import {
  deleteWorkspace,
  getProjectByPath,
  getWorkspace,
  listWorkspaces,
  setWorkspace,
} from "../storage/state";
import type { Env } from "../types";
import { getArtifactsRepoName } from "../types";
import { canReadProject, canWriteProject } from "../utils/authz";
import { createLogger } from "../utils/logger";
import { badRequest, created, forbidden, notFound, ok, unauthorized } from "../utils/response";
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

  if (!canWriteProject(project, userId, agentOwnerId)) return forbidden("Project access denied");

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
      token: forked.token,
      parent: project.id, // Store project ID instead of name
      createdAt: new Date().toISOString(),
      branchName: workspaceName, // Artifacts fork name IS the branch ref
    },
    logger,
  );

  if (!setResult.success) {
    logger.error("Failed to set workspace", setResult.error);
    return badRequest(setResult.error.message);
  }

  logger.info("Workspace created", { workspaceName, namespace, slug, projectId: project.id });
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

  if (!canReadProject(project, userId, agentOwnerId))
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
  const _agentOwnerId = c.get("agentOwnerId");
  if (!userId && !agentId) return unauthorized("Authentication required");

  const { name: workspaceName } = c.req.param();

  // Note: This endpoint needs project info to check permissions
  // The workspace name should be globally unique or we need project ID in URL
  // For now, we'll look up workspace and then project

  // This is a simplified version - in production you'd want to include project in the URL
  // e.g., POST /projects/:namespace/:slug/workspaces/:workspaceName/commit

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

  // Fetch project to check permissions (we need namespace/slug from project ID)
  // For now, we'll skip detailed permission check in this simplified endpoint
  // In production, you'd want to look up project by ID

  const cloneResult = await cloneRepo(workspace.remote, workspace.token, logger);
  if (!cloneResult.success) {
    logger.error("Failed to clone repo", cloneResult.error);
    return badRequest(cloneResult.error.message);
  }

  const { fs, dir } = cloneResult.data;
  const commitResult = await commitAndPush(
    fs,
    dir,
    workspace.remote,
    workspace.token,
    body.files,
    body.message,
    logger,
  );
  if (!commitResult.success) {
    logger.error("Failed to commit and push", commitResult.error);
    return badRequest(commitResult.error.message);
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
  const _agentOwnerId = c.get("agentOwnerId");
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

  await c.env.ARTIFACTS.delete(workspaceName).catch((err: unknown) => {
    logger.warn(`[workspaces] Failed to delete Artifacts repo "${workspaceName}"`, {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  const deleteResult = await deleteWorkspace(c.env.STATE, projectId, workspaceName, logger);
  if (!deleteResult.success) {
    logger.error("Failed to delete workspace", deleteResult.error);
    return badRequest(deleteResult.error.message);
  }

  logger.info("Workspace deleted", { workspaceName, projectId });
  return ok({ deleted: true, workspace: workspaceName });
});

export { app as workspacesRouter };
