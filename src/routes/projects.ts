import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import {
  type GaugeRelease,
  SINGLE_CREATION_HOLD_TTL_MS,
  checkPrivateProjectGauge,
  gaugePath,
  releaseWhenSettled,
} from "../billing/private-project-gauge";
import {
  importRateLimitMiddleware,
  rateLimitMiddleware,
  releaseImportLock,
} from "../middleware/rate-limit";
import { emitEvent } from "../queue/events";
import { syncOrImportProject } from "../services/project-sync";
import {
  MAX_NATIVE_LOG_DEPTH,
  getCommitLogPreferNative,
  kvTagDetailCache,
  kvTreeListingCache,
  listFilesInRepoPreferNative,
} from "../storage/artifacts-reads";
import { recordAudit } from "../storage/audit";
import { captureDeletionTarget, isTargetDeleting } from "../storage/deletion";
import { createDeletionJob } from "../storage/deletion-jobs";
import { listProjectEvents } from "../storage/events";
import { recordGaugeCharge } from "../storage/gauge-index";
import {
  createBranchRef,
  deleteBranchRef,
  freshRepoToken,
  importFromGitHub,
  initAndPush,
  isValidBranchName,
  listRepoBranches,
  listRepoTags,
  resolveBranchRef,
} from "../storage/git-ops";
import {
  buildAuthConfig,
  parseRepoUrl,
  resolveAuthConfig,
  resolveDefaultBranch,
} from "../storage/git-providers";
import { projectPrincipal } from "../storage/github-installations";
import { finalizeImportSnapshot } from "../storage/import-finalize";
import {
  STALLED_THRESHOLD_MS,
  cancelImportJob,
  createImportJob,
  deleteImportJob,
  deleteImportJobById,
  getImportProgress,
  getLatestImportDepth,
  isImportCancelled,
  recoverStalledImport,
  updateImportStatus,
} from "../storage/imports";
import { getOrg, getOrgBySlug } from "../storage/orgs";
import {
  claimNamespace,
  confirmOwnerNamespace,
  releaseNamespaceClaim,
} from "../storage/project-namespace";
import { listProvenance } from "../storage/provenance";
import { writeSnapshotFromRepo } from "../storage/repo-snapshot";
import {
  getProjectById,
  getProjectByPath,
  listProjectsByNamespace,
  setProject,
} from "../storage/state";
import {
  checkForSyncUpdates,
  getProjectProvider,
  getProjectSourceUrl,
  getSyncStatus,
  setSyncInProgress,
  updateProjectAfterSync,
  updateProjectSyncError,
} from "../storage/sync";
import type {
  ArtifactsCreateResult,
  CredentialBinding,
  Env,
  ImportStatus,
  ProjectEntry,
} from "../types";
import { getArtifactsRepoName, getUserNamespace, projectDefaultBranch } from "../types";
import { getFileContent, isValidFilePath } from "../ui/file-content";
import {
  NEW_PROJECT_ERROR_INVALID_NAME,
  NEW_PROJECT_ERROR_INVALID_URL,
  NEW_PROJECT_ERROR_NAME_TAKEN,
  NEW_PROJECT_ERROR_PRIVATE_LIMIT,
  type NewProjectFormValues,
  newProjectError,
} from "../ui/pages/new-project";
import {
  type BindingContext,
  bindingAllowsCreateIn,
  bindingCoversProject,
  canReadProject,
  canWriteProject,
  credentialBindingFrom,
  effectiveOrgAccessLevel,
  filterReadableProjects,
  isBound,
  isDirectOwner,
} from "../utils/authz";
import type { AppError } from "../utils/errors";
import { getWaitUntil } from "../utils/execution-ctx";
import { createLogger } from "../utils/logger";
import type { Logger } from "../utils/logger";
import { readJsonWithLimit } from "../utils/request-body";
import {
  appError,
  badRequest,
  created,
  forbidden,
  internalError,
  notFound,
  ok,
  unauthorized,
} from "../utils/response";
import type { Result } from "../utils/result";
import {
  DEFAULT_CLONE_DEPTH,
  isStringRecord,
  isValidGitHubUrl,
  isValidNamespace,
  isValidRepoUrl,
  isValidSlug,
  slugify,
  validateCloneDepth,
} from "../utils/validation";
import { renderNewProjectPage } from "./form-pages";

const DEFAULT_FILES: Record<string, string> = {
  "README.md": "# My Project\n\nCreated with Stratum.\n",
  "src/index.ts": 'export function hello(): string {\n  return "hello world";\n}\n',
};

const app = new Hono<{ Bindings: Env }>();

// Project-create body carries an optional seed file set — no post-parse cap
// exists today, so this pre-parse ceiling is the only bound on it.
const MAX_PROJECT_CREATE_BODY_BYTES = 1024 * 1024;
// Import body is a repo URL + a few short fields.
const MAX_PROJECT_IMPORT_BODY_BYTES = 1024 * 1024;
// Same backstop rationale as MAX_ACCOUNT_DELETE_BODY_BYTES in routes/users.ts:
// only a short confirmation value is ever read back, so 1 MiB is headroom no
// legitimate request can reach rather than a limit anyone will meet.
const MAX_PROJECT_DELETE_BODY_BYTES = 1024 * 1024;

function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/\s]+?)(?:\.git|\/)?$/i);
  if (!match || !match[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2] };
}

// Helper to generate project ID
function generateProjectId(): string {
  return crypto.randomUUID();
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
    const parsed = await readJsonWithLimit<typeof body>(c, MAX_PROJECT_CREATE_BODY_BYTES, logger);
    if (parsed instanceof Response) return parsed;
    body = parsed;
  } else {
    const form = await c.req.parseBody();
    body = { name: form.name, visibility: form.visibility, seed: form.seed, org: form.org };
  }

  // A browser submitting the new-project form gets the form back with the
  // reason under the field it is about and its own values refilled, not a raw
  // JSON 400. Rendered from this request rather than redirected with the
  // values in the query, which would let a crafted link prefill the form (see
  // routes/form-pages.tsx).
  const isForm = !contentType.includes("application/json");
  const formName = typeof body.name === "string" ? body.name : undefined;
  const backToForm = (code: string, status: 400 | 409) =>
    renderNewProjectPage(
      c,
      logger,
      {
        error: newProjectError(code),
        values: { mode: "blank", ...(formName !== undefined ? { name: formName } : {}) },
      },
      status,
    );

  if (!isValidSlug(body.name)) {
    if (isForm) return backToForm(NEW_PROJECT_ERROR_INVALID_NAME, 400);
    return badRequest("name must be a 1-64 char alphanumeric slug");
  }

  // Optional org ownership: the project lives under the org's namespace and
  // access follows org/team membership instead of personal ownership.
  let owner: { id: string; type: "user" | "org" } = { id: userId, type: "user" };
  let namespace = getUserNamespace(username);
  if (body.org !== undefined && body.org !== "") {
    if (typeof body.org !== "string") return badRequest("org must be a string slug");
    const orgResult = await getOrgBySlug(c.env.DB, logger, body.org);
    if (!orgResult.success) return notFound("Organization", body.org);
    const org = orgResult.data;
    // An org requiring a second factor this session lacks grants nothing
    // (#256), nor does one whose IP allowlist excludes this request (#399);
    // the org-policy middlewares turn this 403 into the specific refusal.
    const accessLevel = await effectiveOrgAccessLevel(c.env.DB, org.id, userId);
    if (accessLevel !== "write" && accessLevel !== "admin") {
      return forbidden("Creating projects in this organization requires write access");
    }
    owner = { id: org.id, type: "org" };
    namespace = `@${org.slug}`;
  }

  // A bound token (#323) may create only inside its own org; a project-bound
  // token names one existing project and may create none.
  if (!bindingAllowsCreateIn(credentialBindingFrom(c), owner)) {
    return forbidden(
      "This token is limited to one project or organization and cannot create projects here",
    );
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

  const slug = slugify(String(body.name));

  // The private-project gauge (PRD §8). Every path that creates a private
  // project goes through the same check; see billing/private-project-gauge.ts.
  // An admission holds a slot until the `finally` at the bottom ends it, on
  // every exit: by then the project entry is either written (and counted) or
  // never will be.
  let gaugeSubjectId: string | undefined;
  let releaseGaugeHold: GaugeRelease | undefined;
  if (visibility === "private") {
    const gauge = await checkPrivateProjectGauge(c.env, logger, {
      actorUserId: userId,
      username,
      owner,
      targetNamespace: namespace,
      paths: [gaugePath(namespace, slug)],
      holdTtlMs: SINGLE_CREATION_HOLD_TTL_MS,
      waitUntil: getWaitUntil(c),
    });
    if (!gauge.admitted) {
      // A browser submitting the new-project form must land back on the
      // form, not on a raw JSON 403. The redirect carries a fixed code,
      // never the reason text, so the query string cannot inject copy.
      if (isForm) {
        return c.redirect(`/new?error=${NEW_PROJECT_ERROR_PRIVATE_LIMIT}`, 303);
      }
      return forbidden(gauge.reason);
    }
    gaugeSubjectId = gauge.gaugeSubjectId;
    releaseGaugeHold = gauge.release;
  }

  // The creation runs as one promise so it can be handed to `waitUntil` as
  // well as returned: a client that disconnects must not cancel it before the
  // `finally` releases the hold. See `releaseWhenSettled`.
  const creation = (async () => {
    try {
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

      // Validate slug length after slugification
      if (!isValidSlug(slug)) {
        if (isForm) return backToForm(NEW_PROJECT_ERROR_INVALID_NAME, 400);
        return badRequest("Slug too long (max 100 characters)");
      }
      const projectId = generateProjectId();

      // Check if project already exists
      const existingResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
      if (existingResult.success) {
        if (isForm) return backToForm(NEW_PROJECT_ERROR_NAME_TAKEN, 409);
        return badRequest(`Project '${slug}' already exists in your namespace`);
      }

      // Create Artifacts repo with namespaced name
      const artifactsRepoName = getArtifactsRepoName(namespace, slug);
      let repo: Awaited<ReturnType<typeof c.env.ARTIFACTS.create>>;
      try {
        repo = await c.env.ARTIFACTS.create(artifactsRepoName);
      } catch (artifactsError) {
        const msg =
          artifactsError instanceof Error ? artifactsError.message : String(artifactsError);
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

      const initResult = await initAndPush(
        repo.remote,
        repo.token,
        files,
        "Initial commit",
        logger,
      );
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
        ...(gaugeSubjectId !== undefined ? { gaugeSubjectId } : {}),
      };

      // The claim goes into D1 before the KV entry so a username change cannot
      // slip between the two; see storage/project-namespace.ts.
      if (owner.type === "user") {
        const claimed = await claimNamespace(
          c.env.DB,
          { ownerId: owner.id, namespace, slug },
          logger,
        );
        if (!claimed.success) return appError(claimed.error);
      }

      // Charged to the actor but stored under an org: index it under the actor so
      // the gauge can find it without walking their memberships. Written BEFORE the
      // project entry and fatal on failure, so a project charged to someone can
      // never exist without its index entry — a missing entry would be a silent,
      // repeatable under-count. The reverse order is harmless: an entry whose
      // project never lands is pruned as NOT_FOUND on the next count.
      if (owner.type === "org" && gaugeSubjectId !== undefined && gaugeSubjectId !== owner.id) {
        const indexed = await recordGaugeCharge(c.env.STATE, logger, {
          subjectId: gaugeSubjectId,
          namespace,
          slug,
          projectId,
        });
        if (!indexed.success) return internalError("Failed to record the private project charge");
      }

      const setResult = await setProject(c.env.STATE, project, logger);
      if (!setResult.success) {
        logger.error("Failed to set project", setResult.error);
        if (owner.type === "user") await releaseNamespaceClaim(c.env.DB, namespace, slug, logger);
        return internalError(setResult.error.message);
      }

      // The username on this request was read at auth time, before the repository
      // was created; see confirmOwnerNamespace for the rename it may have crossed.
      if (owner.type === "user") {
        const confirmed = await confirmOwnerNamespace(c.env, owner.id, project, logger);
        if (!confirmed.success) return appError(confirmed.error);
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
        project.id,
      );

      // A browser form lands on the new project; API callers keep the JSON body.
      // (The import endpoint below does the same.)
      if (!contentType.includes("application/json")) {
        return c.redirect(`/${namespace}/${slug}`, 303);
      }

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
    } finally {
      await releaseGaugeHold?.();
    }
  })();
  releaseWhenSettled(creation, () => releaseGaugeHold?.(), getWaitUntil(c));
  return creation;
});

/**
 * The projects `GET /api/projects` considers before the readability filter.
 * Never the authorization decision itself — `filterReadableProjects` still runs
 * over whatever this returns, binding included.
 */
async function listCandidateProjects(
  env: Env,
  binding: CredentialBinding,
  username: string,
  logger: Logger,
): Promise<Result<ProjectEntry[], AppError>> {
  switch (binding.kind) {
    case "unbound":
      return listProjectsByNamespace(env.STATE, getUserNamespace(username), logger);
    case "project": {
      const found = await getProjectById(env.STATE, binding.projectId, logger);
      if (found.success) return { success: true, data: [found.data] };
      // A bound project that is gone leaves the token inert, not erroring.
      if (found.error.code === "NOT_FOUND") return { success: true, data: [] };
      return found;
    }
    case "org": {
      // `getOrg` reports every failure as not-found; an empty list is the
      // fail-closed answer either way.
      const org = await getOrg(env.DB, logger, binding.orgId);
      if (!org.success) return { success: true, data: [] };
      return listProjectsByNamespace(env.STATE, `@${org.data.slug}`, logger);
    }
  }
}

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

  // An unbound caller lists their own namespace, as always. A bound token
  // (#323) lists what it is bound to instead — its personal namespace would
  // otherwise be filtered to nothing for an org- or foreign-project binding,
  // which tells the MCP `list_projects` tool "you have no projects".
  const binding = credentialBindingFrom(c);
  const projectsResult = await listCandidateProjects(c.env, binding, username, logger);

  if (!projectsResult.success) {
    logger.error("Failed to list projects", projectsResult.error);
    return internalError(projectsResult.error.message);
  }

  const projects = await filterReadableProjects(
    c.env.DB,
    projectsResult.data,
    binding,
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

  if (!(await canReadProject(c.env.DB, project, credentialBindingFrom(c), userId, agentOwnerId)))
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
  // Before the rate limiter: see `refuseBoundImport`.
  refuseBoundImport(),
  // Also before the rate limiter, for the same reason.
  requireImportTargetOwner("import projects"),
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

    // Set once the gauge admits a private import; the `finally` below ends its
    // hold on every exit, because by then the project entry is either written
    // (and counted) or never will be. The whole import runs as one promise
    // that is also handed to `waitUntil`, so a client that disconnects cannot
    // cancel it before that `finally` runs; see `releaseWhenSettled`.
    let releaseGaugeHold: GaugeRelease | undefined;
    const importing = (async () => {
      try {
        const userId = c.get("userId");
        const username = c.get("username");
        if (!userId || !username) return unauthorized("Authentication required");

        const { namespace, slug } = c.req.param();

        // Validate namespace format
        if (!isValidNamespace(namespace)) {
          return badRequest("Invalid namespace format");
        }

        // The new-project form posts here in import mode; like POST /, a refusal
        // the user can fix goes back to the form rather than to a JSON body.
        const isForm = !(c.req.header("content-type") ?? "").includes("application/json");
        // `importRateLimitMiddleware` has already taken this project's import
        // lock. A refusal starts no import, so it gives the lock back; otherwise
        // the user's corrected resubmission would be refused as "already
        // importing" until the lock's TTL ran out.
        //
        // The form is re-rendered from this request, with its own values, not
        // redirected with them in the query: a link that prefilled an import URL
        // could lure someone into importing a repository of the sender's choosing.
        const refuseToForm = async (
          code: string,
          values: NewProjectFormValues,
          status: 400 | 403 = 400,
        ) => {
          await releaseImportLock(c.env.STATE, namespace, slug, logger);
          return renderNewProjectPage(c, logger, { error: newProjectError(code), values }, status);
        };
        if (!isValidSlug(slug)) {
          if (isForm) {
            return refuseToForm(NEW_PROJECT_ERROR_INVALID_NAME, { mode: "import", name: slug });
          }
          return badRequest("Slug too long (max 100 characters)");
        }

        // The caller's own namespace, or an org they can write to (#406).
        // `requireImportTargetOwner` already refused anything else before the
        // rate limiter; resolved again here because the owner decides how the
        // project is recorded and charged below.
        const target = await resolveImportTargetOwner(c, namespace, "import projects", logger);
        if ("response" in target) return target.response;
        const owner = target.owner;

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
                    // The depth the job was created with, not a fresh literal —
                    // a re-trigger must not quietly shallow a full-history import.
                    depth: existingImport.data.depth ?? DEFAULT_CLONE_DEPTH,
                    initiatedBy: userId,
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
                    // Explicit, not left to processImportJob's DEFAULT_CLONE_DEPTH
                    // default: omitting it silently re-triggers a full-history
                    // import at depth 10, which is the bug this PR exists to fix.
                    existingImport.data.depth ?? DEFAULT_CLONE_DEPTH,
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
          const parsed = await readJsonWithLimit<typeof body>(
            c,
            MAX_PROJECT_IMPORT_BODY_BYTES,
            logger,
          );
          if (parsed instanceof Response) return parsed;
          body = parsed;
        } else {
          // Form data — pass depth through raw so validateCloneDepth can accept
          // both numeric strings and the "full" keyword.
          const formData = await c.req.parseBody();
          body = {
            url: formData.url,
            branch: formData.branch,
            depth: formData.depth,
            visibility: formData.visibility,
          };
        }

        // What the user typed, echoed back into the form on a refusal.
        const formValues = {
          mode: "import" as const,
          name: slug,
          ...(typeof body.url === "string" ? { url: body.url } : {}),
        };
        if (!isValidRepoUrl(body.url) && !isValidGitHubUrl(body.url)) {
          if (isForm) return refuseToForm(NEW_PROJECT_ERROR_INVALID_URL, formValues);
          return badRequest("url must be a valid repository URL from GitHub, GitLab, or Bitbucket");
        }

        // Validate clone depth (integer 1..MAX_CLONE_DEPTH, or 0 / "full" for
        // full history; absent -> DEFAULT_CLONE_DEPTH).
        const depthResult = validateCloneDepth(body.depth);
        if (!depthResult.valid) {
          return badRequest(depthResult.error);
        }
        const depth = depthResult.depth;

        // Resolve the branch to import. An explicitly requested branch is
        // authoritative; otherwise ask the provider for the repository's real
        // default branch (falling back to "main" with a warning if the provider
        // lookup fails — see resolveDefaultBranch for the fail-open rationale).
        const requestedBranch =
          typeof body.branch === "string" && body.branch.trim().length > 0
            ? body.branch.trim()
            : undefined;
        const branch =
          requestedBranch ??
          (await resolveDefaultBranch(body.url, c.env, logger, { type: "user", id: userId }));

        // Validate visibility if provided
        let visibility: "private" | "public" = "private";
        if (body.visibility !== undefined) {
          if (body.visibility !== "private" && body.visibility !== "public") {
            return badRequest("visibility must be 'private' or 'public'");
          }
          visibility = body.visibility;
        }

        // The same private-project gauge as POST / — an import is another way to
        // create one. Checked before the import job row or the repository exists,
        // so a refusal leaves nothing behind.
        let gaugeSubjectId: string | undefined;
        if (visibility === "private") {
          const gauge = await checkPrivateProjectGauge(c.env, logger, {
            actorUserId: userId,
            username,
            owner,
            targetNamespace: namespace,
            paths: [gaugePath(namespace, slug)],
            holdTtlMs: SINGLE_CREATION_HOLD_TTL_MS,
            waitUntil: getWaitUntil(c),
          });
          // A refusal took no hold, so there is nothing for the `finally` to
          // release; the form path gives back the import lock as well.
          if (!gauge.admitted) {
            if (isForm) return refuseToForm(NEW_PROJECT_ERROR_PRIVATE_LIMIT, formValues, 403);
            return forbidden(gauge.reason);
          }
          gaugeSubjectId = gauge.gaugeSubjectId;
          releaseGaugeHold = gauge.release;
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
            depth,
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
          ownerId: owner.id,
          ownerType: owner.type,
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
          ...(gaugeSubjectId !== undefined ? { gaugeSubjectId } : {}),
        };

        // Claim before the KV write, as project creation does. Only a personal
        // namespace is claimed: the claim exists to order a project write
        // against a USERNAME change, and an org slug is not renamed that way.
        if (owner.type === "user") {
          const claimed = await claimNamespace(
            c.env.DB,
            { ownerId: owner.id, namespace, slug },
            logger,
          );
          if (!claimed.success) return appError(claimed.error);
        }

        // Charged to the actor but stored under an org: index it under the
        // actor, written before the project entry and fatal on failure, exactly
        // as project creation does (see POST /).
        if (owner.type === "org" && gaugeSubjectId !== undefined && gaugeSubjectId !== owner.id) {
          const indexed = await recordGaugeCharge(c.env.STATE, logger, {
            subjectId: gaugeSubjectId,
            namespace,
            slug,
            projectId,
          });
          if (!indexed.success) {
            return internalError("Failed to record the private project charge");
          }
        }

        const setResult = await setProject(c.env.STATE, project, logger);
        if (!setResult.success) {
          logger.error("Failed to set project after import", setResult.error);
          if (owner.type === "user") {
            await releaseNamespaceClaim(c.env.DB, namespace, slug, logger);
          }
          return internalError(setResult.error.message);
        }

        // Same guard as project creation. The import job row created above is
        // never queued in this case; it ages out with cleanupOldImports.
        if (owner.type === "user") {
          const confirmed = await confirmOwnerNamespace(c.env, owner.id, project, logger);
          if (!confirmed.success) return appError(confirmed.error);
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
              depth,
              initiatedBy: userId,
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
            processImportJob(c.env, project, importId, body.url, branch, logger, depth).catch(
              (error) => {
                logger.error(
                  "Unhandled error in background import job",
                  error instanceof Error ? error : undefined,
                  {
                    namespace,
                    slug,
                    importId,
                  },
                );
              },
            ),
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
      } finally {
        await releaseGaugeHold?.();
      }
    })();
    releaseWhenSettled(importing, () => releaseGaugeHold?.(), getWaitUntil(c));
    return importing;
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
  depth: number = DEFAULT_CLONE_DEPTH,
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

    // Clone finished — surface the phase transition so the progress UI moves
    // off "cloning" while the project entry and snapshot are written.
    await updateImportStatus(
      env.DB,
      namespace,
      slug,
      "processing",
      logger,
      "Repository cloned, finalizing import",
    );

    // Built here, persisted below. `importCompleted: true` must not reach KV
    // until every way this run can still end in a non-terminal-success state
    // has been ruled out, or a cancelled import leaves behind a project entry
    // claiming it completed.
    const updatedProject: ProjectEntry = {
      ...project,
      remote: importResult.data.remote,
      importCompleted: true,
    };

    // Final cancellation check before completing
    if (await checkCancelled()) return;

    // Snapshot + file count, before the terminal status flip. See
    // finalizeImportSnapshot for why the ordering matters.
    await finalizeImportSnapshot(
      env,
      {
        remote: updatedProject.remote,
        namespace,
        slug,
        defaultBranch: projectDefaultBranch(updatedProject),
      },
      logger,
    );

    // Re-check: the snapshot walk clones the repo, so it is long enough for a
    // cancel to land inside it. Writing "completed" without re-checking would
    // silently overwrite that cancellation.
    if (await checkCancelled()) return;

    const setResult = await setProject(env.STATE, updatedProject, logger);
    if (!setResult.success) {
      // The entry write is the last thing standing between here and
      // "completed", so a discarded failure would report an import that
      // succeeded against a project KV still says was never imported.
      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "failed",
        logger,
        `Failed to update project: ${setResult.error.message}`,
      );
      await releaseImportLock(env.STATE, namespace, slug, logger);
      return;
    }

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

  if (!(await canReadProject(c.env.DB, project, credentialBindingFrom(c), userId, agentOwnerId)))
    return notFound("Project", `${project.namespace}/${project.slug}`);

  const readToken = await freshRepoToken(c.env.ARTIFACTS, project.remote, "read", logger);
  if (!readToken.success) return internalError(readToken.error.message);

  const ref = await resolveRequestedRef(c, project, readToken.data, logger);
  if ("response" in ref) return ref.response;

  const filesResult = await listFilesInRepoPreferNative(
    c.env.ARTIFACTS,
    project.remote,
    readToken.data,
    logger,
    ref.branch,
    project.id ? { treeCache: kvTreeListingCache(c.env.STATE, project.id, logger) } : {},
  );
  if (!filesResult.success) {
    logger.error("Failed to list files in repo", filesResult.error);
    return internalError(filesResult.error.message);
  }

  logger.info("Project files listed", {
    namespace,
    slug,
    ref: ref.branch,
    fileCount: filesResult.data.length,
  });
  return ok({
    namespace,
    slug,
    path: `/${namespace}/${slug}`,
    ref: ref.branch,
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

  if (!(await canReadProject(c.env.DB, project, credentialBindingFrom(c), userId, agentOwnerId)))
    return notFound("Project", `${project.namespace}/${project.slug}`);

  const readToken = await freshRepoToken(c.env.ARTIFACTS, project.remote, "read", logger);
  if (!readToken.success) return internalError(readToken.error.message);

  const ref = await resolveRequestedRef(c, project, readToken.data, logger);
  if ("response" in ref) return ref.response;

  const contentResult = await getFileContent(
    project.remote,
    readToken.data,
    filePath,
    logger,
    ref.branch,
    c.env.ARTIFACTS,
  );
  if (!contentResult.success) {
    return internalError(contentResult.error.message);
  }

  const result = contentResult.data;
  logger.info("File content retrieved", {
    namespace,
    slug,
    path: filePath,
    ref: ref.branch,
    kind: result.kind,
  });

  if (result.kind === "not-found") {
    return notFound("File", filePath);
  }

  if (result.kind === "content") {
    return ok({
      namespace,
      slug,
      path: filePath,
      ref: ref.branch,
      kind: "content",
      value: result.value,
    });
  }

  return ok({ namespace, slug, path: filePath, ref: ref.branch, kind: result.kind });
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

  if (!(await canReadProject(c.env.DB, project, credentialBindingFrom(c), userId, agentOwnerId)))
    return notFound("Project", `${project.namespace}/${project.slug}`);

  // A positive integer, at most the 50 commits the log has ever returned; any
  // other value (non-numeric, zero, negative) means the default.
  const requestedDepth = Number(c.req.query("depth") ?? 20);
  const depth =
    Number.isInteger(requestedDepth) && requestedDepth > 0
      ? Math.min(requestedDepth, MAX_NATIVE_LOG_DEPTH)
      : 20;
  const readToken = await freshRepoToken(c.env.ARTIFACTS, project.remote, "read", logger);
  if (!readToken.success) return internalError(readToken.error.message);

  const ref = await resolveRequestedRef(c, project, readToken.data, logger);
  if ("response" in ref) return ref.response;

  const logResult = await getCommitLogPreferNative(
    c.env.ARTIFACTS,
    project.remote,
    readToken.data,
    logger,
    depth,
    ref.branch,
  );
  if (!logResult.success) {
    logger.error("Failed to get commit log", logResult.error);
    return internalError(logResult.error.message);
  }

  logger.info("Commit log retrieved", {
    namespace,
    slug,
    depth,
    ref: ref.branch,
    commitCount: logResult.data.length,
  });
  return ok({
    namespace,
    slug,
    path: `/${namespace}/${slug}`,
    ref: ref.branch,
    log: logResult.data,
  });
});

// GET /projects/:namespace/:slug/tags - List git tags (annotated + lightweight).
// Annotated tags are dereferenced to their target commit; a tag whose target
// lies outside the shallow clone window comes back with `unresolvable: true`
// rather than failing the listing (#182).
app.get("/:namespace/:slug/tags", async (c) => {
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

  if (!(await canReadProject(c.env.DB, project, credentialBindingFrom(c), userId, agentOwnerId)))
    return notFound("Project", `${project.namespace}/${project.slug}`);

  const readToken = await freshRepoToken(c.env.ARTIFACTS, project.remote, "read", logger);
  if (!readToken.success) return internalError(readToken.error.message);
  const tagsResult = await listRepoTags(
    project.remote,
    readToken.data,
    logger,
    undefined,
    project.id ? { detailCache: kvTagDetailCache(c.env.STATE, project.id, logger) } : {},
  );
  if (!tagsResult.success) {
    logger.error("Failed to list tags", tagsResult.error);
    return internalError(tagsResult.error.message);
  }

  logger.info("Tags retrieved", { namespace, slug, tagCount: tagsResult.data.tags.length });
  return ok({
    namespace,
    slug,
    path: `/${namespace}/${slug}`,
    tags: tagsResult.data.tags,
    truncated: tagsResult.data.truncated,
    totalTagCount: tagsResult.data.totalTagCount,
  });
});

/**
 * Longest `POST /branches` body accepted. A branch request is two short
 * strings; anything larger is a client bug or an attempt to make the parser do
 * work, and every other JSON route in this codebase caps its body the same way.
 */
const MAX_BRANCH_BODY_BYTES = 4 * 1024;

/**
 * Recovers the branch name from a `DELETE .../branches/*` URL.
 *
 * Reads the RAW pathname rather than `c.req.path`, because the two decode
 * differently: Hono gives route params through `decodeURIComponent` but the
 * path through `decodeURI`, which leaves `%40` alone. A client that builds the
 * URL with `encodeURIComponent` — as this codebase's own UI does — therefore
 * sends `%40alice`, and matching a `/@alice/api/branches/` prefix against the
 * path finds nothing.
 *
 * So each segment is decoded here, and the anchor is the decoded
 * namespace/slug pair rather than a bare "branches" segment: a project whose
 * slug IS `branches` would otherwise match the slug and lop the name in half,
 * while taking the first match keeps a branch legitimately named
 * `refs/branches/x` intact.
 *
 * Decoding per segment also means `%2F` becomes a real `/`, so a client may
 * send a hierarchical name either way and gets the same branch.
 */
function branchNameFromPath(url: string, namespace: string, slug: string): string {
  let segments: string[];
  try {
    segments = new URL(url).pathname.split("/").map(decodeURIComponent);
  } catch {
    // A malformed percent-escape cannot name any branch; an empty name is
    // refused by the caller's validity check.
    return "";
  }
  for (let i = 0; i + 2 < segments.length; i++) {
    if (segments[i] === namespace && segments[i + 1] === slug && segments[i + 2] === "branches") {
      return segments.slice(i + 3).join("/");
    }
  }
  return "";
}

/**
 * For the import/sync routes authorized by "it is in your own namespace"
 * rather than through authz: a bound token (#323) additionally needs the
 * project to be inside its binding. Answered with the 404 those routes give a
 * missing project, so a binding does not reveal what else the account owns.
 * `null` means proceed.
 */
async function refuseOutsideBinding(
  c: { env: Env } & BindingContext,
  namespace: string,
  slug: string,
  logger: Logger,
): Promise<Response | null> {
  const binding = credentialBindingFrom(c);
  if (!isBound(binding)) return null;
  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (projectResult.success && bindingCoversProject(binding, projectResult.data)) return null;
  return notFound("Project", `${namespace}/${slug}`);
}

/**
 * Import creates (or re-triggers) a project in the caller's PERSONAL
 * namespace, which no bound token (#323) may create in.
 *
 * A middleware, ordered BEFORE `importRateLimitMiddleware`, rather than a check
 * in the handler: the limiter takes the per-project import lock and one of the
 * caller's import slots on the way in, and a refusal returned after it would
 * leave that lock held — so a bound token could block imports of projects it
 * cannot even see. A function declaration so it is hoisted above the route
 * registrations that use it.
 */
function refuseBoundImport(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    if (isBound(credentialBindingFrom(c))) {
      return forbidden(
        "This token is limited to one project or organization and cannot import projects",
      );
    }
    await next();
  };
}

/**
 * Who would own a project imported at `namespace`, if the caller may import
 * there at all (#406).
 *
 * The caller's own `@username` namespace, or an org namespace where the caller
 * has write access — the same rule `POST /api/projects` applies to `org`,
 * including the second-factor block. Usernames and org slugs share one `@name`
 * namespace space (`usernameNamespaceTaken`), so the two branches can never
 * both match a namespace. A missing org and an org the caller cannot write to
 * get the SAME 403, so the refusal does not reveal which org slugs exist.
 */
async function resolveImportTargetOwner(
  c: Context<{ Bindings: Env }>,
  namespace: string,
  verb: string,
  logger: Logger,
): Promise<{ owner: { id: string; type: "user" | "org" } } | { response: Response }> {
  const userId = c.get("userId");
  const username = c.get("username");
  if (!userId || !username) return { response: unauthorized("Authentication required") };

  if (namespace === getUserNamespace(username)) {
    return { owner: { id: userId, type: "user" } };
  }

  const refusal = {
    response: forbidden(
      `You can only ${verb} in your own namespace or in an organization you have write access to`,
    ),
  };
  if (!namespace.startsWith("@") || namespace.length < 2) return refusal;
  const orgResult = await getOrgBySlug(c.env.DB, logger, namespace.slice(1));
  if (!orgResult.success) return refusal;
  const org = orgResult.data;
  // An org requiring a second factor this session lacks grants nothing (#256),
  // nor does one whose IP allowlist excludes this request (#399), exactly as
  // on project creation.
  const accessLevel = await effectiveOrgAccessLevel(c.env.DB, org.id, userId);
  if (accessLevel !== "write" && accessLevel !== "admin") return refusal;
  return { owner: { id: org.id, type: "org" } };
}

/**
 * {@link resolveImportTargetOwner} as a middleware, ordered BEFORE the import
 * rate limiter for the reason given on {@link refuseBoundImport}: the limiter
 * takes the target project's import lock, so a refusal returned after it would
 * let anyone block an org's import of a slug for the lock's full duration.
 */
function requireImportTargetOwner(verb: string): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const logger = createLogger({ path: c.req.path, method: c.req.method });
    const resolved = await resolveImportTargetOwner(
      c,
      c.req.param("namespace") ?? "",
      verb,
      logger,
    );
    if ("response" in resolved) return resolved.response;
    await next();
  };
}

/**
 * {@link refuseOutsideBinding} for the import retry/delete/cancel routes, as a
 * middleware ordered before their rate limiters for the reason given on
 * {@link refuseBoundImport}: an out-of-binding call must not take the target
 * project's import lock.
 */
function requireImportTargetInBinding(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const logger = createLogger({ path: c.req.path, method: c.req.method });
    const refusal = await refuseOutsideBinding(
      c,
      c.req.param("namespace") ?? "",
      c.req.param("slug") ?? "",
      logger,
    );
    if (refusal) return refusal;
    await next();
  };
}

/** Loads a project and confirms the caller may WRITE to it.
 *
 * Non-writers get 404, not 403 — the same choice the other project-scoped
 * sub-resource routers make (`webhooks.ts`, `changes.ts`), so a private
 * project's existence is not disclosed by the status code. `agentOwnerId` is
 * passed through: agents are first-class contributors here, and a token
 * belonging to a writer's agent gets that writer's access.
 */
async function requireProjectWriter(
  c: {
    env: Env;
    get: (key: "userId" | "agentOwnerId") => string | undefined;
    req: { param: (key: string) => string };
  } & BindingContext,
  logger: Logger,
): Promise<{ project: ProjectEntry } | { response: Response }> {
  const namespace = c.req.param("namespace");
  const slug = c.req.param("slug");
  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") {
      return { response: notFound("Project", `${namespace}/${slug}`) };
    }
    logger.error("Failed to get project", projectResult.error);
    return { response: internalError(projectResult.error.message) };
  }
  const project = projectResult.data;

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  if (!(await canWriteProject(c.env.DB, project, credentialBindingFrom(c), userId, agentOwnerId))) {
    return { response: notFound("Project", `${project.namespace}/${project.slug}`) };
  }
  // An import still in flight is pushing refs of its own, so the advertisement
  // a branch write reads is a moving target: the answer would be either "no
  // default branch yet" or a branch pinned to a tip the import is about to move
  // past. `importCompleted` is absent on legacy projects; absence means done.
  if (project.importCompleted === false) {
    return {
      response: c409("Project import is still in progress", "IMPORT_IN_PROGRESS"),
    };
  }
  return { project };
}

/** Maps a branch write refusal onto this API's status codes.
 *
 * There is no 422 in `src/utils/errors.ts`; invalid input is a 400 here, as it
 * is everywhere else in this codebase.
 */
function branchWriteFailureResponse(
  failure: { kind: string; name?: string; startPoint?: string; existing?: string },
  namespace: string,
  slug: string,
): Response {
  switch (failure.kind) {
    case "invalid-name":
      return badRequest(`Invalid branch name: ${failure.name}`);
    case "exists":
      return c409(`Branch already exists: ${failure.name}`, "BRANCH_EXISTS");
    case "conflicts-with":
      return c409(
        `Cannot create branch '${failure.name}': it collides with the existing branch '${failure.existing}'. Git stores refs as files, so one name cannot also be a directory containing the other.`,
        "BRANCH_NAME_CONFLICT",
      );
    case "no-default-branch":
      return c409(
        `This repository does not advertise its default branch ('${failure.name}'), so there is nothing to branch from.`,
        "NO_DEFAULT_BRANCH",
      );
    case "not-found":
      return notFound("Branch", `${namespace}/${slug}#${failure.name}`);
    case "default-branch":
      return c409(`Cannot delete the default branch: ${failure.name}`, "DEFAULT_BRANCH_PROTECTED");
    case "bad-start-point":
      return badRequest(
        `Start point not found in this repository: ${failure.startPoint}. Use a branch name or a full 40-character commit sha that the repository already contains. Tag names are not accepted.`,
      );
    default:
      return internalError("Branch operation failed");
  }
}

/** Who to credit an audited branch write to. An agent token carries its
 * owner's id, so the acting user is still recorded — the actor TYPE is what
 * distinguishes the two, and an audit trail that flattened them would lose the
 * distinction the provenance model exists to keep. */
function auditActor(c: {
  get: (key: "userId" | "agentOwnerId") => string | undefined;
}): { actorType: "user" | "agent"; actorId?: string } {
  const agentOwnerId = c.get("agentOwnerId");
  const actorId = c.get("userId") ?? agentOwnerId;
  return {
    actorType: agentOwnerId !== undefined ? "agent" : "user",
    ...(actorId !== undefined ? { actorId } : {}),
  };
}

/** A 409 carrying a machine-readable code, matching how the other routers
 * report conflicts (`{ error, code }` at 409). */
function c409(message: string, code: string): Response {
  return new Response(JSON.stringify({ error: message, code }), {
    status: 409,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Resolves a read route's `?ref=` query parameter to the branch it should read.
 *
 * Absent means the project's default branch, exactly as before this parameter
 * existed. Present means the ref must actually be a branch on the remote:
 * there is deliberately no fall back to the default, because serving the
 * default branch's tree under a URL that names another ref is the precise bug
 * ref-scoped browsing exists to avoid.
 *
 * Costs one ref advertisement (two subrequests) when a ref is given, and
 * nothing at all when it is not — so the common, unparameterized read is
 * unchanged.
 */
async function resolveRequestedRef(
  c: { env: Env; req: { query: (key: string) => string | undefined } },
  project: ProjectEntry,
  readToken: string,
  logger: Logger,
): Promise<{ branch: string } | { response: Response }> {
  // An empty `ref=` is treated as absent rather than as an invalid name: a GET
  // form that submits with nothing chosen sends exactly that, and answering a
  // browser's default submission with a 400 would be a worse contract than
  // reading it as "no preference".
  const requested = c.req.query("ref");
  if (requested === undefined || requested === "") {
    return { branch: projectDefaultBranch(project) };
  }

  const resolved = await resolveBranchRef(project.remote, readToken, logger, requested);
  if (resolved.success) return { branch: resolved.data.name };

  if (!("kind" in resolved.error)) {
    logger.error("Failed to resolve requested ref", resolved.error);
    return { response: internalError(resolved.error.message) };
  }
  switch (resolved.error.kind) {
    case "invalid":
      return { response: badRequest(`Invalid ref: ${resolved.error.name}`) };
    case "ambiguous":
      return {
        response: c409(
          `Ambiguous ref '${resolved.error.name}': it names both a branch and a tag. Browsing resolves branches only.`,
          "AMBIGUOUS_REF",
        ),
      };
    default:
      return {
        response: notFound("Branch", `${project.namespace}/${project.slug}#${resolved.error.name}`),
      };
  }
}

// GET /projects/:namespace/:slug/branches - List branches (#181).
// Reads the remote's ref advertisement — two subrequests, no clone — so this
// endpoint costs the same on a repo with three branches as on one with three
// thousand. See listRepoBranches for why a clone cannot answer this.
app.get("/:namespace/:slug/branches", async (c) => {
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

  if (!(await canReadProject(c.env.DB, project, credentialBindingFrom(c), userId, agentOwnerId)))
    return notFound("Project", `${project.namespace}/${project.slug}`);

  const readToken = await freshRepoToken(c.env.ARTIFACTS, project.remote, "read", logger);
  if (!readToken.success) return internalError(readToken.error.message);

  const defaultBranch = projectDefaultBranch(project);
  const branchesResult = await listRepoBranches(
    project.remote,
    readToken.data,
    logger,
    defaultBranch,
  );
  if (!branchesResult.success) {
    logger.error("Failed to list branches", branchesResult.error);
    return internalError(branchesResult.error.message);
  }

  logger.info("Branches retrieved", {
    namespace,
    slug,
    branchCount: branchesResult.data.branches.length,
  });
  return ok({
    namespace,
    slug,
    path: `/${namespace}/${slug}`,
    defaultBranch,
    branches: branchesResult.data.branches,
    truncated: branchesResult.data.truncated,
    totalBranchCount: branchesResult.data.totalBranchCount,
  });
});

// POST /projects/:namespace/:slug/branches - Create a branch (#181).
// The new ref can only ever point at an object the repository already holds, so
// this cannot introduce unevaluated content and the change gate is untouched —
// see createBranchRef, which is where that invariant is enforced.
app.post("/:namespace/:slug/branches", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const { namespace, slug } = c.req.param();
  const access = await requireProjectWriter(c, logger);
  if ("response" in access) return access.response;
  const { project } = access;

  if (await isTargetDeleting(c.env, project, logger)) {
    return c409("Project is being deleted", "TARGET_DELETING");
  }

  type BranchCreateBody = { name?: unknown; startPoint?: unknown };
  const parsed = await readJsonWithLimit<BranchCreateBody>(c, MAX_BRANCH_BODY_BYTES, logger).catch(
    (): BranchCreateBody => ({}),
  );
  if (parsed instanceof Response) return parsed;
  // `readJsonWithLimit` returns whatever JSON.parse produced, so a literal
  // `null` body throws nothing and arrives here — destructuring it is a
  // TypeError, i.e. a 500 for input that is merely malformed.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return badRequest("Request body must be a JSON object");
  }

  const { name, startPoint } = parsed;
  if (!isValidBranchName(name)) {
    return badRequest("Invalid branch name");
  }
  if (startPoint !== undefined && typeof startPoint !== "string") {
    return badRequest("startPoint must be a string");
  }

  const writeToken = await freshRepoToken(c.env.ARTIFACTS, project.remote, "write", logger);
  if (!writeToken.success) return internalError(writeToken.error.message);

  const createResult = await createBranchRef(project.remote, writeToken.data, logger, {
    name,
    ...(startPoint !== undefined ? { startPoint } : {}),
    defaultBranch: projectDefaultBranch(project),
  });
  if (!createResult.success) {
    if ("kind" in createResult.error) {
      return branchWriteFailureResponse(createResult.error, namespace, slug);
    }
    logger.error("Failed to create branch", createResult.error);
    return internalError(createResult.error.message);
  }

  await recordAudit(c.env.DB, logger, {
    action: "branch.created",
    ...auditActor(c),
    subject: `${project.namespace}/${project.slug}`,
    project,
    detail: { branch: createResult.data.name, oid: createResult.data.oid },
  });

  return created({ namespace, slug, branch: createResult.data });
});

// DELETE /projects/:namespace/:slug/branches/* - Delete a branch (#181).
// Wildcard path so a hierarchical name (`release/2.x`) survives as real path
// segments. Hono decodes the path with decodeURI, not decodeURIComponent, so a
// percent-encoded `%2F` stays literal and is refused by the name guard.
app.delete("/:namespace/:slug/branches/*", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const { namespace, slug } = c.req.param();
  const access = await requireProjectWriter(c, logger);
  if ("response" in access) return access.response;
  const { project } = access;

  if (await isTargetDeleting(c.env, project, logger)) {
    return c409("Project is being deleted", "TARGET_DELETING");
  }

  const name = branchNameFromPath(c.req.url, namespace, slug);
  if (!isValidBranchName(name)) {
    return badRequest("Invalid branch name");
  }

  const writeToken = await freshRepoToken(c.env.ARTIFACTS, project.remote, "write", logger);
  if (!writeToken.success) return internalError(writeToken.error.message);

  const deleteResult = await deleteBranchRef(project.remote, writeToken.data, logger, {
    name,
    defaultBranch: projectDefaultBranch(project),
  });
  if (!deleteResult.success) {
    if ("kind" in deleteResult.error) {
      return branchWriteFailureResponse(deleteResult.error, namespace, slug);
    }
    logger.error("Failed to delete branch", deleteResult.error);
    return internalError(deleteResult.error.message);
  }

  await recordAudit(c.env.DB, logger, {
    action: "branch.deleted",
    ...auditActor(c),
    subject: `${project.namespace}/${project.slug}`,
    project,
    detail: { branch: name },
  });

  return ok({ namespace, slug, deleted: name });
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

  if (!(await canReadProject(c.env.DB, project, credentialBindingFrom(c), userId, agentOwnerId)))
    return notFound("Project", `${project.namespace}/${project.slug}`);

  const limitParam = c.req.query("limit");
  const limit = limitParam !== undefined ? Number(limitParam) : undefined;

  // Scope provenance by the canonical project_id (name is the legacy fallback).
  const recordsResult = await listProvenance(c.env.DB, logger, project.name, limit, {
    projectId: project.id,
  });
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

  if (!(await canReadProject(c.env.DB, project, credentialBindingFrom(c), userId, agentOwnerId)))
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

  if (
    !(await canReadProject(
      c.env.DB,
      projectResult.data,
      credentialBindingFrom(c),
      userId,
      agentOwnerId,
    ))
  )
    return notFound("Project", `${namespace}/${slug}`);

  const progressResult = await getImportProgress(c.env.DB, namespace, slug, logger);
  if (!progressResult.success) {
    logger.error("Failed to get import progress", progressResult.error);
    return internalError(progressResult.error.message);
  }

  if (!progressResult.data) {
    return notFound("Import job", `${namespace}/${slug}`);
  }

  // Check for stalled imports. 'queued' is excluded here because it means the
  // job has not been picked up yet rather than that it stopped progressing; the
  // scheduled sweep covers it under a longer grace period. 'cancelling' IS
  // included (#304): a cancel that the consumer never finished is the exact
  // state that left projects showing a CANCELLING badge indefinitely, and
  // `recoverStalledImport` already matches it in SQL — only this guard omitted it.
  if (["cloning", "processing", "syncing", "cancelling"].includes(progressResult.data.status)) {
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
  if (
    !(await canReadProject(
      c.env.DB,
      projectResult.data,
      credentialBindingFrom(c),
      userId,
      agentOwnerId,
    ))
  )
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
  // Before any limiter: see `requireImportTargetInBinding`.
  requireImportTargetInBinding(),
  requireImportTargetOwner("retry imports"),
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
    // Own namespace or a writable org (#406); `requireImportTargetOwner`
    // already refused anything else before the limiter. Kept here too so the
    // handler stays safe if its middleware list is ever reordered.
    const target = await resolveImportTargetOwner(c, namespace, "retry imports", logger);
    if ("response" in target) return target.response;

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
          depth: existing.depth ?? DEFAULT_CLONE_DEPTH,
          // Without this the retry path is the one case that never emails the
          // person waiting on the import — which is the gap this PR closes.
          initiatedBy: userId,
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
        processImportJob(
          c.env,
          projectResult.data,
          importId,
          githubUrl,
          branch,
          logger,
          existing.depth ?? DEFAULT_CLONE_DEPTH,
        ).catch((error) => {
          logger.error(
            "Unhandled error in background import retry",
            error instanceof Error ? error : undefined,
            { namespace, slug },
          );
        }),
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

/**
 * Statuses a user may delete. Deliberately narrower than "terminal": a
 * `completed` job is the record the next sync reads its clone depth from
 * (`getLatestImportDepth`), so removing it would silently downgrade a
 * full-history project to a shallow clone.
 */
const DELETABLE_IMPORT_STATUSES: readonly ImportStatus[] = ["failed", "cancelled"];

// POST /projects/:namespace/:slug/import/delete - Discard a finished import job
// so an abandoned failure stops rendering import chrome on the project page (#304).
app.post(
  "/:namespace/:slug/import/delete",
  // Before any limiter: see `requireImportTargetInBinding`.
  requireImportTargetInBinding(),
  requireImportTargetOwner("delete imports"),
  // A plain per-user limiter, NOT importRateLimitMiddleware: that one takes the
  // per-project import lock and only the import paths release it, so deleting a
  // dead job would 429 the user's next import for the lock's full duration —
  // and clearing a failed import is exactly what someone does right before
  // retrying. Deleting a terminal row starts no work worth serialising.
  rateLimitMiddleware({ requestsPerMinute: 20 }),
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
    // Own namespace or a writable org (#406); `requireImportTargetOwner`
    // already refused anything else before the limiter. Kept here too so the
    // handler stays safe if its middleware list is ever reordered.
    const target = await resolveImportTargetOwner(c, namespace, "delete imports", logger);
    if ("response" in target) return target.response;

    const progressResult = await getImportProgress(c.env.DB, namespace, slug, logger);
    if (!progressResult.success) {
      logger.error("Failed to get import progress", progressResult.error);
      return internalError(progressResult.error.message);
    }

    if (!progressResult.data) {
      return notFound("Import job", `${namespace}/${slug}`);
    }

    const existing = progressResult.data;

    if (!DELETABLE_IMPORT_STATUSES.includes(existing.status)) {
      // Removing a row the queue consumer still owns would orphan an in-flight
      // import, so a live job must be cancelled before it can be discarded.
      return c.json(
        {
          error: `Cannot delete an import with status: ${existing.status}. Cancel it first.`,
        },
        409,
      );
    }

    // Scoped to this job's id, not to namespace+slug: a project accumulates a
    // row per sync, and wiping them all would take the depth history with it.
    const deleteResult = await deleteImportJobById(
      c.env.DB,
      existing.id,
      DELETABLE_IMPORT_STATUSES,
      logger,
    );
    if (!deleteResult.success) {
      logger.error("Failed to delete import job", deleteResult.error);
      return internalError(deleteResult.error.message);
    }

    if (!deleteResult.data) {
      // Either another delete removed the row first, or a retry re-queued it
      // between the status check above and the delete.
      return notFound("Import job", `${namespace}/${slug}`);
    }

    logger.info("Import job deleted", { namespace, slug, importId: existing.id });
    return ok({ message: "Import deleted", namespace, slug });
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
  // Own namespace or a writable org (#406): an org-owned import is kept in
  // sync by the same people who could import it.
  const target = await resolveImportTargetOwner(c, namespace, "sync projects", logger);
  if ("response" in target) return target.response;

  const bindingRefusal = await refuseOutsideBinding(c, namespace, slug, logger);
  if (bindingRefusal) return bindingRefusal;

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

  // GitHub resolves per repo (App installation token, else GITHUB_TOKEN), so
  // it needs the owner/repo; an unparseable URL keeps the static credential.
  const parsedSource = parseRepoUrl(sourceUrl);
  const auth = parsedSource
    ? await resolveAuthConfig(provider, parsedSource.info, projectPrincipal(project), c.env, logger)
    : buildAuthConfig(provider, c.env);

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
  const branch = projectDefaultBranch(project);
  // Read BEFORE creating the job below: this looks up the most recent import
  // job for the project, and the one about to be created would become that,
  // so the lookup would read back the value it is trying to inherit.
  //
  // As on the webhook path, this depth reaches the fallback full import rather
  // than the incremental fetch, which uses its own SYNC_FETCH_DEPTH window
  // (see `syncOrImportProject`). It is still the recorded depth rather than a
  // literal, which is what the fallback needs.
  const inheritedDepth = await getLatestImportDepth(c.env.DB, namespace, slug, logger);
  const syncDepth = inheritedDepth ?? DEFAULT_CLONE_DEPTH;
  const createResult = await createImportJob(
    c.env.DB,
    {
      id: importId,
      projectId: project.id,
      namespace,
      slug,
      sourceUrl,
      branch,
      depth: syncDepth,
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
        depth: syncDepth,
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
      processSyncJob(c.env, project, importId, sourceUrl, branch, logger, syncDepth).catch(
        (error) => {
          logger.error(
            "Unhandled error in background sync job",
            error instanceof Error ? error : undefined,
            {
              namespace,
              slug,
              importId,
            },
          );
        },
      ),
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

  if (!(await canReadProject(c.env.DB, project, credentialBindingFrom(c), userId, agentOwnerId)))
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

// Background sync processing (queue-less fallback). Exported for testing.
export async function processSyncJob(
  env: Env,
  project: ProjectEntry,
  importId: string,
  sourceUrl: string,
  branch: string,
  logger: Logger,
  /**
   * Clone depth for the legacy import fallback below. Required rather than
   * defaulted: a default here is indistinguishable from a caller that forgot,
   * which is exactly how this path kept re-importing at depth 10.
   */
  depth: number,
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

    // #190: sync is an INCREMENTAL fetch into the existing Artifacts repo —
    // never delete-and-re-import, which destroyed Stratum-native commits and
    // orphaned workspace forks. Only projects with no recorded Artifacts remote
    // (initial import never completed, so no forks can exist) still take the
    // import path.
    const outcome = await syncOrImportProject(
      env.ARTIFACTS,
      {
        remote: project.remote,
        artifactsRepoName,
        sourceUrl,
        branch,
        depth,
        logContext: { namespace, slug },
      },
      logger,
    );
    const syncedRemote = outcome.remote;
    const syncError = outcome.error;

    if (syncError) {
      await updateProjectSyncError(env.STATE, project, `Sync failed: ${syncError.message}`, logger);
      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "failed",
        logger,
        `Sync failed: ${syncError.message}`,
      );
      return;
    }

    // Update project with new commit info
    // Get the latest commit SHA
    const provider = getProjectProvider(project);
    let latestCommit = project.lastSyncedCommit;

    if (provider) {
      try {
        const { getProvider } = await import("../storage/git-providers");
        const providerClient = getProvider(provider);
        const parsed = (await import("../storage/git-providers")).parseRepoUrl(sourceUrl);
        if (parsed) {
          const auth = await resolveAuthConfig(
            provider,
            parsed.info,
            projectPrincipal(project),
            env,
            logger,
          );
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

    // Update project. The remote only changes on the legacy full-import
    // fallback — incremental sync keeps the existing repo (and thus the
    // remote) stable. Persisting it here is required: otherwise the next sync
    // still sees the legacy remote and re-runs the destructive full import.
    await updateProjectAfterSync(
      env.STATE,
      { ...project, remote: syncedRemote },
      latestCommit || "unknown",
      logger,
    );

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
      { remote: syncedRemote, namespace, slug, defaultBranch: projectDefaultBranch(project) },
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
  // Before any limiter: see `requireImportTargetInBinding`.
  requireImportTargetInBinding(),
  requireImportTargetOwner("cancel imports"),
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
    // Own namespace or a writable org (#406); `requireImportTargetOwner`
    // already refused anything else before the limiter. Kept here too so the
    // handler stays safe if its middleware list is ever reordered.
    const target = await resolveImportTargetOwner(c, namespace, "cancel imports", logger);
    if ("response" in target) return target.response;

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

/**
 * Owner-only project deletion. Requires a confirm token that EXACTLY equals
 * `@namespace/slug` (no normalization) — this makes accidental deletion hard and
 * cross-user deletion impossible. Enqueues a durable job and best-effort drives
 * it now; the periodic sweep guarantees completion if this request dies.
 */
async function handleProjectDelete(c: Context<{ Bindings: Env }>) {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const namespace = c.req.param("namespace") ?? "";
  const slug = c.req.param("slug") ?? "";
  const isJson = c.req.header("content-type")?.includes("application/json") ?? false;

  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (!projectResult.success) {
    // 404 for a missing project — do not distinguish "not found" from
    // "not yours" to a non-owner (they get 404 below too).
    return notFound("Project", `${namespace}/${slug}`);
  }
  const project = projectResult.data;

  // Owner-only: mere write access (org member/team) is NOT enough — a 404 hides
  // the project's existence from non-owners.
  if (!isDirectOwner(project, credentialBindingFrom(c), userId, agentOwnerId)) {
    return notFound("Project", `${namespace}/${slug}`);
  }

  // Confirm token must EXACTLY equal "@namespace/slug".
  let confirm: unknown;
  if (isJson) {
    const body = await readJsonWithLimit<{ confirm?: unknown }>(
      c,
      MAX_PROJECT_DELETE_BODY_BYTES,
      logger,
    ).catch(() => ({}) as { confirm?: unknown });
    if (body instanceof Response) return body;
    confirm = body.confirm;
  } else {
    const form = await c.req.parseBody();
    confirm = form.confirm;
  }
  const expected = `${project.namespace}/${project.slug}`;
  if (confirm !== expected) {
    return badRequest(`Confirmation must exactly equal "${expected}"`);
  }

  const captured = await captureDeletionTarget(c.env, project, logger);
  if (!captured.success) {
    logger.error("Failed to capture deletion target", captured.error);
    return internalError(captured.error.message);
  }

  const jobResult = await createDeletionJob(c.env.DB, logger, {
    kind: "project",
    target: captured.data,
    targetId: project.id,
  });
  if (!jobResult.success) {
    logger.error("Failed to create deletion job", jobResult.error);
    return internalError(jobResult.error.message);
  }
  const { job, created } = jobResult.data;

  // A concurrent/repeated delete returns the in-flight job — the partial unique
  // index guarantees only one active cascade per project (atomic, no TOCTOU).
  if (!created) {
    logger.info("Project deletion already in flight", { namespace, slug, jobId: job.id });
    return isJson ? c.json({ status: "deleting", jobId: job.id }, 202) : c.redirect("/", 302);
  }

  // Route-level "requested" — the runner records "deletion.started" once the
  // cascade actually begins, so this must not duplicate that action.
  await recordAudit(c.env.DB, logger, {
    action: "deletion.requested",
    actorType: "user",
    actorId: userId,
    subject: job.id,
    project,
    detail: { kind: "project", namespace: project.namespace, slug: project.slug },
  });

  // Best-effort immediate drive; the sweep is authoritative.
  const { runDeletionJob } = await import("../queue/deletion-runner");
  c.executionCtx.waitUntil(
    runDeletionJob(c.env, job.id, logger).then((r) => {
      if (!r.success) logger.error("Project deletion drive failed", r.error);
    }),
  );

  logger.info("Project deletion enqueued", { namespace, slug, jobId: job.id });
  if (!isJson) {
    return c.redirect("/", 302);
  }
  return c.json({ status: "deleting", jobId: job.id }, 202);
}

app.delete("/:namespace/:slug", handleProjectDelete);
// Form-friendly alias for the UI "Danger Zone" (browsers can't send DELETE).
app.post("/:namespace/:slug/delete", handleProjectDelete);

export { app as projectsRouter };
