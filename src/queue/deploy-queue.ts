/**
 * Consumer for the `stratum-deploys` queue.
 *
 * The interesting decisions here are all about *when a message comes back*.
 * `runDeployMessage` never throws and splits its outcomes into three:
 *
 * - `ok` with `aborted` — the message can never succeed (no `projectId`, a
 *   reverted change, a deleting project, an unknown deployment row). Redelivery
 *   would replay the same refusal until the retry budget ran out, so it is
 *   acked.
 * - `ok` otherwise — every deployment the message named reached a terminal
 *   status. A `failed` row is a *result*, not a delivery failure: retrying it
 *   would re-run a deploy the operator has to fix and re-trigger by hand.
 * - `err` — the run could not determine what happened (D1 or KV unavailable,
 *   the project unreadable). This is the only case redelivery helps, and it is
 *   safe: the `ux_deployments_attempt` unique index and `claimDeployment`'s
 *   lease give mutual exclusion, so a redelivered message cannot double-deploy.
 *
 * A malformed body is acked with a logged error rather than retried. Nothing
 * about redelivering a message the runner cannot parse changes its shape, and
 * the retry budget would only delay the DLQ.
 *
 * ## The send itself can fail, and losing it loses the deploy
 *
 * Everything above is about a message that *arrived*. `queue.send` can also
 * reject, and every producer of this queue is in a position where it cannot
 * usefully report that: the merge has already happened, or the deployment row
 * has already been moved to `queued`, where nothing but a queue message can
 * ever pick it up again. {@link recordDeployRequest} is the durable fallback —
 * an outbox row in D1, swept by the five-minute cron and forwarded to this
 * queue by {@link forwardDeployRequest}. See the note on that function for why
 * the deploy work itself never rides the events queue.
 */
import { type DeployQueueMessage, runDeployMessage } from "../deploy/runner";
import type { PostMergeStatus } from "../merge/post-merge";
import { getChange } from "../storage/changes";
import { isIsoTimestamp } from "../storage/deployments";
import { type EventRecord, insertEvent } from "../storage/events";
import { getProjectById } from "../storage/state";
import type { Env, Message, MessageBatch } from "../types";
import { type Logger, createLogger } from "../utils/logger";
import type { EventQueueMessage } from "./events";

/**
 * Outbox `events.type` for a deploy request that could not be handed to
 * `DEPLOY_QUEUE` directly.
 *
 * Deliberately outside `StratumEvent`. A row of this type is *work*, not a
 * notification: it carries no meaning for a subscriber, and the union is what
 * webhook receivers and analytics see. Keeping it out of the union is what lets
 * {@link forwardDeployRequest} be its only handler.
 */
export const DEPLOY_ENQUEUE_EVENT_TYPE = "deploy.enqueue";

/**
 * Is this outbox row internal work rather than a domain notification?
 *
 * The event consumer asks before choosing a handler set, so an internal row is
 * never delivered to a `*`-subscribed webhook or counted as a product event.
 */
export function isInternalEventType(type: string): boolean {
  return type === DEPLOY_ENQUEUE_EVENT_TYPE;
}

/**
 * Record a deploy request that `DEPLOY_QUEUE.send` refused, so it can be
 * delivered later instead of being lost.
 *
 * The row goes in the **existing event outbox** rather than a new table: that
 * outbox already has the two halves this needs — a durable D1 row written
 * before anything is sent, and a five-minute sweep that re-enqueues rows still
 * `pending`. A `deployments`-only sweep could not cover the merge path at all,
 * because a merge whose send fails has produced no deployment row to find (the
 * runner creates rows only after it consumes the message).
 *
 * Never throws: every caller is on a path that has already succeeded at
 * something the user was told about, and none of them can undo it.
 *
 * @param input.project - The project's name, for the outbox row's own column.
 *   Callers that only know the id may omit it; it is resolved, best effort.
 * @returns Whether the request is now durable. `false` means the outbox write
 *   itself failed, and the request is genuinely lost.
 */
export async function recordDeployRequest(
  env: Env,
  logger: Logger,
  input: { message: DeployQueueMessage; project?: string },
): Promise<boolean> {
  if (!env.DB) {
    logger.error("Cannot record a deploy request: no database is bound", undefined, {
      projectId: input.message.projectId,
    });
    return false;
  }

  let project = input.project;
  if (project === undefined) {
    // Only reached on a send failure, so the extra read costs nothing in the
    // normal case. The id is a usable stand-in if the lookup fails: the column
    // is descriptive here, and every consumer of this row scopes on project_id.
    try {
      const resolved = await getProjectById(env.STATE, input.message.projectId, logger);
      project = resolved.success ? resolved.data.name : input.message.projectId;
    } catch {
      project = input.message.projectId;
    }
  }

  const inserted = await insertEvent(env.DB, logger, {
    type: DEPLOY_ENQUEUE_EVENT_TYPE,
    project,
    projectId: input.message.projectId,
    actorType: "system",
    payload: { ...input.message },
  });
  if (!inserted.success) {
    logger.error("Could not record a deploy request for recovery", inserted.error, {
      projectId: input.message.projectId,
      kind: input.message.kind,
    });
    return false;
  }

  logger.warn("Deploy request recorded for recovery after a failed queue send", {
    eventId: inserted.data.id,
    projectId: input.message.projectId,
    kind: input.message.kind,
  });

  // Best effort nudge so recovery does not always wait for the cron. The sweep
  // is the guarantee; this is only latency.
  if (env.EVENTS_QUEUE) {
    try {
      const nudge: EventQueueMessage = { eventId: inserted.data.id };
      await env.EVENTS_QUEUE.send(nudge);
    } catch (error) {
      logger.warn("Could not nudge the events queue; the sweep will pick the request up", {
        eventId: inserted.data.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return true;
}

/**
 * Deliver one {@link DEPLOY_ENQUEUE_EVENT_TYPE} outbox row to `DEPLOY_QUEUE`.
 *
 * **Forwarding is all it does.** The deploy itself never runs on the events
 * queue: that queue's consumer has no deploy lease, no visibility timeout sized
 * for a provider upload, and a batch size that would put several deploys in one
 * isolate — every property `stratum-deploys` exists to provide. This handler's
 * whole job is to put the message back where it belongs.
 *
 * Throws when the forward fails, which is the contract `processEvent` expects:
 * the event stays `pending`, the queue retries it, and the sweep re-enqueues it
 * until the attempt budget runs out. A payload that cannot be parsed and an
 * instance with no `DEPLOY_QUEUE` both return normally instead — no redelivery
 * changes either answer.
 */
export async function forwardDeployRequest(
  env: Env,
  event: EventRecord,
  logger: Logger,
): Promise<void> {
  if (event.type !== DEPLOY_ENQUEUE_EVENT_TYPE) return;

  const message = parseDeployMessage(event.payload);
  if (message === null) {
    logger.error("Deploy enqueue outbox row is unusable; dropping it", undefined, {
      eventId: event.id,
    });
    return;
  }

  if (!env.DEPLOY_QUEUE) {
    logger.warn("Deployments are not enabled on this instance; dropping a recovered request", {
      eventId: event.id,
      projectId: message.projectId,
    });
    return;
  }

  await env.DEPLOY_QUEUE.send(message);
  logger.info("Recovered deploy request forwarded to the deploy queue", {
    eventId: event.id,
    projectId: message.projectId,
    kind: message.kind,
  });
}

/** Narrows an untrusted queue body to a message the runner will accept. */
function parseDeployMessage(body: unknown): DeployQueueMessage | null {
  if (typeof body !== "object" || body === null) return null;
  const msg = body as Record<string, unknown>;

  const nonEmpty = (value: unknown): value is string =>
    typeof value === "string" && value.trim() !== "";

  if (!nonEmpty(msg.projectId)) return null;

  if (msg.kind === "merge") {
    if (!nonEmpty(msg.changeId) || !nonEmpty(msg.commitSha)) return null;
    return {
      kind: "merge",
      projectId: msg.projectId,
      changeId: msg.changeId,
      commitSha: msg.commitSha,
      // Absent on a message enqueued before this field existed, and on one whose
      // change carried a `merged_at` the deployments columns will not take. The
      // runner falls back to processing time for both rather than dropping a
      // real deploy; see `mergeTimeOf`.
      ...(isIsoTimestamp(msg.mergedAt) ? { mergedAt: msg.mergedAt } : {}),
    };
  }

  if (msg.kind === "deployment") {
    if (!nonEmpty(msg.deploymentId)) return null;
    return { kind: "deployment", projectId: msg.projectId, deploymentId: msg.deploymentId };
  }

  return null;
}

async function consumeOne(env: Env, msg: Message<unknown>, logger: Logger): Promise<void> {
  const message = parseDeployMessage(msg.body);
  if (message === null) {
    logger.error("Deploy queue message is malformed; dropping", undefined, {
      messageId: msg.id,
    });
    msg.ack();
    return;
  }

  let result: Awaited<ReturnType<typeof runDeployMessage>>;
  try {
    result = await runDeployMessage(env, message, logger);
  } catch (error) {
    // runDeployMessage is documented never to throw, so reaching here means an
    // unknown failure — the same class as `err`, and treated the same way.
    logger.error("Deploy run threw", error instanceof Error ? error : new Error(String(error)), {
      kind: message.kind,
      projectId: message.projectId,
    });
    msg.retry();
    return;
  }

  if (!result.success) {
    logger.error("Deploy run could not complete; retrying", result.error, {
      kind: message.kind,
      projectId: message.projectId,
    });
    msg.retry();
    return;
  }

  const summary = result.data;
  if (summary.aborted !== undefined) {
    logger.info("Deploy message abandoned", {
      kind: message.kind,
      projectId: message.projectId,
      reason: summary.aborted,
    });
  } else {
    logger.info("Deploy message handled", {
      kind: message.kind,
      projectId: message.projectId,
      deployments: summary.deployments.map((record) => ({
        deploymentId: record.deploymentId,
        name: record.name,
        status: record.status,
      })),
    });
  }
  msg.ack();
}

/**
 * Queue entry point. One message is one deployment (or one merge fan-out), so
 * the batch is walked serially — `max_batch_size = 1` in `wrangler.toml` makes
 * that a formality, but a raised batch size must not turn into N concurrent
 * provider uploads sharing one invocation's subrequest budget.
 */
export async function handleDeployQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const logger = createLogger({ component: "DeployConsumer" });
  for (const msg of batch.messages) {
    await consumeOne(env, msg, logger);
  }
}

/**
 * Enqueue a merged change for deployment — best effort, and deliberately gated
 * on the post-merge outcome.
 *
 * **Why this is not driven by the `change.merged` event.** `change.merged` is
 * emitted *before* `runPostMergeCheck` runs, and a post-merge failure
 * auto-reverts the merge. Subscribing the deploy trigger to that event would
 * therefore publish the exact commit Stratum had just decided to revert. The
 * only safe trigger is the post-merge result, which is why callers pass it in
 * and why `reverted` and `failed` are refused here rather than at the call
 * site: both merge paths must make the same decision.
 *
 * `skipped` and `passed` both deploy. `skipped` means no post-merge command is
 * configured — the overwhelmingly common case — and treating "the operator
 * declared no smoke check" as "do not deploy" would make deployments
 * unreachable for almost every project.
 *
 * A queue-send failure is logged and swallowed: the merge has already happened
 * and the response describes it truthfully. Failing the request over an
 * undeliverable deploy would report a completed merge as an error.
 *
 * **The message carries the merge time.** Every deployment row is ordered by it
 * rather than by when its message is processed, because the queue promises no
 * ordering and a retry reorders outright — see `DeployQueueMessage.mergedAt`.
 */
/**
 * When the change actually merged, for the message to carry.
 *
 * Read back off the change row rather than stamped here, because this function
 * runs *after* `runPostMergeCheck`, and that check can spend minutes in a
 * sandbox. Stamping the clock here would put a merge whose smoke test ran long
 * behind a later merge whose check was skipped — reintroducing the reordering
 * this field exists to remove, just one layer up from the queue.
 *
 * Falls back to the clock when the row cannot be read or carries a `merged_at`
 * the deployments columns would reject. That is strictly better than sending
 * nothing: an approximate merge time still orders correctly against every other
 * merge whose time is known, and the runner's own fallback then never has to
 * fire. A caller-supplied `mergedAt` wins over both, for a path that already
 * knows it.
 */
async function resolveMergeTime(
  env: Env,
  logger: Logger,
  input: { changeId: string; mergedAt?: string },
): Promise<string> {
  if (isIsoTimestamp(input.mergedAt)) return input.mergedAt;

  const change = await getChange(env.DB, logger, input.changeId);
  if (change.success && isIsoTimestamp(change.data.mergedAt)) return change.data.mergedAt;

  logger.warn("Merged change has no usable merged_at; ordering the deploy on enqueue time", {
    changeId: input.changeId,
  });
  return new Date().toISOString();
}

export async function enqueueMergeDeploy(
  env: Env,
  logger: Logger,
  input: {
    projectId: string;
    changeId: string;
    commitSha: string;
    postMergeStatus: PostMergeStatus;
    /** The change's `merged_at`, when the caller already has it. */
    mergedAt?: string;
  },
): Promise<void> {
  if (input.postMergeStatus === "reverted" || input.postMergeStatus === "failed") {
    logger.info("Not enqueuing a deploy: the post-merge check did not pass", {
      changeId: input.changeId,
      postMerge: input.postMergeStatus,
    });
    return;
  }
  if (!env.DEPLOY_QUEUE) return;
  if (input.commitSha.trim() === "" || input.projectId.trim() === "") return;

  const message: DeployQueueMessage = {
    kind: "merge",
    projectId: input.projectId,
    changeId: input.changeId,
    commitSha: input.commitSha,
    mergedAt: await resolveMergeTime(env, logger, input),
  };
  try {
    await env.DEPLOY_QUEUE.send(message);
  } catch (error) {
    logger.error(
      "Failed to enqueue post-merge deploy",
      error instanceof Error ? error : new Error(String(error)),
      { changeId: input.changeId, commitSha: input.commitSha },
    );
    // Swallowing the failure is right — the merge happened and the response
    // describes it truthfully. Losing the request is not: the runner creates
    // deployment rows only *after* it consumes this message, so a dropped send
    // leaves no row at all, and there is nothing for an operator to see, retry
    // or sweep. The outbox row is the thing that can still be recovered.
    const recorded = await recordDeployRequest(env, logger, { message });
    if (!recorded) {
      logger.error("Post-merge deploy request could not be made durable and is lost", undefined, {
        changeId: input.changeId,
        commitSha: input.commitSha,
        projectId: input.projectId,
      });
    }
  }
}
