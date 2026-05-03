import { Hono } from "hono";
import { getCommitLog, importFromGitHub, initAndPush, listFilesInRepo } from "../storage/git-ops";
import { createImportJob, getImportProgress, updateImportProgress, updateImportStatus, deleteImportJob, cancelImportJob, isImportCancelled } from "../storage/imports";
import { listProvenance } from "../storage/provenance";
import { getProjectByPath, listProjectsByNamespace, setProject } from "../storage/state";
import type { Env, ProjectEntry, ImportProgress, ArtifactsCreateResult } from "../types";
import { getArtifactsRepoName } from "../types";
import { canReadProject, filterReadableProjects } from "../utils/authz";
import { internalError, badRequest, created, forbidden, notFound, ok, unauthorized } from "../utils/response";
import { isStringRecord, isValidGitHubUrl, isValidNamespace, isValidSlug, slugify } from "../utils/validation";
import { createLogger } from "../utils/logger";
import type { Logger } from "../utils/logger";
import { importRateLimitMiddleware, releaseImportLock } from "../middleware/rate-limit";

const DEFAULT_FILES: Record<string, string> = {
  "README.md": "# My Project\n\nCreated with Stratum.\n",
  "src/index.ts": 'export function hello(): string {\n  return "hello world";\n}\n',
};

const app = new Hono<{ Bindings: Env }>();

function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/\s]+?)(?:\.git|\/)?$/i);
  if (!match || !match[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2] };
}

// Helper to generate project ID
function generateProjectId(): string {
  return crypto.randomUUID();
}

// Helper to get user's namespace (username with @ prefix)
function getUserNamespace(username: string): string {
  return username.startsWith('@') ? username : `@${username}`;
}

// POST /projects - Create a new project
// Body: { name: string, visibility?: "private" | "public", files?: Record<string, string>, seed?: boolean }
app.post("/", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const username = c.get("username");
  if (!userId || !username) return unauthorized("Authentication required");

  const body = await c.req.json<{ name?: unknown; files?: unknown; visibility?: unknown }>();
  if (!isValidSlug(body.name)) return badRequest("name must be a 1-64 char alphanumeric slug");

  const namespace = getUserNamespace(username);
  
  // Validate namespace format
  if (!isValidNamespace(namespace)) {
    return badRequest("Invalid namespace format");
  }

  // Validate visibility if provided
  let visibility: "private" | "public" = "private";
  if (body.visibility !== undefined) {
    if (body.visibility !== "private" && body.visibility !== "public") {
      return badRequest("visibility must be 'private' or 'public'");
    }
    visibility = body.visibility;
  }

  const seed = c.req.query("seed") === "true";
  const files =
    body.files !== undefined
      ? isStringRecord(body.files)
        ? body.files
        : null
      : seed
        ? DEFAULT_FILES
        : { ".gitkeep": "" };

  if (files === null)
    return badRequest("files must be an object of string paths to string contents");

  const slug = slugify(String(body.name));
  
  // Validate slug length after slugification
  if (!isValidSlug(slug)) {
    return badRequest(`Slug too long (max 100 characters)`);
  }
  const projectId = generateProjectId();

  // Check if project already exists
  const existingResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (existingResult.success) {
    return badRequest(`Project '${slug}' already exists in your namespace`);
  }

  // Create Artifacts repo with namespaced name
  const artifactsRepoName = getArtifactsRepoName(namespace, slug);
  const repo = await c.env.ARTIFACTS.create(artifactsRepoName);
  
  const initResult = await initAndPush(repo.remote, repo.token, files, "Initial commit", logger);
  if (!initResult.success) {
    logger.error('Failed to initialize and push repository', initResult.error);
    return internalError(initResult.error.message);
  }

  const project: ProjectEntry = {
    id: projectId,
    name: String(body.name),
    slug,
    namespace,
    ownerId: userId,
    ownerType: 'user',
    remote: repo.remote,
    token: repo.token,
    createdAt: new Date().toISOString(),
    visibility,
  };

  const setResult = await setProject(c.env.STATE, project, logger);
  if (!setResult.success) {
    logger.error('Failed to set project', setResult.error);
    return internalError(setResult.error.message);
  }

  logger.info('Project created', { 
    projectId, 
    namespace, 
    slug, 
    visibility 
  });
  
  return created({ 
    id: projectId,
    name: project.name,
    namespace,
    slug,
    path: `/${namespace}/${slug}`,
    remote: repo.remote, 
    commit: initResult.data, 
    visibility 
  });
});

// GET /projects - List projects for the authenticated user
app.get("/", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const username = c.get("username");
  const agentOwnerId = c.get("agentOwnerId");

  if (!userId || !username) {
    return ok({ projects: [] });
  }

  const namespace = getUserNamespace(username);
  const projectsResult = await listProjectsByNamespace(c.env.STATE, namespace, logger);
  
  if (!projectsResult.success) {
    logger.error('Failed to list projects', projectsResult.error);
    return internalError(projectsResult.error.message);
  }

  const projects = filterReadableProjects(projectsResult.data, userId, agentOwnerId);
  logger.info('Projects listed', { count: projects.length });
  
  return ok({
    projects: projects.map(({ id, name, namespace, slug, remote, createdAt, visibility }) => ({ 
      id,
      name, 
      namespace,
      slug,
      path: `/${namespace}/${slug}`,
      remote, 
      createdAt, 
      visibility 
    })),
  });
});

// GET /projects/:namespace/:slug - Get a specific project
app.get("/:namespace/:slug", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { namespace, slug } = c.req.param();

  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === 'NOT_FOUND') {
      return notFound("Project", `${namespace}/${slug}`);
    }
    logger.error('Failed to get project', projectResult.error);
    return internalError(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!canReadProject(project, userId, agentOwnerId)) return forbidden("Project access denied");

  logger.info('Project retrieved', { namespace, slug });
  return ok({
    id: project.id,
    name: project.name,
    namespace: project.namespace,
    slug: project.slug,
    path: `/${project.namespace}/${project.slug}`,
    remote: project.remote,
    createdAt: project.createdAt,
    visibility: project.visibility,
    githubUrl: project.githubUrl,
    githubOwner: project.githubOwner,
    githubRepo: project.githubRepo,
    githubDefaultBranch: project.githubDefaultBranch,
    githubConnectionStatus: project.githubConnectionStatus,
  });
});

// POST /projects/:namespace/:slug/import - Import from GitHub
// Strict rate limiting: 1 import per minute per user, 1 concurrent import per project
app.post("/:namespace/:slug/import", importRateLimitMiddleware({
  importsPerWindow: 1,
  windowSeconds: 60,
  maxConcurrentPerProject: 1,
  projectLockSeconds: 300, // 5 minutes default import timeout
}), async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

  try {
    const userId = c.get("userId");
    const username = c.get("username");
    if (!userId || !username) return unauthorized("Authentication required");

    const { namespace, slug } = c.req.param();
    
    // Validate namespace format
    if (!isValidNamespace(namespace)) {
      return badRequest("Invalid namespace format");
    }
    
    if (!isValidSlug(slug)) return badRequest("Slug too long (max 100 characters)");

    const userNamespace = getUserNamespace(username);
    
    // Validate user namespace format
    if (!isValidNamespace(userNamespace)) {
      return badRequest("Invalid namespace format");
    }
    
    // For now, users can only import into their own namespace
    if (namespace !== userNamespace) {
      return forbidden("You can only import projects into your own namespace");
    }

    // Check if project already exists
    const existingProjectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
    if (existingProjectResult.success) {
      logger.info('Project already exists', { namespace, slug });
      // Redirect to existing project if coming from web UI
      const contentType = c.req.header("content-type") || "";
      if (!contentType.includes("application/json")) {
        return c.redirect(`/@${namespace.replace('@', '')}/${slug}`);
      }
      return ok({ 
        namespace, 
        slug, 
        remote: existingProjectResult.data.remote, 
        source: existingProjectResult.data.githubUrl 
      });
    }

    // Handle both JSON and form data
    let body: { url?: unknown; branch?: unknown; depth?: unknown; visibility?: unknown };
    const contentType = c.req.header("content-type") || "";
    
    if (contentType.includes("application/json")) {
      body = await c.req.json();
    } else {
      // Form data
      const formData = await c.req.parseBody();
      body = {
        url: formData.url,
        branch: formData.branch,
        depth: formData.depth ? Number(formData.depth) : undefined,
        visibility: formData.visibility,
      };
    }

    if (!isValidGitHubUrl(body.url))
      return badRequest("url must be a valid github.com repository URL");

    const branch = typeof body.branch === "string" ? body.branch : "main";

    // Validate visibility if provided
    let visibility: "private" | "public" = "private";
    if (body.visibility !== undefined) {
      if (body.visibility !== "private" && body.visibility !== "public") {
        return badRequest("visibility must be 'private' or 'public'");
      }
      visibility = body.visibility;
    }

    // Generate project ID
    const projectId = generateProjectId();
    const importId = generateProjectId();

    // Create import job FIRST (before creating project)
    const createImportResult = await createImportJob(
      c.env.DB,
      {
        id: importId,
        projectId,
        namespace,
        slug,
        sourceUrl: body.url,
        branch,
      },
      logger
    );

    if (!createImportResult.success) {
      logger.error('Failed to create import job', createImportResult.error);
      return internalError(createImportResult.error.message);
    }

    // Create the project entry immediately (marked as being imported)
    // For now, we'll create a placeholder Artifacts repo
    const artifactsRepoName = getArtifactsRepoName(namespace, slug);
    let repo: ArtifactsCreateResult;

    try {
      repo = await c.env.ARTIFACTS.create(artifactsRepoName);
    } catch (artifactsError) {
      // If repo already exists, try to get it and create a token
      const errorMessage = artifactsError instanceof Error ? artifactsError.message : "";
      if (errorMessage.includes("already exists")) {
        const existingRepo = await c.env.ARTIFACTS.get(artifactsRepoName);
        const tokenResult = await existingRepo.createToken("write", 86400 * 30); // 30 days
        repo = {
          name: existingRepo.name,
          remote: existingRepo.remote,
          token: tokenResult.plaintext,
        };
      } else {
        throw artifactsError;
      }
    }

    const project: ProjectEntry = {
      id: projectId,
      name: slug,
      slug,
      namespace,
      ownerId: userId,
      ownerType: 'user',
      remote: repo.remote,
      token: repo.token,
      createdAt: new Date().toISOString(),
      githubUrl: body.url,
      ...(parseGitHubRepo(body.url) ?? {}),
      githubDefaultBranch: branch,
      githubConnectedAt: new Date().toISOString(),
      githubConnectionStatus: "connected",
      visibility,
    };

    const setResult = await setProject(c.env.STATE, project, logger);
    if (!setResult.success) {
      logger.error('Failed to set project after import', setResult.error);
      return internalError(setResult.error.message);
    }

    // Queue the actual import job for background processing
    // TODO: This should be queued to a background worker
    // For now, we'll trigger it asynchronously
    processImportJob(c.env, project, importId, body.url, branch, logger);

    // Redirect to project page immediately (user will see import progress)
    if (!contentType.includes("application/json")) {
      return c.redirect(`/@${namespace.replace('@', '')}/${slug}?import=active`);
    }

    logger.info('Import queued', { namespace, slug, importId, url: body.url, visibility });
    return created({ 
      namespace, 
      slug, 
      importId,
      path: `/${namespace}/${slug}`,
      status: "queued",
      source: body.url, 
      visibility 
    });
  } catch (err) {
    logger.error("[import] Error:", err instanceof Error ? err : undefined);
    const message = err instanceof Error ? err.message : String(err);
    return internalError(message);
  }
});

// Background import processing (should be moved to a queue worker)
async function processImportJob(
  env: Env,
  project: ProjectEntry,
  importId: string,
  githubUrl: string,
  branch: string,
  logger: Logger
) {
  const { namespace, slug } = project;
  const artifactsRepoName = getArtifactsRepoName(namespace, slug);
  
  // Helper to check for cancellation
  const checkCancelled = async (): Promise<boolean> => {
    const isCancelled = await isImportCancelled(env.DB, namespace, slug, logger);
    if (isCancelled) {
      logger.info('Import cancelled by user', { namespace, slug });
      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "cancelled",
        logger,
        "Import cancelled by user"
      );
      // Clean up partial import
      await deleteImportJob(env.DB, namespace, slug, logger);
      // Release the rate limit lock
      await releaseImportLock(env.STATE, namespace, slug, logger);
    }
    return isCancelled;
  };
  
  try {
    // Check cancellation before starting
    if (await checkCancelled()) return;

    // Update status to cloning
    await updateImportStatus(env.DB, namespace, slug, "cloning", logger, "Cloning repository");

    // Check cancellation after status update
    if (await checkCancelled()) return;

    // Perform the actual import
    const depth = 10; // Default depth

    const importResult = await importFromGitHub(
      env.ARTIFACTS,
      artifactsRepoName,
      githubUrl,
      logger,
      branch,
      depth
    );

    if (!importResult.success) {
      // Check if it was cancelled during the operation
      if (await checkCancelled()) return;

      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "failed",
        logger,
        `Import failed: ${importResult.error.message}`
      );
      // Release the rate limit lock on failure
      await releaseImportLock(env.STATE, namespace, slug, logger);
      return;
    }

    // Check cancellation before updating project
    if (await checkCancelled()) return;

    // Update project with actual repo info
    const updatedProject: ProjectEntry = {
      ...project,
      remote: importResult.data.remote,
      token: importResult.data.token,
    };

    await setProject(env.STATE, updatedProject, logger);

    // Final cancellation check before completing
    if (await checkCancelled()) return;

    // Mark import as complete
    await updateImportStatus(
      env.DB,
      namespace,
      slug,
      "completed",
      logger,
      "Import completed successfully"
    );

    // Release the rate limit lock on completion
    await releaseImportLock(env.STATE, namespace, slug, logger);

    logger.info('Import completed', { namespace, slug, importId });
  } catch (error) {
    logger.error('Import job failed', error instanceof Error ? error : undefined, { namespace, slug });

    // Check if this was a cancellation
    const isCancelled = await isImportCancelled(env.DB, namespace, slug, logger);
    if (isCancelled) {
      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "cancelled",
        logger,
        "Import cancelled"
      );
      await deleteImportJob(env.DB, namespace, slug, logger);
    } else {
      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "failed",
        logger,
        `Import failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Release the rate limit lock on error
    await releaseImportLock(env.STATE, namespace, slug, logger);
  }
}

// GET /projects/:namespace/:slug/files - List files in project
app.get("/:namespace/:slug/files", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { namespace, slug } = c.req.param();

  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === 'NOT_FOUND') {
      return notFound("Project", `${namespace}/${slug}`);
    }
    logger.error('Failed to get project', projectResult.error);
    return internalError(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!canReadProject(project, userId, agentOwnerId)) return forbidden("Project access denied");

  const filesResult = await listFilesInRepo(project.remote, project.token, logger);
  if (!filesResult.success) {
    logger.error('Failed to list files in repo', filesResult.error);
    return internalError(filesResult.error.message);
  }

  logger.info('Project files listed', { namespace, slug, fileCount: filesResult.data.length });
  return ok({ 
    namespace,
    slug,
    path: `/${namespace}/${slug}`,
    files: filesResult.data 
  });
});

// GET /projects/:namespace/:slug/log - Get commit log
app.get("/:namespace/:slug/log", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { namespace, slug } = c.req.param();

  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === 'NOT_FOUND') {
      return notFound("Project", `${namespace}/${slug}`);
    }
    logger.error('Failed to get project', projectResult.error);
    return internalError(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!canReadProject(project, userId, agentOwnerId)) return forbidden("Project access denied");

  const depth = Number(c.req.query("depth") ?? 20);
  const logResult = await getCommitLog(project.remote, project.token, logger, depth);
  if (!logResult.success) {
    logger.error('Failed to get commit log', logResult.error);
    return internalError(logResult.error.message);
  }

  logger.info('Commit log retrieved', { namespace, slug, depth, commitCount: logResult.data.length });
  return ok({ 
    namespace,
    slug,
    path: `/${namespace}/${slug}`,
    log: logResult.data 
  });
});

// GET /projects/:namespace/:slug/provenance - Get provenance records
app.get("/:namespace/:slug/provenance", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { namespace, slug } = c.req.param();

  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === 'NOT_FOUND') {
      return notFound("Project", `${namespace}/${slug}`);
    }
    logger.error('Failed to get project', projectResult.error);
    return internalError(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!canReadProject(project, userId, agentOwnerId)) return forbidden("Project access denied");

  const limitParam = c.req.query("limit");
  const limit = limitParam !== undefined ? Number(limitParam) : undefined;

  // Use project ID for provenance lookup
  const recordsResult = await listProvenance(c.env.DB, logger, project.id, limit);
  if (!recordsResult.success) {
    logger.error('Failed to list provenance', recordsResult.error);
    return internalError(recordsResult.error.message);
  }

  logger.info('Provenance listed', { namespace, slug, limit, recordCount: recordsResult.data.length });
  return ok({ 
    namespace,
    slug,
    path: `/${namespace}/${slug}`,
    records: recordsResult.data 
  });
});

// GET /projects/:namespace/:slug/import/status - Get import progress (for polling)
app.get("/:namespace/:slug/import/status", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

  const { namespace, slug } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");

  // Check if project exists and user has access
  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (!projectResult.success) {
    return notFound("Project", `${namespace}/${slug}`);
  }

  if (!canReadProject(projectResult.data, userId, agentOwnerId)) {
    return forbidden("Project access denied");
  }

  const progressResult = await getImportProgress(c.env.DB, namespace, slug, logger);
  if (!progressResult.success) {
    logger.error('Failed to get import progress', progressResult.error);
    return internalError(progressResult.error.message);
  }

  if (!progressResult.data) {
    return notFound("Import job", `${namespace}/${slug}`);
  }

  return ok(progressResult.data);
});

// GET /projects/:namespace/:slug/import/stream - SSE endpoint for real-time updates
app.get("/:namespace/:slug/import/stream", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

  const { namespace, slug } = c.req.param();

  // Check if project exists and user has access
  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (!projectResult.success) {
    return notFound("Project", `${namespace}/${slug}`);
  }

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  if (!canReadProject(projectResult.data, userId, agentOwnerId)) {
    return forbidden("Project access denied");
  }

  // Set up SSE response
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let interval: ReturnType<typeof setInterval> | null = null;
      let isClosed = false;
      
      // Cleanup function to ensure interval is always cleared
      const cleanup = () => {
        if (interval) {
          clearInterval(interval);
          interval = null;
        }
        if (!isClosed) {
          isClosed = true;
          try {
            controller.close();
          } catch {
            // Controller might already be closed, ignore
          }
        }
      };
      
      // Send status and check if we should continue
      const sendStatus = async (): Promise<boolean> => {
        if (isClosed) return false;
        
        try {
          const progressResult = await getImportProgress(c.env.DB, namespace, slug, logger);
          if (isClosed) return false; // Check again after async
          
          if (progressResult.success && progressResult.data) {
            const data = `data: ${JSON.stringify(progressResult.data)}\n\n`;
            controller.enqueue(encoder.encode(data));
            
            // Close stream if import is complete or failed
            if (["completed", "failed", "cancelled"].includes(progressResult.data.status)) {
              cleanup();
              return false;
            }
          }
          return true;
        } catch (error) {
          logger.error('Error sending SSE status', error instanceof Error ? error : undefined);
          cleanup();
          return false;
        }
      };

      // Send initial status (non-blocking)
      sendStatus().catch((error) => {
        logger.error('Error in initial SSE status', error instanceof Error ? error : undefined);
        cleanup();
      });

      // Poll every 2 seconds
      interval = setInterval(() => {
        sendStatus().catch((error) => {
          logger.error('Error in SSE interval', error instanceof Error ? error : undefined);
          cleanup();
        });
      }, 2000);

      // Cleanup on abort
      c.req.raw.signal.addEventListener("abort", cleanup, { once: true });
    },
  });

  return c.body(stream);
});

// POST /projects/:namespace/:slug/import/retry - Retry failed import
// Same rate limiting as initial import
app.post("/:namespace/:slug/import/retry", importRateLimitMiddleware({
  importsPerWindow: 1,
  windowSeconds: 60,
  maxConcurrentPerProject: 1,
  projectLockSeconds: 300,
}), async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const username = c.get("username");
  if (!userId || !username) return unauthorized("Authentication required");

  const { namespace, slug } = c.req.param();
  const userNamespace = getUserNamespace(username);
  
  if (namespace !== userNamespace) {
    return forbidden("You can only retry imports in your own namespace");
  }

  // Get existing import progress
  const progressResult = await getImportProgress(c.env.DB, namespace, slug, logger);
  if (!progressResult.success) {
    logger.error('Failed to get import progress', progressResult.error);
    return internalError(progressResult.error.message);
  }

  if (!progressResult.data) {
    return notFound("Import job", `${namespace}/${slug}`);
  }

  const existing = progressResult.data;

  // Reset the import job
  const resetResult = await updateImportStatus(
    c.env.DB, 
    namespace, 
    slug, 
    "queued", 
    logger,
    "Import retry requested"
  );

  if (!resetResult.success) {
    logger.error('Failed to reset import job', resetResult.error);
    return internalError(resetResult.error.message);
  }

  // TODO: Re-queue the import job for processing

  logger.info('Import retry initiated', { namespace, slug });
  return ok({ 
    message: "Import retry initiated",
    namespace,
    slug,
    status: "queued"
  });
});

// POST /projects/:namespace/:slug/sync - Re-sync with GitHub
app.post("/:namespace/:slug/sync", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const username = c.get("username");
  if (!userId || !username) return unauthorized("Authentication required");

  const { namespace, slug } = c.req.param();
  const userNamespace = getUserNamespace(username);
  
  if (namespace !== userNamespace) {
    return forbidden("You can only sync projects in your own namespace");
  }

  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === 'NOT_FOUND') {
      return notFound("Project", `${namespace}/${slug}`);
    }
    logger.error('Failed to get project', projectResult.error);
    return internalError(projectResult.error.message);
  }

  const project = projectResult.data;

  if (!project.githubUrl) {
    return badRequest("Project is not connected to GitHub");
  }

  // Create a new import job for the sync
  const importId = generateProjectId();
  const createResult = await createImportJob(
    c.env.DB,
    {
      id: importId,
      projectId: project.id,
      namespace,
      slug,
      sourceUrl: project.githubUrl,
      branch: project.githubDefaultBranch || "main",
    },
    logger
  );

  if (!createResult.success) {
    logger.error('Failed to create sync job', createResult.error);
    return internalError(createResult.error.message);
  }

  // TODO: Queue the sync job for processing

  logger.info('Sync initiated', { namespace, slug, importId });
  return ok({
    message: "Sync initiated",
    namespace,
    slug,
    importId,
    status: "queued"
  });
});

// POST /projects/:namespace/:slug/import/cancel - Cancel ongoing import
// More lenient rate limiting: 5 cancels per minute per user
app.post("/:namespace/:slug/import/cancel", importRateLimitMiddleware({
  importsPerWindow: 5,
  windowSeconds: 60,
  maxConcurrentPerProject: 1,
  projectLockSeconds: 60, // Shorter lock for cancel operations
}), async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get('userId'),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const username = c.get("username");
  if (!userId || !username) return unauthorized("Authentication required");

  const { namespace, slug } = c.req.param();
  const userNamespace = getUserNamespace(username);
  
  if (namespace !== userNamespace) {
    return forbidden("You can only cancel imports in your own namespace");
  }

  const cancelResult = await cancelImportJob(c.env.DB, namespace, slug, logger);
  
  if (!cancelResult.success) {
    if (cancelResult.error.code === 'NOT_FOUND') {
      return notFound("Import job", `${namespace}/${slug}`);
    }
    if (cancelResult.error.code === 'INVALID_STATE') {
      return c.json({ error: cancelResult.error.message }, 400);
    }
    logger.error('Failed to cancel import', cancelResult.error);
    return internalError(cancelResult.error.message);
  }

  logger.info('Import cancellation requested', { namespace, slug });
  return ok({
    message: "Import cancellation requested",
    namespace,
    slug,
    status: "cancelling"
  });
});

export { app as projectsRouter };
