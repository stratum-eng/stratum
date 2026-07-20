import { hashToken } from "../utils/crypto";
import { AppError, NotFoundError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

// Sessions are stored HASHED at rest: the `id` column holds hashToken(rawId), and
// the raw id is only ever held by the client cookie. A read-only leak of the
// sessions table (SQLi read, a backup, logs) therefore yields no replayable
// credential — matching how user/agent/magic-link tokens are stored.

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
      .bind(await hashToken(id), userId, expiresAt)
      .run();

    logger.info("Session created", { userId, rememberMe });
    // Return the RAW id — it becomes the cookie; only its hash is persisted.
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
  logger.debug("Fetching session");
  const row = await db
    .prepare("SELECT id, user_id, expires_at FROM sessions WHERE id = ?")
    .bind(await hashToken(id))
    .first<SessionRow>();

  if (!row) {
    return err(new NotFoundError("Session", id));
  }

  // Return the caller's raw id (the row's id is the hash) so downstream refresh/
  // isCurrent comparisons against the cookie keep working.
  return ok({ id, userId: row.user_id, expiresAt: row.expires_at });
}

export async function deleteSession(
  db: D1Database,
  id: string,
  userId: string,
  logger: Logger,
): Promise<Result<boolean, AppError>> {
  logger.debug("Deleting session", { userId });
  try {
    const result = await db
      .prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?")
      .bind(await hashToken(id), userId)
      .run();

    const deleted = (result.meta?.changes ?? 0) > 0;

    if (deleted) {
      logger.info("Session deleted", { sessionId: id, userId });
    } else {
      logger.warn("Session not found or not owned by user", { sessionId: id, userId });
    }

    return ok(deleted);
  } catch (error) {
    logger.error("Failed to delete session", error instanceof Error ? error : undefined, {
      id,
      userId,
    });
    return err(
      new AppError(`Failed to delete session '${id}'`, "STORAGE_ERROR", 500, { sessionId: id }),
    );
  }
}

/**
 * Revoke a session by its STORED id (the hash surfaced by getUserSessions), NOT a
 * raw cookie value — so it must not be re-hashed. Used by the "log out of this
 * device" list UI, where the client only ever sees the opaque hashed handle.
 */
export async function deleteSessionByStoredId(
  db: D1Database,
  storedId: string,
  userId: string,
  logger: Logger,
): Promise<Result<boolean, AppError>> {
  try {
    const result = await db
      .prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?")
      .bind(storedId, userId)
      .run();
    return ok((result.meta?.changes ?? 0) > 0);
  } catch (error) {
    logger.error(
      "Failed to delete session by stored id",
      error instanceof Error ? error : undefined,
      {
        userId,
      },
    );
    return err(new AppError("Failed to delete session", "STORAGE_ERROR", 500, { userId }));
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
      .bind(newExpiresAt, await hashToken(id))
      .run();

    logger.info("Session refreshed", { newExpiresAt, rememberMe });
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
