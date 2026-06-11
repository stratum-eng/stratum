import { type EventActorType, insertEvent } from "../storage/events";
import type { Queue } from "../types";
import type { Logger } from "../utils/logger";
import { createLogger } from "../utils/logger";

export type StratumEvent =
  | { type: "change.created"; project: string; changeId: string; workspace: string }
  | { type: "change.evaluated"; project: string; changeId: string; score: number; passed: boolean }
  | { type: "change.merged"; project: string; changeId: string; commit: string }
  | { type: "change.rejected"; project: string; changeId: string }
  | { type: "project.created"; project: string }
  | { type: "project.imported"; project: string; sourceUrl: string }
  // workspace.deleted is deliberately absent: the delete path only knows the
  // project ID, and events are scoped by project name. It lands with the
  // project-identity unification work.
  | { type: "workspace.created"; project: string; workspace: string }
  | { type: "sync.completed"; project: string; commit?: string }
  | { type: "issue.opened"; project: string; issueNumber: number; title: string }
  | {
      type: "issue.closed";
      project: string;
      issueNumber: number;
      title: string;
      changeId?: string;
    };

export interface EventActor {
  type: EventActorType;
  id?: string;
}

/** Message delivered on the stratum-events queue. The outbox row is the source of truth. */
export interface EventQueueMessage {
  eventId: string;
}

const fallbackLogger = createLogger({ component: "Events" });

/**
 * Durably record a domain event (outbox row in D1), then nudge the queue consumer.
 *
 * The queue send is best-effort: if it fails or no queue is bound, the sweep cron
 * re-enqueues pending rows. Never throws — event emission must not break the
 * primary request path.
 */
export async function emitEvent(
  db: D1Database,
  queue: Queue | undefined | null,
  event: StratumEvent,
  actor: EventActor,
  logger: Logger = fallbackLogger,
): Promise<void> {
  const { type, project, ...payload } = event;

  const insertResult = await insertEvent(db, logger, {
    type,
    project,
    actorType: actor.type,
    ...(actor.id !== undefined ? { actorId: actor.id } : {}),
    payload,
  });
  if (!insertResult.success) {
    // Already logged by insertEvent; nothing durable to deliver, so stop here.
    return;
  }

  if (!queue) {
    logger.debug("No events queue bound; event waits for sweep", {
      eventId: insertResult.data.id,
      eventType: type,
    });
    return;
  }

  try {
    const message: EventQueueMessage = { eventId: insertResult.data.id };
    await queue.send(message);
  } catch (error) {
    logger.warn("Event queue send failed; sweep will re-enqueue", {
      eventId: insertResult.data.id,
      eventType: type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
