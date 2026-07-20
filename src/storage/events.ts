import { AppError, NotFoundError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export type EventActorType = "user" | "agent" | "system";
export type EventStatus = "pending" | "processed" | "failed";

export interface EventRecord {
  id: string;
  type: string;
  project: string;
  /** Globally-unique project UUID; NULL on rows written before dual-write. */
  projectId?: string;
  actorType: EventActorType;
  actorId?: string;
  payload: Record<string, unknown>;
  status: EventStatus;
  attempts: number;
  createdAt: string;
  processedAt?: string;
  /** Names of handlers that have already run for this event, so a retry skips
   * them instead of re-running (and re-emitting) already-succeeded work. */
  completedHandlers?: string[];
}

interface EventRow {
  id: string;
  type: string;
  project: string;
  project_id: string | null;
  actor_type: string;
  actor_id: string | null;
  payload: string;
  status: string;
  attempts: number;
  created_at: string;
  processed_at: string | null;
  completed_handlers: string | null;
}

function rowToEvent(row: EventRow, logger: Logger): EventRecord {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    logger.warn("Event payload is not valid JSON", { eventId: row.id });
  }

  let completedHandlers: string[] = [];
  if (row.completed_handlers) {
    try {
      const parsed: unknown = JSON.parse(row.completed_handlers);
      if (Array.isArray(parsed))
        completedHandlers = parsed.filter((v): v is string => typeof v === "string");
    } catch {
      logger.warn("Event completed_handlers is not valid JSON", { eventId: row.id });
    }
  }

  const event: EventRecord = {
    id: row.id,
    type: row.type,
    project: row.project,
    actorType: row.actor_type as EventActorType,
    payload,
    status: row.status as EventStatus,
    attempts: row.attempts,
    createdAt: row.created_at,
    completedHandlers,
  };
  if (row.project_id !== null) event.projectId = row.project_id;
  if (row.actor_id !== null) event.actorId = row.actor_id;
  if (row.processed_at !== null) event.processedAt = row.processed_at;
  return event;
}

function toAppError(error: unknown, operation: string, context: Record<string, unknown>) {
  return error instanceof AppError
    ? error
    : new AppError(
        error instanceof Error ? error.message : `Failed in ${operation}`,
        "DATABASE_ERROR",
        500,
        { operation, ...context },
      );
}

export async function insertEvent(
  db: D1Database,
  logger: Logger,
  opts: {
    type: string;
    project: string;
    projectId?: string;
    actorType: EventActorType;
    actorId?: string;
    payload: Record<string, unknown>;
  },
): Promise<Result<EventRecord, AppError>> {
  const id = newId("evt");
  const createdAt = new Date().toISOString();

  try {
    await db
      .prepare(
        "INSERT INTO events (id, type, project, project_id, actor_type, actor_id, payload, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)",
      )
      .bind(
        id,
        opts.type,
        opts.project,
        opts.projectId ?? null,
        opts.actorType,
        opts.actorId ?? null,
        JSON.stringify(opts.payload),
        createdAt,
      )
      .run();

    const event: EventRecord = {
      id,
      type: opts.type,
      project: opts.project,
      actorType: opts.actorType,
      payload: opts.payload,
      status: "pending",
      attempts: 0,
      createdAt,
    };
    if (opts.projectId !== undefined) event.projectId = opts.projectId;
    if (opts.actorId !== undefined) event.actorId = opts.actorId;

    logger.debug("Event inserted", { eventId: id, eventType: opts.type, project: opts.project });
    return ok(event);
  } catch (error) {
    const appError = toAppError(error, "insertEvent", { eventType: opts.type });
    logger.error("Failed to insert event", appError, { eventType: opts.type });
    return err(appError);
  }
}

export async function getEvent(
  db: D1Database,
  logger: Logger,
  id: string,
): Promise<Result<EventRecord, NotFoundError | AppError>> {
  try {
    const row = await db.prepare("SELECT * FROM events WHERE id = ?").bind(id).first<EventRow>();
    if (!row) {
      logger.debug("Event not found", { eventId: id });
      return err(new NotFoundError("Event", id));
    }
    return ok(rowToEvent(row, logger));
  } catch (error) {
    const appError = toAppError(error, "getEvent", { eventId: id });
    logger.error("Failed to get event", appError, { eventId: id });
    return err(appError);
  }
}

export async function listProjectEvents(
  db: D1Database,
  logger: Logger,
  project: string,
  limit = 50,
): Promise<Result<EventRecord[], AppError>> {
  try {
    const result = await db
      .prepare("SELECT * FROM events WHERE project = ? ORDER BY created_at DESC LIMIT ?")
      .bind(project, limit)
      .all<EventRow>();
    return ok(result.results.map((row) => rowToEvent(row, logger)));
  } catch (error) {
    const appError = toAppError(error, "listProjectEvents", { project });
    logger.error("Failed to list project events", appError, { project });
    return err(appError);
  }
}

export async function listRecentEvents(
  db: D1Database,
  logger: Logger,
  limit = 50,
): Promise<Result<EventRecord[], AppError>> {
  try {
    const result = await db
      .prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ?")
      .bind(limit)
      .all<EventRow>();
    return ok(result.results.map((row) => rowToEvent(row, logger)));
  } catch (error) {
    const appError = toAppError(error, "listRecentEvents", {});
    logger.error("Failed to list recent events", appError);
    return err(appError);
  }
}

export async function markEventProcessed(
  db: D1Database,
  logger: Logger,
  id: string,
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare("UPDATE events SET status = 'processed', processed_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), id)
      .run();
    logger.debug("Event marked processed", { eventId: id });
    return ok(undefined);
  } catch (error) {
    const appError = toAppError(error, "markEventProcessed", { eventId: id });
    logger.error("Failed to mark event processed", appError, { eventId: id });
    return err(appError);
  }
}

export async function markEventFailed(
  db: D1Database,
  logger: Logger,
  id: string,
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare("UPDATE events SET status = 'failed', processed_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), id)
      .run();
    logger.warn("Event marked failed", { eventId: id });
    return ok(undefined);
  } catch (error) {
    const appError = toAppError(error, "markEventFailed", { eventId: id });
    logger.error("Failed to mark event failed", appError, { eventId: id });
    return err(appError);
  }
}

export async function incrementEventAttempts(
  db: D1Database,
  logger: Logger,
  id: string,
): Promise<Result<void, AppError>> {
  try {
    await db.prepare("UPDATE events SET attempts = attempts + 1 WHERE id = ?").bind(id).run();
    return ok(undefined);
  } catch (error) {
    const appError = toAppError(error, "incrementEventAttempts", { eventId: id });
    logger.error("Failed to increment event attempts", appError, { eventId: id });
    return err(appError);
  }
}

/**
 * Persist the full set of handler names that have completed for an event, so a
 * retry can skip them. The caller passes the accumulated set (idempotent write).
 */
export async function setCompletedHandlers(
  db: D1Database,
  logger: Logger,
  id: string,
  handlerNames: string[],
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare("UPDATE events SET completed_handlers = ? WHERE id = ?")
      .bind(JSON.stringify(handlerNames), id)
      .run();
    return ok(undefined);
  } catch (error) {
    const appError = toAppError(error, "setCompletedHandlers", { eventId: id });
    logger.error("Failed to record completed handlers", appError, { eventId: id });
    return err(appError);
  }
}

export async function listStalePendingEvents(
  db: D1Database,
  logger: Logger,
  opts: { olderThanMs: number; limit?: number },
): Promise<Result<EventRecord[], AppError>> {
  const cutoff = new Date(Date.now() - opts.olderThanMs).toISOString();
  try {
    const result = await db
      .prepare(
        "SELECT * FROM events WHERE status = 'pending' AND created_at < ? ORDER BY created_at ASC LIMIT ?",
      )
      .bind(cutoff, opts.limit ?? 100)
      .all<EventRow>();
    return ok(result.results.map((row) => rowToEvent(row, logger)));
  } catch (error) {
    const appError = toAppError(error, "listStalePendingEvents", {});
    logger.error("Failed to list stale pending events", appError);
    return err(appError);
  }
}
