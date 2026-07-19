import { createPostHogClient } from "../analytics/posthog";
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
  async handle(env, event) {
    const posthog = createPostHogClient(env);
    await posthog.capture({
      event: `stratum.${event.type}`,
      distinctId: event.actorId ?? "system",
      properties: { project: event.project, actorType: event.actorType },
    });
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

/**
 * Ordered handler registry. Every handler runs for every event and decides
 * internally whether the event type concerns it. Issue auto-close runs
 * before webhooks so receivers observe a consistent issue state.
 */
const handlers: EventHandler[] = [analyticsHandler, issueAutoCloseHandler, webhookHandler];

/** Exported for tests. Runs the ordered handlers, resuming past completed ones. */
export async function processEvent(env: Env, event: EventRecord, logger: Logger): Promise<void> {
  // Resume from where a prior attempt left off: skip handlers already recorded as
  // completed, and persist progress after each success so a later failure doesn't
  // re-run (and re-emit) the ones that already ran. On failure, stop — running a
  // later handler on an inconsistent earlier state would defeat the ordering.
  const completed = [...(event.completedHandlers ?? [])];
  const completedSet = new Set(completed);
  for (const handler of handlers) {
    if (completedSet.has(handler.name)) continue;
    await handler.handle(env, event, logger);
    completed.push(handler.name);
    completedSet.add(handler.name);
    await setCompletedHandlers(env.DB, logger, event.id, completed);
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
