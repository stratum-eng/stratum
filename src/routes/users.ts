import { Hono } from "hono";
import type { Context } from "hono";
import { recordAudit } from "../storage/audit";
import { createDeletionJob } from "../storage/deletion-jobs";
import { getUser, getUserByUsername, markUserDeleting, rotateUserToken } from "../storage/users";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";
import { badRequest, internalError, ok } from "../utils/response";
import { validateUsername } from "../utils/username-validation";

const app = new Hono<{ Bindings: Env }>();

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
    const body = await c.req
      .json<{ confirm?: unknown }>()
      .catch(() => ({}) as { confirm?: unknown });
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
