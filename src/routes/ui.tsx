import { Hono } from "hono";
import { createAgent, deleteAgent, getAgent, listAgents } from "../storage/agents";
import { recordAudit } from "../storage/audit";
import { listComments, listReviews } from "../storage/change-reviews";
import { getChange, listChanges } from "../storage/changes";
import { getChangeCostSummary } from "../storage/costs";
import { listEvalRuns } from "../storage/eval-runs";
import { listProjectEvents } from "../storage/events";
import {
  freshRepoToken,
  getCommitLog,
  getDiffBetweenRepos,
  listFilesInRepo,
  readFileFromRepo,
} from "../storage/git-ops";
import { getImportProgress } from "../storage/imports";
import { getIssueByNumber, listIssues } from "../storage/issues";
import { readRepoSnapshot } from "../storage/repo-snapshot";
import {
  getProject,
  getProjectByPath,
  getWorkspace,
  listProjects,
  listWorkspaces,
} from "../storage/state";
import { getProjectSourceUrl, getSyncStatus } from "../storage/sync";
import { getUser, rotateUserToken } from "../storage/users";
import { listDeliveries, listWebhooks } from "../storage/webhooks";
import type { Env, ProjectEntry } from "../types";
import { parseUnifiedDiff } from "../ui/components/diff-view";
import { getFileContent, isValidFilePath } from "../ui/file-content";
import { ActivityPage } from "../ui/pages/activity";
import { ChangeDetailPage } from "../ui/pages/change-detail";
import { ChangesPage } from "../ui/pages/changes";
import { FileViewerPage } from "../ui/pages/file-viewer";
import { HomePage } from "../ui/pages/home";
import { IssueDetailPage, IssuesPage, NewIssuePage } from "../ui/pages/issues";
import { NewProjectPage } from "../ui/pages/new-project";
import { RepoPage } from "../ui/pages/repo";
import { SettingsPage } from "../ui/pages/settings";
import { SyncPage } from "../ui/pages/sync";
import { WebhooksPage } from "../ui/pages/webhooks";
import { WorkspacesPage } from "../ui/pages/workspaces";
import { canReadProject, canWriteProject, filterMemberProjects } from "../utils/authz";
import { createLogger } from "../utils/logger";
import { isValidNamespace, isValidSlug } from "../utils/validation";
import { SUBSCRIBABLE_EVENTS } from "./webhooks";

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

/**
 * Resolve issue author ids to display names ("@username" for users, the agent's
 * name for agents). Unresolvable authors fall back to their author type.
 */
async function resolveIssueAuthors(
  db: D1Database,
  issues: Array<{ authorType: "user" | "agent"; authorId: string }>,
  logger: ReturnType<typeof createLogger>,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    [...new Map(issues.map((issue) => [issue.authorId, issue.authorType]))].map(
      async ([authorId, authorType]): Promise<readonly [string, string]> => {
        if (authorType === "user") {
          const result = await getUser(db, authorId, logger);
          return [authorId, result.success ? `@${result.data.username}` : "user"];
        }
        const result = await getAgent(db, authorId, logger);
        return [authorId, result.success ? `${result.data.name} (agent)` : "agent"];
      },
    ),
  );
  return Object.fromEntries(entries);
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
  // The dashboard is the caller's personal workspace: it lists only the projects
  // that are theirs (owned + org/team), never the whole instance's public
  // projects. Signed-out visitors get an empty list and a sign-in prompt; public
  // projects remain reachable by direct URL.
  const memberProjects = await filterMemberProjects(
    c.env.DB,
    allProjectsResult.data,
    userId,
    agentOwnerId,
  );
  // Most-recently-created first. createdAt is ISO-8601, so lexicographic order
  // matches chronological order.
  memberProjects.sort((a, b) => {
    if (a.createdAt === b.createdAt) return 0;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
  const view = memberProjects.map((p) => ({
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

async function loadAgentSummaries(
  db: D1Database,
  userId: string,
  logger: ReturnType<typeof createLogger>,
): Promise<Array<{ id: string; name: string; model?: string; createdAt: string }>> {
  const agentsResult = await listAgents(db, userId, logger);
  if (!agentsResult.success) return [];
  return agentsResult.data.map((agent) => ({
    id: agent.id,
    name: agent.name,
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    createdAt: agent.createdAt,
  }));
}

// GET /settings — Account, API key, and agent token management
app.get("/settings", async (c) => {
  const logger = createLogger({ path: c.req.path, userId: c.get("userId") });
  const user = await getCurrentUser(c, logger);
  if (!user) return c.redirect("/auth/email");

  const agents = await loadAgentSummaries(c.env.DB, user.id, logger);
  return c.html(<SettingsPage user={user} agents={agents} />);
});

// POST /settings/rotate-token — Rotate the API key; renders the new key once
app.post("/settings/rotate-token", async (c) => {
  const logger = createLogger({ path: c.req.path, userId: c.get("userId") });
  const user = await getCurrentUser(c, logger);
  if (!user) return c.redirect("/auth/email");

  const rotateResult = await rotateUserToken(c.env.DB, user.id, logger);
  if (!rotateResult.success) {
    logger.error("Failed to rotate API key", rotateResult.error);
    return c.html(issuePageError(500), 500);
  }

  await recordAudit(c.env.DB, logger, {
    action: "token.rotated",
    actorType: "user",
    actorId: user.id,
  });

  const agents = await loadAgentSummaries(c.env.DB, user.id, logger);
  // Rendered in the POST response so the secret never lands in a URL or log.
  return c.html(
    <SettingsPage
      user={user}
      agents={agents}
      freshToken={{ kind: "api-key", value: rotateResult.data }}
    />,
  );
});

// POST /settings/agents — Create an agent token; renders it once
app.post("/settings/agents", async (c) => {
  const logger = createLogger({ path: c.req.path, userId: c.get("userId") });
  const user = await getCurrentUser(c, logger);
  if (!user) return c.redirect("/auth/email");

  const form = await c.req.parseBody();
  const name = typeof form.name === "string" ? form.name.trim().slice(0, 100) : "";
  if (!name) return c.html(issuePageError(400), 400);
  const model =
    typeof form.model === "string" && form.model.trim()
      ? form.model.trim().slice(0, 100)
      : undefined;

  const createResult = await createAgent(c.env.DB, user.id, name, logger, model);
  if (!createResult.success) {
    logger.error("Failed to create agent", createResult.error);
    return c.html(issuePageError(500), 500);
  }

  await recordAudit(c.env.DB, logger, {
    action: "agent.created",
    actorType: "user",
    actorId: user.id,
    subject: createResult.data.agent.id,
    detail: { name },
  });

  const agents = await loadAgentSummaries(c.env.DB, user.id, logger);
  return c.html(
    <SettingsPage
      user={user}
      agents={agents}
      freshToken={{ kind: "agent", value: createResult.data.plaintext, agentName: name }}
    />,
  );
});

// POST /settings/agents/:id/delete — Revoke an agent token
app.post("/settings/agents/:id/delete", async (c) => {
  const logger = createLogger({ path: c.req.path, userId: c.get("userId") });
  const user = await getCurrentUser(c, logger);
  if (!user) return c.redirect("/auth/email");

  const { id } = c.req.param();
  const agentResult = await getAgent(c.env.DB, id, logger);
  if (agentResult.success && agentResult.data.ownerId === user.id) {
    const deleteResult = await deleteAgent(c.env.DB, id, logger);
    if (deleteResult.success) {
      await recordAudit(c.env.DB, logger, {
        action: "agent.revoked",
        actorType: "user",
        actorId: user.id,
        subject: id,
      });
    }
  }
  return c.redirect("/settings", 302);
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

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    logger.warn("Project not found or access denied", { name, userId });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{name}' not found.
      </div>,
      404,
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
  if (importResult.success && importResult.data && importResult.data.status !== "completed") {
    importProgress = importResult.data;
  }

  // Fetch upstream sync status — guard: skip for legacy entries without a namespace
  let syncStatus: {
    hasUpdates?: boolean;
    commitsBehind?: number;
    latestCommit?: string;
    lastCheckedAt?: string;
  } | null = null;
  let canSync = false;
  if (project.namespace) {
    const legacyNamespace = project.namespace ?? "@legacy";
    const legacySlug = project.slug ?? project.name;
    const syncStatusResult = await getSyncStatus(c.env.STATE, legacyNamespace, legacySlug, logger);
    if (syncStatusResult.success && syncStatusResult.data) {
      syncStatus = syncStatusResult.data;
    }
    canSync =
      !!getProjectSourceUrl(project) &&
      !!userId &&
      project.ownerType === "user" &&
      project.ownerId === userId &&
      project.importCompleted !== false;
  }
  const isOwner = !!userId && project.ownerType === "user" && project.ownerId === userId;

  const snapshotResult = await readRepoSnapshot(c.env.STATE, project, logger);
  if (snapshotResult.success && snapshotResult.data) {
    files = snapshotResult.data.files;
    log = snapshotResult.data.commits;
    readme = snapshotResult.data.readme;
  } else {
    // Cache miss or corrupt entry — fall back to git clone
    try {
      const tokenResult = await freshRepoToken(c.env.ARTIFACTS, project.remote, "read", logger);
      if (!tokenResult.success) throw tokenResult.error;
      const readToken = tokenResult.data;
      const [filesResult, logResult] = await Promise.all([
        listFilesInRepo(project.remote, readToken, logger),
        getCommitLog(project.remote, readToken, logger, 20),
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
        const readmeResult = await readFileFromRepo(project.remote, readToken, readmePath, logger);
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
        sourceUrl: getProjectSourceUrl(project),
        sourceProvider: project.sourceProvider,
        sourceOwner: project.sourceOwner,
        sourceRepo: project.sourceRepo,
        lastSyncedAt: project.lastSyncedAt,
        lastSyncedCommit: project.lastSyncedCommit,
        lastSyncStatus: project.lastSyncStatus,
        lastSyncError: project.lastSyncError,
        autoSyncEnabled: project.autoSyncEnabled,
      }}
      files={files}
      log={log}
      readme={readme}
      user={userResult}
      importProgress={importProgress}
      syncStatus={syncStatus}
      canSync={canSync}
      isOwner={isOwner}
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

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    logger.warn("Project not found or access denied", { name, userId });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{name}' not found.
      </div>,
      404,
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

  if (!(await canReadProject(c.env.DB, projectResult.data, userId, agentOwnerId))) {
    logger.warn("Change not found or access denied", { id, userId });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">Not found.</div>,
      404,
    );
  }

  const [evalRunsResult, commentsResult, reviewsResult, costsResult] = await Promise.all([
    listEvalRuns(c.env.DB, logger, change.id),
    listComments(c.env.DB, logger, change.id),
    listReviews(c.env.DB, logger, change.id),
    getChangeCostSummary(c.env.DB, logger, change.id),
  ]);

  // The diff is only renderable while the workspace still exists and the
  // change is still in review; failures degrade to "no diff section".
  let diffFiles: ReturnType<typeof parseUnifiedDiff> | null = null;
  const DIFFABLE_STATUSES = ["open", "needs_changes", "accepted", "approved"];
  if (DIFFABLE_STATUSES.includes(change.status)) {
    const workspaceResult = await getWorkspace(
      c.env.STATE,
      projectResult.data.id,
      change.workspace,
      logger,
    );
    if (workspaceResult.success) {
      const [projectToken, workspaceToken] = await Promise.all([
        freshRepoToken(c.env.ARTIFACTS, projectResult.data.remote, "read", logger),
        freshRepoToken(c.env.ARTIFACTS, workspaceResult.data.remote, "read", logger),
      ]);
      if (projectToken.success && workspaceToken.success) {
        const diffResult = await getDiffBetweenRepos(
          projectResult.data.remote,
          projectToken.data,
          workspaceResult.data.remote,
          workspaceToken.data,
          logger,
        );
        if (diffResult.success) {
          diffFiles = parseUnifiedDiff(diffResult.data.diff);
        } else {
          logger.warn("Failed to load change diff", { changeId: change.id });
        }
      } else {
        logger.warn("Failed to mint tokens for change diff", { changeId: change.id });
      }
    }
  }
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
      comments={commentsResult.success ? commentsResult.data : []}
      reviews={reviewsResult.success ? reviewsResult.data : []}
      costs={costsResult.success ? costsResult.data : []}
      diff={diffFiles}
      canReview={!!userResult && (await canWriteProject(c.env.DB, projectResult.data, userId))}
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

  if (!(await canReadProject(c.env.DB, projectResult.data, userId, agentOwnerId))) {
    logger.warn("Project not found or access denied", { name, userId });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">Not found.</div>,
      404,
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

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{namespace}/{slug}' not found.
      </div>,
      404,
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

// GET /:namespace/:slug/activity — Project activity feed
app.get("/:namespace/:slug/activity", async (c) => {
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

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{namespace}/{slug}' not found.
      </div>,
      404,
    );
  }

  const eventsResult = await listProjectEvents(c.env.DB, logger, project.name);
  if (!eventsResult.success) {
    logger.error("Failed to list project events", eventsResult.error);
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Error loading activity. Please try again.
      </div>,
      500,
    );
  }

  return c.html(
    <ActivityPage
      project={{ name: project.name, namespace: project.namespace, slug: project.slug }}
      events={eventsResult.data}
      user={userResult}
    />,
  );
});

// Shared loader for issue pages: validates path, loads user + project, checks read access.
async function loadIssuePageContext(c: {
  env: Env;
  get(key: "userId" | "agentOwnerId"): string | undefined;
  req: { param(key: string): string; path: string; query(key: string): string | undefined };
}): Promise<
  | {
      project: ProjectEntry;
      user: { id: string; email: string; username: string } | null;
      userId: string | undefined;
      logger: ReturnType<typeof createLogger>;
    }
  | { errorStatus: 400 | 404 }
> {
  const namespace = c.req.param("namespace");
  const slug = c.req.param("slug");
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({ path: c.req.path, userId });

  if (!isValidNamespace(namespace) || !isValidSlug(slug)) return { errorStatus: 400 };

  const [user, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProjectByPath(c.env.STATE, namespace, slug, logger),
  ]);
  if (!projectResult.success) return { errorStatus: 404 };
  const project = projectResult.data;
  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) return { errorStatus: 404 };

  return { project, user, userId, logger };
}

const issuePageError = (status: 400 | 404 | 500) => (
  <div style="padding:2rem;font-family:monospace;color:#f87171;">
    {status === 400 ? "Invalid project path." : status === 404 ? "Not found." : "Server error."}
  </div>
);

// GET /:namespace/:slug/issues — Issues list
app.get("/:namespace/:slug/issues", async (c) => {
  const ctx = await loadIssuePageContext(c);
  if ("errorStatus" in ctx) return c.html(issuePageError(ctx.errorStatus), ctx.errorStatus);
  const { project, user, userId, logger } = ctx;

  const statusParam = c.req.query("status");
  const filter: "open" | "closed" | "all" =
    statusParam === "closed" ? "closed" : statusParam === "all" ? "all" : "open";

  const issuesResult = await listIssues(
    c.env.DB,
    logger,
    project.name,
    filter === "all" ? undefined : filter,
    { projectId: project.id },
  );
  if (!issuesResult.success) {
    logger.error("Failed to list issues", issuesResult.error);
    return c.html(issuePageError(500), 500);
  }

  const [authors, canWrite] = await Promise.all([
    resolveIssueAuthors(c.env.DB, issuesResult.data, logger),
    canWriteProject(c.env.DB, project, userId),
  ]);

  return c.html(
    <IssuesPage
      project={{ name: project.name, namespace: project.namespace, slug: project.slug }}
      issues={issuesResult.data}
      authors={authors}
      filter={filter}
      canWrite={canWrite}
      user={user}
    />,
  );
});

// GET /:namespace/:slug/issues/new — New issue form (writers only)
app.get("/:namespace/:slug/issues/new", async (c) => {
  const ctx = await loadIssuePageContext(c);
  if ("errorStatus" in ctx) return c.html(issuePageError(ctx.errorStatus), ctx.errorStatus);
  const { project, user, userId } = ctx;

  if (!(await canWriteProject(c.env.DB, project, userId))) {
    return c.html(issuePageError(404), 404);
  }

  return c.html(
    <NewIssuePage
      project={{ name: project.name, namespace: project.namespace, slug: project.slug }}
      user={user}
    />,
  );
});

// GET /:namespace/:slug/issues/:number — Issue detail
app.get("/:namespace/:slug/issues/:number", async (c) => {
  const ctx = await loadIssuePageContext(c);
  if ("errorStatus" in ctx) return c.html(issuePageError(ctx.errorStatus), ctx.errorStatus);
  const { project, user, userId, logger } = ctx;

  const number = Number(c.req.param("number"));
  if (!Number.isInteger(number) || number <= 0) {
    return c.html(issuePageError(400), 400);
  }

  const issueResult = await getIssueByNumber(c.env.DB, logger, project.name, number, {
    projectId: project.id,
  });
  if (!issueResult.success) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Issue #{number} not found.
      </div>,
      404,
    );
  }

  const [authors, canWrite] = await Promise.all([
    resolveIssueAuthors(c.env.DB, [issueResult.data], logger),
    canWriteProject(c.env.DB, project, userId),
  ]);

  return c.html(
    <IssueDetailPage
      project={{ name: project.name, namespace: project.namespace, slug: project.slug }}
      issue={issueResult.data}
      authors={authors}
      canWrite={canWrite}
      user={user}
    />,
  );
});

// GET /:namespace/:slug/webhooks — Webhook management (project writers only)
app.get("/:namespace/:slug/webhooks", async (c) => {
  const { namespace, slug } = c.req.param();
  const userId = c.get("userId");
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

  // Webhook URLs and secrets are sensitive: writers only.
  if (!(await canWriteProject(c.env.DB, project, userId))) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{namespace}/{slug}' not found.
      </div>,
      404,
    );
  }

  const webhooksResult = await listWebhooks(c.env.DB, logger, project.name);
  if (!webhooksResult.success) {
    logger.error("Failed to list webhooks", webhooksResult.error);
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Error loading webhooks. Please try again.
      </div>,
      500,
    );
  }

  const webhooks = await Promise.all(
    webhooksResult.data.map(async (webhook) => {
      const deliveriesResult = await listDeliveries(c.env.DB, logger, webhook.id, 5);
      return { webhook, deliveries: deliveriesResult.success ? deliveriesResult.data : [] };
    }),
  );

  return c.html(
    <WebhooksPage
      project={{ name: project.name, namespace: project.namespace, slug: project.slug }}
      webhooks={webhooks}
      subscribableEvents={SUBSCRIBABLE_EVENTS}
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

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{namespace}/{slug}' not found.
      </div>,
      404,
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

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{namespace}/{slug}' not found.
      </div>,
      404,
    );
  }

  const syncStatusResult = await getSyncStatus(c.env.STATE, namespace, slug, logger);
  const stored = syncStatusResult.success ? syncStatusResult.data : null;
  const syncStatus = {
    namespace,
    slug,
    // Only external import sources are shown; the internal artifacts remote is not a
    // sync source and must not leak into the page.
    sourceUrl: getProjectSourceUrl(project) ?? "",
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
      user={userResult}
    />,
  );
});

// GET /:namespace/:slug/blob/* — File viewer (must be before /:namespace/:slug catch-all)
app.get("/:namespace/:slug/blob/*", async (c) => {
  const { namespace, slug } = c.req.param();
  const filePath = c.req.path.slice(`/${namespace}/${slug}/blob/`.length);
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({ path: c.req.path, userId });

  if (!isValidNamespace(namespace)) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Invalid namespace format.
      </div>,
      400,
    );
  }

  if (!isValidSlug(slug)) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">Invalid slug format.</div>,
      400,
    );
  }

  if (!filePath || !isValidFilePath(filePath)) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">Invalid file path.</div>,
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

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{namespace}/{slug}' not found.
      </div>,
      404,
    );
  }

  const readToken = await freshRepoToken(c.env.ARTIFACTS, project.remote, "read", logger);
  if (!readToken.success) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">Error loading file.</div>,
      500,
    );
  }
  const contentResult = await getFileContent(project.remote, readToken.data, filePath, logger);
  if (!contentResult.success) {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">Error loading file.</div>,
      500,
    );
  }

  const content = contentResult.data;
  if (content.kind === "not-found") {
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        File '{filePath}' not found in this repository.
      </div>,
      404,
    );
  }

  return c.html(
    <FileViewerPage
      project={{
        namespace: project.namespace,
        slug: project.slug,
        name: project.name,
      }}
      path={filePath}
      content={content}
      user={userResult}
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

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    logger.warn("Project not found or access denied", { namespace, slug, userId });
    return c.html(
      <div style="padding:2rem;font-family:monospace;color:#f87171;">
        Project '{namespace}/{slug}' not found.
      </div>,
      404,
    );
  }

  let files: string[] = [];
  let log: Array<{ sha: string; message: string; author: string; timestamp: number }> = [];
  let readme: string | null = null;
  let importProgress = null;

  // Check for active import — hide the card once it has completed
  const importResult = await getImportProgress(c.env.DB, namespace, slug, logger);
  if (importResult.success && importResult.data && importResult.data.status !== "completed") {
    importProgress = importResult.data;
  }

  // Fetch upstream sync status (null on KV failure — not fatal)
  let syncStatus: {
    hasUpdates?: boolean;
    commitsBehind?: number;
    latestCommit?: string;
    lastCheckedAt?: string;
  } | null = null;
  const syncStatusResult = await getSyncStatus(c.env.STATE, namespace, slug, logger);
  if (syncStatusResult.success && syncStatusResult.data) {
    syncStatus = syncStatusResult.data;
  }

  const isOwner = !!userId && project.ownerType === "user" && project.ownerId === userId;
  const canSync = !!getProjectSourceUrl(project) && isOwner && project.importCompleted !== false;

  const snapshotResult2 = await readRepoSnapshot(c.env.STATE, project, logger);
  if (snapshotResult2.success && snapshotResult2.data) {
    files = snapshotResult2.data.files;
    log = snapshotResult2.data.commits;
    readme = snapshotResult2.data.readme;
  } else {
    // Cache miss or corrupt entry — fall back to git clone
    try {
      const tokenResult = await freshRepoToken(c.env.ARTIFACTS, project.remote, "read", logger);
      if (!tokenResult.success) throw tokenResult.error;
      const readToken = tokenResult.data;
      const [filesResult, logResult] = await Promise.all([
        listFilesInRepo(project.remote, readToken, logger),
        getCommitLog(project.remote, readToken, logger, 20),
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
        const readmeResult = await readFileFromRepo(project.remote, readToken, readmePath, logger);
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
        sourceUrl: getProjectSourceUrl(project),
        sourceProvider: project.sourceProvider,
        sourceOwner: project.sourceOwner,
        sourceRepo: project.sourceRepo,
        lastSyncedAt: project.lastSyncedAt,
        lastSyncedCommit: project.lastSyncedCommit,
        lastSyncStatus: project.lastSyncStatus,
        lastSyncError: project.lastSyncError,
        autoSyncEnabled: project.autoSyncEnabled,
      }}
      files={files}
      log={log}
      readme={readme}
      user={userResult}
      importProgress={importProgress}
      syncStatus={syncStatus}
      canSync={canSync}
      isOwner={isOwner}
    />,
  );
});

export { app as uiRouter };
