import { Hono } from "hono";
import { recordAudit } from "../storage/audit";
import { getUser, getUserByUsername, rotateUserToken } from "../storage/users";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";
import { ok } from "../utils/response";
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
