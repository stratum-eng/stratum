import { Hono } from "hono";
import { getChange, listChanges } from "../storage/changes";
import { listEvalRuns } from "../storage/eval-runs";
import { getCommitLog, listFilesInRepo, readFileFromRepo } from "../storage/git-ops";
import { getImportProgress } from "../storage/imports";
import { getProject, getProjectByPath, listProjects, listWorkspaces } from "../storage/state";
import { getSyncStatus } from "../storage/sync";
import { getUser } from "../storage/users";
import type { Env } from "../types";
import { ChangeDetailPage } from "../ui/pages/change-detail";
import { ChangesPage } from "../ui/pages/changes";
import { HomePage } from "../ui/pages/home";
import { NewProjectPage } from "../ui/pages/new-project";
import { RepoPage } from "../ui/pages/repo";
import { SyncPage } from "../ui/pages/sync";
import { WorkspacesPage } from "../ui/pages/workspaces";
import { canReadProject, filterReadableProjects } from "../utils/authz";
import { createLogger } from "../utils/logger";
import { isValidNamespace, isValidSlug } from "../utils/validation";

const app = new Hono<{ Bindings: Env }>();

// Helper to get current user info
async function getCurrentUser(
  c: { get: (key: "userId") => string | undefined; env: { DB: D1Database } },
  logger: ReturnType<typeof createLogger>,
): Promise<{ id: string; email: string; username: string } | null> {
  const userId = c.get("userId");
  if (!userId) return null;
  const result = await getUser(c.env.DB, userId, logger);
  if (!result.success) return null;

  const user = result.data;
  // Username is always present - enforced by database schema and validation
  return { id: user.id, email: user.email, username: user.username };
}

// GET / — Dashboard (list projects)
app.get("/", async (c) => {
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({
    path: c.req.path,
    userId,
  });

  const [userResult, allProjectsResult] = await Promise.all([
    getCurrentUser(c, logger),
    listProjects(c.env.STATE, logger),
  ]);

  if (!allProjectsResult.success) {
    logger.error("Failed to list projects", allProjectsResult.error);
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Error loading projects. Please try again.
      </div>,
      500,
    );
  }

  const user = userResult;
  const projects = filterReadableProjects(allProjectsResult.data, userId, agentOwnerId);
  const view = projects.map((p) => ({
    name: p.name,
    namespace: p.namespace,
    slug: p.slug,
    remote: p.remote,
    createdAt: p.createdAt,
    ...(p.visibility !== undefined ? { visibility: p.visibility } : {}),
  }));

  logger.debug("Rendering home page", { projectCount: view.length });
  return c.html(<HomePage projects={view} user={user} />);
});

// GET /new — New project form
app.get("/new", async (c) => {
  const logger = createLogger({
    path: c.req.path,
    userId: c.get("userId"),
  });

  const user = await getCurrentUser(c, logger);
  if (!user) {
    logger.debug("User not authenticated, redirecting to login");
    return c.redirect("/auth/email");
  }

  logger.debug("Rendering new project page");
  return c.html(<NewProjectPage user={user} />);
});

// GET /p/:name — Repo view (files + commit log) - DEPRECATED: Use /:namespace/:slug
app.get("/p/:name", async (c) => {
  const { name } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({
    path: c.req.path,
    userId,
    projectName: name,
  });

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProject(c.env.STATE, name, logger),
  ]);

  if (!projectResult.success) {
    logger.warn("Project not found", { name });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{name}' not found.
      </div>,
      404,
    );
  }
  const project = projectResult.data;

  if (!canReadProject(project, userId, agentOwnerId)) {
    logger.warn("Access denied to project", { name, userId });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Access denied. You don't have permission to view this project.
      </div>,
      403,
    );
  }

  let files: string[] = [];
  let log: Array<{ sha: string; message: string; author: string; timestamp: number }> = [];
  let readme: string | null = null;
  let importProgress = null;

  // Check for active import
  const importResult = await getImportProgress(
    c.env.DB,
    project.namespace || "@legacy",
    project.slug || project.name,
    logger,
  );
  if (importResult.success && importResult.data) {
    importProgress = importResult.data;
  }

  try {
    const [filesResult, logResult] = await Promise.all([
      listFilesInRepo(project.remote, project.token, logger),
      getCommitLog(project.remote, project.token, logger, 20),
    ]);

    if (filesResult.success) {
      files = filesResult.data;
    } else {
      logger.warn("Failed to list files in repo", { error: filesResult.error });
    }

    if (logResult.success) {
      log = logResult.data;
    } else {
      logger.warn("Failed to get commit log", { error: logResult.error });
    }

    // Try to read README.md if it exists
    const readmePath = files.find((f) => f.toLowerCase() === "readme.md");
    if (readmePath) {
      const readmeResult = await readFileFromRepo(
        project.remote,
        project.token,
        readmePath,
        logger,
      );
      if (readmeResult.success) {
        readme = readmeResult.data;
      }
    }
  } catch (error) {
    // Repo may be empty or unreachable — render with empty data
    logger.warn("Error loading repo data", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logger.debug("Rendering project page", {
    name,
    fileCount: files.length,
    hasImport: !!importProgress,
  });
  return c.html(
    <RepoPage
      project={{
        name: project.name,
        namespace: project.namespace,
        slug: project.slug,
        remote: project.remote,
        createdAt: project.createdAt,
      }}
      files={files}
      log={log}
      readme={readme}
      user={userResult}
      importProgress={importProgress}
    />,
  );
});

// GET /p/:name/changes — Changes list
app.get("/p/:name/changes", async (c) => {
  const { name } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({
    path: c.req.path,
    userId,
    projectName: name,
  });

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProject(c.env.STATE, name, logger),
  ]);

  if (!projectResult.success) {
    logger.warn("Project not found for changes", { name });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{name}' not found.
      </div>,
      404,
    );
  }
  const project = projectResult.data;

  if (!canReadProject(project, userId, agentOwnerId)) {
    logger.warn("Access denied to project changes", { name, userId });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Access denied. You don't have permission to view this project.
      </div>,
      403,
    );
  }

  const changesResult = await listChanges(c.env.DB, logger, name);
  if (!changesResult.success) {
    logger.error("Failed to list changes", changesResult.error);
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Error loading changes. Please try again.
      </div>,
      500,
    );
  }

  const view = changesResult.data.map((change) => ({
    id: change.id,
    project: change.project,
    workspace: change.workspace,
    status: change.status,
    ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
    ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
    createdAt: change.createdAt,
  }));

  logger.debug("Rendering changes page", { name, changeCount: view.length });
  return c.html(
    <ChangesPage
      project={{ name: project.name, namespace: project.namespace, slug: project.slug }}
      changes={view}
      user={userResult}
    />,
  );
});

// GET /changes/:id — Change detail
app.get("/changes/:id", async (c) => {
  const { id } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({
    path: c.req.path,
    userId,
    changeId: id,
  });

  const [userResult, changeResult] = await Promise.all([
    getCurrentUser(c, logger),
    getChange(c.env.DB, logger, id),
  ]);

  if (!changeResult.success) {
    logger.warn("Change not found", { id });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">Change '{id}' not found.</div>,
      404,
    );
  }
  const change = changeResult.data;

  const projectResult = await getProject(c.env.STATE, change.project, logger);
  if (!projectResult.success) {
    logger.error("Project not found for change", projectResult.error, { project: change.project });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">Project not found.</div>,
      500,
    );
  }

  if (!canReadProject(projectResult.data, userId, agentOwnerId)) {
    logger.warn("Access denied to change", { id, userId });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">Access denied.</div>,
      403,
    );
  }

  const evalRunsResult = await listEvalRuns(c.env.DB, logger, change.id);
  if (!evalRunsResult.success) {
    logger.error("Failed to list eval runs", evalRunsResult.error);
  }

  const evalRuns = evalRunsResult.success
    ? evalRunsResult.data.map((run) => ({
        id: run.id,
        evaluatorType: run.evaluatorType,
        score: run.score,
        passed: run.passed,
        reason: run.reason,
        ranAt: run.ranAt,
      }))
    : [];

  logger.debug("Rendering change detail page", { id });
  return c.html(
    <ChangeDetailPage
      change={{
        id: change.id,
        project: change.project,
        workspace: change.workspace,
        status: change.status,
        ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
        ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
        ...(change.evalReason !== undefined ? { evalReason: change.evalReason } : {}),
        createdAt: change.createdAt,
      }}
      evalRuns={evalRuns}
      provenance={null}
      user={userResult}
    />,
  );
});

// GET /p/:name/workspaces — Workspaces list
app.get("/p/:name/workspaces", async (c) => {
  const { name } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({
    path: c.req.path,
    userId,
    projectName: name,
  });

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProject(c.env.STATE, name, logger),
  ]);

  if (!projectResult.success) {
    logger.warn("Project not found for workspaces", { name });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{name}' not found.
      </div>,
      404,
    );
  }

  if (!canReadProject(projectResult.data, userId, agentOwnerId)) {
    logger.warn("Access denied to project workspaces", { name, userId });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">Access denied.</div>,
      403,
    );
  }

  const project = projectResult.data;

  const workspacesResult = await listWorkspaces(c.env.STATE, project.id, logger);
  if (!workspacesResult.success) {
    logger.error("Failed to list workspaces", workspacesResult.error);
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Error loading workspaces.
      </div>,
      500,
    );
  }

  const view = workspacesResult.data.map((ws) => ({
    name: ws.name,
    parent: ws.parent,
    createdAt: ws.createdAt,
  }));

  logger.debug("Rendering workspaces page", { name, workspaceCount: view.length });
  return c.html(
    <WorkspacesPage
      project={{ name: project.name, namespace: project.namespace, slug: project.slug }}
      workspaces={view}
      user={userResult}
    />,
  );
});

// GET /:namespace/:slug/changes — Changes list (namespace format)
app.get("/:namespace/:slug/changes", async (c) => {
  const { namespace, slug } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({ path: c.req.path, userId });

  if (!isValidNamespace(namespace) || !isValidSlug(slug)) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">Invalid project path.</div>,
      400,
    );
  }

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProjectByPath(c.env.STATE, namespace, slug, logger),
  ]);

  if (!projectResult.success) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{namespace}/{slug}' not found.
      </div>,
      404,
    );
  }
  const project = projectResult.data;

  if (!canReadProject(project, userId, agentOwnerId)) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">Access denied.</div>,
      403,
    );
  }

  const changesResult = await listChanges(c.env.DB, logger, project.name);
  if (!changesResult.success) {
    logger.error("Failed to list changes", changesResult.error);
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Error loading changes. Please try again.
      </div>,
      500,
    );
  }

  const changes = changesResult.data.map((change) => ({
    id: change.id,
    project: change.project,
    workspace: change.workspace,
    status: change.status,
    ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
    ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
    createdAt: change.createdAt,
  }));

  return c.html(
    <ChangesPage
      project={{ name: project.name, namespace: project.namespace, slug: project.slug }}
      changes={changes}
      user={userResult}
    />,
  );
});

// GET /:namespace/:slug/workspaces — Workspaces list (namespace format)
app.get("/:namespace/:slug/workspaces", async (c) => {
  const { namespace, slug } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({ path: c.req.path, userId });

  if (!isValidNamespace(namespace) || !isValidSlug(slug)) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">Invalid project path.</div>,
      400,
    );
  }

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProjectByPath(c.env.STATE, namespace, slug, logger),
  ]);

  if (!projectResult.success) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{namespace}/{slug}' not found.
      </div>,
      404,
    );
  }
  const project = projectResult.data;

  if (!canReadProject(project, userId, agentOwnerId)) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">Access denied.</div>,
      403,
    );
  }

  const workspacesResult = await listWorkspaces(c.env.STATE, project.id, logger);
  if (!workspacesResult.success) {
    logger.error("Failed to list workspaces", workspacesResult.error);
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Error loading workspaces. Please try again.
      </div>,
      500,
    );
  }

  const workspaces = workspacesResult.data.map((ws) => ({
    name: ws.name,
    parent: ws.parent,
    createdAt: ws.createdAt,
  }));

  return c.html(
    <WorkspacesPage
      project={{ name: project.name, namespace: project.namespace, slug: project.slug }}
      workspaces={workspaces}
      user={userResult}
    />,
  );
});

// GET /:namespace/:slug/sync — Sync management page
app.get("/:namespace/:slug/sync", async (c) => {
  const { namespace, slug } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({ path: c.req.path, userId });

  if (!isValidNamespace(namespace) || !isValidSlug(slug)) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">Invalid project path.</div>,
      400,
    );
  }

  if (!userId) {
    return c.redirect("/auth/email");
  }

  const [_userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProjectByPath(c.env.STATE, namespace, slug, logger),
  ]);

  if (!projectResult.success) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{namespace}/{slug}' not found.
      </div>,
      404,
    );
  }
  const project = projectResult.data;

  if (!canReadProject(project, userId, agentOwnerId)) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">Access denied.</div>,
      403,
    );
  }

  const syncStatusResult = await getSyncStatus(c.env.STATE, namespace, slug, logger);
  const stored = syncStatusResult.success ? syncStatusResult.data : null;
  const syncStatus = {
    namespace,
    slug,
    sourceUrl: project.remote || "",
    sourceBranch: "main",
    lastSyncStatus: (stored?.lastSyncStatus ?? "idle") as
      | "success"
      | "failed"
      | "in_progress"
      | "idle",
    lastSyncedAt: stored?.lastSyncedAt,
    lastSyncedCommit: stored?.lastSyncedCommit,
    lastSyncError: stored?.lastSyncError,
    hasUpdates: stored?.hasUpdates ?? false,
    commitsBehind: stored?.commitsBehind,
    latestCommit: stored?.latestCommit,
    autoSyncEnabled: stored?.autoSyncEnabled ?? false,
    syncFrequency: stored?.syncFrequency,
    lastCheckedAt: stored?.lastCheckedAt ?? new Date().toISOString(),
  };

  return c.html(
    <SyncPage
      project={{
        namespace: project.namespace || namespace,
        slug: project.slug || slug,
        name: project.name,
      }}
      syncStatus={syncStatus}
      syncHistory={[]}
    />,
  );
});

// GET /:namespace/:slug — Repo view with namespace (NEW FORMAT) - MUST BE LAST
app.get("/:namespace/:slug", async (c) => {
  const params = c.req.param();
  const { namespace, slug } = params;

  // Validate namespace format
  if (!isValidNamespace(namespace)) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Invalid namespace format. Namespaces must start with @ and contain only lowercase
        alphanumeric characters and hyphens.
      </div>,
      400,
    );
  }

  // Validate slug format
  if (!isValidSlug(slug)) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Invalid slug format. Slugs must be 1-64 characters, alphanumeric, hyphens, or underscores.
      </div>,
      400,
    );
  }

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({
    path: c.req.path,
    userId,
    projectName: `${namespace}/${slug}`,
  });

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProjectByPath(c.env.STATE, namespace, slug, logger),
  ]);

  if (!projectResult.success) {
    logger.warn("Project not found", { namespace, slug });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{namespace}/{slug}' not found.
      </div>,
      404,
    );
  }
  const project = projectResult.data;

  if (!canReadProject(project, userId, agentOwnerId)) {
    logger.warn("Access denied to project", { namespace, slug, userId });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Access denied. You don't have permission to view this project.
      </div>,
      403,
    );
  }

  let files: string[] = [];
  let log: Array<{ sha: string; message: string; author: string; timestamp: number }> = [];
  let readme: string | null = null;
  let importProgress = null;

  // Check for active import
  const importResult = await getImportProgress(c.env.DB, namespace, slug, logger);
  if (importResult.success && importResult.data) {
    importProgress = importResult.data;
  }

  try {
    const [filesResult, logResult] = await Promise.all([
      listFilesInRepo(project.remote, project.token, logger),
      getCommitLog(project.remote, project.token, logger, 20),
    ]);

    if (filesResult.success) {
      files = filesResult.data;
    } else {
      logger.warn("Failed to list files in repo", { error: filesResult.error });
    }

    if (logResult.success) {
      log = logResult.data;
    } else {
      logger.warn("Failed to get commit log", { error: logResult.error });
    }

    // Try to read README.md if it exists
    const readmePath = files.find((f) => f.toLowerCase() === "readme.md");
    if (readmePath) {
      const readmeResult = await readFileFromRepo(
        project.remote,
        project.token,
        readmePath,
        logger,
      );
      if (readmeResult.success) {
        readme = readmeResult.data;
      }
    }
  } catch (error) {
    // Repo may be empty or unreachable — render with empty data
    logger.warn("Error loading repo data", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logger.debug("Rendering project page", {
    namespace,
    slug,
    fileCount: files.length,
    hasImport: !!importProgress,
  });
  return c.html(
    <RepoPage
      project={{
        name: project.name,
        namespace: project.namespace,
        slug: project.slug,
        remote: project.remote,
        createdAt: project.createdAt,
      }}
      files={files}
      log={log}
      readme={readme}
      user={userResult}
      importProgress={importProgress}
    />,
  );
});

export { app as uiRouter };
