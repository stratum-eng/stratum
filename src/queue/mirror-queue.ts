/**
 * Consumer for the `stratum-mirrors` queue (#417).
 *
 * A message says only "project X's mirror may have work"; what the work is
 * lives in the `push_mirrors` row. So every outcome but one is an ack:
 *
 * - **pushed / skipped / busy / diverged / failed** — acked. Each is either
 *   done, or recorded in D1 in a state nothing about redelivery improves.
 *   `busy` in particular is safe to drop: the run holding the lease re-reads
 *   the request counter before it lets go.
 * - **retry** — redelivered after the backoff the run chose. The row carries
 *   the same due time, so if this message outlives the queue's retry budget the
 *   five-minute sweep sends a fresh one. That is why this queue has no
 *   dead-letter queue: a dropped message loses nothing.
 *
 * A malformed body is acked with a logged error; redelivery would not change
 * its shape.
 */
import { type MirrorQueueMessage, runPushMirror } from "../github/mirror";
import type { Env, Message, MessageBatch } from "../types";
import { type Logger, createLogger } from "../utils/logger";

function isMirrorMessage(body: unknown): body is MirrorQueueMessage {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Record<string, unknown>;
  return (
    candidate.type === "mirror.push" &&
    typeof candidate.projectId === "string" &&
    candidate.projectId.length > 0
  );
}

async function consumeOne(env: Env, msg: Message<unknown>, logger: Logger): Promise<void> {
  if (!isMirrorMessage(msg.body)) {
    logger.error("Malformed mirror queue message; acking", undefined, { messageId: msg.id });
    msg.ack();
    return;
  }
  const { projectId } = msg.body;
  const outcome = await runPushMirror(env, logger, projectId);
  if (outcome.kind === "retry") {
    msg.retry({ delaySeconds: outcome.delaySeconds });
    return;
  }
  logger.info("Mirror message handled", { projectId, outcome: outcome.kind });
  msg.ack();
}

/**
 * Queue entry point. Walked serially even though `max_batch_size = 1` makes
 * that a formality: each push holds a clone in memory, and a raised batch size
 * must not turn into several clones sharing one isolate.
 */
export async function handleMirrorQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const logger = createLogger({ component: "MirrorConsumer" });
  for (const msg of batch.messages) {
    await consumeOne(env, msg, logger);
  }
}
