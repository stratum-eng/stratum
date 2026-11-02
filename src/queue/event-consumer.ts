import { trackerForEventActor, trackerForSystem } from "../analytics/tracker";
import {
  type EventRecord,
  getEvent,
  incrementEventAttempts,
  listStalePendingEvents,
  markEventFailed,
  markEventProcessed,
  setCompletedHandlers,
} from "../storage/events";
import type { Env, Message, MessageBatch } from "../types";
import type { Logger } from "../utils/logger";
import { createLogger } from "../utils/logger";
import { forwardDeployRequest, isInternalEventType } from "./deploy-queue";
import type { EventQueueMessage } from "./events";
import { autoCloseLinkedIssues } from "./issue-autoclose";
import { deliverEventToWebhooks } from "./webhook-delivery";

/** Attempts after which a pending event is abandoned and marked failed. */
export const MAX_EVENT_ATTEMPTS = 5;

/** Pending events older than this are re-enqueued by the sweep cron. */
const STALE_EVENT_MS = 5 * 60 * 1000;

export interface EventHandler {
  /** Stable name used in logs. */
  name: string;
  handle(env: Env, event: EventRecord, logger: Logger): Promise<void>;
}

const analyticsHandler: EventHandler = {
  name: "analytics",
  async handle(env, event, logger) {
    // Resolving the actor's telemetry preference (#257) is the tracker's job,
    // and it fails closed: an unresolvable lookup yields a tracker that sends
    // nothing. A queue consumer has no request and no auth context, so unlike
    // the request path it must read the preference from D1 — one lookup for a
    // user-authored event, two for an agent-authored one, against the 4+ D1
    // operations `consumeOne` already performs per message.
    //
    // Neither the lookup nor the send may fail the message: analytics is
    // best-effort, and throwing here would stop issue-autoclose and webhooks
    // from ever running.
    //
    // Suppression and delivery are alike TERMINAL, not deferred. Returning
    // normally lets `processEvent` record "analytics" in `completed_handlers`,
    // so a later retry of the same message skips this handler rather than
    // re-attempting the export. A transient D1 error therefore drops one
    // analytics event permanently. That is the deliberate trade: retrying
    // would either re-run the export for a user who may have opted out in the
    // meantime, or block the handlers that are not best-effort.
    try {
      const tracker = await trackerForEventActor(env, event, logger);
      await tracker.captureDomainEvent(event);
    } catch (error) {
      logger.warn("Analytics handler threw; dropping event export", {
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};

const webhookHandler: EventHandler = {
  name: "webhooks",
  async handle(env, event, logger) {
    await deliverEventToWebhooks(env, event, logger);
  },
};

const issueAutoCloseHandler: EventHandler = {
  name: "issue-autoclose",
  async handle(env, event, logger) {
    await autoCloseLinkedIssues(env, event, logger);
  },
};

const deployForwardHandler: EventHandler = {
  name: "deploy-forward",
  async handle(env, event, logger) {
    await forwardDeployRequest(env, event, logger);
  },
};

/**
 * Ordered handler registry. Every handler runs for every event and decides
 * internally whether the event type concerns it. Issue auto-close runs
 * before webhooks so receivers observe a consistent issue state.
 */
const handlers: EventHandler[] = [analyticsHandler, issueAutoCloseHandler, webhookHandler];

/**
 * Handlers for an *internal* outbox row — one that carries work rather than a
 * domain notification, and whose only job is to reach the queue that owns that
 * work. The registry above is deliberately not consulted for these: a webhook
 * subscribed to `*` would otherwise receive a recovery record as though it were
 * something that happened to the project, and analytics would count it as a
 * product event.
 */
const internalHandlers: EventHandler[] = [deployForwardHandler];

/** Exported for tests. Runs the ordered handlers, resuming past completed ones. */
export async function processEvent(env: Env, event: EventRecord, logger: Logger): Promise<void> {
  const active = isInternalEventType(event.type) ? internalHandlers : handlers;
  // Resume from where a prior attempt left off: skip handlers already recorded as
  // completed, and persist progress after each success so a later failure doesn't
  // re-run (and re-emit) the ones that already ran. On failure, stop — running a
  // later handler on an inconsistent earlier state would defeat the ordering.
  const completed = [...(event.completedHandlers ?? [])];
  const completedSet = new Set(completed);
  for (const handler of active) {
    if (completedSet.has(handler.name)) continue;
    await handler.handle(env, event, logger);
    completed.push(handler.name);
    completedSet.add(handler.name);
    // If we can't persist progress, stop and let the message retry rather than
    // running later handlers on unpersisted state — otherwise a subsequent failure
    // would re-run (re-emit) this handler, the exact idempotency hole this guards.
    const persisted = await setCompletedHandlers(env.DB, logger, event.id, completed);
    if (!persisted.success) throw persisted.error;
  }
}

async function consumeOne(
  env: Env,
  msg: Message<EventQueueMessage>,
  logger: Logger,
): Promise<void> {
  const eventId = msg.body?.eventId;
  if (typeof eventId !== "string" || !eventId) {
    logger.warn("Event queue message without eventId; dropping", { messageId: msg.id });
    msg.ack();
    return;
  }

  const eventResult = await getEvent(env.DB, logger, eventId);
  if (!eventResult.success) {
    if (eventResult.error.code === "NOT_FOUND") {
      logger.warn("Event row missing for queue message; dropping", { eventId });
      msg.ack();
    } else {
      // Transient D1 error — let the queue redeliver.
      msg.retry();
    }
    return;
  }
  const event = eventResult.data;

  if (event.status !== "pending") {
    msg.ack();
    return;
  }

  await incrementEventAttempts(env.DB, logger, eventId);

  try {
    await processEvent(env, event, logger);
  } catch (error) {
    const attempts = event.attempts + 1;
    logger.error(
      "Event handler failed",
      error instanceof Error ? error : new Error(String(error)),
      { eventId, eventType: event.type, attempts },
    );
    if (attempts >= MAX_EVENT_ATTEMPTS) {
      await markEventFailed(env.DB, logger, eventId);
      // An abandoned event is a durable notification that will never be
      // delivered — a webhook subscriber silently missing a merge. It is the
      // one queue outcome worth a metric, and it is reported personless
      // against the instance rather than against whoever happened to trigger
      // it: this describes the instance failing, not something a user did.
      // Awaited, not scheduled: a queue consumer has no `waitUntil`, so an
      // unawaited fetch can be cancelled when the handler returns.
      await trackerForSystem(env).capture("background_job_completed", {
        job: "event-consumer",
        outcome: "abandoned",
        attempts,
      });
      msg.ack();
    } else {
      msg.retry();
    }
    return;
  }

  await markEventProcessed(env.DB, logger, eventId);
  msg.ack();
}

export async function handleEventQueue(
  batch: MessageBatch<EventQueueMessage>,
  env: Env,
): Promise<void> {
  const logger = createLogger({ component: "EventConsumer" });
  for (const msg of batch.messages) {
    await consumeOne(env, msg, logger);
  }
}

/**
 * Re-enqueue pending events whose queue message was lost, and abandon events
 * that exhausted their attempt budget. Runs on the frequent cron.
 */
export async function sweepStaleEvents(env: Env, logger: Logger): Promise<void> {
  const staleResult = await listStalePendingEvents(env.DB, logger, { olderThanMs: STALE_EVENT_MS });
  if (!staleResult.success) return;
  const stale = staleResult.data;
  if (stale.length === 0) return;

  logger.info("Sweeping stale pending events", { count: stale.length });

  for (const event of stale) {
    if (event.attempts >= MAX_EVENT_ATTEMPTS) {
      await markEventFailed(env.DB, logger, event.id);
      continue;
    }
    if (!env.EVENTS_QUEUE) {
      // No queue bound (local dev): process inline so events still complete.
      await incrementEventAttempts(env.DB, logger, event.id);
      try {
        await processEvent(env, event, logger);
        await markEventProcessed(env.DB, logger, event.id);
      } catch (error) {
        logger.error(
          "Inline event processing failed during sweep",
          error instanceof Error ? error : new Error(String(error)),
          { eventId: event.id, eventType: event.type },
        );
      }
      continue;
    }
    try {
      const message: EventQueueMessage = { eventId: event.id };
      await env.EVENTS_QUEUE.send(message);
    } catch (error) {
      logger.warn("Failed to re-enqueue stale event", {
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
