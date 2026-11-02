/**
 * Bulk import API routes
 * Allows importing multiple repositories at once
 */

import { Hono } from "hono";
import { entitlementsEnabled } from "../billing/entitlements";
import { checkPrivateProjectGauge } from "../billing/private-project-gauge";
import {
  detectProvider,
  isValidRepoUrl,
  parseRepoUrl,
  resolveDefaultBranch,
} from "../storage/git-providers";
import { createImportJob, updateImportStatus } from "../storage/imports";
import {
  claimNamespace,
  confirmOwnerNamespace,
  releaseNamespaceClaim,
} from "../storage/project-namespace";
import { getProjectByPath, setProject } from "../storage/state";
import type { ArtifactsCreateResult, BulkImportJob, Env, ProjectEntry } from "../types";
import { getArtifactsRepoName, getUserNamespace } from "../types";
import { getWaitUntil } from "../utils/execution-ctx";
import { createLogger } from "../utils/logger";
import type { Logger } from "../utils/logger";
import { readJsonWithLimit } from "../utils/request-body";
import { badRequest, created, forbidden, notFound, ok, unauthorized } from "../utils/response";
import { isValidNamespace, isValidSlug, validateCloneDepth } from "../utils/validation";

const app = new Hono<{ Bindings: Env }>();

// At most 50 repo entries (enforced below), each a handful of short strings.
const MAX_BULK_IMPORT_BODY_BYTES = 1024 * 1024;

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
  /** Branch to import (defaults to the provider's default branch) */
  branch?: string;
  /** Clone depth: integer 1..1000, or 0 / "full" for full history (default 10) */
  depth?: number | string;
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
 * Extract slug from repo name
 */
function extractSlugFromUrl(url: string): string | null {
  const parsed = parseRepoUrl(url);
  if (!parsed) return null;
  return parsed.info.repo.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();
}

/** Where one requested repo would land, as {@link processRepoImport} resolves it. */
function importTarget(
  request: RepoImportRequest,
  username: string,
  index: number,
): { namespace: string; slug: string; visibility: "private" | "public" } {
  return {
    namespace: request.namespace || getUserNamespace(username),
    slug: request.slug || extractSlugFromUrl(request.url) || `repo-${index}`,
    visibility: request.visibility || "private",
  };
}

/**
 * How many private projects this batch would actually create: entries that
 * will fail the own-namespace or slug checks create nothing, and neither does
 * one whose project already exists (it is reported as a success untouched).
 * A re-run after a partial import is therefore not charged for what the first
 * run already made.
 */
async function countNewPrivateProjects(
  env: Env,
  logger: Logger,
  repos: RepoImportRequest[],
  username: string,
): Promise<number> {
  const own = getUserNamespace(username);
  const seen = new Set<string>();
  let count = 0;
  for (const [index, request] of repos.entries()) {
    const { namespace, slug, visibility } = importTarget(request, username, index);
    if (visibility !== "private" || namespace !== own || !isValidSlug(slug)) continue;
    // Two entries for the same slug make one project.
    if (seen.has(slug)) continue;
    seen.add(slug);
    const existing = await getProjectByPath(env.STATE, namespace, slug, logger);
    if (!existing.success) count++;
  }
  return count;
}

/**
 * Process a single repo import (async background job). Exported for tests.
 */
export async function processRepoImport(
  env: Env,
  jobId: string,
  request: RepoImportRequest,
  ownerId: string,
  username: string,
  index: number,
  total: number,
  gaugeSubjectId?: string,
): Promise<{ success: boolean; error?: string; repo: string }> {
  const logger = createLogger({
    requestId: jobId,
    userId: ownerId,
    path: `/api/bulk-import/${jobId}`,
    method: "POST",
  });

  const { url } = request;
  const { namespace, slug, visibility } = importTarget(request, username, index);

  // Update job progress
  const job = bulkImportJobs.get(jobId);
  if (job) {
    job.processedRepos++;
    bulkImportJobs.set(jobId, job);
  }

  try {
    // Validate namespace
    if (!isValidNamespace(namespace)) {
      job && job.failedRepos++;
      return { success: false, error: "Invalid namespace", repo: url };
    }

    // Ownership: a caller may only import into their OWN namespace. Without this
    // check a caller-supplied `namespace` could create a project (owned by them)
    // under another user's @handle or an org they aren't in — namespace squatting
    // / impersonation. Mirrors the single-import path in projects.ts.
    if (namespace !== getUserNamespace(username)) {
      job && job.failedRepos++;
      return {
        success: false,
        error: "You can only import projects into your own namespace",
        repo: url,
      };
    }

    // Validate slug
    if (!isValidSlug(slug)) {
      job && job.failedRepos++;
      return { success: false, error: "Invalid slug", repo: url };
    }

    // Validate clone depth
    const depthResult = validateCloneDepth(request.depth);
    if (!depthResult.valid) {
      job && job.failedRepos++;
      return { success: false, error: depthResult.error, repo: url };
    }
    const depth = depthResult.depth;

    // Check if project already exists
    const existingResult = await getProjectByPath(env.STATE, namespace, slug, logger);
    if (existingResult.success) {
      // Count as success since project exists
      job && job.successfulRepos++;
      return { success: true, repo: url };
    }

    // Resolve the branch to import: an explicitly requested branch wins;
    // otherwise ask the provider for the repository's real default branch
    // (fail-open to "main" — see resolveDefaultBranch).
    const branch = request.branch || (await resolveDefaultBranch(url, env, logger));

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
      createdAt: new Date().toISOString(),
      sourceUrl: url,
      sourceProvider: provider || undefined,
      sourceOwner: parsed?.info.owner,
      sourceRepo: parsed?.info.repo,
      sourceDefaultBranch: branch,
      visibility,
      ...(visibility === "private" && gaugeSubjectId !== undefined ? { gaugeSubjectId } : {}),
    };

    // Claim before the KV write, as project creation does.
    const claimed = await claimNamespace(env.DB, { ownerId, namespace, slug }, logger);
    if (!claimed.success) {
      job && job.failedRepos++;
      return { success: false, error: claimed.error.message, repo: url };
    }

    const setResult = await setProject(env.STATE, project, logger);
    if (!setResult.success) {
      job && job.failedRepos++;
      await releaseNamespaceClaim(env.DB, namespace, slug, logger);
      return { success: false, error: setResult.error.message, repo: url };
    }

    // The owner's username was read when the bulk job started; see
    // confirmOwnerNamespace for the rename it may have crossed since.
    const confirmed = await confirmOwnerNamespace(env, ownerId, project, logger);
    if (!confirmed.success) {
      job && job.failedRepos++;
      return { success: false, error: confirmed.error.message, repo: url };
    }

    // Enqueue the clone FIRST, then mark "queued" only once it's accepted — so a
    // queue outage surfaces as a "failed" repo, not a row stuck at "queued" forever.
    // (Without this enqueue the repo would never actually be imported.)
    try {
      const { queueImportJob } = await import("../queue/import-queue");
      await queueImportJob(env.IMPORT_QUEUE, {
        importId,
        projectId,
        namespace,
        slug,
        githubUrl: url,
        branch,
        depth,
        initiatedBy: ownerId,
      });
    } catch (queueError) {
      const msg = queueError instanceof Error ? queueError.message : String(queueError);
      logger.error(
        "Failed to enqueue bulk import job",
        queueError instanceof Error ? queueError : undefined,
        { namespace, slug },
      );
      await updateImportStatus(env.DB, namespace, slug, "failed", logger, `Enqueue failed: ${msg}`);
      job && job.failedRepos++;
      return { success: false, error: `Failed to enqueue import: ${msg}`, repo: url };
    }

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

  const body = await readJsonWithLimit<{ repos?: RepoImportRequest[] }>(
    c,
    MAX_BULK_IMPORT_BODY_BYTES,
    logger,
  );
  if (body instanceof Response) return body;

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

  // The private-project gauge, for the whole batch at once: the imports below
  // run concurrently, so checking each one would let a batch admitted one at a
  // time land well past the limit. A batch that does not fit is refused before
  // any of it is created. Gated first so a self-hoster pays no existence reads.
  let gaugeSubjectId: string | undefined;
  if (entitlementsEnabled(c.env)) {
    const adding = await countNewPrivateProjects(c.env, logger, body.repos, username);
    if (adding > 0) {
      const gauge = await checkPrivateProjectGauge(c.env, logger, {
        actorUserId: userId,
        username,
        owner: { id: userId, type: "user" },
        targetNamespace: userNamespace,
        waitUntil: getWaitUntil(c),
        adding,
      });
      if (!gauge.admitted) return forbidden(gauge.reason);
      gaugeSubjectId = gauge.gaugeSubjectId;
    }
  }

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
    processRepoImport(
      c.env,
      jobId,
      repoRequest,
      userId,
      username,
      index,
      repos.length,
      gaugeSubjectId,
    ).then((result) => {
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
    }),
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
