/**
 * Push mirror API (#417).
 *
 *   GET    /api/projects/:namespace/:slug/mirror         — configuration and status
 *   PUT    /api/projects/:namespace/:slug/mirror         — configure (JSON)
 *   POST   /api/projects/:namespace/:slug/mirror         — configure (JSON or form)
 *   DELETE /api/projects/:namespace/:slug/mirror         — remove
 *   POST   /api/projects/:namespace/:slug/mirror/delete  — remove (form)
 *   POST   /api/projects/:namespace/:slug/mirror/resume  — clear failed/diverged, push now
 *
 * Every route is admin-only. Configuring a mirror decides where a project's
 * whole history is published and switches the project out of layer mode, and
 * resuming one is the only thing that clears a divergence — neither is a
 * decision for everyone who can open a change.
 *
 * The POST routes are also the targets of the settings page's forms, so a
 * non-JSON request is answered with a redirect back to that page carrying a
 * fixed code (see {@link mirrorNotice}), never text the request supplied.
 */

import { Hono } from "hono";
import { requestPushMirror, sendNudge } from "../github/mirror";
import { openGitHubRemote, parseGitHubRepo } from "../github/remote";
import { recordAudit } from "../storage/audit";
import { isTargetDeleting } from "../storage/deletion";
import {
  type PushMirror,
  deletePushMirror,
  getPushMirror,
  hasPendingPush,
  resumePushMirror,
  upsertPushMirror,
} from "../storage/push-mirrors";
import { getProjectByPath } from "../storage/state";
import type { Env, ProjectEntry } from "../types";
import {
  type BindingContext,
  canWriteProject,
  credentialBindingFrom,
  isProjectAdmin,
  refuseProjectAccess,
} from "../utils/authz";
import type { AppError } from "../utils/errors";
import { createLogger } from "../utils/logger";
import type { Logger } from "../utils/logger";
import { readJsonWithLimit } from "../utils/request-body";
import { internalError, notFound, ok, unauthorized } from "../utils/response";

const app = new Hono<{ Bindings: Env }>();

const MAX_MIRROR_BODY_BYTES = 16 * 1024;

/** What the API and the settings page show for a mirror. */
export interface PushMirrorView {
  /** `owner/repo` on GitHub. */
  repo: string;
  url: string;
  enabled: boolean;
  state: PushMirror["state"];
  /** Whether a push is outstanding (requested, not yet completed). */
  pending: boolean;
  lastPushedSha: string | null;
  lastPushedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  /** When the next retry is due, while `state` is `retrying`. */
  nextAttemptAt: string | null;
  /** Consecutive failed attempts. */
  attempts: number;
}

/**
 * The public shape of a mirror row. Internal bookkeeping (the request counters,
 * the lease) stays out: it describes how the queue works, not the mirror.
 */
export function toPushMirrorView(mirror: PushMirror): PushMirrorView {
  return {
    repo: `${mirror.repoOwner}/${mirror.repoName}`,
    url: `https://github.com/${mirror.repoOwner}/${mirror.repoName}`,
    enabled: mirror.enabled,
    state: mirror.state,
    pending: hasPendingPush(mirror),
    lastPushedSha: mirror.lastPushedSha ?? null,
    lastPushedAt: mirror.lastPushedAt ?? null,
    lastAttemptAt: mirror.lastAttemptAt ?? null,
    lastError: mirror.lastError ?? null,
    nextAttemptAt: mirror.nextAttemptAt ?? null,
    attempts: mirror.attempts,
  };
}

/**
 * Outcomes the settings page knows how to describe. A form round-trip carries
 * one of these codes and nothing else.
 */
export const MIRROR_NOTICES = {
  saved: "Mirror saved. The first push has been queued.",
  disabled: "Mirror saved, and disabled. Nothing is pushed while it is disabled.",
  removed: "Mirror removed. The GitHub repository itself was not changed.",
  resumed: "Mirror resumed. A push has been queued.",
  none: "This project has no mirror configured.",
  "invalid-repo": "Enter the mirror as owner/repository, for example acme/widgets.",
  "not-configured":
    "The GitHub App is not configured on this instance. A push mirror needs it; ask the operator.",
  "not-installed":
    "The GitHub App is not installed on that repository. Install it there with the Contents permission set to read and write, then save again.",
  "not-authorized":
    "The GitHub App installation for that repository is not linked to this project's owner. Link it from the GitHub App setup page, then save again.",
  "no-permission":
    "The GitHub App does not have the Contents permission (read and write) on that repository. Grant it in the App's settings, accept the new permissions on the installation, then save again.",
  taken: "That repository is already connected to another Stratum project.",
  github: "GitHub could not be reached to check the repository. Try again shortly.",
  deleting: "This project is being deleted.",
  failed: "The mirror could not be saved. Try again shortly.",
} as const;

export type MirrorNoticeCode = keyof typeof MIRROR_NOTICES;

/** The message for a `?mirror=` code, or undefined for anything else. */
export function mirrorNotice(code: string | undefined): string | undefined {
  return code !== undefined && Object.hasOwn(MIRROR_NOTICES, code)
    ? MIRROR_NOTICES[code as MirrorNoticeCode]
    : undefined;
}

type RefusalStatus = 400 | 403 | 404 | 409 | 502 | 503;

/** Maps a refused credential to the notice that tells an admin what to fix. */
function credentialRefusal(error: AppError): { code: MirrorNoticeCode; status: RefusalStatus } {
  switch (error.code) {
    case "GITHUB_APP_NOT_CONFIGURED":
    case "GITHUB_APP_KEY_INVALID":
      return { code: "not-configured", status: 503 };
    case "GITHUB_APP_NOT_INSTALLED":
      return { code: "not-installed", status: 409 };
    case "GITHUB_APP_NOT_AUTHORIZED":
      return { code: "not-authorized", status: 403 };
    case "GITHUB_APP_PERMISSION_DENIED":
      return { code: "no-permission", status: 403 };
    case "GITHUB_REPO_NOT_CANONICAL":
      return { code: "taken", status: 409 };
    default:
      return { code: "github", status: 502 };
  }
}

function wantsJson(c: { req: { header: (name: string) => string | undefined } }): boolean {
  return c.req.header("content-type")?.includes("application/json") ?? false;
}

function settingsUrl(project: ProjectEntry, code: MirrorNoticeCode): string {
  return `/${project.namespace}/${project.slug}/settings?mirror=${code}#mirror`;
}

type AccessContext = BindingContext & {
  env: Env;
  get(key: "userId"): string | undefined;
  req: { param(key: string): string };
};

/**
 * Resolve the project and require the caller to administer it: its direct
 * owner, or an owner/admin of the org that owns it. Agents are refused — they
 * carry no `userId` — because an agent that could repoint a project's mirror
 * could publish its history anywhere its owner's App is installed.
 */
async function requireAdmin(
  c: AccessContext,
  logger: Logger,
): Promise<{ project: ProjectEntry; userId: string } | { response: Response }> {
  const userId = c.get("userId");
  if (!userId) return { response: unauthorized("Only authenticated users can manage a mirror") };

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

const routeLogger = (c: {
  get(key: "userId"): string | undefined;
  req: { path: string; method: string };
}): Logger =>
  createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

// GET /api/projects/:namespace/:slug/mirror — configuration and status, or null
app.get("/:namespace/:slug/mirror", async (c) => {
  const logger = routeLogger(c);
  const access = await requireAdmin(c, logger);
  if ("response" in access) return access.response;
  const mirror = await getPushMirror(c.env.DB, logger, access.project.id);
  if (!mirror.success) return internalError("Failed to load the mirror");
  return ok({ mirror: mirror.data ? toPushMirrorView(mirror.data) : null });
});

/**
 * Configure the mirror: PUT for API clients, POST for the settings form (an
 * HTML form cannot issue PUT) and for clients that prefer it.
 *
 * An enabled mirror is checked against GitHub before it is saved: the App must
 * be installed on the target, linked to the project's owner, and the project
 * must be able to become the repository's canonical target. Saving a mirror
 * that could never push would only move the error from this response, where an
 * admin is looking, to a `failed` state they find later.
 */
app.on(["PUT", "POST"], "/:namespace/:slug/mirror", async (c) => {
  const logger = routeLogger(c);
  const access = await requireAdmin(c, logger);
  if ("response" in access) return access.response;
  const { project, userId } = access;
  const json = wantsJson(c);

  const refuse = (code: MirrorNoticeCode, status: RefusalStatus) =>
    json
      ? c.json({ error: MIRROR_NOTICES[code], code }, status)
      : c.redirect(settingsUrl(project, code), 302);

  let repoInput: unknown;
  let enabled = true;
  if (json) {
    const parsed = await readJsonWithLimit<{ repo?: unknown; enabled?: unknown }>(
      c,
      MAX_MIRROR_BODY_BYTES,
      logger,
    ).catch(() => ({}) as { repo?: unknown; enabled?: unknown });
    if (parsed instanceof Response) return parsed;
    repoInput = parsed.repo;
    if (parsed.enabled !== undefined) enabled = parsed.enabled === true;
  } else {
    const form = await c.req.parseBody();
    repoInput = form.repo;
    // A checkbox is present when ticked and absent otherwise.
    enabled = form.enabled !== undefined;
  }

  const target = parseGitHubRepo(repoInput);
  if (target === null) return refuse("invalid-repo", 400);
  if (await isTargetDeleting(c.env, project, logger)) return refuse("deleting", 409);

  if (enabled) {
    const remote = await openGitHubRemote(c.env, project, target, "write", logger);
    if (!remote.success) {
      const refusal = credentialRefusal(remote.error);
      logger.info("Mirror not saved: no usable GitHub App credential for the target", {
        projectId: project.id,
        repo: `${target.owner}/${target.repo}`,
        code: remote.error.code,
      });
      return refuse(refusal.code, refusal.status);
    }
  }

  const saved = await upsertPushMirror(c.env.DB, logger, {
    projectId: project.id,
    namespace: project.namespace,
    slug: project.slug,
    repoOwner: target.owner,
    repoName: target.repo,
    enabled,
    configuredBy: userId,
  });
  if (!saved.success) {
    return saved.error.code === "MIRROR_TARGET_TAKEN"
      ? refuse("taken", 409)
      : refuse("failed", 503);
  }

  await recordAudit(c.env.DB, logger, {
    action: "mirror.configured",
    actorType: "user",
    actorId: userId,
    subject: project.id,
    project,
    detail: {
      project: project.name,
      repo: `${saved.data.repoOwner}/${saved.data.repoName}`,
      enabled,
    },
  });

  // The first push, or the catch-up after re-enabling. Requested, not run:
  // this response does not wait on a clone.
  if (enabled) await requestPushMirror(c.env, logger, project.id, "mirror configured");

  if (!json) return c.redirect(settingsUrl(project, enabled ? "saved" : "disabled"), 302);
  const current = await getPushMirror(c.env.DB, logger, project.id);
  return ok({
    mirror: toPushMirrorView(current.success && current.data ? current.data : saved.data),
  });
});

async function removeMirror(
  env: Env,
  logger: Logger,
  project: ProjectEntry,
  userId: string,
): Promise<{ removed: boolean } | { failed: true }> {
  const existing = await getPushMirror(env.DB, logger, project.id);
  const removed = await deletePushMirror(env.DB, logger, project.id);
  if (!removed.success) return { failed: true };
  if (removed.data) {
    await recordAudit(env.DB, logger, {
      action: "mirror.removed",
      actorType: "user",
      actorId: userId,
      subject: project.id,
      project,
      detail: {
        project: project.name,
        ...(existing.success && existing.data
          ? { repo: `${existing.data.repoOwner}/${existing.data.repoName}` }
          : {}),
      },
    });
  }
  return { removed: removed.data };
}

// DELETE /api/projects/:namespace/:slug/mirror — stop mirroring; GitHub is left as it is
app.delete("/:namespace/:slug/mirror", async (c) => {
  const logger = routeLogger(c);
  const access = await requireAdmin(c, logger);
  if ("response" in access) return access.response;
  const result = await removeMirror(c.env, logger, access.project, access.userId);
  if ("failed" in result) return internalError("Failed to remove the mirror");
  if (!result.removed)
    return notFound("Mirror", `${access.project.namespace}/${access.project.slug}`);
  return ok({ deleted: true });
});

// POST /api/projects/:namespace/:slug/mirror/delete — the form's way to DELETE
app.post("/:namespace/:slug/mirror/delete", async (c) => {
  const logger = routeLogger(c);
  const access = await requireAdmin(c, logger);
  if ("response" in access) return access.response;
  const json = wantsJson(c);
  const result = await removeMirror(c.env, logger, access.project, access.userId);
  if ("failed" in result) {
    return json
      ? internalError("Failed to remove the mirror")
      : c.redirect(settingsUrl(access.project, "failed"), 302);
  }
  if (!json)
    return c.redirect(settingsUrl(access.project, result.removed ? "removed" : "none"), 302);
  if (!result.removed)
    return notFound("Mirror", `${access.project.namespace}/${access.project.slug}`);
  return ok({ deleted: true });
});

/**
 * POST /api/projects/:namespace/:slug/mirror/resume
 *
 * Clears `failed` or `diverged` and queues a push. For a diverged mirror this
 * is the admin saying "I have looked at the GitHub repository": if it is still
 * not an ancestor of the project, the next push finds that and stops again —
 * resuming never forces anything.
 */
app.post("/:namespace/:slug/mirror/resume", async (c) => {
  const logger = routeLogger(c);
  const access = await requireAdmin(c, logger);
  if ("response" in access) return access.response;
  const { project, userId } = access;
  const json = wantsJson(c);

  const before = await getPushMirror(c.env.DB, logger, project.id);
  const resumed = await resumePushMirror(c.env.DB, logger, project.id);
  if (!resumed.success) {
    return json
      ? internalError("Failed to resume the mirror")
      : c.redirect(settingsUrl(project, "failed"), 302);
  }
  if (resumed.data === null) {
    return json
      ? notFound("Mirror", `${project.namespace}/${project.slug}`)
      : c.redirect(settingsUrl(project, "none"), 302);
  }

  await recordAudit(c.env.DB, logger, {
    action: "mirror.resumed",
    actorType: "user",
    actorId: userId,
    subject: project.id,
    project,
    detail: {
      project: project.name,
      repo: `${resumed.data.repoOwner}/${resumed.data.repoName}`,
      ...(before.success && before.data ? { previousState: before.data.state } : {}),
    },
  });
  if (resumed.data.enabled) await sendNudge(c.env, logger, project.id);

  return json
    ? ok({ mirror: toPushMirrorView(resumed.data) }, 202)
    : c.redirect(settingsUrl(project, "resumed"), 302);
});

export { app as mirrorRouter };
