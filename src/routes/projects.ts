import { Hono } from "hono";
import { importRateLimitMiddleware, releaseImportLock } from "../middleware/rate-limit";
import { emitEvent } from "../queue/events";
import { listProjectEvents } from "../storage/events";
import {
  freshRepoToken,
  getCommitLog,
  importFromGitHub,
  initAndPush,
  listFilesInRepo,
} from "../storage/git-ops";
import { buildAuthConfig } from "../storage/git-providers";
import {
  cancelImportJob,
  createImportJob,
  deleteImportJob,
  getImportProgress,
  isImportCancelled,
  recoverStalledImport,
  updateImportStatus,
} from "../storage/imports";
import { getOrgAccessLevel, getOrgBySlug } from "../storage/orgs";
import { listProvenance } from "../storage/provenance";
import { writeSnapshotFromRepo } from "../storage/repo-snapshot";
import { getProjectByPath, listProjectsByNamespace, setProject } from "../storage/state";
import {
  checkForSyncUpdates,
  getProjectProvider,
  getProjectSourceUrl,
  getSyncStatus,
  setSyncInProgress,
  updateProjectAfterSync,
  updateProjectSyncError,
} from "../storage/sync";
import type { ArtifactsCreateResult, Env, ProjectEntry } from "../types";
import { getArtifactsRepoName } from "../types";
import { getFileContent, isValidFilePath } from "../ui/file-content";
import { canReadProject, filterReadableProjects } from "../utils/authz";
import { createLogger } from "../utils/logger";
import type { Logger } from "../utils/logger";
import {
  badRequest,
  created,
  forbidden,
  internalError,
  notFound,
  ok,
  unauthorized,
} from "../utils/response";
import {
  isStringRecord,
  isValidGitHubUrl,
  isValidNamespace,
  isValidRepoUrl,
  isValidSlug,
  slugify,
} from "../utils/validation";

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
  return username.startsWith("@") ? username : `@${username}`;
}

// POST /projects - Create a new project
// Body: { name: string, visibility?: "private" | "public", files?: Record<string, string>, seed?: boolean }
app.post("/", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const username = c.get("username");
  if (!userId || !username) return unauthorized("Authentication required");

  let body: {
    name?: unknown;
    files?: unknown;
    visibility?: unknown;
    seed?: unknown;
    org?: unknown;
  };
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    body = await c.req.json<typeof body>();
  } else {
    const form = await c.req.parseBody();
    body = { name: form.name, visibility: form.visibility, seed: form.seed, org: form.org };
  }

  if (!isValidSlug(body.name)) return badRequest("name must be a 1-64 char alphanumeric slug");

  // Optional org ownership: the project lives under the org's namespace and
  // access follows org/team membership instead of personal ownership.
  let owner: { id: string; type: "user" | "org" } = { id: userId, type: "user" };
  let namespace = getUserNamespace(username);
  if (body.org !== undefined && body.org !== "") {
    if (typeof body.org !== "string") return badRequest("org must be a string slug");
    const orgResult = await getOrgBySlug(c.env.DB, logger, body.org);
    if (!orgResult.success) return notFound("Organization", body.org);
    const org = orgResult.data;
    const accessLevel = await getOrgAccessLevel(c.env.DB, logger, org.id, userId);
    if (accessLevel !== "write" && accessLevel !== "admin") {
      return forbidden("Creating projects in this organization requires write access");
    }
    owner = { id: org.id, type: "org" };
    namespace = `@${org.slug}`;
  }

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

  const seed = body.seed === "true" || body.seed === true || c.req.query("seed") === "true";
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
    return badRequest("Slug too long (max 100 characters)");
  }
  const projectId = generateProjectId();

  // Check if project already exists
  const existingResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (existingResult.success) {
    return badRequest(`Project '${slug}' already exists in your namespace`);
  }

  // Create Artifacts repo with namespaced name
  const artifactsRepoName = getArtifactsRepoName(namespace, slug);
  let repo: Awaited<ReturnType<typeof c.env.ARTIFACTS.create>>;
  try {
    repo = await c.env.ARTIFACTS.create(artifactsRepoName);
  } catch (artifactsError) {
    const msg = artifactsError instanceof Error ? artifactsError.message : String(artifactsError);
    if (msg.includes("already exists")) {
      // Orphaned Artifacts repo from a previous failed attempt (KV write failed after Artifacts
      // create succeeded). Delete it and recreate — ARTIFACTS.get() returns a JsRpcStub where
      // property accesses are lazy JsRpcProperty objects that can't be used as plain strings.
      try {
        await c.env.ARTIFACTS.delete(artifactsRepoName);
        repo = await c.env.ARTIFACTS.create(artifactsRepoName);
      } catch (recoveryError) {
        logger.error(
          "Failed to delete and recreate Artifacts repo",
          recoveryError instanceof Error ? recoveryError : undefined,
          { artifactsRepoName, error: recoveryError },
        );
        return internalError(
          `Failed to recover repository: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        );
      }
    } else {
      logger.error(
        "Failed to create Artifacts repo",
        artifactsError instanceof Error ? artifactsError : undefined,
        { artifactsRepoName, msg },
      );
      return internalError(`Failed to create repository: ${msg}`);
    }
  }

  const initResult = await initAndPush(repo.remote, repo.token, files, "Initial commit", logger);
  if (!initResult.success) {
    logger.error("Failed to initialize and push repository", initResult.error);
    return internalError(initResult.error.message);
  }

  const project: ProjectEntry = {
    id: projectId,
    name: String(body.name),
    slug,
    namespace,
    ownerId: owner.id,
    ownerType: owner.type,
    remote: repo.remote,
    createdAt: new Date().toISOString(),
    visibility,
  };

  const setResult = await setProject(c.env.STATE, project, logger);
  if (!setResult.success) {
    logger.error("Failed to set project", setResult.error);
    return internalError(setResult.error.message);
  }

  logger.info("Project created", {
    projectId,
    namespace,
    slug,
    visibility,
  });

  await emitEvent(
    c.env.DB,
    c.env.EVENTS_QUEUE,
    { type: "project.created", project: project.name },
    { type: "user", id: userId },
    logger,
  );

  return created({
    id: projectId,
    name: project.name,
    namespace,
    slug,
    path: `/${namespace}/${slug}`,
    remote: repo.remote,
    commit: initResult.data,
    visibility,
  });
});

// GET /projects - List projects for the authenticated user
app.get("/", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
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
    logger.error("Failed to list projects", projectsResult.error);
    return internalError(projectsResult.error.message);
  }

  const projects = await filterReadableProjects(
    c.env.DB,
    projectsResult.data,
    userId,
    agentOwnerId,
  );
  logger.info("Projects listed", { count: projects.length });

  return ok({
    projects: projects.map(({ id, name, namespace, slug, remote, createdAt, visibility }) => ({
      id,
      name,
      namespace,
      slug,
      path: `/${namespace}/${slug}`,
      remote,
      createdAt,
      visibility,
    })),
  });
});

// GET /projects/:namespace/:slug - Get a specific project
app.get("/:namespace/:slug", async (c) => {
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
    return internalError(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId)))
    return notFound("Project", `${project.namespace}/${project.slug}`);

  logger.info("Project retrieved", { namespace, slug });
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
app.post(
  "/:namespace/:slug/import",
  importRateLimitMiddleware({
    importsPerWindow: 3,
    windowSeconds: 60,
    maxConcurrentPerProject: 1,
    projectLockSeconds: 300, // 5 minutes default import timeout
  }),
  async (c) => {
    const logger = createLogger({
      requestId: crypto.randomUUID(),
      userId: c.get("userId"),
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
        logger.info("Project already exists", { namespace, slug });

        // If the project exists but the import never completed, re-trigger it so the
        // user doesn't need to hunt for the "Retry Import" button after a rate-limit failure.
        const existingImport = await getImportProgress(c.env.DB, namespace, slug, logger);
        if (existingImport.success && existingImport.data) {
          const importStatus = existingImport.data.status;
          const isIncomplete = !["completed", "queued", "cloning", "processing"].includes(
            importStatus,
          );

          if (isIncomplete) {
            logger.info("Project exists with incomplete import — re-triggering", {
              namespace,
              slug,
              importStatus,
            });
            await updateImportStatus(
              c.env.DB,
              namespace,
              slug,
              "queued",
              logger,
              "Import re-triggered via form",
            );

            if (c.env.IMPORT_QUEUE) {
              try {
                const { queueImportJob } = await import("../queue/import-queue");
                await queueImportJob(c.env.IMPORT_QUEUE, {
                  importId: existingImport.data.id,
                  projectId: existingImport.data.projectId,
                  namespace,
                  slug,
                  githubUrl: existingImport.data.sourceUrl,
                  branch: existingImport.data.branch ?? "main",
                  depth: 10,
                });
              } catch (queueError) {
                logger.error(
                  "Failed to re-queue import on form re-submit",
                  queueError instanceof Error ? queueError : undefined,
                  { namespace, slug },
                );
                // Non-fatal — user can use the Retry button on the project page
              }
            } else {
              // No queue — fall back to direct processing
              const projectForRetry = existingProjectResult.data;
              c.executionCtx.waitUntil(
                processImportJob(
                  c.env,
                  projectForRetry,
                  existingImport.data.id,
                  existingImport.data.sourceUrl,
                  existingImport.data.branch ?? "main",
                  logger,
                ).catch((error) => {
                  logger.error(
                    "Unhandled error in background import re-trigger",
                    error instanceof Error ? error : undefined,
                    { namespace, slug },
                  );
                }),
              );
            }
          }
        }

        const contentType = c.req.header("content-type") || "";
        if (!contentType.includes("application/json")) {
          return c.redirect(`/@${namespace.replace("@", "")}/${slug}?import=active`);
        }
        return ok({
          namespace,
          slug,
          remote: existingProjectResult.data.remote,
          source: existingProjectResult.data.githubUrl,
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

      if (!isValidRepoUrl(body.url) && !isValidGitHubUrl(body.url))
        return badRequest("url must be a valid repository URL from GitHub, GitLab, or Bitbucket");

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
        logger,
      );

      if (!createImportResult.success) {
        logger.error("Failed to create import job", createImportResult.error);
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
          // Orphaned repo — delete and recreate to avoid JsRpcProperty on get() Stub fields.
          await c.env.ARTIFACTS.delete(artifactsRepoName);
          repo = await c.env.ARTIFACTS.create(artifactsRepoName);
        } else {
          throw artifactsError;
        }
      }

      // Detect provider and parse URL
      const { detectProvider, parseRepoUrl } = await import("../storage/git-providers");
      const provider = detectProvider(body.url);
      const parsedUrl = parseRepoUrl(body.url);

      // Parse GitHub repo for legacy field compatibility
      const parsedGitHub = parseGitHubRepo(body.url);

      const project: ProjectEntry = {
        id: projectId,
        name: slug,
        slug,
        namespace,
        ownerId: userId,
        ownerType: "user",
        remote: repo.remote,
        createdAt: new Date().toISOString(),
        // Legacy fields for backward compatibility
        githubUrl: body.url,
        githubOwner: parsedGitHub?.owner,
        githubRepo: parsedGitHub?.repo,
        githubDefaultBranch: branch,
        githubConnectedAt: new Date().toISOString(),
        githubConnectionStatus: "connected",
        // New generic provider fields
        sourceUrl: body.url,
        sourceProvider: provider || undefined,
        sourceOwner: parsedUrl?.info.owner,
        sourceRepo: parsedUrl?.info.repo,
        sourceDefaultBranch: branch,
        visibility,
        importCompleted: false,
      };

      const setResult = await setProject(c.env.STATE, project, logger);
      if (!setResult.success) {
        logger.error("Failed to set project after import", setResult.error);
        return internalError(setResult.error.message);
      }

      // Queue the actual import job for background processing using the queue if available
      if (c.env.IMPORT_QUEUE) {
        try {
          const { queueImportJob } = await import("../queue/import-queue");
          await queueImportJob(c.env.IMPORT_QUEUE, {
            importId,
            projectId,
            namespace,
            slug,
            githubUrl: body.url,
            branch,
            depth: 10,
          });
        } catch (queueError) {
          // Log queue error but don't fall back - queue exists but send() failed
          logger.error(
            "Failed to queue import job",
            queueError instanceof Error ? queueError : undefined,
            {
              namespace,
              slug,
              importId,
            },
          );
          // Update import status to failed before rethrowing
          await updateImportStatus(
            c.env.DB,
            namespace,
            slug,
            "failed",
            logger,
            `Failed to enqueue import job: ${queueError instanceof Error ? queueError.message : String(queueError)}`,
          );
          // Don't fall back to direct processing here - the queue exists but send failed,
          // which could lead to duplicate work. Let the client retry instead.
          throw queueError;
        }
      } else {
        // Queue not configured - fall back to direct processing
        logger.warn("IMPORT_QUEUE not configured, falling back to direct processing", {
          namespace,
          slug,
        });
        c.executionCtx.waitUntil(
          processImportJob(c.env, project, importId, body.url, branch, logger).catch((error) => {
            logger.error(
              "Unhandled error in background import job",
              error instanceof Error ? error : undefined,
              {
                namespace,
                slug,
                importId,
              },
            );
          }),
        );
      }

      // Redirect to project page immediately (user will see import progress)
      if (!contentType.includes("application/json")) {
        return c.redirect(`/@${namespace.replace("@", "")}/${slug}?import=active`);
      }

      logger.info("Import queued", { namespace, slug, importId, url: body.url, visibility });
      return created({
        namespace,
        slug,
        importId,
        path: `/${namespace}/${slug}`,
        status: "queued",
        source: body.url,
        visibility,
      });
    } catch (err) {
      logger.error("[import] Error:", err instanceof Error ? err : undefined);
      const message = err instanceof Error ? err.message : String(err);
      return internalError(message);
    }
  },
);

// Background import processing (should be moved to a queue worker)
async function processImportJob(
  env: Env,
  project: ProjectEntry,
  importId: string,
  githubUrl: string,
  branch: string,
  logger: Logger,
) {
  const { namespace, slug } = project;
  const artifactsRepoName = getArtifactsRepoName(namespace, slug);

  // Helper to check for cancellation
  const checkCancelled = async (): Promise<boolean> => {
    const isCancelled = await isImportCancelled(env.DB, namespace, slug, logger);
    if (isCancelled) {
      logger.info("Import cancelled by user", { namespace, slug });
      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "cancelled",
        logger,
        "Import cancelled by user",
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

    const depth = 10; // Default depth

    const importResult = await importFromGitHub(
      env.ARTIFACTS,
      artifactsRepoName,
      githubUrl,
      logger,
      branch,
      depth,
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
        `Import failed: ${importResult.error.message}`,
      );
      // Release the rate limit lock on failure
      await releaseImportLock(env.STATE, namespace, slug, logger);
      return;
    }

    // Check cancellation before updating project
    if (await checkCancelled()) return;

    // Update project with actual repo info and mark import as complete
    const updatedProject: ProjectEntry = {
      ...project,
      remote: importResult.data.remote,
      importCompleted: true,
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
      "Import completed successfully",
    );

    // Release the rate limit lock on completion
    await releaseImportLock(env.STATE, namespace, slug, logger);

    // Write repo snapshot to KV so page loads skip git clones going forward
    await writeSnapshotFromRepo(
      env.STATE,
      env.ARTIFACTS,
      { remote: updatedProject.remote, namespace, slug },
      logger,
    );

    logger.info("Import completed", { namespace, slug, importId });
  } catch (error) {
    logger.error("Import job failed", error instanceof Error ? error : undefined, {
      namespace,
      slug,
    });

    // Check if this was a cancellation
    const isCancelled = await isImportCancelled(env.DB, namespace, slug, logger);
    if (isCancelled) {
      await updateImportStatus(env.DB, namespace, slug, "cancelled", logger, "Import cancelled");
      await deleteImportJob(env.DB, namespace, slug, logger);
    } else {
      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "failed",
        logger,
        `Import failed: ${error instanceof Error ? error.message : String(error)}`,
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
    return internalError(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId)))
    return notFound("Project", `${project.namespace}/${project.slug}`);

  const readToken = await freshRepoToken(c.env.ARTIFACTS, project.remote, "read", logger);
  if (!readToken.success) return internalError(readToken.error.message);
  const filesResult = await listFilesInRepo(project.remote, readToken.data, logger);
  if (!filesResult.success) {
    logger.error("Failed to list files in repo", filesResult.error);
    return internalError(filesResult.error.message);
  }

  logger.info("Project files listed", { namespace, slug, fileCount: filesResult.data.length });
  return ok({
    namespace,
    slug,
    path: `/${namespace}/${slug}`,
    files: filesResult.data,
  });
});

// GET /projects/:namespace/:slug/content - Get file content by path
app.get("/:namespace/:slug/content", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { namespace, slug } = c.req.param();
  const filePath = c.req.query("path");

  if (!filePath) return badRequest("Missing required query parameter: path");
  if (!isValidFilePath(filePath)) return badRequest("Invalid file path");

  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") {
      return notFound("Project", `${namespace}/${slug}`);
    }
    return internalError(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId)))
    return notFound("Project", `${project.namespace}/${project.slug}`);

  const readToken = await freshRepoToken(c.env.ARTIFACTS, project.remote, "read", logger);
  if (!readToken.success) return internalError(readToken.error.message);
  const contentResult = await getFileContent(project.remote, readToken.data, filePath, logger);
  if (!contentResult.success) {
    return internalError(contentResult.error.message);
  }

  const result = contentResult.data;
  logger.info("File content retrieved", { namespace, slug, path: filePath, kind: result.kind });

  if (result.kind === "not-found") {
    return notFound("File", filePath);
  }

  if (result.kind === "content") {
    return ok({ namespace, slug, path: filePath, kind: "content", value: result.value });
  }

  return ok({ namespace, slug, path: filePath, kind: result.kind });
});

// GET /projects/:namespace/:slug/log - Get commit log
app.get("/:namespace/:slug/log", async (c) => {
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
    return internalError(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId)))
    return notFound("Project", `${project.namespace}/${project.slug}`);

  const depth = Number(c.req.query("depth") ?? 20);
  const readToken = await freshRepoToken(c.env.ARTIFACTS, project.remote, "read", logger);
  if (!readToken.success) return internalError(readToken.error.message);
  const logResult = await getCommitLog(project.remote, readToken.data, logger, depth);
  if (!logResult.success) {
    logger.error("Failed to get commit log", logResult.error);
    return internalError(logResult.error.message);
  }

  logger.info("Commit log retrieved", {
    namespace,
    slug,
    depth,
    commitCount: logResult.data.length,
  });
  return ok({
    namespace,
    slug,
    path: `/${namespace}/${slug}`,
    log: logResult.data,
  });
});

// GET /projects/:namespace/:slug/provenance - Get provenance records
app.get("/:namespace/:slug/provenance", async (c) => {
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
    return internalError(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId)))
    return notFound("Project", `${project.namespace}/${project.slug}`);

  const limitParam = c.req.query("limit");
  const limit = limitParam !== undefined ? Number(limitParam) : undefined;

  // Use project ID for provenance lookup
  const recordsResult = await listProvenance(c.env.DB, logger, project.id, limit);
  if (!recordsResult.success) {
    logger.error("Failed to list provenance", recordsResult.error);
    return internalError(recordsResult.error.message);
  }

  logger.info("Provenance listed", {
    namespace,
    slug,
    limit,
    recordCount: recordsResult.data.length,
  });
  return ok({
    namespace,
    slug,
    path: `/${namespace}/${slug}`,
    records: recordsResult.data,
  });
});

// GET /projects/:namespace/:slug/activity - Project activity feed (domain events)
app.get("/:namespace/:slug/activity", async (c) => {
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
    return internalError(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId)))
    return notFound("Project", `${project.namespace}/${project.slug}`);

  const limitParam = c.req.query("limit");
  const parsedLimit = limitParam !== undefined ? Number(limitParam) : Number.NaN;
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 50;

  const eventsResult = await listProjectEvents(c.env.DB, logger, project.name, limit);
  if (!eventsResult.success) {
    logger.error("Failed to list project events", eventsResult.error);
    return internalError(eventsResult.error.message);
  }

  logger.info("Activity listed", { namespace, slug, count: eventsResult.data.length });
  return ok({
    namespace,
    slug,
    path: `/${namespace}/${slug}`,
    events: eventsResult.data.map((event) => ({
      id: event.id,
      type: event.type,
      actorType: event.actorType,
      ...(event.actorId !== undefined ? { actorId: event.actorId } : {}),
      payload: event.payload,
      createdAt: event.createdAt,
    })),
  });
});

// GET /projects/:namespace/:slug/import/status - Get import progress (for polling)
app.get("/:namespace/:slug/import/status", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
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

  if (!(await canReadProject(c.env.DB, projectResult.data, userId, agentOwnerId)))
    return notFound("Project", `${namespace}/${slug}`);

  const progressResult = await getImportProgress(c.env.DB, namespace, slug, logger);
  if (!progressResult.success) {
    logger.error("Failed to get import progress", progressResult.error);
    return internalError(progressResult.error.message);
  }

  if (!progressResult.data) {
    return notFound("Import job", `${namespace}/${slug}`);
  }

  // Check for stalled imports (5 minute threshold)
  // Note: 'queued' is not included because it's a valid initial state that doesn't indicate progress
  const STALLED_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
  if (["cloning", "processing", "syncing"].includes(progressResult.data.status)) {
    const lastUpdatedAt = new Date(progressResult.data.updatedAt).getTime();
    const elapsedMs = Date.now() - lastUpdatedAt;

    if (elapsedMs > STALLED_THRESHOLD_MS) {
      logger.warn("Import appears stalled, attempting recovery", {
        namespace,
        slug,
        importId: progressResult.data.id,
        status: progressResult.data.status,
        elapsedMs,
      });

      const recoverResult = await recoverStalledImport(
        c.env.DB,
        namespace,
        slug,
        STALLED_THRESHOLD_MS,
        logger,
      );

      if (recoverResult.success && recoverResult.data) {
        // Re-fetch the progress after recovery
        const updatedResult = await getImportProgress(c.env.DB, namespace, slug, logger);
        if (updatedResult.success && updatedResult.data) {
          return ok(updatedResult.data);
        }
      }
    }
  }

  return ok(progressResult.data);
});

// GET /projects/:namespace/:slug/import/stream - SSE endpoint for real-time updates
app.get("/:namespace/:slug/import/stream", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
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
  if (!(await canReadProject(c.env.DB, projectResult.data, userId, agentOwnerId)))
    return notFound("Project", `${namespace}/${slug}`);

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
          logger.error("Error sending SSE status", error instanceof Error ? error : undefined);
          cleanup();
          return false;
        }
      };

      // Send initial status (non-blocking)
      sendStatus().catch((error) => {
        logger.error("Error in initial SSE status", error instanceof Error ? error : undefined);
        cleanup();
      });

      // Poll every 2 seconds
      interval = setInterval(() => {
        sendStatus().catch((error) => {
          logger.error("Error in SSE interval", error instanceof Error ? error : undefined);
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
app.post(
  "/:namespace/:slug/import/retry",
  importRateLimitMiddleware({
    importsPerWindow: 3,
    windowSeconds: 60,
    maxConcurrentPerProject: 1,
    projectLockSeconds: 300,
  }),
  async (c) => {
    const logger = createLogger({
      requestId: crypto.randomUUID(),
      userId: c.get("userId"),
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
      logger.error("Failed to get import progress", progressResult.error);
      return internalError(progressResult.error.message);
    }

    if (!progressResult.data) {
      return notFound("Import job", `${namespace}/${slug}`);
    }

    const existing = progressResult.data;

    const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
    if (!projectResult.success) {
      return notFound("Project", `${namespace}/${slug}`);
    }

    // Reset the import job to queued
    const resetResult = await updateImportStatus(
      c.env.DB,
      namespace,
      slug,
      "queued",
      logger,
      "Import retry requested",
    );

    if (!resetResult.success) {
      logger.error("Failed to reset import job", resetResult.error);
      return internalError(resetResult.error.message);
    }

    const githubUrl = existing.sourceUrl;
    const branch = existing.branch ?? "main";
    const importId = existing.id;

    if (c.env.IMPORT_QUEUE) {
      try {
        const { queueImportJob } = await import("../queue/import-queue");
        await queueImportJob(c.env.IMPORT_QUEUE, {
          importId,
          projectId: existing.projectId,
          namespace,
          slug,
          githubUrl,
          branch,
          depth: 10,
        });
      } catch (queueError) {
        logger.error(
          "Failed to re-queue import job",
          queueError instanceof Error ? queueError : undefined,
          { namespace, slug },
        );
        await updateImportStatus(
          c.env.DB,
          namespace,
          slug,
          "failed",
          logger,
          `Failed to re-queue: ${queueError instanceof Error ? queueError.message : String(queueError)}`,
        );
        return internalError("Failed to queue import job");
      }
    } else {
      // No queue — process synchronously in the background
      logger.warn("IMPORT_QUEUE not configured, falling back to direct processing", {
        namespace,
        slug,
      });
      c.executionCtx.waitUntil(
        processImportJob(c.env, projectResult.data, importId, githubUrl, branch, logger).catch(
          (error) => {
            logger.error(
              "Unhandled error in background import retry",
              error instanceof Error ? error : undefined,
              { namespace, slug },
            );
          },
        ),
      );
    }

    logger.info("Import retry initiated", { namespace, slug });
    return ok({
      message: "Import retry initiated",
      namespace,
      slug,
      status: "queued",
    });
  },
);

// POST /projects/:namespace/:slug/sync - Re-sync with remote repository (GitHub/GitLab/Bitbucket)
app.post("/:namespace/:slug/sync", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const username = c.get("username");
  if (!userId || !username) return unauthorized("Authentication required");

  const { namespace, slug } = c.req.param();
  const isJson = c.req.header("content-type")?.includes("application/json") ?? false;
  const userNamespace = getUserNamespace(username);

  if (namespace !== userNamespace) {
    return forbidden("You can only sync projects in your own namespace");
  }

  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") {
      return notFound("Project", `${namespace}/${slug}`);
    }
    logger.error("Failed to get project", projectResult.error);
    return internalError(projectResult.error.message);
  }

  const project = projectResult.data;
  const sourceUrl = getProjectSourceUrl(project);

  if (!sourceUrl) {
    if (!isJson) {
      return c.redirect(`/${namespace}/${slug}?sync=error&reason=no-source-url`);
    }
    return badRequest("Project is not connected to a remote repository");
  }

  const provider = getProjectProvider(project);
  if (!provider) {
    if (!isJson) {
      return c.redirect(`/${namespace}/${slug}?sync=error&reason=unsupported-provider`);
    }
    return badRequest(
      "Project source URL is not from a supported provider (GitHub, GitLab, or Bitbucket)",
    );
  }

  // Check if there's already a sync in progress
  const syncStatusResult = await getSyncStatus(c.env.STATE, namespace, slug, logger);
  if (syncStatusResult.success && syncStatusResult.data?.lastSyncStatus === "in_progress") {
    if (!isJson) {
      return c.redirect(`/${namespace}/${slug}?sync=error&reason=sync-in-progress`);
    }
    return badRequest("A sync is already in progress for this project");
  }

  // Set sync in progress
  await setSyncInProgress(c.env.STATE, namespace, slug, logger);

  // Build auth config from environment
  const auth = buildAuthConfig(provider, {
    GITHUB_TOKEN: c.env.GITHUB_TOKEN,
    GITLAB_TOKEN: c.env.GITLAB_TOKEN,
    BITBUCKET_TOKEN: c.env.BITBUCKET_TOKEN,
    BITBUCKET_USERNAME: c.env.BITBUCKET_USERNAME,
    BITBUCKET_APP_PASSWORD: c.env.BITBUCKET_APP_PASSWORD,
  });

  // Check for updates first
  const checkResult = await checkForSyncUpdates(c.env.STATE, project, auth, logger);
  if (!checkResult.success) {
    await updateProjectSyncError(c.env.STATE, project, checkResult.error.message, logger);
    if (!isJson) {
      return c.redirect(`/${namespace}/${slug}?sync=error&reason=check-failed`);
    }
    return internalError(checkResult.error.message);
  }

  if (!checkResult.data.hasUpdates) {
    logger.info("No updates available for project", { namespace, slug });
    if (!isJson) {
      return c.redirect(`/${namespace}/${slug}`);
    }
    return ok({
      message: "No updates available",
      namespace,
      slug,
      hasUpdates: false,
      lastSyncedCommit: project.lastSyncedCommit,
    });
  }

  // Create a new import job for the sync
  const importId = generateProjectId();
  const branch = project.sourceDefaultBranch || project.githubDefaultBranch || "main";
  const createResult = await createImportJob(
    c.env.DB,
    {
      id: importId,
      projectId: project.id,
      namespace,
      slug,
      sourceUrl,
      branch,
    },
    logger,
  );

  if (!createResult.success) {
    await updateProjectSyncError(c.env.STATE, project, createResult.error.message, logger);
    logger.error("Failed to create sync job", createResult.error);
    if (!isJson) {
      return c.redirect(`/${namespace}/${slug}?sync=error&reason=job-create-failed`);
    }
    return internalError(createResult.error.message);
  }

  // Queue the sync job for processing using the queue if available
  if (c.env.IMPORT_QUEUE) {
    try {
      const { queueSyncJob } = await import("../queue/import-queue");
      await queueSyncJob(c.env.IMPORT_QUEUE, {
        importId,
        projectId: project.id,
        namespace,
        slug,
        githubUrl: sourceUrl,
        branch,
        depth: 10,
        provider: provider ?? undefined,
      });
    } catch (queueError) {
      // Log queue error but don't fall back - queue exists but send() failed
      logger.error(
        "Failed to queue sync job",
        queueError instanceof Error ? queueError : undefined,
        {
          namespace,
          slug,
          importId,
        },
      );
      // Clear sync in-progress state and mark import as failed before rethrowing
      await updateProjectSyncError(
        c.env.STATE,
        project,
        `Failed to enqueue sync job: ${queueError instanceof Error ? queueError.message : String(queueError)}`,
        logger,
      );
      await updateImportStatus(
        c.env.DB,
        namespace,
        slug,
        "failed",
        logger,
        `Failed to enqueue sync job: ${queueError instanceof Error ? queueError.message : String(queueError)}`,
      );
      // Don't fall back to direct processing here - the queue exists but send failed,
      // which could lead to duplicate work. Let the client retry instead.
      throw queueError;
    }
  } else {
    // Queue not configured - fall back to direct processing
    logger.warn("IMPORT_QUEUE not configured for sync, falling back to direct processing", {
      namespace,
      slug,
    });
    c.executionCtx.waitUntil(
      processSyncJob(c.env, project, importId, sourceUrl, branch, logger).catch((error) => {
        logger.error(
          "Unhandled error in background sync job",
          error instanceof Error ? error : undefined,
          {
            namespace,
            slug,
            importId,
          },
        );
      }),
    );
  }

  logger.info("Sync initiated", {
    namespace,
    slug,
    importId,
    provider,
    commitsBehind: checkResult.data.commitsBehind,
    latestCommit: checkResult.data.latestCommit?.slice(0, 7),
  });

  if (!isJson) {
    return c.redirect(`/${namespace}/${slug}?sync=queued`);
  }
  return ok({
    message: "Sync initiated",
    namespace,
    slug,
    importId,
    status: "queued",
    hasUpdates: true,
    commitsBehind: checkResult.data.commitsBehind,
    latestCommit: checkResult.data.latestCommit,
  });
});

// GET /projects/:namespace/:slug/sync/status - Get sync status
app.get("/:namespace/:slug/sync/status", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { namespace, slug } = c.req.param();

  // Get project
  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") {
      return notFound("Project", `${namespace}/${slug}`);
    }
    logger.error("Failed to get project", projectResult.error);
    return internalError(projectResult.error.message);
  }

  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId)))
    return notFound("Project", `${namespace}/${slug}`);

  // Get detailed sync status
  const syncStatusResult = await getSyncStatus(c.env.STATE, namespace, slug, logger);
  const syncStatus = syncStatusResult.success ? syncStatusResult.data : null;

  // Get import progress if there's an active sync
  const importProgressResult = await getImportProgress(c.env.DB, namespace, slug, logger);
  const importProgress = importProgressResult.success ? importProgressResult.data : null;

  const sourceUrl = getProjectSourceUrl(project);
  const provider = getProjectProvider(project);

  logger.debug("Sync status retrieved", { namespace, slug });

  return ok({
    namespace,
    slug,
    sourceUrl,
    provider,
    lastSyncedAt: project.lastSyncedAt,
    lastSyncedCommit: project.lastSyncedCommit,
    lastSyncStatus: project.lastSyncStatus || "idle",
    lastSyncError: project.lastSyncError,
    autoSyncEnabled: project.autoSyncEnabled || false,
    hasUpdates: syncStatus?.hasUpdates,
    commitsBehind: syncStatus?.commitsBehind,
    latestCommit: syncStatus?.latestCommit,
    lastCheckedAt: syncStatus?.lastCheckedAt,
    importProgress: importProgress
      ? {
          status: importProgress.status,
          progress: importProgress.progress,
          logs: importProgress.logs.slice(-5), // Last 5 logs
          errors: importProgress.errors.length > 0 ? importProgress.errors : undefined,
        }
      : undefined,
  });
});

// Background sync processing
async function processSyncJob(
  env: Env,
  project: ProjectEntry,
  importId: string,
  sourceUrl: string,
  branch: string,
  logger: Logger,
) {
  const { namespace, slug } = project;
  const artifactsRepoName = getArtifactsRepoName(namespace, slug);

  try {
    // Update status to cloning
    await updateImportStatus(
      env.DB,
      namespace,
      slug,
      "cloning",
      logger,
      "Fetching updates from remote",
    );

    // Perform the sync import
    const depth = 10; // Default depth

    const importResult = await importFromGitHub(
      env.ARTIFACTS,
      artifactsRepoName,
      sourceUrl,
      logger,
      branch,
      depth,
    );

    if (!importResult.success) {
      await updateProjectSyncError(
        env.STATE,
        project,
        `Sync failed: ${importResult.error.message}`,
        logger,
      );
      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "failed",
        logger,
        `Sync failed: ${importResult.error.message}`,
      );
      return;
    }

    // Update project with new commit info
    // Get the latest commit SHA
    const provider = getProjectProvider(project);
    let latestCommit = project.lastSyncedCommit;

    if (provider) {
      const auth = buildAuthConfig(provider, {
        GITHUB_TOKEN: env.GITHUB_TOKEN,
        GITLAB_TOKEN: env.GITLAB_TOKEN,
        BITBUCKET_TOKEN: env.BITBUCKET_TOKEN,
      });

      try {
        const { getProvider } = await import("../storage/git-providers");
        const providerClient = getProvider(provider);
        const parsed = (await import("../storage/git-providers")).parseRepoUrl(sourceUrl);
        if (parsed) {
          const commitResult = await providerClient.getLatestCommit(
            parsed.info.owner,
            parsed.info.repo,
            branch,
            auth,
            logger,
          );
          if (commitResult.success && commitResult.data) {
            latestCommit = commitResult.data.sha;
          }
        }
      } catch (error) {
        logger.debug("Failed to get latest commit after sync", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Update project
    await updateProjectAfterSync(env.STATE, project, latestCommit || "unknown", logger);

    // Mark import as complete
    await updateImportStatus(
      env.DB,
      namespace,
      slug,
      "completed",
      logger,
      "Sync completed successfully",
    );

    // Write repo snapshot to KV so page loads skip git clones going forward
    await writeSnapshotFromRepo(
      env.STATE,
      env.ARTIFACTS,
      { remote: importResult.data.remote, namespace, slug },
      logger,
    );

    logger.info("Sync completed", { namespace, slug, importId });
  } catch (error) {
    logger.error("Sync job failed", error instanceof Error ? error : undefined, {
      namespace,
      slug,
    });

    await updateProjectSyncError(
      env.STATE,
      project,
      `Sync failed: ${error instanceof Error ? error.message : String(error)}`,
      logger,
    );

    await updateImportStatus(
      env.DB,
      namespace,
      slug,
      "failed",
      logger,
      `Sync failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// POST /projects/:namespace/:slug/import/cancel - Cancel ongoing import
// More lenient rate limiting: 5 cancels per minute per user
app.post(
  "/:namespace/:slug/import/cancel",
  importRateLimitMiddleware({
    importsPerWindow: 5,
    windowSeconds: 60,
    maxConcurrentPerProject: 1,
    projectLockSeconds: 60, // Shorter lock for cancel operations
  }),
  async (c) => {
    const logger = createLogger({
      requestId: crypto.randomUUID(),
      userId: c.get("userId"),
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
      if (cancelResult.error.code === "NOT_FOUND") {
        return notFound("Import job", `${namespace}/${slug}`);
      }
      if (cancelResult.error.code === "INVALID_STATE") {
        return c.json({ error: cancelResult.error.message }, 400);
      }
      logger.error("Failed to cancel import", cancelResult.error);
      return internalError(cancelResult.error.message);
    }

    const finalStatus = cancelResult.data.status;
    logger.info("Import cancellation requested", { namespace, slug, finalStatus });
    return ok({
      message: finalStatus === "cancelled" ? "Import cancelled" : "Import cancellation requested",
      namespace,
      slug,
      status: finalStatus,
    });
  },
);

export { app as projectsRouter };
