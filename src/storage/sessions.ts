import { AppError, NotFoundError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export interface Session {
  id: string;
  userId: string;
  expiresAt: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
  };
}

export async function createSession(
  db: D1Database,
  userId: string,
  logger: Logger,
  rememberMe = true,
): Promise<Result<Session, AppError>> {
  logger.debug("Creating session", { userId, rememberMe });
  try {
    const id = newId("sess");
    // 30 days for remember me, 1 day otherwise
    const expirationDays = rememberMe ? 30 : 1;
    const expiresAt = new Date(Date.now() + expirationDays * 24 * 60 * 60 * 1000).toISOString();

    await db
      .prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(id, userId, expiresAt)
      .run();

    logger.info("Session created", { sessionId: id, userId, rememberMe });
    return ok({ id, userId, expiresAt });
  } catch (error) {
    logger.error("Failed to create session", error instanceof Error ? error : undefined, {
      userId,
    });
    return err(
      new AppError(`Failed to create session for user '${userId}'`, "STORAGE_ERROR", 500, {
        userId,
      }),
    );
  }
}

export async function getSession(
  db: D1Database,
  id: string,
  logger: Logger,
): Promise<Result<Session, NotFoundError>> {
  logger.debug("Fetching session", { id });
  const row = await db
    .prepare("SELECT id, user_id, expires_at FROM sessions WHERE id = ?")
    .bind(id)
    .first<SessionRow>();

  if (!row) {
    return err(new NotFoundError("Session", id));
  }

  return ok(rowToSession(row));
}

export async function deleteSession(
  db: D1Database,
  id: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  logger.debug("Deleting session", { id });
  try {
    await db.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
    logger.info("Session deleted", { sessionId: id });
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to delete session", error instanceof Error ? error : undefined, { id });
    return err(
      new AppError(`Failed to delete session '${id}'`, "STORAGE_ERROR", 500, { sessionId: id }),
    );
  }
}

/**
 * Refresh a session by extending its expiration time.
 * Only extends if the session is still valid.
 */
export async function refreshSession(
  db: D1Database,
  id: string,
  rememberMe: boolean,
  logger: Logger,
): Promise<Result<Session, AppError | NotFoundError>> {
  logger.debug("Refreshing session", { id, rememberMe });

  // First check if session exists and is valid
  const sessionResult = await getSession(db, id, logger);
  if (!sessionResult.success) {
    return err(sessionResult.error);
  }

  const session = sessionResult.data;
  const now = new Date();
  const expiresAt = new Date(session.expiresAt);

  // Don't refresh expired sessions
  if (expiresAt < now) {
    logger.warn("Attempted to refresh expired session", { sessionId: id });
    return err(new AppError("Session has expired", "SESSION_EXPIRED", 401, { sessionId: id }));
  }

  try {
    // Calculate new expiration based on remember me preference
    const extensionDays = rememberMe ? 30 : 1;
    const newExpiresAt = new Date(Date.now() + extensionDays * 24 * 60 * 60 * 1000).toISOString();

    await db
      .prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(newExpiresAt, id)
      .run();

    logger.info("Session refreshed", { sessionId: id, newExpiresAt, rememberMe });
    return ok({ ...session, expiresAt: newExpiresAt });
  } catch (error) {
    logger.error("Failed to refresh session", error instanceof Error ? error : undefined, { id });
    return err(
      new AppError(`Failed to refresh session '${id}'`, "STORAGE_ERROR", 500, { sessionId: id }),
    );
  }
}

/**
 * Delete all sessions for a user (logout from all devices)
 */
export async function deleteAllUserSessions(
  db: D1Database,
  userId: string,
  logger: Logger,
): Promise<Result<number, AppError>> {
  logger.debug("Deleting all sessions for user", { userId });
  try {
    const result = await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
    const deletedCount = result.meta?.changes ?? 0;
    logger.info("All user sessions deleted", { userId, deletedCount });
    return ok(deletedCount);
  } catch (error) {
    logger.error("Failed to delete user sessions", error instanceof Error ? error : undefined, {
      userId,
    });
    return err(
      new AppError(`Failed to delete sessions for user '${userId}'`, "STORAGE_ERROR", 500, {
        userId,
      }),
    );
  }
}

/**
 * Get all active sessions for a user
 */
export async function getUserSessions(
  db: D1Database,
  userId: string,
  logger: Logger,
): Promise<Result<Session[], AppError>> {
  logger.debug("Fetching sessions for user", { userId });
  try {
    const { results } = await db
      .prepare(
        "SELECT id, user_id, expires_at FROM sessions WHERE user_id = ? ORDER BY expires_at DESC",
      )
      .bind(userId)
      .all<SessionRow>();

    const sessions = (results ?? []).map(rowToSession);
    logger.debug("Sessions fetched", { userId, count: sessions.length });
    return ok(sessions);
  } catch (error) {
    logger.error("Failed to fetch user sessions", error instanceof Error ? error : undefined, {
      userId,
    });
    return err(
      new AppError(`Failed to fetch sessions for user '${userId}'`, "STORAGE_ERROR", 500, {
        userId,
      }),
    );
  }
}
