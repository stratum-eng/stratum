/**
 * Deploy secrets and deployment history.
 *
 * Two authorization rules here are stricter than the project's usual read/write
 * split, and both are load bearing:
 *
 * 1. The secret routes refuse agent identities outright. `isProjectAdmin`
 *    accepts an `agentOwnerId`, so an agent owned by the project owner would
 *    otherwise be an admin — and could swap or delete the production deploy
 *    credential. See {@link requireSecretsAdmin}.
 * 2. `log_tail` is served to project *writers* only, never on the plain read
 *    path. `canReadProject` returns true unconditionally for a public project,
 *    and a provider error payload can echo request context back at us.
 *
 * No route on either router returns a secret value. `loadSecretValues` is the
 * only function that yields one, and it is not reachable from this router at
 * all — but it is no longer route-unreachable in general: BYOK resolves a
 * project's provider credential on the change-creation path
 * (`evaluation/llm-byok.ts`). That value never comes back out either; it goes
 * straight into the provider request header. The invariant these routes keep is
 * the narrower, checkable one: nothing here reads a value.
 *
 * The browser talks to these same routes. An HTML form can only issue GET or
 * POST and cannot read a JSON body, so the secret writes have form-friendly
 * POST aliases beside them and the approve/retry routes answer a form caller
 * with a redirect — all sharing the one copy of each authorization gate above,
 * because a second copy is a gate that can be fixed in one place and not the
 * other. Which shape a caller gets is decided by its `content-type`, the same
 * way `routes/webhooks.ts` and `routes/projects.ts` decide it.
 */
import { Hono } from "hono";
import type { DeployQueueMessage } from "../deploy/runner";
import { recordDeployRequest } from "../queue/deploy-queue";
import { recordAudit } from "../storage/audit";
import {
  DEPLOYMENT_STATUSES,
  type Deployment,
  type DeploymentStatus,
  TERMINAL_DEPLOYMENT_STATUSES,
  approveDeployment,
  findDeploymentById,
  insertDeployment,
  listDeployments,
} from "../storage/deployments";
import {
  DEPLOY_SECRET_KEY_MISSING,
  MAX_SECRET_VALUE_BYTES,
  type ProjectSecretSummary,
  SECRET_NAME_PATTERN,
  deleteSecret,
  listSecretNames,
  putSecret,
} from "../storage/project-secrets";
import { getProjectById, getProjectByPath } from "../storage/state";
import type { Env, ProjectEntry } from "../types";
import { canReadProject, canWriteProject, isProjectAdmin } from "../utils/authz";
import { AppError } from "../utils/errors";
import { type Logger, createLogger } from "../utils/logger";
import { readJsonWithLimit } from "../utils/request-body";
import {
  appError,
  badRequest,
  forbidden,
  internalError,
  notFound,
  ok,
  unauthorized,
} from "../utils/response";
import type { Result } from "../utils/result";

/**
 * A secret write body is one value plus its JSON envelope. Four times the value
 * cap leaves room for whitespace and escaping while still rejecting a payload
 * that could never contain a storable value.
 */
const MAX_SECRET_BODY_BYTES = MAX_SECRET_VALUE_BYTES * 4;

/** The failures a secret form can report back to the settings page. */
type SecretErrorCode = "name" | "value" | "key" | "failed";

/**
 * Secret-form failures as a closed set of codes, not free text: the reason has
 * to survive a redirect through the query string, and echoing an attacker's
 * string back into the page — escaped or not — invites it to be read as ours.
 * The route emits the code; {@link secretErrorMessage} is what the settings
 * page resolves it back to.
 */
const SECRET_ERRORS: Record<SecretErrorCode, string> = {
  name: "Secret names must be uppercase letters, digits and underscores, starting with a letter.",
  value: "A secret value is required.",
  key: "This instance has no DEPLOY_SECRET_KEY configured, so secrets cannot be stored.",
  failed: "Could not save that secret. Please try again.",
};

/**
 * The message for a `?secretError=` code, or `undefined` for anything else —
 * which is the whole point: an unrecognized code renders nothing rather than
 * putting a caller-supplied string on the page.
 */
export function secretErrorMessage(code: string | undefined): string | undefined {
  // `Object.hasOwn`, not `in`: `in` answers true for inherited keys such as
  // "toString" and would hand the page a function instead of a message.
  if (code === undefined || !Object.hasOwn(SECRET_ERRORS, code)) return undefined;
  return SECRET_ERRORS[code as SecretErrorCode];
}

type AccessFailure = { response: Response };

/** The subset of a Hono context these helpers read, so they stay unit-testable. */
interface RouteContext {
  env: Env;
  get: (key: "userId" | "agentId" | "agentOwnerId") => string | undefined;
  req: { param: (key: string) => string };
}

function routeLogger(c: {
  get: (key: "userId") => string | undefined;
  req: { path: string; method: string };
}): Logger {
  return createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });
}

async function loadProject(
  c: RouteContext,
  logger: Logger,
): Promise<{ project: ProjectEntry } | AccessFailure> {
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
  return { project: projectResult.data };
}

/**
 * The one definition of who may manage a project's deploy secrets: a project
 * admin that is not an agent.
 *
 * The agent check is not redundant with the admin check and must not be folded
 * into it: `isProjectAdmin(db, project, userId, agentOwnerId)` grants admin to
 * an agent whose *owner* owns the project, so a `stratum_agent_` token issued
 * for routine work would be able to overwrite or delete the production deploy
 * credential. Deploy credentials are the one thing an agent is never trusted
 * with (PRD G3), so `agentOwnerId` is deliberately not passed below.
 *
 * Exported because the settings page decides whether to render the Deploy
 * secrets section at all, and that decision has to be this rule rather than a
 * second copy of it that can be fixed in one place and not the other.
 */
export async function canManageSecrets(
  db: D1Database,
  project: ProjectEntry,
  identity: { userId: string | undefined; agentId: string | undefined },
): Promise<boolean> {
  if (identity.agentId !== undefined || identity.userId === undefined) return false;
  return await isProjectAdmin(db, project, identity.userId);
}

/**
 * {@link canManageSecrets} as a route guard, for the secret routes and their
 * form-friendly aliases. The identity is refused before the project is even
 * loaded, so a caller who may not manage secrets cannot use these routes to
 * probe which projects exist.
 */
async function requireSecretsAdmin(
  c: RouteContext,
  logger: Logger,
): Promise<{ project: ProjectEntry; userId: string } | AccessFailure> {
  if (c.get("agentId")) {
    return { response: forbidden("Agent credentials cannot manage deploy secrets") };
  }
  const userId = c.get("userId");
  if (!userId) {
    return { response: unauthorized("Only authenticated users can manage deploy secrets") };
  }

  const loaded = await loadProject(c, logger);
  if ("response" in loaded) return loaded;

  if (!(await canManageSecrets(c.env.DB, loaded.project, { userId, agentId: c.get("agentId") }))) {
    return { response: forbidden("Project access denied") };
  }
  return { project: loaded.project, userId };
}

/**
 * Whether the caller speaks JSON. A browser form posts
 * `application/x-www-form-urlencoded` (or `multipart/form-data`) and cannot
 * read a JSON body, so anything that is not JSON is answered with a redirect.
 */
function wantsJson(c: { req: { header: (name: string) => string | undefined } }): boolean {
  return c.req.header("content-type")?.includes("application/json") ?? false;
}

/** The settings page a secret form came from, anchored at its own section. */
function secretsSettingsUrl(project: ProjectEntry, error?: SecretErrorCode): string {
  const base = `/${project.namespace}/${project.slug}/settings`;
  return error === undefined ? `${base}#secrets` : `${base}?secretError=${error}#secrets`;
}

/**
 * Stores one secret and audits the write. Shared by the PUT route and its
 * form-friendly POST alias so the two cannot drift on what gets recorded — the
 * audit trail is the only durable evidence that a deploy credential changed.
 */
async function writeSecret(
  env: Env,
  logger: Logger,
  access: { project: ProjectEntry; userId: string },
  name: string,
  value: string,
): Promise<Result<ProjectSecretSummary, AppError>> {
  const result = await putSecret(env.DB, logger, env, {
    projectId: access.project.id,
    name,
    value,
    actorId: access.userId,
  });
  if (!result.success) {
    logger.error("Failed to store project secret", result.error);
    return result;
  }

  await recordAudit(env.DB, logger, {
    action: "secret.written",
    actorType: "user",
    actorId: access.userId,
    subject: `${access.project.id}:${name}`,
    detail: { project: access.project.name, name },
  });
  return result;
}

/**
 * Deletes one secret and audits it when a row was actually removed. Shared by
 * the DELETE route and its form-friendly POST alias.
 *
 * Resolves to `false` when the project had no such name — nothing was removed,
 * so nothing is audited.
 */
async function removeSecret(
  env: Env,
  logger: Logger,
  access: { project: ProjectEntry; userId: string },
  name: string,
): Promise<Result<boolean, AppError>> {
  const result = await deleteSecret(env.DB, logger, { projectId: access.project.id, name });
  if (!result.success) {
    logger.error("Failed to delete project secret", result.error);
    return result;
  }
  if (!result.data) return result;

  await recordAudit(env.DB, logger, {
    action: "secret.deleted",
    actorType: "user",
    actorId: access.userId,
    subject: `${access.project.id}:${name}`,
    detail: { project: access.project.name, name },
  });
  return result;
}

/**
 * The deployment as an API response. `logTail` is dropped unless the caller may
 * write to the project — it holds a redacted provider payload, and redaction is
 * literal-substring matching that a public-project reader should not be given
 * the chance to test.
 */
function toResponse(deployment: Deployment, includeLogTail: boolean): Record<string, unknown> {
  const { logTail, ...rest } = deployment;
  if (includeLogTail && logTail !== undefined) return { ...rest, logTail };
  return rest;
}

function isTerminal(status: DeploymentStatus): boolean {
  return (TERMINAL_DEPLOYMENT_STATUSES as readonly string[]).includes(status);
}

function parseCount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Project-scoped routes. Mounted at /api/projects.
// ---------------------------------------------------------------------------

const projectApp = new Hono<{ Bindings: Env }>();

// GET /api/projects/:namespace/:slug/secrets — Names and metadata only
projectApp.get("/:namespace/:slug/secrets", async (c) => {
  const logger = routeLogger(c);
  const access = await requireSecretsAdmin(c, logger);
  if ("response" in access) return access.response;

  const result = await listSecretNames(c.env.DB, logger, access.project.id);
  if (!result.success) return appError(result.error);
  return ok({ secrets: result.data });
});

// PUT /api/projects/:namespace/:slug/secrets/:name — Create or replace a value
projectApp.put("/:namespace/:slug/secrets/:name", async (c) => {
  const logger = routeLogger(c);
  const access = await requireSecretsAdmin(c, logger);
  if ("response" in access) return access.response;
  const name = c.req.param("name");

  let value: unknown;
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const parsed = await readJsonWithLimit<{ value?: unknown }>(
      c,
      MAX_SECRET_BODY_BYTES,
      logger,
    ).catch(() => ({}) as { value?: unknown });
    if (parsed instanceof Response) return parsed;
    value = parsed.value;
  } else {
    const form = await c.req.parseBody();
    value = form.value;
  }
  if (typeof value !== "string") return badRequest("value must be a string");

  const result = await writeSecret(c.env, logger, access, name, value);
  if (!result.success) return appError(result.error);
  return ok({ secret: result.data });
});

/**
 * POST /api/projects/:namespace/:slug/secrets — Form-friendly create or replace
 *
 * The browser's way in to the PUT above, which an HTML form cannot issue. It
 * runs the *same* {@link requireSecretsAdmin} guard rather than restating the
 * agent refusal, and the secret's name arrives in the body because a form has
 * no way to put it in the path.
 *
 * A form caller is redirected back to the settings page with the failure as one
 * of a fixed set of codes ({@link SECRET_ERRORS}) — never as text the caller
 * supplied, which the page would then render as ours.
 */
projectApp.post("/:namespace/:slug/secrets", async (c) => {
  const logger = routeLogger(c);
  const access = await requireSecretsAdmin(c, logger);
  if ("response" in access) return access.response;
  const json = wantsJson(c);

  let body: { name?: unknown; value?: unknown };
  if (json) {
    const parsed = await readJsonWithLimit<{ name?: unknown; value?: unknown }>(
      c,
      MAX_SECRET_BODY_BYTES,
      logger,
    ).catch(() => ({}) as { name?: unknown; value?: unknown });
    if (parsed instanceof Response) return parsed;
    body = parsed;
  } else {
    body = await c.req.parseBody();
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const value = typeof body.value === "string" ? body.value : "";
  if (!SECRET_NAME_PATTERN.test(name)) {
    return json
      ? badRequest(SECRET_ERRORS.name)
      : c.redirect(secretsSettingsUrl(access.project, "name"), 302);
  }
  if (value.length === 0) {
    return json
      ? badRequest(SECRET_ERRORS.value)
      : c.redirect(secretsSettingsUrl(access.project, "value"), 302);
  }

  const result = await writeSecret(c.env, logger, access, name, value);
  if (!result.success) {
    if (json) return appError(result.error);
    const code = result.error.code === DEPLOY_SECRET_KEY_MISSING ? "key" : "failed";
    return c.redirect(secretsSettingsUrl(access.project, code), 302);
  }

  return json ? ok({ secret: result.data }) : c.redirect(secretsSettingsUrl(access.project), 302);
});

// DELETE /api/projects/:namespace/:slug/secrets/:name
projectApp.delete("/:namespace/:slug/secrets/:name", async (c) => {
  const logger = routeLogger(c);
  const access = await requireSecretsAdmin(c, logger);
  if ("response" in access) return access.response;
  const name = c.req.param("name");

  const result = await removeSecret(c.env, logger, access, name);
  if (!result.success) return appError(result.error);
  if (!result.data) return notFound("Secret", name);
  return ok({ deleted: true, name });
});

/**
 * POST /api/projects/:namespace/:slug/secrets/:name/delete — Form-friendly delete
 *
 * Browsers cannot issue DELETE. Behind the same {@link requireSecretsAdmin}
 * guard as the route above; a form caller lands back on the settings page,
 * including when the name was already gone — the row it was clicked from no
 * longer exists either, so there is nothing to report.
 */
projectApp.post("/:namespace/:slug/secrets/:name/delete", async (c) => {
  const logger = routeLogger(c);
  const access = await requireSecretsAdmin(c, logger);
  if ("response" in access) return access.response;
  const name = c.req.param("name");
  const json = wantsJson(c);

  const result = await removeSecret(c.env, logger, access, name);
  if (!result.success) {
    return json
      ? appError(result.error)
      : c.redirect(secretsSettingsUrl(access.project, "failed"), 302);
  }
  if (!json) return c.redirect(secretsSettingsUrl(access.project), 302);
  if (!result.data) return notFound("Secret", name);
  return ok({ deleted: true, name });
});

// GET /api/projects/:namespace/:slug/deployments — History, newest first
projectApp.get("/:namespace/:slug/deployments", async (c) => {
  const logger = routeLogger(c);
  const loaded = await loadProject(c, logger);
  if ("response" in loaded) return loaded.response;
  const { project } = loaded;

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return notFound("Project", `${project.namespace}/${project.slug}`);
  }

  const status = c.req.query("status");
  if (status !== undefined && !(DEPLOYMENT_STATUSES as readonly string[]).includes(status)) {
    return badRequest(`status must be one of: ${DEPLOYMENT_STATUSES.join(", ")}`);
  }

  const name = c.req.query("name");
  const limit = parseCount(c.req.query("limit"));
  const offset = parseCount(c.req.query("offset"));

  const result = await listDeployments(c.env.DB, logger, {
    projectId: project.id,
    ...(name !== undefined ? { name } : {}),
    ...(status !== undefined ? { status: status as DeploymentStatus } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
  });
  if (!result.success) return appError(result.error);

  const includeLogTail = await canWriteProject(c.env.DB, project, userId, agentOwnerId);
  return ok({ deployments: result.data.map((entry) => toResponse(entry, includeLogTail)) });
});

// ---------------------------------------------------------------------------
// Deployment-scoped routes. Mounted at /api/deployments.
// ---------------------------------------------------------------------------

const deploymentApp = new Hono<{ Bindings: Env }>();

/**
 * Resolves `:id` to a deployment the caller may see.
 *
 * The URL carries no project, so the row's own `project_id` is what gets
 * authorized. A deployment in a project the caller cannot read answers 404
 * rather than 403: a 403 would confirm that the id exists, which is exactly
 * what a cross-tenant probe is looking for.
 */
async function loadDeployment(
  c: RouteContext & { req: { param: (key: string) => string } },
  logger: Logger,
): Promise<{ deployment: Deployment; project: ProjectEntry } | AccessFailure> {
  const id = c.req.param("id");

  const found = await findDeploymentById(c.env.DB, logger, id);
  if (!found.success) return { response: appError(found.error) };
  if (!found.data) return { response: notFound("Deployment", id) };
  const deployment = found.data;

  const projectResult = await getProjectById(c.env.STATE, deployment.projectId, logger);
  if (!projectResult.success) {
    // A row whose project is gone is not reportable as a deployment either.
    if (projectResult.error.code === "NOT_FOUND") return { response: notFound("Deployment", id) };
    return { response: appError(projectResult.error) };
  }
  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, c.get("userId"), c.get("agentOwnerId")))) {
    return { response: notFound("Deployment", id) };
  }
  return { deployment, project };
}

// GET /api/deployments/:id — Detail
deploymentApp.get("/:id", async (c) => {
  const logger = routeLogger(c);
  const loaded = await loadDeployment(c, logger);
  if ("response" in loaded) return loaded.response;
  const { deployment, project } = loaded;

  const includeLogTail = await canWriteProject(
    c.env.DB,
    project,
    c.get("userId"),
    c.get("agentOwnerId"),
  );
  return ok({ deployment: toResponse(deployment, includeLogTail) });
});

// POST /api/deployments/:id/approve — Release a pending_approval deployment
//
// Also the target of the Approve button on the deployments page: a form caller
// (anything not sending JSON) is redirected back to the deployment instead of
// being shown a JSON blob, since every page here must work with JavaScript
// disabled. The user-only gate below is the same one either way.
deploymentApp.post("/:id/approve", async (c) => {
  const logger = routeLogger(c);

  // Approval is a gate agent identities cannot pass: a `stratum_agent_` token
  // sets `agentId` and never `userId`. The guarantee this buys is exactly "not
  // an agent identity" — a user's scoped API token and an MCP OAuth grant both
  // set `userId` and are accepted, so it is NOT evidence of a human at a
  // keyboard. Same gate, and same stated limitation, as `reviews.ts`.
  const userId = c.get("userId");
  if (!userId) return unauthorized("Only authenticated users can approve a deployment");

  const loaded = await loadDeployment(c, logger);
  if ("response" in loaded) return loaded.response;
  const { deployment, project } = loaded;

  if (!(await canWriteProject(c.env.DB, project, userId))) {
    return forbidden("Project access denied");
  }

  const queue = c.env.DEPLOY_QUEUE;
  if (!queue) {
    // Checked before the status flip: a row moved to `queued` with nothing to
    // pick it up is unreachable — `claimDeployment` only ever runs from a queue
    // message — and approval is not repeatable once the row has left
    // `pending_approval`.
    return appError(
      new AppError(
        "Deployments are not enabled on this instance (DEPLOY_QUEUE is not configured)",
        "DEPLOY_QUEUE_UNAVAILABLE",
        503,
      ),
    );
  }

  const result = await approveDeployment(c.env.DB, logger, {
    projectId: project.id,
    deploymentId: deployment.id,
    approvedBy: userId,
  });
  if (!result.success) return appError(result.error);

  if (!result.data.approved) {
    if (result.data.reason === "not_found") return notFound("Deployment", deployment.id);
    // The conditional UPDATE is what makes a double-approve safe: the second
    // caller lands here instead of enqueueing the same commit twice.
    return appError(
      new AppError(
        `Deployment is ${deployment.status}, not awaiting approval`,
        "DEPLOYMENT_NOT_PENDING",
        409,
      ),
    );
  }
  const approved = result.data.deployment;

  const message: DeployQueueMessage = {
    kind: "deployment",
    projectId: project.id,
    deploymentId: approved.id,
  };
  try {
    await queue.send(message);
  } catch (error) {
    logger.error(
      "Deployment was approved but could not be enqueued",
      error instanceof Error ? error : undefined,
      { deploymentId: approved.id, projectId: project.id },
    );
    // The row has already left `pending_approval`, and only a queue message can
    // move it any further — `claimDeployment` runs from the consumer, and a
    // second approval of a `queued` row is refused. "Retry it" was therefore
    // advice that could not succeed. Recording the request durably instead
    // hands it to the outbox sweep, so the approval the user granted still runs.
    const recorded = await recordDeployRequest(c.env, logger, {
      message,
      project: project.name,
    });
    if (!recorded) {
      return internalError(
        "Deployment was approved but could not be started, and the request could not be recorded for recovery",
      );
    }
  }

  await recordAudit(c.env.DB, logger, {
    action: "deployment.approved",
    actorType: "user",
    actorId: userId,
    subject: approved.id,
    detail: {
      project: project.name,
      name: approved.name,
      commitSha: approved.commitSha,
      attempt: approved.attempt,
    },
  });

  if (!wantsJson(c)) {
    return c.redirect(`/${project.namespace}/${project.slug}/deployments/${approved.id}`, 302);
  }
  return ok({ deployment: toResponse(approved, true) });
});

// POST /api/deployments/:id/retry — Re-run the same commit as a new attempt
//
// Also the target of the Retry button. As with approve, a form caller gets a
// redirect and a JSON caller gets the row; the terminal-status check below is
// what keeps a retry from routing around the approval gate, and there is one
// copy of it.
deploymentApp.post("/:id/retry", async (c) => {
  const logger = routeLogger(c);
  const userId = c.get("userId");
  const agentId = c.get("agentId");
  const agentOwnerId = c.get("agentOwnerId");

  const loaded = await loadDeployment(c, logger);
  if ("response" in loaded) return loaded.response;
  const { deployment, project } = loaded;

  if (!(await canWriteProject(c.env.DB, project, userId, agentOwnerId))) {
    return forbidden("Project access denied");
  }

  if (!isTerminal(deployment.status)) {
    // A `queued`, `running` or `pending_approval` row still has a future. A new
    // attempt alongside it would publish the same commit twice — and, for
    // `pending_approval`, would route around the approval gate entirely, since
    // the new row starts `queued`.
    return appError(
      new AppError(
        `Deployment is ${deployment.status}; only a finished deployment can be retried`,
        "DEPLOYMENT_NOT_RETRYABLE",
        409,
      ),
    );
  }

  const queue = c.env.DEPLOY_QUEUE;
  if (!queue) {
    return appError(
      new AppError(
        "Deployments are not enabled on this instance (DEPLOY_QUEUE is not configured)",
        "DEPLOY_QUEUE_UNAVAILABLE",
        503,
      ),
    );
  }

  const inserted = await insertDeployment(c.env.DB, logger, {
    projectId: project.id,
    project: project.name,
    // The change id is carried over deliberately: it is what lets the runner
    // re-check that the change was not reverted between the original deploy and
    // this retry. Dropping it would turn a retry into the one path that can
    // publish reverted code.
    changeId: deployment.changeId ?? null,
    commitSha: deployment.commitSha,
    name: deployment.name,
    target: deployment.target,
    attempt: deployment.attempt + 1,
    status: "queued",
    requestedByType: agentId ? "agent" : "user",
    requestedById: agentId ?? userId ?? null,
  });
  if (!inserted.success) return appError(inserted.error);

  if (!inserted.data.inserted) {
    // The unique index on (project, name, commit, attempt) already holds this
    // attempt — someone retried first, and their row is the live one.
    return appError(
      new AppError(
        `Attempt ${deployment.attempt + 1} of this deployment already exists`,
        "DEPLOYMENT_RETRY_EXISTS",
        409,
      ),
    );
  }
  const retry = inserted.data.deployment;

  const message: DeployQueueMessage = {
    kind: "deployment",
    projectId: project.id,
    deploymentId: retry.id,
  };
  try {
    await queue.send(message);
  } catch (error) {
    logger.error(
      "Retry row was created but could not be enqueued",
      error instanceof Error ? error : undefined,
      { deploymentId: retry.id, projectId: project.id },
    );
    // Same dead end as approve, one step further along: the new attempt row
    // exists and is `queued`, so "try again" would only be refused by the
    // unique index on (project, name, commit, attempt). The outbox sweep is
    // what can still start it.
    const recorded = await recordDeployRequest(c.env, logger, {
      message,
      project: project.name,
    });
    if (!recorded) {
      return internalError(
        "Retry was recorded but could not be started, and the request could not be saved for recovery",
      );
    }
  }

  await recordAudit(c.env.DB, logger, {
    action: "deployment.retried",
    actorType: agentId ? "agent" : "user",
    actorId: agentId ?? userId,
    subject: retry.id,
    detail: {
      project: project.name,
      name: retry.name,
      commitSha: retry.commitSha,
      attempt: retry.attempt,
      retryOf: deployment.id,
    },
  });

  if (!wantsJson(c)) {
    return c.redirect(`/${project.namespace}/${project.slug}/deployments/${retry.id}`, 302);
  }
  return ok({ deployment: toResponse(retry, true) }, 201);
});

export { projectApp as projectDeploymentsRouter, deploymentApp as deploymentsRouter };
