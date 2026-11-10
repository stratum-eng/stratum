import { type EventActorType, insertEvent } from "../storage/events";
import type { Queue } from "../types";
import type { Logger } from "../utils/logger";
import { createLogger } from "../utils/logger";

export type StratumEvent =
  | { type: "change.created"; project: string; changeId: string; workspace: string }
  | { type: "change.evaluated"; project: string; changeId: string; score: number; passed: boolean }
  | { type: "change.merged"; project: string; changeId: string; commit: string }
  | { type: "change.rejected"; project: string; changeId: string }
  | { type: "change.reverted"; project: string; changeId: string; revertCommit: string }
  | { type: "change.commented"; project: string; changeId: string }
  | {
      type: "change.reviewed";
      project: string;
      changeId: string;
      verdict: "approve" | "request_changes" | "comment";
    }
  | { type: "project.created"; project: string }
  | { type: "project.imported"; project: string; sourceUrl: string }
  // workspace.deleted is deliberately absent: the delete path only knows the
  // project ID, and events are scoped by project name. It lands with the
  // project-identity unification work.
  | { type: "workspace.created"; project: string; workspace: string }
  | { type: "sync.completed"; project: string; commit?: string }
  | { type: "issue.opened"; project: string; issueNumber: number; title: string }
  | { type: "issue.commented"; project: string; issueNumber: number }
  | {
      type: "issue.closed";
      project: string;
      issueNumber: number;
      title: string;
      changeId?: string;
    }
  // Deploy work never travels on this registry — `stratum-deploys` carries it.
  // These are notifications *about* a deploy, for webhooks and analytics, and a
  // subscriber that never sees one has lost a notification, not a deployment.
  | {
      type: "deployment.requested";
      project: string;
      deploymentId: string;
      name: string;
      target: string;
      commit: string;
      changeId?: string;
    }
  | {
      type: "deployment.succeeded";
      project: string;
      deploymentId: string;
      name: string;
      target: string;
      commit: string;
      url?: string;
    }
  | {
      type: "deployment.failed";
      project: string;
      deploymentId: string;
      name: string;
      target: string;
      commit: string;
      /** Already redacted against the deployment's secret values by the runner. */
      reason: string;
    }
  // Push mirror (#417). Both mean the GitHub copy has stopped following the
  // project and will not catch up by itself: `diverged` until an admin resumes
  // the mirror, `failed` until the next merge or a resume.
  | { type: "mirror.diverged"; project: string; repo: string; reason: string }
  | { type: "mirror.failed"; project: string; repo: string; reason: string }
  // Break-glass resync (#418): an admin fast-forwarded the default branch to
  // its GitHub copy. The one way commits reach a default branch without going
  // through a change, so the event says so (`evaluated: false`) and lists what
  // came in. Who did it is the event's actor.
  | {
      type: "branch.resynced";
      project: string;
      branch: string;
      /** The branch's tip before. */
      oldSha: string;
      /** The branch's tip now. */
      newSha: string;
      /** `owner/repo` on GitHub the commits were read from. */
      repo: string;
      /** Whether `repo` is the project's push mirror or its linked source. */
      source: "mirror" | "source";
      /** From the new tip backwards, capped; `commitCount` is the true total. */
      commits: { sha: string; summary: string; author: string }[];
      commitCount: number;
      commitsTruncated: boolean;
      /** Always `false`: Stratum's evaluators never ran on these commits. */
      evaluated: false;
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
  // Globally-unique project UUID. Threaded from callers that have the project
  // in scope so the outbox row can be tenant-scoped. Callers that only know the
  // project name pass undefined and the row's project_id stays NULL.
  projectId?: string,
): Promise<void> {
  const { type, project, ...payload } = event;

  const insertResult = await insertEvent(db, logger, {
    type,
    project,
    ...(projectId !== undefined ? { projectId } : {}),
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
