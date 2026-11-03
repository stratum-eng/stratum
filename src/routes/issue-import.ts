/**
 * GitHub issue import API (#421).
 *
 *   POST /api/projects/:namespace/:slug/issues/import/github  — queue an import
 *   GET  /api/projects/:namespace/:slug/issues/import/github  — latest run
 *
 * The POST is also the target of the settings page's "Import issues" form, so a
 * non-JSON request is answered with a redirect back to that page carrying a
 * fixed status code (see `issueImportNotice`) instead of JSON.
 *
 * The source repository is never caller-supplied: it is the project's own
 * GitHub source. The import reads GitHub with the instance's credential, which
 * may see repositories the caller cannot, so letting the caller name a repo
 * would turn this route into a way to read someone else's issues. For the same
 * reason a private source is refused until credentials are bound per owner.
 */

import { Hono } from "hono";
import { GitHubClient } from "../github/client";
import { enqueueIssueImportPage, githubRepoKey } from "../github/issue-import";
import { resolveIssueImportToken } from "../github/issue-import-credential";
import { recordAudit } from "../storage/audit";
import { isTargetDeleting } from "../storage/deletion";
import {
  createIssueImportRun,
  getLatestIssueImportRun,
  recordIssueImportProgress,
} from "../storage/github-issue-import";
import { getProjectByPath } from "../storage/state";
import type { Env, ProjectEntry } from "../types";
import {
  type BindingContext,
  canWriteProject,
  credentialBindingFrom,
  isProjectAdmin,
  refuseProjectAccess,
} from "../utils/authz";
import { createLogger } from "../utils/logger";
import type { Logger } from "../utils/logger";
import { internalError, notFound, ok, unauthorized } from "../utils/response";

const app = new Hono<{ Bindings: Env }>();

/**
 * Outcomes the settings page knows how to describe. The form round-trip carries
 * only one of these codes, never free text, so nothing a request controls is
 * ever rendered back.
 */
export const ISSUE_IMPORT_NOTICES = {
  queued: "Issue import queued. Refresh this page to follow its progress.",
  active: "An issue import is already running for this project.",
  "no-source": "This project has no GitHub source to import issues from.",
  incomplete: "The repository import has not finished yet; import issues after it completes.",
  private: "Issues can only be imported from public GitHub repositories for now.",
  "not-configured": "GitHub integration is not configured on this instance.",
  github: "GitHub could not be reached to check the repository. Try again shortly.",
  deleting: "This project is being deleted.",
  failed: "The import could not be queued. Try again shortly.",
} as const;

export type IssueImportNoticeCode = keyof typeof ISSUE_IMPORT_NOTICES;

/** The message for a `?issueImport=` code, or undefined for anything else. */
export function issueImportNotice(code: string | undefined): string | undefined {
  return code !== undefined && Object.hasOwn(ISSUE_IMPORT_NOTICES, code)
    ? ISSUE_IMPORT_NOTICES[code as IssueImportNoticeCode]
    : undefined;
}

function wantsJson(c: { req: { header: (name: string) => string | undefined } }): boolean {
  return c.req.header("content-type")?.includes("application/json") ?? false;
}

function settingsUrl(project: ProjectEntry, code: IssueImportNoticeCode): string {
  return `/${project.namespace}/${project.slug}/settings?issueImport=${code}#issue-import`;
}

type AccessContext = BindingContext & {
  env: Env;
  get(key: "userId"): string | undefined;
  req: { param(key: string): string };
};

/**
 * Resolve the project and require the caller to administer it. An import
 * writes every issue in a repository into the project at once and spends the
 * instance's GitHub quota, which is more than the write access opening a single
 * issue needs.
 */
async function requireAdmin(
  c: AccessContext,
  logger: Logger,
): Promise<{ project: ProjectEntry; userId: string } | { response: Response }> {
  const userId = c.get("userId");
  if (!userId) return { response: unauthorized("Only authenticated users can import issues") };

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
  const binding = credentialBindingFrom(c);
  if (!(await isProjectAdmin(c.env.DB, project, binding, userId))) {
    // A writer who is not an admin learns they lack the role (they can see the
    // project anyway); anyone else gets the same 404 as a missing project.
    const hidden = () => notFound("Project", `${project.namespace}/${project.slug}`);
    return {
      response: (await canWriteProject(c.env.DB, project, binding, userId))
        ? refuseProjectAccess(binding, project, hidden)
        : hidden(),
    };
  }
  return { project, userId };
}

// POST /api/projects/:namespace/:slug/issues/import/github — queue an import
app.post("/:namespace/:slug/issues/import/github", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });
  const access = await requireAdmin(c, logger);
  if ("response" in access) return access.response;
  const { project, userId } = access;
  const json = wantsJson(c);

  const refuse = (code: IssueImportNoticeCode, status: 400 | 403 | 409 | 502 | 503) =>
    json
      ? c.json({ error: ISSUE_IMPORT_NOTICES[code], code }, status)
      : c.redirect(settingsUrl(project, code), 302);

  if (await isTargetDeleting(c.env, project, logger)) return refuse("deleting", 409);
  // The code import is what proves the source was readable without the
  // instance's credential; until it has completed, nothing has.
  if (project.importCompleted === false) return refuse("incomplete", 409);

  const repoKey = githubRepoKey(project);
  if (repoKey === null) return refuse("no-source", 400);
  const [owner, repo] = repoKey.split("/") as [string, string];

  const token = await resolveIssueImportToken(c.env, project);
  if (!token.success) return refuse("not-configured", 503);

  const visibility = await new GitHubClient(token.data, logger).getRepoVisibility(owner, repo);
  if (!visibility.success) {
    logger.warn("Could not check GitHub repository visibility", { repo: repoKey });
    return refuse("github", 502);
  }
  if (visibility.private) return refuse("private", 403);

  const run = await createIssueImportRun(c.env.DB, logger, {
    projectId: project.id,
    githubRepo: repoKey,
    initiatedBy: userId,
  });
  if (!run.success) {
    return run.error.code === "IMPORT_ACTIVE" ? refuse("active", 409) : refuse("failed", 503);
  }

  const queued = await enqueueIssueImportPage(c.env.IMPORT_QUEUE, {
    runId: run.data.id,
    projectId: project.id,
    namespace: project.namespace,
    slug: project.slug,
    page: 1,
  });
  if (!queued.success) {
    logger.error("Failed to enqueue GitHub issue import", queued.error);
    // Release the project's one active slot rather than leave a run nobody
    // will ever pick up blocking the next attempt.
    await recordIssueImportProgress(c.env.DB, logger, run.data.id, {
      status: "failed",
      message: "The import could not be queued",
    });
    return refuse("failed", 503);
  }

  await recordAudit(c.env.DB, logger, {
    action: "issues.github_import_started",
    actorType: "user",
    actorId: userId,
    subject: run.data.id,
    project,
    detail: { project: project.name, githubRepo: repoKey },
  });

  return json ? c.json({ run: run.data }, 202) : c.redirect(settingsUrl(project, "queued"), 302);
});

// GET /api/projects/:namespace/:slug/issues/import/github — latest run, or null
app.get("/:namespace/:slug/issues/import/github", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });
  const access = await requireAdmin(c, logger);
  if ("response" in access) return access.response;
  const latest = await getLatestIssueImportRun(c.env.DB, logger, access.project.id);
  if (!latest.success) return internalError("Failed to load the issue import status");
  return ok({ run: latest.data });
});

export { app as issueImportRouter };
