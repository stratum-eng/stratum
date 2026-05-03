import type { Queue } from "../types";
import { createLogger } from "../utils/logger";

export type StratumEvent =
  | { type: "change.created"; changeId: string; project: string; workspace: string }
  | { type: "change.evaluated"; changeId: string; score: number; passed: boolean }
  | { type: "change.merged"; changeId: string; project: string; commit: string }
  | { type: "change.rejected"; changeId: string; project: string };

const logger = createLogger({ component: "Events" });

export async function publishEvent(
  queue: Queue | undefined | null,
  event: StratumEvent,
): Promise<void> {
  if (!queue) {
    logger.debug("Event not published - no queue configured", { eventType: event.type });
    return;
  }

  logger.debug("Publishing event", {
    eventType: event.type,
    changeId: "changeId" in event ? event.changeId : undefined,
  });

  try {
    await queue.send(event);
    logger.info("Event published successfully", {
      eventType: event.type,
      changeId: "changeId" in event ? event.changeId : undefined,
    });
  } catch (err) {
    logger.error("Failed to publish event", err instanceof Error ? err : new Error(String(err)), {
      eventType: event.type,
    });
    throw err;
  }
}
