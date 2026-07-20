import { generateApiKey } from "../utils/crypto";
import { AppError, NotFoundError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export interface Webhook {
  id: string;
  project: string;
  /** Globally-unique project UUID; NULL on rows written before dual-write. */
  projectId?: string;
  url: string;
  secret: string;
  /** Comma-separated event types, or "*" for all. */
  events: string;
  active: boolean;
  createdBy: string;
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  status: "success" | "failed";
  statusCode?: number;
  error?: string;
  durationMs?: number;
  createdAt: string;
}

interface WebhookRow {
  id: string;
  project: string;
  project_id: string | null;
  url: string;
  secret: string;
  events: string;
  active: number;
  created_by: string;
  created_at: string;
}

interface DeliveryRow {
  id: string;
  webhook_id: string;
  event_id: string;
  event_type: string;
  status: string;
  status_code: number | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

function rowToWebhook(row: WebhookRow): Webhook {
  const webhook: Webhook = {
    id: row.id,
    project: row.project,
    url: row.url,
    secret: row.secret,
    events: row.events,
    active: row.active === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
  if (row.project_id !== null) webhook.projectId = row.project_id;
  return webhook;
}

function rowToDelivery(row: DeliveryRow): WebhookDelivery {
  const delivery: WebhookDelivery = {
    id: row.id,
    webhookId: row.webhook_id,
    eventId: row.event_id,
    eventType: row.event_type,
    status: row.status as WebhookDelivery["status"],
    createdAt: row.created_at,
  };
  if (row.status_code !== null) delivery.statusCode = row.status_code;
  if (row.error !== null) delivery.error = row.error;
  if (row.duration_ms !== null) delivery.durationMs = row.duration_ms;
  return delivery;
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

/** Does this webhook subscribe to the given event type? */
export function webhookMatchesEvent(webhook: Webhook, eventType: string): boolean {
  if (webhook.events === "*") return true;
  return webhook.events
    .split(",")
    .map((entry) => entry.trim())
    .includes(eventType);
}

export async function createWebhook(
  db: D1Database,
  logger: Logger,
  opts: { project: string; projectId?: string; url: string; events?: string; createdBy: string },
): Promise<Result<Webhook, AppError>> {
  const id = newId("wh");
  const secret = await generateApiKey("stm_whsec");
  const createdAt = new Date().toISOString();
  const events = opts.events?.trim() || "*";

  try {
    await db
      .prepare(
        "INSERT INTO webhooks (id, project, project_id, url, secret, events, active, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
      )
      .bind(
        id,
        opts.project,
        opts.projectId ?? null,
        opts.url,
        secret,
        events,
        opts.createdBy,
        createdAt,
      )
      .run();

    logger.info("Webhook created", { webhookId: id, project: opts.project });
    const webhook: Webhook = {
      id,
      project: opts.project,
      url: opts.url,
      secret,
      events,
      active: true,
      createdBy: opts.createdBy,
      createdAt,
    };
    if (opts.projectId !== undefined) webhook.projectId = opts.projectId;
    return ok(webhook);
  } catch (error) {
    const appError = toAppError(error, "createWebhook", { project: opts.project });
    logger.error("Failed to create webhook", appError, { project: opts.project });
    return err(appError);
  }
}

export async function getWebhook(
  db: D1Database,
  logger: Logger,
  id: string,
): Promise<Result<Webhook, NotFoundError | AppError>> {
  try {
    const row = await db
      .prepare("SELECT * FROM webhooks WHERE id = ?")
      .bind(id)
      .first<WebhookRow>();
    if (!row) {
      logger.debug("Webhook not found", { webhookId: id });
      return err(new NotFoundError("Webhook", id));
    }
    return ok(rowToWebhook(row));
  } catch (error) {
    const appError = toAppError(error, "getWebhook", { webhookId: id });
    logger.error("Failed to get webhook", appError, { webhookId: id });
    return err(appError);
  }
}

export async function listWebhooks(
  db: D1Database,
  logger: Logger,
  project: string,
  opts?: { activeOnly?: boolean; projectId?: string },
): Promise<Result<Webhook[], AppError>> {
  try {
    const activeClause = opts?.activeOnly ? " AND active = 1" : "";
    // When a canonical project_id is known (delivery path), match on it and fall
    // back to the name only for legacy webhooks whose project_id wasn't backfilled.
    // Matching purely on the free-form `project` name would deliver one tenant's
    // events to a same-named project in ANOTHER namespace (cross-tenant leak).
    const result = opts?.projectId
      ? await db
          .prepare(
            `SELECT * FROM webhooks WHERE (project_id = ? OR (project_id IS NULL AND project = ?))${activeClause}`,
          )
          .bind(opts.projectId, project)
          .all<WebhookRow>()
      : await db
          .prepare(`SELECT * FROM webhooks WHERE project = ?${activeClause}`)
          .bind(project)
          .all<WebhookRow>();
    return ok(result.results.map(rowToWebhook));
  } catch (error) {
    const appError = toAppError(error, "listWebhooks", { project });
    logger.error("Failed to list webhooks", appError, { project });
    return err(appError);
  }
}

export async function deleteWebhook(
  db: D1Database,
  logger: Logger,
  id: string,
): Promise<Result<void, AppError>> {
  try {
    await db.prepare("DELETE FROM webhook_deliveries WHERE webhook_id = ?").bind(id).run();
    await db.prepare("DELETE FROM webhooks WHERE id = ?").bind(id).run();
    logger.info("Webhook deleted", { webhookId: id });
    return ok(undefined);
  } catch (error) {
    const appError = toAppError(error, "deleteWebhook", { webhookId: id });
    logger.error("Failed to delete webhook", appError, { webhookId: id });
    return err(appError);
  }
}

export async function setWebhookActive(
  db: D1Database,
  logger: Logger,
  id: string,
  active: boolean,
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare("UPDATE webhooks SET active = ? WHERE id = ?")
      .bind(active ? 1 : 0, id)
      .run();
    logger.info("Webhook active state updated", { webhookId: id, active });
    return ok(undefined);
  } catch (error) {
    const appError = toAppError(error, "setWebhookActive", { webhookId: id });
    logger.error("Failed to update webhook", appError, { webhookId: id });
    return err(appError);
  }
}

export async function recordDelivery(
  db: D1Database,
  logger: Logger,
  opts: {
    webhookId: string;
    eventId: string;
    eventType: string;
    status: "success" | "failed";
    statusCode?: number;
    error?: string;
    durationMs?: number;
  },
): Promise<Result<WebhookDelivery, AppError>> {
  const id = newId("whd");
  const createdAt = new Date().toISOString();

  try {
    await db
      .prepare(
        "INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, status, status_code, error, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        opts.webhookId,
        opts.eventId,
        opts.eventType,
        opts.status,
        opts.statusCode ?? null,
        opts.error ?? null,
        opts.durationMs ?? null,
        createdAt,
      )
      .run();

    const delivery: WebhookDelivery = {
      id,
      webhookId: opts.webhookId,
      eventId: opts.eventId,
      eventType: opts.eventType,
      status: opts.status,
      createdAt,
    };
    if (opts.statusCode !== undefined) delivery.statusCode = opts.statusCode;
    if (opts.error !== undefined) delivery.error = opts.error;
    if (opts.durationMs !== undefined) delivery.durationMs = opts.durationMs;
    return ok(delivery);
  } catch (error) {
    const appError = toAppError(error, "recordDelivery", { webhookId: opts.webhookId });
    logger.error("Failed to record webhook delivery", appError, { webhookId: opts.webhookId });
    return err(appError);
  }
}

export async function listDeliveries(
  db: D1Database,
  logger: Logger,
  webhookId: string,
  limit = 30,
): Promise<Result<WebhookDelivery[], AppError>> {
  try {
    const result = await db
      .prepare(
        "SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .bind(webhookId, limit)
      .all<DeliveryRow>();
    return ok(result.results.map(rowToDelivery));
  } catch (error) {
    const appError = toAppError(error, "listDeliveries", { webhookId });
    logger.error("Failed to list webhook deliveries", appError, { webhookId });
    return err(appError);
  }
}
