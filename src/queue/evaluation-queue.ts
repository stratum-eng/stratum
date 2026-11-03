/**
 * Consumer for the `stratum-evaluations` queue (#412, ADR 009).
 *
 * One message is one evaluation run. Outcomes:
 *
 * - **recorded or superseded** — acked. A superseded run is not a failure: the
 *   change moved on (a newer run, a reject, a merge), and redelivering it would
 *   only repeat a write the run-keyed guard already refuses.
 * - **permanent error** (the change's project or workspace is gone, a tree the
 *   diff refuses outright) — the run is failed closed and the message acked.
 * - **transient error** — retried, until the delivery that
 *   {@link MAX_EVALUATION_DELIVERIES} names as the last, which fails the run
 *   closed instead of leaving the change in `evaluating` for the sweep.
 *
 * A malformed body is acked with a logged error: nothing about redelivering it
 * changes its shape.
 */
import {
  MAX_EVALUATION_DELIVERIES,
  evaluationFailureReason,
  failEvaluationJob,
  runEvaluationJob,
} from "../services/evaluation-run";
import type { Env, EvaluationQueueMessage, Message, MessageBatch } from "../types";
import { type Logger, createLogger } from "../utils/logger";

/** Seconds before a transient failure is redelivered. */
const RETRY_DELAY_SECONDS = 30;

function isEvaluationMessage(body: unknown): body is EvaluationQueueMessage {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Record<string, unknown>;
  return (
    candidate.type === "change.evaluate" &&
    typeof candidate.changeId === "string" &&
    candidate.changeId.length > 0 &&
    typeof candidate.runId === "string" &&
    candidate.runId.length > 0
  );
}

async function consumeOne(
  env: Env,
  msg: Message<unknown>,
  logger: Logger,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<void> {
  if (!isEvaluationMessage(msg.body)) {
    logger.error("Malformed evaluation queue message; acking", undefined, { messageId: msg.id });
    msg.ack();
    return;
  }
  const { changeId, runId } = msg.body;
  const attempt = msg.attempts ?? 1;

  let failure: { message: string; permanent: boolean };
  try {
    const result = await runEvaluationJob(env, logger, { changeId, runId }, { waitUntil });
    if (result.success) {
      msg.ack();
      return;
    }
    failure = { message: result.error.message, permanent: result.error.permanent };
  } catch (error) {
    // `runEvaluationJob` returns a Result, but a runtime fault below it must
    // still end in a retry or a closed failure, never in a change stuck in
    // `evaluating` until the sweep.
    failure = { message: error instanceof Error ? error.message : String(error), permanent: false };
  }

  if (!failure.permanent && attempt < MAX_EVALUATION_DELIVERIES) {
    logger.warn("Evaluation run failed; retrying", {
      changeId,
      runId,
      attempt,
      error: failure.message,
    });
    msg.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    return;
  }

  await failEvaluationJob(env, logger, {
    changeId,
    runId,
    reason: evaluationFailureReason(failure.message),
  });
  msg.ack();
}

export async function handleEvaluationQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<void> {
  const logger = createLogger({ component: "EvaluationConsumer" });
  for (const msg of batch.messages) {
    await consumeOne(env, msg, logger, waitUntil);
  }
}
