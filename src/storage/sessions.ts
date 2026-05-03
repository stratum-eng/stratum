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
): Promise<Result<Session, AppError>> {
  logger.debug("Creating session", { userId });
  try {
    const id = newId("sess");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await db
      .prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(id, userId, expiresAt)
      .run();

    logger.info("Session created", { sessionId: id, userId });
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
