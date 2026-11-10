/**
 * Break-glass resync API (#418).
 *
 *   POST /api/projects/:namespace/:slug/resync — fast-forward the default
 *        branch to the same branch on the project's GitHub copy (JSON or form)
 *
 * A mirrored project treats GitHub as read-only: inbound sync and PR promotion
 * answer `409 PUSH_MIRROR_ENABLED`. This route is the one deliberate way
 * around that, for the day Stratum could not merge and a fix had to land on
 * GitHub first. It is therefore gated more tightly than anything else that
 * moves a branch:
 *
 * - **Admins only** — the project's owner, or an owner/admin of the org that
 *   owns it — through the same check as the mirror routes, which is also what
 *   applies the org's second-factor policy and IP allowlist.
 * - **No delegated credentials.** An OAuth grant (MCP, the CLI's device flow)
 *   is refused with `ADMIN_REQUIRES_DIRECT_CREDENTIAL`, as it is on
 *   `/api/admin/*`. This route is also not mounted in the MCP dispatcher.
 * - **Agents never.** They carry no `userId`.
 *
 * The commits a resync brings in were never evaluated by this project's
 * policy. That is the point of a break-glass path and also its cost, so the
 * route says so everywhere it leaves a record: the audit entries, the event,
 * and the response all carry `evaluated: false` and the list of commits.
 *
 * Nothing here decides whether a move is a fast-forward or performs it — that
 * is `src/github/resync.ts`. This file decides who may ask, and writes down
 * what happened.
 */

import { Hono } from "hono";
import { requestPushMirror, sendNudge } from "../github/mirror";
import {
  type ResyncOutcome,
  type ResyncRefusalCode,
  type ResyncSource,
  resolveResyncSource,
  resyncSourceRepo,
  runResync,
} from "../github/resync";
import { emitEvent } from "../queue/events";
import { recordAudit } from "../storage/audit";
import { isTargetDeleting } from "../storage/deletion";
import { type PushMirror, getPushMirror, resumePushMirror } from "../storage/push-mirrors";
import { type Env, type ProjectEntry, projectDefaultBranch } from "../types";
import { durableObjectNamespace } from "../utils/durable-objects";
import type { Logger } from "../utils/logger";
import { readTextWithLimit } from "../utils/request-body";
import { internalError, ok, payloadTooLarge } from "../utils/response";
import { fromPromise } from "../utils/result";
import { type PushMirrorView, requireAdmin, routeLogger, toPushMirrorView } from "./mirror";

const app = new Hono<{ Bindings: Env }>();

const MAX_RESYNC_BODY_BYTES = 4 * 1024;
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Outcomes the settings page knows how to describe. A form round-trip carries
 * one of these codes and, for the outcomes that name commits, two SHAs that
 * are re-validated before they are shown — never text the request supplied.
 */
/** Refusals after which the branch may have moved anyway. See the route. */
const UNCERTAIN_RESYNC_CODES: ReadonlySet<string> = new Set([
  "RESYNC_PUSH_TIMEOUT",
  "RESYNC_FAILED",
]);

export const RESYNC_NOTICES = {
  done: "Fast-forwarded. The commits that came in were not evaluated by this project's policy; the audit log lists them.",
  "up-to-date": "Already up to date: the project has everything GitHub has. Nothing was changed.",
  diverged:
    "Refused: the project and GitHub have diverged, and neither contains the other. A resync only fast-forwards, so nothing was changed.",
  "sha-mismatch":
    "Refused: GitHub is not at the commit you entered. Nothing was changed. Check what was pushed there before trying again.",
  moved:
    "The project's branch moved while the resync was running, so nothing was changed. Run it again.",
  confirm: "Type the GitHub repository's owner/name exactly to confirm. Nothing was changed.",
  "invalid-sha":
    "The expected commit must be a full 40-character SHA. Leave it empty to accept whatever GitHub has. Nothing was changed.",
  "invalid-body":
    "The request body was not a JSON object. Nothing was changed. Send an empty body, or a JSON object with an optional expectedSha.",
  "no-upstream":
    "This project has no push mirror and no linked GitHub repository, so there is nothing to resync from.",
  "no-branch": "The GitHub repository has no branch with the project's default branch name.",
  "empty-project":
    "This project has no commits on its default branch yet. A resync does not populate an empty project.",
  "not-configured":
    "The GitHub App is not configured on this instance. A resync needs it; ask the operator.",
  "not-installed":
    "The GitHub App is not installed on that repository. Install it there, then try again.",
  "not-authorized":
    "The GitHub App installation for that repository is not linked to this project's owner. Link it from the GitHub App setup page, then try again.",
  "no-permission":
    "The GitHub App does not have the Contents permission on that repository. Grant it in the App's settings, then try again.",
  "no-access": "GitHub refused the App's token for that repository. Nothing was changed.",
  github: "GitHub could not be read. Nothing was changed. Try again shortly.",
  project: "The project's repository could not be read. Nothing was changed. Try again shortly.",
  incomplete:
    "The history between the two commits could not be read completely, so the resync could not prove this is a fast-forward. Nothing was changed.",
  rejected: "The project's repository refused the fast-forward. Nothing was changed.",
  uncertain:
    "The resync did not finish in time, and the fast-forward may or may not have landed. Check the default branch and the audit log before running it again.",
  deleting: "This project is being deleted.",
  failed: "The resync could not be completed. Check the default branch before running it again.",
} as const;

export type ResyncNoticeCode = keyof typeof RESYNC_NOTICES;

/** Notices that report success rather than a refusal. */
const GOOD_NOTICES: ReadonlySet<ResyncNoticeCode> = new Set(["done", "up-to-date"]);

/** What the settings page renders after a form round-trip. */
export interface ResyncNotice {
  message: string;
  ok: boolean;
  /** The project's commit (before, for `done`), when the outcome named one. */
  from?: string;
  /** GitHub's commit (the new tip, for `done`), when the outcome named one. */
  to?: string;
}

/**
 * The notice for a `?resync=` code, or undefined for anything else. `from` and
 * `to` come from the query string, so they are shown only when they are
 * exactly a commit SHA.
 */
export function resyncNotice(
  code: string | undefined,
  from?: string,
  to?: string,
): ResyncNotice | undefined {
  if (code === undefined || !Object.hasOwn(RESYNC_NOTICES, code)) return undefined;
  const known = code as ResyncNoticeCode;
  return {
    message: RESYNC_NOTICES[known],
    ok: GOOD_NOTICES.has(known),
    ...(from !== undefined && FULL_SHA.test(from) ? { from } : {}),
    ...(to !== undefined && FULL_SHA.test(to) ? { to } : {}),
  };
}

const REFUSAL_NOTICES: Record<ResyncRefusalCode, ResyncNoticeCode> = {
  GITHUB_APP_NOT_CONFIGURED: "not-configured",
  GITHUB_APP_NOT_INSTALLED: "not-installed",
  GITHUB_APP_NOT_AUTHORIZED: "not-authorized",
  GITHUB_APP_PERMISSION_DENIED: "no-permission",
  GITHUB_ACCESS_DENIED: "no-access",
  RESYNC_UPSTREAM_UNAVAILABLE: "github",
  RESYNC_PROJECT_UNAVAILABLE: "project",
  RESYNC_UPSTREAM_BRANCH_MISSING: "no-branch",
  RESYNC_PROJECT_BRANCH_MISSING: "empty-project",
  RESYNC_SHA_MISMATCH: "sha-mismatch",
  RESYNC_DIVERGED: "diverged",
  RESYNC_HISTORY_INCOMPLETE: "incomplete",
  RESYNC_PROJECT_MOVED: "moved",
  RESYNC_PUSH_REJECTED: "rejected",
  RESYNC_PUSH_TIMEOUT: "uncertain",
  RESYNC_FAILED: "failed",
};

/** Where a form post lands: the settings page's resync card, with the outcome. */
function settingsUrl(
  project: ProjectEntry,
  code: ResyncNoticeCode,
  shas: { from?: string; to?: string } = {},
): string {
  const query = new URLSearchParams({ resync: code });
  if (shas.from !== undefined) query.set("from", shas.from);
  if (shas.to !== undefined) query.set("to", shas.to);
  return `/${project.namespace}/${project.slug}/settings?${query.toString()}#resync`;
}

/**
 * Whether the request is the settings page's form. Decided by the form
 * content types rather than "anything that is not JSON" (the mirror routes'
 * rule): an API client that posts with no body and no content type is asking
 * for the default resync and should get JSON back, not a redirect.
 */
function isFormPost(c: { req: { header: (name: string) => string | undefined } }): boolean {
  const type = c.req.header("content-type") ?? "";
  return type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data");
}

/** The slice of `RepoDO` a resync calls, over RPC. */
interface RepoDoResyncStub {
  resync(input: {
    project: ProjectEntry;
    source: ResyncSource;
    expectedSha?: string;
  }): Promise<ResyncOutcome>;
}

/** The outcome reported when the run itself died, so nothing is known about the branch. */
function unknownOutcome(branch: string): ResyncOutcome {
  return {
    status: "refused",
    code: "RESYNC_FAILED",
    httpStatus: 502,
    branch,
    message:
      "The resync did not report back, so it is not known whether the branch moved. Check the default branch before running it again.",
  };
}

/**
 * Runs the resync where merges for this project run.
 *
 * With `REPO_DO_ENABLED`, that is the project's `RepoDO`: its `resync` method
 * pushes behind the same input gate `advance` takes, so a merge and a resync
 * cannot interleave, and it refreshes the head the object caches. With the
 * kill switch off, merges go through the classic path, which holds no lock of
 * its own and relies on the project repository refusing a push that is not a
 * fast-forward of what it has — and so does this, by running inline.
 *
 * Never throws: a run that dies (a Durable Object reset, an unexpected
 * exception) is reported as `RESYNC_FAILED` with the outcome unknown.
 */
async function dispatchResync(
  env: Env,
  project: ProjectEntry,
  source: ResyncSource,
  expectedSha: string | undefined,
  logger: Logger,
): Promise<ResyncOutcome> {
  const pin = expectedSha !== undefined ? { expectedSha } : {};
  // The namespace comes from the helper, never from `env.REPO_DO` directly, so
  // a deployment with `DO_JURISDICTION` set reaches the restricted object
  // (#453). The helper throws on an invalid jurisdiction, so it is resolved
  // inside the promise this function already turns into an outcome.
  const run = async (): Promise<ResyncOutcome> => {
    const repoDo =
      env.REPO_DO_ENABLED === "true" ? durableObjectNamespace(env, "REPO_DO") : undefined;
    if (repoDo === undefined) return runResync(env, project, source, pin, logger);
    const stub = repoDo.get(repoDo.idFromName(project.id)) as unknown as RepoDoResyncStub;
    return stub.resync({ project, source, ...pin });
  };
  const result = await fromPromise(run());
  if (result.success) return result.data;
  logger.error("Resync run failed without reporting an outcome", result.error, {
    projectId: project.id,
  });
  return unknownOutcome(projectDefaultBranch(project));
}

/**
 * Leaves the push mirror in a state that matches what the resync found.
 *
 * A fast-forward, or finding nothing to do, both prove the same thing: GitHub's
 * branch is contained in the project's. That is exactly the condition a mirror
 * stuck in `diverged` or `failed` was waiting for — typically because a push
 * ran while GitHub was ahead with the break-glass fix — so the mirror is
 * resumed, exactly as the Resume button would, and a push is queued. That push
 * finds the two already equal and records `ok` without sending anything; if
 * something else is wrong (a moved tag, say) it stops again as it would have.
 * Nothing is forced either way.
 *
 * A healthy mirror just gets a push requested after a fast-forward, so
 * `lastPushedSha` catches up with the new tip.
 *
 * @returns The mirror as it now stands, or null when the project has none
 */
async function settleMirror(
  env: Env,
  logger: Logger,
  project: ProjectEntry,
  userId: string,
  mirror: PushMirror | null,
  moved: boolean,
): Promise<PushMirrorView | null> {
  if (mirror === null) return null;
  const repo = `${mirror.repoOwner}/${mirror.repoName}`;

  if (mirror.state === "diverged" || mirror.state === "failed") {
    const resumed = await resumePushMirror(env.DB, logger, project.id);
    if (!resumed.success || resumed.data === null) {
      // The branch has already moved; failing the request over the mirror's
      // bookkeeping would misreport it. An admin can still press Resume.
      logger.warn("Resync could not resume the mirror; it stays as it was", {
        projectId: project.id,
        state: mirror.state,
      });
      return toPushMirrorView(mirror);
    }
    await recordAudit(env.DB, logger, {
      action: "mirror.resumed",
      actorType: "user",
      actorId: userId,
      subject: project.id,
      project,
      detail: { project: project.name, repo, previousState: mirror.state, via: "resync" },
    });
    if (resumed.data.enabled) await sendNudge(env, logger, project.id);
    return toPushMirrorView(resumed.data);
  }

  if (moved) await requestPushMirror(env, logger, project.id, "resync");
  const current = await getPushMirror(env.DB, logger, project.id);
  return toPushMirrorView(current.success && current.data ? current.data : mirror);
}

/**
 * POST /api/projects/:namespace/:slug/resync
 *
 * Body (JSON, optional): `{ "expectedSha": "<40 hex>" }` — only fast-forward
 * if GitHub's branch is at exactly this commit. The settings form sends
 * `confirm` (the source repository's `owner/name`, typed out) and optionally
 * `expected_sha`.
 *
 * Answers `200` with `status: "fast-forwarded"` or `status: "up-to-date"`.
 * Every refusal carries a `code`; the ones that are about two commits
 * (`RESYNC_DIVERGED` above all) carry `projectSha` and `upstreamSha` too.
 */
app.post("/:namespace/:slug/resync", async (c) => {
  const logger = routeLogger(c);

  // Before the project is even looked up, as on /api/admin/*: a grant lives
  // inside software the user does not control, and this is the one route that
  // lands unevaluated commits on a default branch.
  if (c.get("oauthGrantId") !== undefined) {
    logger.warn("Resync refused: OAuth grant", { userId: c.get("userId") });
    return c.json(
      {
        error:
          "A resync needs a signed-in session or a personal API token; an OAuth grant cannot run it",
        code: "ADMIN_REQUIRES_DIRECT_CREDENTIAL",
      },
      403,
    );
  }

  const access = await requireAdmin(c, logger, "resync a project");
  if ("response" in access) return access.response;
  const { project, userId } = access;
  const form = isFormPost(c);

  const refuse = (
    notice: ResyncNoticeCode,
    code: string,
    status: 400 | 403 | 409 | 502 | 503 | 504,
    extra: { message?: string; projectSha?: string; upstreamSha?: string } = {},
  ) => {
    const shas = {
      ...(extra.projectSha !== undefined ? { projectSha: extra.projectSha } : {}),
      ...(extra.upstreamSha !== undefined ? { upstreamSha: extra.upstreamSha } : {}),
    };
    return form
      ? c.redirect(
          settingsUrl(project, notice, { from: extra.projectSha, to: extra.upstreamSha }),
          302,
        )
      : c.json({ error: extra.message ?? RESYNC_NOTICES[notice], code, ...shas }, status);
  };

  let expectedInput: unknown;
  let confirmation: unknown;
  if (form) {
    const body = await c.req.parseBody();
    confirmation = body.confirm;
    expectedInput = body.expected_sha;
  } else {
    // An empty body is a resync with no pin. A body that is present but is not
    // valid JSON is refused: it may have carried an `expectedSha` the caller
    // meant, and running without the pin could fast-forward the branch to a
    // commit they did not intend.
    const read = await readTextWithLimit(c, MAX_RESYNC_BODY_BYTES, logger);
    if (read.tooLarge) {
      return payloadTooLarge(`request body too large (max ${MAX_RESYNC_BODY_BYTES} bytes)`);
    }
    if (read.text.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(read.text);
      } catch {
        return refuse("invalid-body", "RESYNC_INVALID_BODY", 400);
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return refuse("invalid-body", "RESYNC_INVALID_BODY", 400);
      }
      expectedInput = (parsed as { expectedSha?: unknown }).expectedSha;
    }
  }

  let expectedSha: string | undefined;
  // An empty form field is "no pin", the same as leaving the key out of JSON.
  if (expectedInput !== undefined && expectedInput !== null && expectedInput !== "") {
    const candidate = typeof expectedInput === "string" ? expectedInput.trim().toLowerCase() : "";
    if (!FULL_SHA.test(candidate)) return refuse("invalid-sha", "RESYNC_INVALID_SHA", 400);
    expectedSha = candidate;
  }

  if (await isTargetDeleting(c.env, project, logger)) {
    return refuse("deleting", "TARGET_DELETING", 409);
  }

  const mirror = await getPushMirror(c.env.DB, logger, project.id);
  if (!mirror.success) return internalError("Failed to load the project's mirror");
  const source = resolveResyncSource(project, mirror.data);
  if (source === null) return refuse("no-upstream", "RESYNC_NO_UPSTREAM", 409);
  const repo = resyncSourceRepo(source);

  // The form's confirmation step, which needs no JavaScript: the admin types
  // the repository the commits will come from. An API caller has already been
  // deliberate by constructing the request.
  if (form && (typeof confirmation !== "string" || confirmation.trim() !== repo)) {
    return refuse("confirm", "RESYNC_CONFIRMATION_REQUIRED", 400);
  }

  // Written BEFORE anything runs, as `backup.repo_restore` is: if the request
  // dies between the push and the response, this is the trail that says an
  // admin asked for a resync and when.
  await recordAudit(c.env.DB, logger, {
    action: "branch.resync_requested",
    actorType: "user",
    actorId: userId,
    subject: project.id,
    project,
    detail: {
      project: project.name,
      repo,
      source: source.kind,
      ...(expectedSha !== undefined ? { expectedSha } : {}),
    },
  });

  const outcome = await dispatchResync(c.env, project, source, expectedSha, logger);

  if (outcome.status === "refused") {
    // Two refusals do not mean nothing changed. A push that timed out is not
    // cancelled and may still land; a run that died may have pushed first. If
    // it did, unevaluated commits are on the default branch with no
    // `branch.resynced` entry to say so, and a retry answers `up-to-date` and
    // writes none either. This entry is the record: which commit the branch
    // was at, which it may now be at, and why that is not known.
    if (UNCERTAIN_RESYNC_CODES.has(outcome.code)) {
      await recordAudit(c.env.DB, logger, {
        action: "branch.resync_uncertain",
        actorType: "user",
        actorId: userId,
        subject: project.id,
        project,
        detail: {
          project: project.name,
          repo,
          source: source.kind,
          code: outcome.code,
          evaluated: false,
          ...(outcome.projectSha !== undefined ? { oldSha: outcome.projectSha } : {}),
          ...(outcome.upstreamSha !== undefined ? { upstreamSha: outcome.upstreamSha } : {}),
          ...(expectedSha !== undefined ? { expectedSha } : {}),
        },
      });
    }
    logger.info("Resync refused", {
      projectId: project.id,
      repo,
      code: outcome.code,
      projectSha: outcome.projectSha,
      upstreamSha: outcome.upstreamSha,
    });
    return refuse(REFUSAL_NOTICES[outcome.code], outcome.code, outcome.httpStatus, {
      message: outcome.message,
      ...(outcome.projectSha !== undefined ? { projectSha: outcome.projectSha } : {}),
      ...(outcome.upstreamSha !== undefined ? { upstreamSha: outcome.upstreamSha } : {}),
    });
  }

  const sourceView = { kind: source.kind, repo };

  if (outcome.status === "up-to-date") {
    const mirrorView = await settleMirror(c.env, logger, project, userId, mirror.data, false);
    logger.info("Resync found nothing to do", { projectId: project.id, repo });
    if (form) {
      return c.redirect(
        settingsUrl(project, "up-to-date", { from: outcome.projectSha, to: outcome.upstreamSha }),
        302,
      );
    }
    return ok({
      status: outcome.status,
      branch: outcome.branch,
      source: sourceView,
      projectSha: outcome.projectSha,
      upstreamSha: outcome.upstreamSha,
      mirror: mirrorView,
    });
  }

  const moved = {
    branch: outcome.branch,
    oldSha: outcome.oldSha,
    newSha: outcome.newSha,
    repo,
    source: source.kind,
    commits: outcome.commits,
    commitCount: outcome.commitCount,
    commitsTruncated: outcome.commitsTruncated,
    // Said in the record itself, not only in the docs: these commits reached
    // the default branch without this project's evaluators running on them.
    evaluated: false as const,
  };
  await recordAudit(c.env.DB, logger, {
    action: "branch.resynced",
    actorType: "user",
    actorId: userId,
    subject: project.id,
    project,
    detail: {
      project: project.name,
      ...moved,
      ...(expectedSha !== undefined ? { expectedSha } : {}),
    },
  });
  await emitEvent(
    c.env.DB,
    c.env.EVENTS_QUEUE,
    { type: "branch.resynced", project: project.name, ...moved },
    { type: "user", id: userId },
    logger,
    project.id,
  );
  logger.warn("Default branch fast-forwarded by a break-glass resync", {
    projectId: project.id,
    repo,
    branch: outcome.branch,
    oldSha: outcome.oldSha,
    newSha: outcome.newSha,
    commitCount: outcome.commitCount,
  });

  const mirrorView = await settleMirror(c.env, logger, project, userId, mirror.data, true);

  if (form) {
    return c.redirect(
      settingsUrl(project, "done", { from: outcome.oldSha, to: outcome.newSha }),
      302,
    );
  }
  return ok({
    status: outcome.status,
    branch: outcome.branch,
    source: sourceView,
    oldSha: outcome.oldSha,
    newSha: outcome.newSha,
    commits: outcome.commits,
    commitCount: outcome.commitCount,
    commitsTruncated: outcome.commitsTruncated,
    evaluated: false,
    mirror: mirrorView,
  });
});

export { app as resyncRouter };
