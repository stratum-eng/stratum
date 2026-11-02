import type { AnalyticsTracker } from "../analytics/tracker";
import { trackerForSystem } from "../analytics/tracker";
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
  tracker: AnalyticsTracker,
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
      // Don't follow a redirect that could point at an internal address after
      // the create-time URL check; an opaque-redirect response is `ok === false`
      // and recorded as a failed delivery below.
      redirect: "manual",
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
    // The delivery log answers "did MY webhook fire" for one project owner.
    // This answers the operator's version — "is outbound delivery healthy on
    // this instance" — which the per-project log cannot, because nobody reads
    // every project's log. Carries no URL, no ids, and no receiver response.
    await trackDelivery(tracker, response.ok);
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
    await trackDelivery(tracker, false);
  }
}

/** One personless delivery outcome. The receiver's identity never leaves the instance. */
function trackDelivery(tracker: AnalyticsTracker, ok: boolean): Promise<void> {
  return tracker.capture("background_job_completed", {
    job: "webhook-delivery",
    outcome: ok ? "succeeded" : "failed",
  });
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
  // Delivery is scoped by the canonical project_id only (#235). An outbox row
  // that carries no project_id cannot be scoped to a tenant: resolving its
  // free-form `project` name would deliver to whichever same-named project
  // happened to match, across namespaces. Drop it loudly instead — every
  // current emitter threads the id through `emitEvent`, so a row without one is
  // legacy, and a missed delivery is recoverable where a cross-tenant one is
  // not.
  if (event.projectId === undefined) {
    logger.warn("Skipping webhook delivery for an event with no project_id", {
      eventId: event.id,
      eventType: event.type,
      project: event.project,
    });
    return;
  }

  const webhooksResult = await listWebhooks(env.DB, logger, event.projectId, {
    activeOnly: true,
  });
  if (!webhooksResult.success) return;

  const matching = webhooksResult.data.filter((webhook) =>
    webhookMatchesEvent(webhook, event.type),
  );
  if (matching.length === 0) return;

  // One tracker for the whole fan-out: it holds no per-delivery state, and
  // building it per webhook would re-read the environment for each receiver.
  const tracker = trackerForSystem(env);
  await Promise.all(
    matching.map((webhook) => deliverToWebhook(env.DB, webhook, event, logger, tracker)),
  );
}
