import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { authMiddleware } from "../middleware/auth";
import {
  deleteAllUserSessions,
  deleteSession,
  getUserSessions,
  refreshSession,
} from "../storage/sessions";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";

const app = new Hono<{ Bindings: Env }>();

// Apply auth middleware to all routes
app.use("*", authMiddleware);

/**
 * POST /auth/session/refresh
 * Refresh the current session, extending its expiration.
 * Query param: rememberMe=true/false (default: true for 30 days)
 */
app.post("/refresh", async (c) => {
  const userId = c.get("userId");

  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
    userId,
  });

  const sessionId = getCookie(c, "stratum_session");
  if (!sessionId) {
    return c.json({ error: "No active session" }, 401);
  }

  // Check remember me preference (default to true for backward compatibility)
  const rememberMe = c.req.query("rememberMe") !== "false";

  logger.debug("Refreshing session", { rememberMe });

  const result = await refreshSession(c.env.DB, sessionId, rememberMe, logger);

  if (!result.success) {
    if (result.error.name === "NotFoundError") {
      // Session not found - clear cookie
      deleteCookie(c, "stratum_session", { path: "/" });
      return c.json({ error: "Session not found" }, 401);
    }

    if (result.error.code === "SESSION_EXPIRED") {
      // Session expired - clear cookie
      deleteCookie(c, "stratum_session", { path: "/" });
      return c.json({ error: "Session expired" }, 401);
    }

    return c.json({ error: "Failed to refresh session" }, 500);
  }

  // Update cookie with new expiration
  const maxAge = rememberMe ? 2592000 : 86400; // 30 days or 1 day
  setCookie(c, "stratum_session", result.data.id, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge,
    path: "/",
  });

  logger.info("Session refreshed successfully", { rememberMe });

  return c.json({
    success: true,
    expiresAt: result.data.expiresAt,
    rememberMe,
  });
});

/**
 * DELETE /auth/session/all
 * Logout from all devices by deleting all sessions for the user.
 */
app.delete("/all", async (c) => {
  const userId = c.get("userId");

  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
    userId,
  });

  logger.info("Logging out from all devices");

  const result = await deleteAllUserSessions(c.env.DB, userId, logger);

  if (!result.success) {
    logger.error("Failed to logout from all devices");
    return c.json({ error: "Failed to logout from all devices" }, 500);
  }

  // Clear current session cookie
  deleteCookie(c, "stratum_session", { path: "/" });

  logger.info("Logged out from all devices", { deletedCount: result.data });

  return c.json({
    success: true,
    message: `Logged out from ${result.data} device(s)`,
    deletedCount: result.data,
  });
});

/**
 * GET /auth/sessions
 * List all active sessions for the current user.
 */
app.get("/", async (c) => {
  const userId = c.get("userId");

  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
    userId,
  });

  const result = await getUserSessions(c.env.DB, userId, logger);

  if (!result.success) {
    logger.error("Failed to fetch sessions");
    return c.json({ error: "Failed to fetch sessions" }, 500);
  }

  const currentSessionId = getCookie(c, "stratum_session");

  // Mark current session and filter out expired ones
  const now = new Date();
  const sessions = result.data
    .filter((session) => new Date(session.expiresAt) > now)
    .map((session) => ({
      id: session.id,
      expiresAt: session.expiresAt,
      isCurrent: session.id === currentSessionId,
    }));

  return c.json({
    sessions,
    count: sessions.length,
  });
});

/**
 * DELETE /auth/sessions/:id
 * Delete a specific session (logout from a specific device).
 */
app.delete("/:id", async (c) => {
  const userId = c.get("userId");

  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const sessionIdToDelete = c.req.param("id");
  const currentSessionId = getCookie(c, "stratum_session");

  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
    userId,
  });

  logger.debug("Deleting specific session", { sessionId: sessionIdToDelete });

  const result = await deleteSession(c.env.DB, sessionIdToDelete, logger);

  if (!result.success) {
    return c.json({ error: "Session not found" }, 404);
  }

  // If deleting current session, clear the cookie
  if (sessionIdToDelete === currentSessionId) {
    deleteCookie(c, "stratum_session", { path: "/" });
    logger.info("Current session deleted, user logged out");
  }

  return c.json({
    success: true,
    message: "Session deleted",
  });
});

export { app as sessionRouter };
