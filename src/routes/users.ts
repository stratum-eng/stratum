import { Hono } from "hono";
import type { Context } from "hono";
import { buildUsageReport } from "../billing/usage-report";
import { cannotMintLegacyCredential } from "../middleware/auth";
import {
  MAX_TOKEN_EXPIRY_DAYS,
  MIN_TOKEN_EXPIRY_DAYS,
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from "../storage/api-tokens";
import { recordAudit } from "../storage/audit";
import { createDeletionJob } from "../storage/deletion-jobs";
import {
  disableLegacyToken,
  getUser,
  getUserByUsername,
  markUserDeleting,
  rotateUserToken,
} from "../storage/users";
import type { ApiTokenScope, Env } from "../types";
import { createLogger } from "../utils/logger";
import { readJsonWithLimit } from "../utils/request-body";
import { badRequest, internalError, notFound, ok } from "../utils/response";
import { validateUsername } from "../utils/username-validation";

const app = new Hono<{ Bindings: Env }>();

// A backstop against an unbounded read, not a real limit: this route reads back
// only a short confirmation value, so 1 MiB is already far more headroom than
// any request matching the route's contract could use.
const MAX_ACCOUNT_DELETE_BODY_BYTES = 1024 * 1024;

// NOTE: user creation has no API route. Accounts are bootstrapped only through
// verified flows (`/auth/github`, `/auth/google`, `/auth/email` magic link, and
// the localhost-gated `/dev-login`). API tokens are issued only to an
// authenticated caller — see `POST /me/rotate-token` below and `POST /api/agents`.
// An unauthenticated `email → token` endpoint previously lived here; it let
// anyone mint a working token, bypass the closed beta, and squat emails.

app.get("/me", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  if (!userId) {
    logger.warn("Unauthorized access to /me");
    return c.json({ error: "Unauthorized" }, 401);
  }

  const result = await getUser(c.env.DB, userId, logger);
  if (!result.success) {
    logger.warn("User not found", { userId });
    return c.json({ error: "Unauthorized" }, 401);
  }

  const user = result.data;
  logger.debug("User retrieved", { userId });

  return ok({ id: user.id, email: user.email, createdAt: user.createdAt });
});

/**
 * GET /api/users/me/usage — the caller's metered usage against their plan.
 *
 * Read-only, and deliberately the ONLY billing surface reachable from a token:
 * there is no endpoint here to raise a limit, buy capacity or attach a payment
 * method (PRD §4c). An agent that can lift its own ceiling does not have one,
 * which is the same line this codebase already draws at review verdicts.
 *
 * An AGENT token resolves to its owner (`agentOwnerId`), because that is the
 * §4a enforcement subject its evaluations are actually charged to — an agent
 * shown its own empty allowance would be reading a number no check uses.
 */
app.get("/me/usage", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
    userId: c.get("userId"),
  });

  // The acting user, or the person an agent acts for. Never a project's org:
  // limits follow the person (PRD §4a).
  const actorUserId = c.get("userId") ?? c.get("agentOwnerId");
  if (!actorUserId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const report = await buildUsageReport(c.env, logger, { actorUserId });
  if (!report.success) {
    logger.error("Failed to build usage report", report.error);
    return internalError("Usage could not be read");
  }
  return ok(report.data);
});

// POST /api/users/me/rotate-token - Replace the caller's API key
app.post("/me/rotate-token", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
    userId: c.get("userId"),
  });

  const userId = c.get("userId");
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Sessions and the legacy key still rotate — that is the backward
  // compatibility this route exists to keep. A scoped token or an OAuth grant
  // may not, because the key it would mint outlives the revocation of the
  // credential that minted it.
  if (cannotMintLegacyCredential(c)) {
    logger.warn("Rotate rejected - delegated credential cannot mint the legacy key", { userId });
    return c.json(
      {
        error: "A scoped API token or OAuth grant cannot rotate the legacy API key",
        code: "SESSION_REQUIRED",
      },
      403,
    );
  }

  const result = await rotateUserToken(c.env.DB, userId, logger);
  if (!result.success) {
    logger.error("Failed to rotate API key", result.error, { userId });
    return c.json({ error: "Failed to rotate API key" }, 500);
  }

  await recordAudit(c.env.DB, logger, {
    action: "token.rotated",
    actorType: "user",
    actorId: userId,
  });

  // The old key is invalid as of this response; the new one is shown once.
  return ok({ token: result.data });
});

/** A token body is two short strings; anything larger is a client bug. */
const MAX_TOKEN_BODY_BYTES = 4 * 1024;

/**
 * Requires a browser SESSION, not an API token (#254).
 *
 * A `read_write` token that could mint tokens, revoke its siblings, and rotate
 * the legacy credential would make the whole feature circular: the "revoke the
 * lost laptop" story fails if the lost laptop can simply issue itself a
 * replacement. GitHub forbids PATs from managing PATs for the same reason.
 *
 * `POST /me/rotate-token` still accepts the LEGACY key, so existing automation
 * keeps working, but refuses a scoped token or an OAuth grant: see
 * `cannotMintLegacyCredential`. The
 * backward-compatibility argument only ever covered credentials that predate
 * this feature, and a scoped token minting a permanent key would reopen exactly
 * the circularity this helper closes.
 */
function requireSession(
  c: Context<{ Bindings: Env }>,
): { userId: string } | { response: Response } {
  const userId = c.get("userId");
  if (!userId) return { response: c.json({ error: "Unauthorized" }, 401) };
  if (c.get("authVia") !== "session") {
    return {
      response: c.json(
        {
          error: "Token management requires a signed-in session, not an API token",
          code: "SESSION_REQUIRED",
        },
        403,
      ),
    };
  }
  return { userId };
}

// GET /api/users/me/tokens — the caller's tokens. Never returns a hash.
app.get("/me/tokens", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
    userId: c.get("userId"),
  });

  const access = requireSession(c);
  if ("response" in access) return access.response;

  const result = await listApiTokens(c.env.DB, logger, access.userId);
  if (!result.success) return internalError(result.error.message);
  return ok({ tokens: result.data });
});

// POST /api/users/me/tokens — mint a named token. The plaintext is returned
// exactly once, here, and never stored.
app.post("/me/tokens", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
    userId: c.get("userId"),
  });

  const access = requireSession(c);
  if ("response" in access) return access.response;

  type TokenBody = { name?: unknown; scope?: unknown; expiresInDays?: unknown };
  const parsed = await readJsonWithLimit<TokenBody>(c, MAX_TOKEN_BODY_BYTES, logger).catch(
    (): TokenBody => ({}),
  );
  if (parsed instanceof Response) return parsed;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return badRequest("Request body must be a JSON object");
  }

  const { name, scope, expiresInDays } = parsed;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 100) {
    return badRequest("name must be a non-empty string of at most 100 characters");
  }
  if (scope !== undefined && scope !== "read" && scope !== "read_write") {
    return badRequest("scope must be 'read' or 'read_write'");
  }
  if (
    expiresInDays !== undefined &&
    (typeof expiresInDays !== "number" ||
      !Number.isInteger(expiresInDays) ||
      expiresInDays < MIN_TOKEN_EXPIRY_DAYS ||
      expiresInDays > MAX_TOKEN_EXPIRY_DAYS)
  ) {
    return badRequest(
      `expiresInDays must be an integer between ${MIN_TOKEN_EXPIRY_DAYS} and ${MAX_TOKEN_EXPIRY_DAYS}`,
    );
  }

  const result = await createApiToken(c.env.DB, logger, {
    userId: access.userId,
    name: name.trim(),
    // Default to the weaker scope: a caller who does not say what they need
    // should not be handed the ability to write.
    scope: (scope ?? "read") as ApiTokenScope,
    ...(expiresInDays !== undefined ? { expiresInDays } : {}),
  });
  if (!result.success) {
    // A rejected name or expiry is a 400; only the active-token cap is a 409.
    // Reporting a validation failure as a conflict tells the caller to retry
    // after freeing a slot, which will never help.
    if (result.error.statusCode === 400) {
      return c.json({ error: result.error.message, code: result.error.code }, 400);
    }
    if (result.error.statusCode === 409) {
      return c.json({ error: result.error.message, code: result.error.code }, 409);
    }
    return internalError(result.error.message);
  }

  await recordAudit(c.env.DB, logger, {
    action: "token.created",
    actorType: "user",
    actorId: access.userId,
    // The token id is the audit subject, matching the settings-form routes —
    // `subject` is what an audit query filters on; `detail` is not indexed.
    subject: result.data.token.id,
    detail: { scope: result.data.token.scope },
  });

  // The plaintext exists nowhere else after this response, so it must not be
  // cached anywhere on the way back.
  return new Response(
    JSON.stringify({ token: result.data.token, plaintext: result.data.plaintext }),
    {
      status: 201,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    },
  );
});

// DELETE /api/users/me/tokens/:id — revoke one of the caller's own tokens.
app.delete("/me/tokens/:id", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
    userId: c.get("userId"),
  });

  const access = requireSession(c);
  if ("response" in access) return access.response;

  const tokenId = c.req.param("id");
  const result = await revokeApiToken(c.env.DB, logger, { userId: access.userId, tokenId });
  if (!result.success) {
    // Another user's token id is indistinguishable from one that does not exist.
    if (result.error.statusCode === 404) return notFound("Token", tokenId);
    return internalError(result.error.message);
  }

  await recordAudit(c.env.DB, logger, {
    action: "token.revoked",
    actorType: "user",
    actorId: access.userId,
    subject: tokenId,
  });
  return ok({ revoked: tokenId });
});

// POST /api/users/me/legacy-token/disable — turn off the pre-scopes credential.
//
// Without this, every account that existed before scoped tokens permanently
// keeps one un-revocable, un-expiring, unnamed read_write credential alongside
// its scoped ones — leaving this feature's guarantee unavailable to exactly the
// people who already have accounts.
app.post("/me/legacy-token/disable", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
    userId: c.get("userId"),
  });

  const access = requireSession(c);
  if ("response" in access) return access.response;

  const result = await disableLegacyToken(c.env.DB, access.userId, logger);
  if (!result.success) return internalError(result.error.message);

  await recordAudit(c.env.DB, logger, {
    action: "token.legacy_disabled",
    actorType: "user",
    actorId: access.userId,
  });
  return ok({ disabled: true });
});

/**
 * DELETE /api/users/me — GDPR-grade account erasure. The caller must be the
 * user, and must confirm with a token equal to their own username (real
 * confirmation, hard to fire by accident). Sets users.deleting_at (which
 * immediately invalidates their credentials via the auth middleware) and
 * enqueues the account cascade job.
 *
 * v1 grace window: deleting_at marks the account and gates access immediately,
 * while the cascade runs now via the job. A bounded soft window before the
 * irreversible purge (PRD "Grace window") is a future refinement — kept minimal
 * and correct here rather than over-built.
 */
async function handleAccountDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
    userId: c.get("userId"),
  });

  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const userResult = await getUser(c.env.DB, userId, logger);
  if (!userResult.success) return c.json({ error: "Unauthorized" }, 401);
  const user = userResult.data;

  const isJson = c.req.header("content-type")?.includes("application/json") ?? false;
  let confirm: unknown;
  if (isJson) {
    const body = await readJsonWithLimit<{ confirm?: unknown }>(
      c,
      MAX_ACCOUNT_DELETE_BODY_BYTES,
      logger,
    ).catch(() => ({}) as { confirm?: unknown });
    if (body instanceof Response) return body;
    confirm = body.confirm;
  } else {
    const form = await c.req.parseBody();
    confirm = form.confirm;
  }
  if (confirm !== user.username) {
    return badRequest(`Confirmation must exactly equal your username "${user.username}"`);
  }

  // Mark deleting FIRST — this alone revokes access (auth rejects) even if the
  // enqueue below is lost; the sweep will still find the deleting user later.
  const marked = await markUserDeleting(c.env.DB, userId, logger);
  if (!marked.success) {
    logger.error("Failed to mark user deleting", marked.error);
    return internalError(marked.error.message);
  }

  const jobResult = await createDeletionJob(c.env.DB, logger, {
    kind: "account",
    target: { userId },
    targetId: userId,
  });
  if (!jobResult.success) {
    logger.error("Failed to create account deletion job", jobResult.error);
    return internalError(jobResult.error.message);
  }
  const { job, created } = jobResult.data;

  // A concurrent/repeated request returns the in-flight job — the partial unique
  // index guarantees only one active cascade per user (atomic, no TOCTOU).
  if (!created) {
    logger.info("Account deletion already in flight", { userId, jobId: job.id });
    return isJson ? c.json({ jobId: job.id, status: "deleting" }, 202) : c.redirect("/", 302);
  }

  // Route-level "requested" — the runner records "deletion.started" when the
  // cascade begins, so this must not duplicate that action.
  await recordAudit(c.env.DB, logger, {
    action: "deletion.requested",
    actorType: "user",
    actorId: userId,
    subject: job.id,
    detail: { kind: "account" },
  });

  // Best-effort immediate drive; the sweep is authoritative. We do NOT destroy
  // the acting session here — the response is committed first (deleting_at
  // already gates the NEXT request).
  const { runDeletionJob } = await import("../queue/deletion-runner");
  c.executionCtx.waitUntil(
    runDeletionJob(c.env, job.id, logger).then((r) => {
      if (!r.success) logger.error("Account deletion drive failed", r.error);
    }),
  );

  logger.info("Account deletion enqueued", { userId, jobId: job.id });
  if (!isJson) {
    return c.redirect("/", 302);
  }
  return c.json({ status: "deleting", jobId: job.id }, 202);
}

app.delete("/me", handleAccountDelete);
// Form-friendly alias for the UI "Danger Zone".
app.post("/me/delete", handleAccountDelete);

// GET /api/users/check-username - Check if username is available
app.get("/check-username", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  try {
    const username = c.req.query("username");

    if (!username || typeof username !== "string") {
      return c.json({ available: false, message: "Username is required" }, 400);
    }

    const normalizedUsername = username.toLowerCase().trim();

    // Validate username using shared validator (includes reserved name check)
    const validation = validateUsername(normalizedUsername, logger);
    if (!validation.success) {
      const message = validation.error[0]?.message ?? "Invalid username format";
      return c.json({ available: false, message }, 400);
    }

    // Check if username exists
    const existingUser = await getUserByUsername(c.env.DB, normalizedUsername, logger);

    if (existingUser.success) {
      return c.json({
        available: false,
        message: "This username is already taken",
      });
    }

    return c.json({ available: true, message: "Username is available" });
  } catch (error) {
    logger.error(
      "Error checking username availability",
      error instanceof Error ? error : undefined,
    );
    return c.json({ available: false, message: "Unable to check username availability" }, 500);
  }
});

export { app as usersRouter };
