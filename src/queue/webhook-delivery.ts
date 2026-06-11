import type { EventRecord } from "../storage/events";
import {
  type Webhook,
  listWebhooks,
  recordDelivery,
  webhookMatchesEvent,
} from "../storage/webhooks";
import type { Env } from "../types";
import type { Logger } from "../utils/logger";

/** Per-delivery timeout. A slow receiver must not stall event processing. */
const DELIVERY_TIMEOUT_MS = 10_000;

/** Truncated error text stored in the delivery log. */
const MAX_ERROR_LENGTH = 300;

export interface WebhookPayload {
  id: string;
  type: string;
  project: string;
  actorType: string;
  actorId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export async function signPayload(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

async function deliverToWebhook(
  db: D1Database,
  webhook: Webhook,
  event: EventRecord,
  logger: Logger,
): Promise<void> {
  const payload: WebhookPayload = {
    id: event.id,
    type: event.type,
    project: event.project,
    actorType: event.actorType,
    ...(event.actorId !== undefined ? { actorId: event.actorId } : {}),
    payload: event.payload,
    createdAt: event.createdAt,
  };
  const body = JSON.stringify(payload);
  const signature = await signPayload(webhook.secret, body);
  const startedAt = Date.now();

  try {
    const response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "stratum-webhooks",
        "X-Stratum-Event": event.type,
        "X-Stratum-Delivery-Event": event.id,
        "X-Stratum-Signature": signature,
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    await recordDelivery(db, logger, {
      webhookId: webhook.id,
      eventId: event.id,
      eventType: event.type,
      status: response.ok ? "success" : "failed",
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
      ...(response.ok ? {} : { error: `Receiver responded ${response.status}` }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Webhook delivery failed", {
      webhookId: webhook.id,
      eventId: event.id,
      error: message,
    });
    await recordDelivery(db, logger, {
      webhookId: webhook.id,
      eventId: event.id,
      eventType: event.type,
      status: "failed",
      error: message.slice(0, MAX_ERROR_LENGTH),
      durationMs: Date.now() - startedAt,
    });
  }
}

/**
 * Deliver an event to every active, matching webhook on its project.
 *
 * Per-webhook failures are recorded in the delivery log and never thrown:
 * retrying the whole event would re-deliver to receivers that already
 * succeeded. Failed deliveries are visible (and re-sendable) per webhook.
 */
export async function deliverEventToWebhooks(
  env: Env,
  event: EventRecord,
  logger: Logger,
): Promise<void> {
  const webhooksResult = await listWebhooks(env.DB, logger, event.project, { activeOnly: true });
  if (!webhooksResult.success) return;

  const matching = webhooksResult.data.filter((webhook) =>
    webhookMatchesEvent(webhook, event.type),
  );
  if (matching.length === 0) return;

  await Promise.all(matching.map((webhook) => deliverToWebhook(env.DB, webhook, event, logger)));
}
