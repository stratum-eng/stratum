import { Hono } from "hono";
import { createUser, getUser } from "../storage/users";
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

export { app as usersRouter };
