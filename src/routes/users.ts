import { Hono } from "hono";
import { createUser, getUser, getUserByUsername } from "../storage/users";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";
import { badRequest, created, ok } from "../utils/response";
import { isValidEmail } from "../utils/validation";

const app = new Hono<{ Bindings: Env }>();

app.post("/", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const body = await c.req.json<{ email?: unknown }>();
  if (!isValidEmail(body.email)) {
    logger.warn("Invalid email in create user request");
    return badRequest("email must be a valid email address");
  }

  const result = await createUser(c.env.DB, body.email, logger);

  if (!result.success) {
    logger.error("Failed to create user", result.error);
    return c.json({ error: "Failed to create user" }, 500);
  }

  const { user, plaintext } = result.data;
  logger.info("User created via API", { userId: user.id });

  return created({
    user: { id: user.id, email: user.email, createdAt: user.createdAt },
    token: plaintext,
  });
});

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

// GET /api/users/check-username - Check if username is available
app.get("/check-username", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const username = c.req.query("username");

  if (!username || typeof username !== "string") {
    return c.json({ available: false, message: "Username is required" }, 400);
  }

  const normalizedUsername = username.toLowerCase().trim();

  // Validate username format
  const USERNAME_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  if (
    normalizedUsername.length < 3 ||
    normalizedUsername.length > 39 ||
    !USERNAME_REGEX.test(normalizedUsername) ||
    normalizedUsername.includes("--")
  ) {
    return c.json({ available: false, message: "Invalid username format" }, 400);
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
});

export { app as usersRouter };
