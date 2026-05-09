/**
 * Bulk import API routes
 * Allows importing multiple repositories at once
 */

import { Hono } from "hono";
import { detectProvider, isValidRepoUrl, parseRepoUrl } from "../storage/git-providers";
import { createImportJob, updateImportStatus } from "../storage/imports";
import { getProjectByPath, setProject } from "../storage/state";
import type { ArtifactsCreateResult, BulkImportJob, Env, ProjectEntry } from "../types";
import { getArtifactsRepoName } from "../types";
import { createLogger } from "../utils/logger";
import { badRequest, created, forbidden, notFound, ok, unauthorized } from "../utils/response";
import { isValidNamespace, isValidSlug } from "../utils/validation";

const app = new Hono<{ Bindings: Env }>();

// In-memory storage for bulk import jobs (should be moved to D1 in production)
// Key: jobId, Value: BulkImportJob
const bulkImportJobs = new Map<string, BulkImportJob>();

/**
 * Individual repo import request
 */
interface RepoImportRequest {
  /** Repository URL to import */
  url: string;
  /** Optional custom namespace (defaults to user's namespace) */
  namespace?: string;
  /** Optional custom slug (defaults to repo name) */
  slug?: string;
  /** Branch to import (defaults to default branch) */
  branch?: string;
  /** Visibility setting */
  visibility?: "private" | "public";
}

/**
 * Helper to generate project ID
 */
function generateProjectId(): string {
  return crypto.randomUUID();
}

/**
 * Helper to get user's namespace
 */
function getUserNamespace(username: string): string {
  return username.startsWith("@") ? username : `@${username}`;
}

/**
 * Extract slug from repo name
 */
function extractSlugFromUrl(url: string): string | null {
  const parsed = parseRepoUrl(url);
  if (!parsed) return null;
  return parsed.info.repo.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();
}

/**
 * Process a single repo import (async background job)
 */
async function processRepoImport(
  env: Env,
  jobId: string,
  request: RepoImportRequest,
  ownerId: string,
  username: string,
  index: number,
  total: number,
): Promise<{ success: boolean; error?: string; repo: string }> {
  const logger = createLogger({
    requestId: jobId,
    userId: ownerId,
    path: `/api/bulk-import/${jobId}`,
    method: "POST",
  });

  const { url } = request;
  const namespace = request.namespace || getUserNamespace(username);
  const slug = request.slug || extractSlugFromUrl(url) || `repo-${index}`;
  const branch = request.branch || "main";
  const visibility = request.visibility || "private";

  // Update job progress
  const job = bulkImportJobs.get(jobId);
  if (job) {
    job.processedRepos++;
    bulkImportJobs.set(jobId, job);
  }

  try {
    // Validate namespace
    if (!isValidNamespace(namespace)) {
      return { success: false, error: "Invalid namespace", repo: url };
    }

    // Validate slug
    if (!isValidSlug(slug)) {
      return { success: false, error: "Invalid slug", repo: url };
    }

    // Check if project already exists
    const existingResult = await getProjectByPath(env.STATE, namespace, slug, logger);
    if (existingResult.success) {
      // Count as success since project exists
      job && job.successfulRepos++;
      return { success: true, repo: url };
    }

    // Generate IDs
    const projectId = generateProjectId();
    const importId = generateProjectId();

    // Create import job
    const createImportResult = await createImportJob(
      env.DB,
      {
        id: importId,
        projectId,
        namespace,
        slug,
        sourceUrl: url,
        branch,
      },
      logger,
    );

    if (!createImportResult.success) {
      job && job.failedRepos++;
      return { success: false, error: createImportResult.error.message, repo: url };
    }

    // Create Artifacts repo
    const artifactsRepoName = getArtifactsRepoName(namespace, slug);
    let repo: ArtifactsCreateResult;

    try {
      repo = await env.ARTIFACTS.create(artifactsRepoName);
    } catch (artifactsError) {
      const errorMessage = artifactsError instanceof Error ? artifactsError.message : "";
      if (errorMessage.includes("already exists")) {
        // Orphaned repo — delete and recreate to avoid JsRpcProperty on get() Stub fields.
        await env.ARTIFACTS.delete(artifactsRepoName);
        repo = await env.ARTIFACTS.create(artifactsRepoName);
      } else {
        throw artifactsError;
      }
    }

    // Detect provider
    const provider = detectProvider(url);

    // Create project entry
    const parsed = parseRepoUrl(url);
    const project: ProjectEntry = {
      id: projectId,
      name: slug,
      slug,
      namespace,
      ownerId,
      ownerType: "user",
      remote: repo.remote,
      token: repo.token,
      createdAt: new Date().toISOString(),
      sourceUrl: url,
      sourceProvider: provider || undefined,
      sourceOwner: parsed?.info.owner,
      sourceRepo: parsed?.info.repo,
      sourceDefaultBranch: branch,
      visibility,
    };

    const setResult = await setProject(env.STATE, project, logger);
    if (!setResult.success) {
      job && job.failedRepos++;
      return { success: false, error: setResult.error.message, repo: url };
    }

    // Mark as successful (actual import happens in background)
    await updateImportStatus(
      env.DB,
      namespace,
      slug,
      "queued",
      logger,
      `Bulk import job ${index + 1}/${total} queued`,
    );

    job && job.successfulRepos++;
    return { success: true, repo: url };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    job && job.failedRepos++;
    return { success: false, error: errorMessage, repo: url };
  }
}

/**
 * POST /api/bulk-import - Start a bulk import job
 * Body: { repos: Array<{ url: string, namespace?: string, slug?: string, branch?: string, visibility?: "private" | "public" }> }
 */
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

  const body = await c.req.json<{ repos?: RepoImportRequest[] }>();

  if (!body.repos || !Array.isArray(body.repos)) {
    return badRequest("repos must be an array");
  }

  if (body.repos.length === 0) {
    return badRequest("repos array cannot be empty");
  }

  if (body.repos.length > 50) {
    return badRequest("Maximum 50 repositories per bulk import");
  }

  // Validate all URLs
  const invalidUrls: string[] = [];
  for (const repo of body.repos) {
    if (!repo.url || typeof repo.url !== "string") {
      invalidUrls.push("missing-url");
    } else if (!isValidRepoUrl(repo.url)) {
      invalidUrls.push(repo.url);
    }
  }

  if (invalidUrls.length > 0) {
    return badRequest(`Invalid repository URLs: ${invalidUrls.join(", ")}`);
  }

  const userNamespace = getUserNamespace(username);

  // Create bulk import job
  const jobId = generateProjectId();
  const job: BulkImportJob = {
    id: jobId,
    namespace: userNamespace,
    ownerId: userId,
    status: "processing",
    totalRepos: body.repos.length,
    processedRepos: 0,
    successfulRepos: 0,
    failedRepos: 0,
    createdAt: new Date().toISOString(),
    errors: [],
  };

  bulkImportJobs.set(jobId, job);

  const repos = body.repos;

  logger.info("Bulk import job created", {
    jobId,
    totalRepos: repos.length,
  });

  // Process imports in background
  // Note: In production, this should be queued to a background worker
  const importPromises = repos.map((repoRequest, index) =>
    processRepoImport(c.env, jobId, repoRequest, userId, username, index, repos.length).then(
      (result) => {
        if (!result.success && result.error) {
          const currentJob = bulkImportJobs.get(jobId);
          if (currentJob) {
            currentJob.errors.push({
              repo: result.repo,
              error: result.error,
            });
          }
        }
        return result;
      },
    ),
  );

  // Wait for all imports to complete
  Promise.all(importPromises)
    .then(() => {
      const finalJob = bulkImportJobs.get(jobId);
      if (finalJob) {
        finalJob.completedAt = new Date().toISOString();

        if (finalJob.failedRepos === 0) {
          finalJob.status = "completed";
        } else if (finalJob.successfulRepos === 0) {
          finalJob.status = "failed";
        } else {
          finalJob.status = "partial";
        }

        bulkImportJobs.set(jobId, finalJob);

        logger.info("Bulk import job completed", {
          jobId,
          total: finalJob.totalRepos,
          successful: finalJob.successfulRepos,
          failed: finalJob.failedRepos,
        });
      }
    })
    .catch((error) => {
      logger.error("Bulk import job failed", error instanceof Error ? error : undefined, { jobId });
      const finalJob = bulkImportJobs.get(jobId);
      if (finalJob) {
        finalJob.status = "failed";
        finalJob.completedAt = new Date().toISOString();
        bulkImportJobs.set(jobId, finalJob);
      }
    });

  // Return immediately with job ID
  return created({
    jobId,
    status: "queued",
    totalRepos: body.repos.length,
    message: "Bulk import job started. Check status with GET /api/bulk-import/{jobId}",
  });
});

/**
 * GET /api/bulk-import/:id - Get bulk import job status
 */
app.get("/:id", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  if (!userId) return unauthorized("Authentication required");

  const jobId = c.req.param("id");
  const job = bulkImportJobs.get(jobId);

  if (!job) {
    return notFound("Bulk import job", jobId);
  }

  // Users can only view their own jobs
  if (job.ownerId !== userId) {
    return forbidden("You can only view your own bulk import jobs");
  }

  logger.debug("Bulk import job status retrieved", { jobId, status: job.status });

  return ok({
    jobId: job.id,
    status: job.status,
    totalRepos: job.totalRepos,
    processedRepos: job.processedRepos,
    successfulRepos: job.successfulRepos,
    failedRepos: job.failedRepos,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    errors: job.errors.length > 0 ? job.errors : undefined,
    progress: {
      percentage: Math.round((job.processedRepos / job.totalRepos) * 100),
      current: job.processedRepos,
      total: job.totalRepos,
    },
  });
});

/**
 * GET /api/bulk-import - List user's bulk import jobs
 */
app.get("/", async (c) => {
  const userId = c.get("userId");
  if (!userId) return unauthorized("Authentication required");

  // Filter jobs by user
  const userJobs: BulkImportJob[] = [];
  for (const job of bulkImportJobs.values()) {
    if (job.ownerId === userId) {
      userJobs.push(job);
    }
  }

  // Sort by creation date (newest first)
  userJobs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return ok({
    jobs: userJobs.map((job) => ({
      jobId: job.id,
      status: job.status,
      totalRepos: job.totalRepos,
      processedRepos: job.processedRepos,
      successfulRepos: job.successfulRepos,
      failedRepos: job.failedRepos,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      hasErrors: job.errors.length > 0,
    })),
  });
});

export { app as bulkImportRouter };
