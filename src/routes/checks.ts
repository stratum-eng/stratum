/**
 * Check runs over HTTP (#414, ADR 011). Two routers, because they have two
 * different callers and must not share a mount:
 *
 * - {@link changeChecksRouter} — `GET /changes/:id/checks`,
 *   `POST /changes/:id/checks/:checkId/rerun` and, for a first-party CI step,
 *   `GET /changes/:id/checks/:checkId/log`. Ordinary authenticated API,
 *   authorized through `utils/authz.ts` like every other change route, and
 *   mounted for MCP sub-requests too.
 * - {@link checkCallbackRouter} — `POST /api/checks/:id`, the runner's
 *   callback. It has no Stratum credential at all: the HMAC over the body is
 *   the authentication. It is mounted only on the public app, never on the MCP
 *   dispatcher, so no tool call can reach it.
 */
import { type Context, Hono } from "hono";
import {
  CHECK_SIGNATURE_HEADER,
  type CheckReportConflict,
  reportCheck,
  rerunCheck,
} from "../services/check-runs";
import { ciExecutorConfig, fetchCiLog } from "../services/ci-executor";
import { getChange } from "../storage/changes";
import {
  getCheckRun,
  latestChecksForRevision,
  listChecksForChange,
  toCheckRunView,
} from "../storage/checks";
import { getProject, getWorkspace } from "../storage/state";
import type { Env } from "../types";
import {
  canReadProject,
  canWriteProject,
  credentialBindingFrom,
  refuseProjectAccess,
} from "../utils/authz";
import { createLogger } from "../utils/logger";
import { readTextWithLimit } from "../utils/request-body";
import {
  badRequest,
  internalError,
  notFound,
  ok,
  payloadTooLarge,
  unauthorized,
} from "../utils/response";

const changeChecks = new Hono<{ Bindings: Env }>();

/**
 * The change page posts the re-run button as a plain HTML form; API, CLI and
 * agent callers send JSON or no body. Only the form gets redirected back.
 */
function isFormPost(c: Context<{ Bindings: Env }>): boolean {
  const contentType = c.req.header("content-type") ?? "";
  return (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  );
}

changeChecks.get("/changes/:id/checks", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { id } = c.req.param();

  const changeResult = await getChange(c.env.DB, logger, id);
  if (!changeResult.success) {
    if (changeResult.error.code === "NOT_FOUND") return notFound("Change", id);
    return internalError(changeResult.error.message);
  }
  const change = changeResult.data;

  const projectResult = await getProject(c.env.STATE, change.project, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") return notFound("Project", change.project);
    return internalError(projectResult.error.message);
  }
  const project = projectResult.data;
  if (!(await canReadProject(c.env.DB, project, credentialBindingFrom(c), userId, agentOwnerId)))
    return notFound("Change", id);

  // Default: what the merge gate reads — the newest run of each check on the
  // evaluated revision. `?all=true` is the history: every revision, every
  // attempt, oldest first.
  const all = c.req.query("all") === "true";
  const checksResult = all
    ? await listChecksForChange(c.env.DB, logger, id)
    : change.evaluatedSha !== undefined
      ? await latestChecksForRevision(c.env.DB, logger, id, change.evaluatedSha)
      : { success: true as const, data: [] };
  if (!checksResult.success) return internalError(checksResult.error.message);

  return ok({
    changeId: id,
    revision: change.evaluatedSha ?? null,
    checks: checksResult.data.map(toCheckRunView),
  });
});

changeChecks.post("/changes/:id/checks/:checkId/rerun", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });
  // Users only, like `POST /changes/:id/evaluate`: re-running a gate until it
  // passes is a decision about the gate, and an agent proposing a change must
  // not be the one to make it.
  const userId = c.get("userId");
  if (!userId) return unauthorized("Only authenticated users can re-run checks");
  const { id, checkId } = c.req.param();

  const changeResult = await getChange(c.env.DB, logger, id);
  if (!changeResult.success) {
    if (changeResult.error.code === "NOT_FOUND") return notFound("Change", id);
    return internalError(changeResult.error.message);
  }
  const change = changeResult.data;

  const projectResult = await getProject(c.env.STATE, change.project, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") return notFound("Project", change.project);
    return internalError(projectResult.error.message);
  }
  const project = projectResult.data;
  if (!(await canWriteProject(c.env.DB, project, credentialBindingFrom(c), userId)))
    return refuseProjectAccess(credentialBindingFrom(c), project, () => notFound("Change", id));

  const workspaceResult = await getWorkspace(c.env.STATE, project.id, change.workspace, logger);
  if (!workspaceResult.success) {
    if (workspaceResult.error.code === "NOT_FOUND") {
      return badRequest("Change references a missing workspace");
    }
    return internalError(workspaceResult.error.message);
  }

  const rerun = await rerunCheck(c.env, logger, {
    change,
    project,
    checkId,
    workspaceRemote: workspaceResult.data.remote,
    requestOrigin: new URL(c.req.url).origin,
  });
  if (!rerun.success) {
    const { message, code, statusCode } = rerun.error;
    if (statusCode >= 500) {
      logger.error("Check re-run failed", rerun.error, { changeId: id, checkId });
      return internalError(message);
    }
    return c.json(
      { error: message, code },
      statusCode === 404 ? 404 : statusCode === 400 ? 400 : 409,
    );
  }

  const check = toCheckRunView(rerun.data.check);
  logger.info("Check re-run dispatched", {
    changeId: id,
    checkId: check.id,
    name: check.name,
    delivered: rerun.data.dispatchFailure === null,
  });
  if (isFormPost(c)) return c.redirect(`/changes/${id}`, 302);
  if (rerun.data.dispatchFailure !== null) {
    // The new run exists and is already `errored`; the body carries it so the
    // caller sees the same state the change page shows.
    return c.json(
      {
        error: `The check could not be dispatched: ${rerun.data.dispatchFailure}`,
        code: "CHECK_DISPATCH_FAILED",
        check,
      },
      502,
    );
  }
  return ok({ check }, 202);
});

/**
 * The log of one first-party CI step (#415).
 *
 * The executor keeps logs in a bucket nobody can read directly, and serves
 * them to this Worker only, on a signed request. So this route is the whole of
 * "who can read a job's log": exactly who can read the project. A log holds
 * whatever the change's code printed, which for a private repository is the
 * repository.
 *
 * The body is untrusted output served from this origin, so it goes out as
 * plain text that a browser may neither sniff into HTML nor run anything from.
 */
changeChecks.get("/changes/:id/checks/:checkId/log", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { id, checkId } = c.req.param();

  const changeResult = await getChange(c.env.DB, logger, id);
  if (!changeResult.success) {
    if (changeResult.error.code === "NOT_FOUND") return notFound("Change", id);
    return internalError(changeResult.error.message);
  }
  const change = changeResult.data;

  const projectResult = await getProject(c.env.STATE, change.project, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") return notFound("Project", change.project);
    return internalError(projectResult.error.message);
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
    return notFound("Change", id);

  const checkResult = await getCheckRun(c.env.DB, logger, checkId);
  if (!checkResult.success) return internalError(checkResult.error.message);
  const check = checkResult.data?.check;
  // The check must be this change's: the change is what the caller was
  // authorized against, and a check id from another project must not ride it.
  if (check === undefined || check.changeId !== id) return notFound("Check", checkId);
  if (check.ciConfigDigest === undefined) {
    return c.json(
      {
        error:
          "Only a first-party CI step has a log here; this check's runner links its own details",
        code: "CHECK_HAS_NO_LOG",
      },
      404,
    );
  }

  const executor = ciExecutorConfig(c.env);
  if (executor.status !== "configured") {
    return c.json({ error: executor.reason, code: "CI_EXECUTOR_UNAVAILABLE" }, 503);
  }
  const log = await fetchCiLog(executor, logger, check.id);
  if (log.status === "missing") {
    return c.json(
      {
        error:
          "No log has been stored for this check run: the step has not produced output yet, never started, or the log has expired",
        code: "CHECK_LOG_NOT_FOUND",
      },
      404,
    );
  }
  if (log.status === "unavailable") {
    return c.json({ error: log.reason, code: "CI_EXECUTOR_UNAVAILABLE" }, 502);
  }
  return new Response(log.body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    },
  });
});

/** A report is a status, a short summary and a link. */
const MAX_CHECK_REPORT_BODY_BYTES = 64 * 1024;

const CONFLICT_STATUS: Record<CheckReportConflict, 409> = {
  STALE_REVISION: 409,
  CHECK_SUPERSEDED: 409,
  CHECK_TERMINAL: 409,
  CHECK_DEADLINE_EXCEEDED: 409,
};

const checkCallback = new Hono<{ Bindings: Env }>();

/**
 * The runner's callback.
 *
 * How the shared middleware treats it, since it is the one API route with no
 * Stratum credential:
 *
 * - **Auth** passes a request with no `Authorization` header through
 *   unauthenticated, which is what a runner sends. Nothing here reads
 *   `userId`; a caller that does present a Stratum token gains nothing by it,
 *   and a project- or org-bound token is refused before routing because
 *   `/api/checks` is not on the bound-token allow-list.
 * - **CSRF** only guards session-cookie requests, and the signature is
 *   required regardless, so a browser cannot be made to forge a report.
 * - **Rate limiting** applies the anonymous per-IP budget. That bounds how
 *   often an unsigned caller can make this handler read D1 and decrypt a
 *   secret, and is ample for a runner reporting state transitions.
 *
 * Every failure before the signature verifies is the same `401`, whatever the
 * cause, so the endpoint cannot be used to learn whether a check id exists.
 */
checkCallback.post("/:id", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });
  const { id } = c.req.param();

  const read = await readTextWithLimit(c, MAX_CHECK_REPORT_BODY_BYTES, logger);
  if (read.tooLarge) {
    return payloadTooLarge(`request body too large (max ${MAX_CHECK_REPORT_BODY_BYTES} bytes)`);
  }

  const outcome = await reportCheck(c.env, logger, {
    checkId: id,
    rawBody: read.text,
    signatureHeader: c.req.header(CHECK_SIGNATURE_HEADER),
  });
  switch (outcome.kind) {
    case "unauthenticated":
      return c.json({ error: "Invalid signature", code: "INVALID_SIGNATURE" }, 401);
    case "invalid":
      return c.json({ error: outcome.message, code: "INVALID_REPORT" }, 400);
    case "conflict":
      return c.json(
        { error: outcome.message, code: outcome.code, check: toCheckRunView(outcome.check) },
        CONFLICT_STATUS[outcome.code],
      );
    case "error":
      return internalError(outcome.message);
    default:
      return ok({ applied: outcome.applied, check: toCheckRunView(outcome.check) });
  }
});

export { changeChecks as changeChecksRouter, checkCallback as checkCallbackRouter };
