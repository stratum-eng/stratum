/**
 * Push mirror (#417): keep a GitHub repository a read-only, fast-forward-only
 * copy of a project's default branch and tags.
 *
 * ## Shape
 *
 * {@link requestPushMirror} is called by whatever moved the project's refs. It
 * is one conditional UPDATE and a queue send, runs after the merge has landed,
 * and never throws — a merge cannot be failed or held up by its mirror.
 *
 * {@link runPushMirror} does the push, on the `stratum-mirrors` queue consumer
 * (or the five-minute sweep, when no queue is bound). It never pushes "commit
 * X": it pushes the default branch as it is when the run reads it. That is what
 * makes the order of queue deliveries irrelevant — every run converges on the
 * current tip — and it is why two merges in quick succession end with the
 * mirror at the later one, whichever message arrives first or is lost.
 *
 * ## The three outcomes that matter
 *
 * - **Diverged.** The target's branch is not an ancestor of the project's, or
 *   one of its tags points somewhere else. The mirror never force-pushes and
 *   never deletes, so it records `diverged`, emits `mirror.diverged`, writes an
 *   audit entry, and stops until an admin resumes it. Nothing is pushed in a
 *   run that finds divergence — not even refs that would have gone cleanly.
 * - **Failed, retryable.** Anything GitHub or Artifacts might do differently in
 *   a minute. Retried with exponential backoff, {@link MIRROR_MAX_ATTEMPTS}
 *   times in all, then left `failed` for a person to see.
 * - **Failed, permanent.** The App is not installed on the target, the owner is
 *   not linked to it, another project holds the repository. No retry changes
 *   those; the state goes straight to `failed` with the reason.
 *
 * ## What it loads
 *
 * A run that finds the mirror already current fetches no objects at all: both
 * sides' refs are compared from their advertisements. Otherwise the default
 * branch is cloned into Worker memory — shallow when the target's tip is
 * recent, full history for a first push or after a failed attempt — and only
 * the tags the target lacks are fetched. The clone is bounded the way a merge's
 * is, by the isolate's memory; the queue runs one push at a time for that
 * reason (`max_concurrency = 1` in `wrangler.toml`).
 */

import { emitEvent } from "../queue/events";
import { recordAudit } from "../storage/audit";
import {
  type NodeFS,
  cloneRepo,
  fetchRemoteTag,
  freshRepoToken,
  readAdvertisedRefs,
  resolveLocalTip,
} from "../storage/git-ops";
import {
  type PushMirror,
  claimPushLease,
  getPushMirror,
  hasPendingPush,
  listDuePushMirrors,
  recordPushDiverged,
  recordPushFailure,
  recordPushSuccess,
  releasePushLease,
  requestPush,
} from "../storage/push-mirrors";
import { getProjectByPath } from "../storage/state";
import { type Env, type ProjectEntry, projectDefaultBranch } from "../types";
import type { Logger } from "../utils/logger";
import { fromPromise } from "../utils/result";
import {
  type GitHubRemote,
  isAncestor,
  isPermanentRemoteRefusal,
  listGitHubRefs,
  openGitHubRemote,
  pushRefFastForward,
} from "./remote";

/** Message on the `stratum-mirrors` queue. A nudge: the D1 row is the work. */
export interface MirrorQueueMessage {
  type: "mirror.push";
  projectId: string;
}

/** Attempts, counting the first, before a mirror is left `failed`. */
export const MIRROR_MAX_ATTEMPTS = 5;

const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_MAX_SECONDS = 15 * 60;

/**
 * Delay before the retry that follows failed attempt number `attempt` (1-based):
 * 30s, 1m, 2m, 4m, capped at 15m.
 */
export function mirrorBackoffSeconds(attempt: number): number {
  return Math.min(BACKOFF_BASE_SECONDS * 2 ** Math.max(0, attempt - 1), BACKOFF_MAX_SECONDS);
}

/**
 * How long one run may hold a project's push lease. Longer than a run can
 * take — a clone, a handful of tag fetches and their pushes, each individually
 * timed out — so a live run never loses the lease, and short enough that a run
 * killed mid-push (which never reaches its release) stalls the mirror for
 * minutes rather than forever.
 */
const LEASE_MS = 10 * 60 * 1000;

/**
 * Pushes one run performs back to back when requests keep arriving while it
 * holds the lease. Past this it hands over to a fresh queue message, so a
 * project merging continuously cannot pin one invocation indefinitely.
 */
const MAX_PASSES = 3;

/**
 * Tags created on the target per pass. Each is a fetch from Artifacts and a
 * push to GitHub — four subrequests — so a first mirror of a repository with
 * hundreds of tags is spread over several passes instead of spending one
 * invocation's subrequest budget.
 */
export const MAX_TAGS_PER_PASS = 50;

/** A full-history clone of a large repository is slower than a merge's shallow one. */
const FULL_CLONE_TIMEOUT_MS = 120_000;

/** A retry message that arrives this close to its due time is treated as due. */
const EARLY_TOLERANCE_MS = 5_000;

/** Mirrors the sweep nudges per tick. */
const SWEEP_BATCH_LIMIT = 25;
/** Mirrors the sweep pushes inline per tick when no queue is bound. */
const SWEEP_INLINE_LIMIT = 3;

type MirrorEnv = Env;

export type MirrorRunOutcome =
  | { kind: "pushed"; sha: string }
  | { kind: "skipped"; reason: string }
  /** Another run holds the lease; it will see this request when it finishes. */
  | { kind: "busy" }
  | { kind: "diverged"; reason: string }
  | { kind: "retry"; delaySeconds: number; error: string }
  | { kind: "failed"; error: string };

type PassResult =
  | { kind: "pushed"; sha: string; moreTags: boolean }
  | { kind: "diverged"; reason: string }
  | { kind: "error"; message: string; permanent: boolean };

/**
 * Ask for the project's mirror to be brought up to date. Safe to call for any
 * project: one that has no mirror costs a single UPDATE matching no row.
 *
 * Never throws and never reports failure to its caller, by design. Every
 * caller has just finished something the user was told about — a merge above
 * all — and none of them may fail, or wait, on the mirror. A lost queue send is
 * recovered by {@link sweepPushMirrors}, because the request is already in D1.
 *
 * @param reason - Why the refs moved; for the log line only
 */
export async function requestPushMirror(
  env: Pick<MirrorEnv, "DB" | "MIRROR_QUEUE">,
  logger: Logger,
  projectId: string,
  reason: string,
): Promise<void> {
  try {
    const requested = await requestPush(env.DB, logger, projectId);
    if (!requested.success || requested.data === null) return;
    const mirror = requested.data;
    if (mirror.state === "diverged") {
      logger.info("Mirror is diverged; request recorded but nothing is pushed", {
        projectId,
        reason,
      });
      return;
    }
    await sendNudge(env, logger, projectId);
    logger.debug("Mirror push requested", { projectId, reason });
  } catch (error) {
    logger.error(
      "Requesting a mirror push threw; the sweep will pick it up",
      error instanceof Error ? error : new Error(String(error)),
      { projectId, reason },
    );
  }
}

/**
 * Tell the mirror queue a project may have work. Best effort: the request is
 * already recorded, so a failed send only delays the push until the sweep.
 */
export async function sendNudge(
  env: Pick<MirrorEnv, "MIRROR_QUEUE">,
  logger: Logger,
  projectId: string,
): Promise<void> {
  if (!env.MIRROR_QUEUE) return;
  try {
    const message: MirrorQueueMessage = { type: "mirror.push", projectId };
    await env.MIRROR_QUEUE.send(message);
  } catch (error) {
    logger.warn("Mirror queue send failed; the sweep will re-enqueue", {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** A commit id shortened for a message a person reads. */
const short = (sha: string): string => sha.slice(0, 7);

/**
 * One push of the project's current default branch and missing tags.
 *
 * @param fullHistory - Clone full history from the start. Set on a retry: a
 *   shallow clone can be enough to prove a fast-forward and still lack objects
 *   on a side branch that GitHub needs, and the cheap way to rule that out is
 *   not to be shallow the second time.
 */
async function pushPass(
  env: MirrorEnv,
  logger: Logger,
  mirror: PushMirror,
  project: ProjectEntry,
  fullHistory: boolean,
): Promise<PassResult> {
  const target = { owner: mirror.repoOwner, repo: mirror.repoName };
  const transient = (message: string): PassResult => ({
    kind: "error",
    message,
    permanent: false,
  });

  const opened = await openGitHubRemote(env, project, target, "write", logger);
  if (!opened.success) {
    return {
      kind: "error",
      message: opened.error.message,
      permanent: isPermanentRemoteRefusal(opened.error),
    };
  }
  const remote = opened.data;

  const sourceToken = await freshRepoToken(env.ARTIFACTS, project.remote, "read", logger);
  if (!sourceToken.success) return transient(sourceToken.error.message);

  const [sourceRefs, targetRefs] = await Promise.all([
    readAdvertisedRefs(project.remote, sourceToken.data, logger),
    listGitHubRefs(remote, logger),
  ]);
  if (!sourceRefs.success) return transient(sourceRefs.error.message);
  if (!targetRefs.success) {
    return {
      kind: "error",
      message: targetRefs.error.message,
      permanent: targetRefs.error.code === "GITHUB_ACCESS_DENIED",
    };
  }

  const branch = projectDefaultBranch(project);
  const sourceTip = sourceRefs.data.branches[branch];
  if (sourceTip === undefined) {
    return {
      kind: "error",
      message: `The project has no '${branch}' branch to mirror yet`,
      permanent: true,
    };
  }
  const targetTip = targetRefs.data.branches[branch];

  // Tags are decided from the two advertisements alone, before anything is
  // cloned: a tag the target lacks is created, a tag it has at the same oid is
  // done, and a tag it has at a DIFFERENT oid is divergence — the mirror does
  // not move tags, and it does not push around one either.
  const missingTags: string[] = [];
  for (const [name, oid] of Object.entries(sourceRefs.data.tags)) {
    const existing = targetRefs.data.tags[name];
    if (existing === undefined) {
      missingTags.push(name);
    } else if (existing !== oid) {
      return {
        kind: "diverged",
        reason: `Tag '${name}' on ${target.owner}/${target.repo} points at ${short(existing)}, but the project has it at ${short(oid)}`,
      };
    }
  }
  missingTags.sort();
  const tagsThisPass = missingTags.slice(0, MAX_TAGS_PER_PASS);
  const moreTags = missingTags.length > tagsThisPass.length;

  if (targetTip === sourceTip && tagsThisPass.length === 0) {
    return { kind: "pushed", sha: sourceTip, moreTags: false };
  }

  const clone = async (full: boolean) =>
    cloneRepo(project.remote, sourceToken.data, logger, {
      ref: branch,
      fullHistory: full,
      ...(full ? { timeoutMs: FULL_CLONE_TIMEOUT_MS } : {}),
    });

  // An empty target needs every commit, so a shallow clone would only have to
  // be thrown away.
  let full = fullHistory || targetTip === undefined;
  let cloned = await clone(full);
  if (!cloned.success) return transient(cloned.error.message);
  let repo: { fs: NodeFS; dir: string } = cloned.data;

  const localTip = await resolveLocalTip(repo.fs, repo.dir, branch);
  if (!localTip.success) return transient(localTip.error.message);
  const tip = localTip.data;

  if (targetTip !== undefined && targetTip !== tip) {
    let fastForward = await isAncestor(repo.fs, repo.dir, { ancestor: targetTip, descendant: tip });
    if (!fastForward && !full) {
      // Not found within the shallow window. That is not divergence yet — the
      // target may simply be more than a window behind — so look again with
      // everything before concluding anything.
      full = true;
      cloned = await clone(true);
      if (!cloned.success) return transient(cloned.error.message);
      repo = cloned.data;
      fastForward = await isAncestor(repo.fs, repo.dir, { ancestor: targetTip, descendant: tip });
    }
    if (!fastForward) {
      return {
        kind: "diverged",
        reason: `'${branch}' on ${target.owner}/${target.repo} is at ${short(targetTip)}, which is not an ancestor of the project's ${short(tip)}`,
      };
    }
  }

  if (targetTip !== tip) {
    const pushed = await pushOne(repo, remote, `refs/heads/${branch}`, logger);
    if (pushed !== null) return pushed;
  }

  for (const name of tagsThisPass) {
    const fetched = await fromPromise(
      fetchRemoteTag(repo.fs, project.remote, sourceToken.data, name, { fullHistory: full }),
    );
    if (!fetched.success)
      return transient(`Failed to read tag '${name}': ${fetched.error.message}`);
    const pushed = await pushOne(repo, remote, `refs/tags/${name}`, logger);
    if (pushed !== null) return pushed;
  }

  return { kind: "pushed", sha: tip, moreTags };
}

/** Pushes one ref; null on success, otherwise the pass result that ends the pass. */
async function pushOne(
  repo: { fs: NodeFS; dir: string },
  remote: GitHubRemote,
  ref: string,
  logger: Logger,
): Promise<PassResult | null> {
  const pushed = await pushRefFastForward(repo.fs, repo.dir, remote, ref, logger);
  if (!pushed.success) {
    return {
      kind: "error",
      message: pushed.error.message,
      permanent: pushed.error.code === "GITHUB_ACCESS_DENIED",
    };
  }
  if (pushed.data.status === "pushed") return null;
  if (pushed.data.reason === "not-fast-forward") {
    return {
      kind: "diverged",
      reason: `${ref} on ${remote.owner}/${remote.repo} is not an ancestor of the project's`,
    };
  }
  // `tag-exists` and `remote-rejected` both mean the target changed between
  // reading its refs and pushing (or refuses this ref outright). Not judged
  // here: the retry re-reads the refs and classifies what it finds.
  //
  // One refusal is known not to change on a retry: GitHub will not let an App
  // without the Workflows permission push a commit that touches a workflow
  // file. Its message names the permission, and is what the admin needs to see.
  return {
    kind: "error",
    message: `GitHub rejected ${ref}: ${pushed.data.detail}`,
    permanent: /workflows?` permission/i.test(pushed.data.detail),
  };
}

/** Tell people a mirror diverged: one event for subscribers and one audit entry. */
async function surfaceDivergence(
  env: MirrorEnv,
  logger: Logger,
  mirror: PushMirror,
  project: ProjectEntry,
  reason: string,
): Promise<void> {
  const repo = `${mirror.repoOwner}/${mirror.repoName}`;
  logger.warn("Push mirror diverged; pushing is stopped until an admin resumes it", {
    projectId: project.id,
    repo,
    reason,
  });
  await emitEvent(
    env.DB,
    env.EVENTS_QUEUE ?? null,
    { type: "mirror.diverged", project: project.name, repo, reason },
    { type: "system" },
    logger,
    project.id,
  );
  await recordAudit(env.DB, logger, {
    action: "mirror.diverged",
    actorType: "system",
    subject: project.id,
    project,
    detail: { project: project.name, repo, reason },
  });
}

/**
 * Bring one project's mirror up to date. Never throws.
 *
 * Safe to call any number of times, concurrently, for the same project: the
 * lease admits one run, and a run that finds nothing outstanding returns
 * without touching GitHub.
 */
export async function runPushMirror(
  env: MirrorEnv,
  logger: Logger,
  projectId: string,
): Promise<MirrorRunOutcome> {
  try {
    return await runPushMirrorUnsafe(env, logger, projectId);
  } catch (error) {
    // A fault in a push pass never reaches here: the loop turns it into a
    // failed attempt, so it is counted, backed off and, at the cap, reported
    // like any other. What is left is a fault around the passes. Nothing is
    // written for it, because this point does not know whether the run still
    // holds its lease, and an unconditional write could overwrite the state of
    // a run that does. The lease expires by itself and the sweep re-sends.
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Mirror push threw", error instanceof Error ? error : new Error(message), {
      projectId,
    });
    return { kind: "retry", delaySeconds: mirrorBackoffSeconds(1), error: message };
  }
}

/** The body of {@link runPushMirror}, which may throw; the wrapper turns that into an outcome. */
async function runPushMirrorUnsafe(
  env: MirrorEnv,
  logger: Logger,
  projectId: string,
): Promise<MirrorRunOutcome> {
  const current = await getPushMirror(env.DB, logger, projectId);
  if (!current.success) {
    return { kind: "retry", delaySeconds: mirrorBackoffSeconds(1), error: current.error.message };
  }
  if (current.data === null) return { kind: "skipped", reason: "no mirror configured" };
  if (!current.data.enabled) return { kind: "skipped", reason: "mirror disabled" };
  if (current.data.state === "diverged") return { kind: "skipped", reason: "mirror diverged" };
  if (!hasPendingPush(current.data)) return { kind: "skipped", reason: "nothing to push" };
  if (current.data.state === "failed") return { kind: "skipped", reason: "retries exhausted" };
  if (
    current.data.nextAttemptAt !== undefined &&
    Date.parse(current.data.nextAttemptAt) - Date.now() > EARLY_TOLERANCE_MS
  ) {
    // A duplicate delivery during a backoff. The retry that set the backoff is
    // already scheduled, and the sweep covers it if that message is lost.
    return { kind: "skipped", reason: "waiting out a retry backoff" };
  }

  const claimed = await claimPushLease(env.DB, logger, projectId, LEASE_MS);
  if (!claimed.success) {
    return { kind: "retry", delaySeconds: mirrorBackoffSeconds(1), error: claimed.error.message };
  }
  if (claimed.data === null) return { kind: "busy" };
  let mirror = claimed.data;
  // The lease this run holds. Every write that ends or extends the run names
  // it, so a run that stalled past its lease cannot write over the run that
  // claimed the row after it.
  let lease = mirror.leaseExpiresAt;
  if (lease === undefined) return { kind: "busy" };

  const found = await getProjectByPath(env.STATE, mirror.namespace, mirror.slug, logger);
  if (!found.success || found.data.id !== projectId) {
    await releasePushLease(env.DB, logger, projectId, lease);
    if (!found.success && found.error.code !== "NOT_FOUND") {
      return { kind: "retry", delaySeconds: mirrorBackoffSeconds(1), error: found.error.message };
    }
    // Deleted, or the path now belongs to a different project. The deletion
    // cascade removes the row; until it does there is nothing to push from.
    return { kind: "skipped", reason: "project no longer exists" };
  }
  const project = found.data;

  let lastSha = "";
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const seq = mirror.requestedSeq;
    // A pass that throws is a failed attempt like one that returns an error:
    // counted, backed off, and at the cap recorded as `failed` with its
    // `mirror.failed` event. A thrown fault is the kind most likely to repeat,
    // so it must not be the one route to `failed` that tells nobody.
    const result: PassResult = await pushPass(
      env,
      logger,
      mirror,
      project,
      mirror.attempts > 0,
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Mirror push pass threw", error instanceof Error ? error : new Error(message), {
        projectId,
      });
      return { kind: "error", message, permanent: false } as const;
    });

    if (result.kind === "diverged") {
      await recordPushDiverged(env.DB, logger, { projectId, reason: result.reason, lease });
      await surfaceDivergence(env, logger, mirror, project, result.reason);
      return { kind: "diverged", reason: result.reason };
    }

    if (result.kind === "error") {
      const attempt = mirror.attempts + 1;
      if (result.permanent || attempt >= MIRROR_MAX_ATTEMPTS) {
        await recordPushFailure(env.DB, logger, { projectId, error: result.message, lease });
        logger.error("Push mirror failed; no further retries", undefined, {
          projectId,
          attempts: attempt,
          permanent: result.permanent,
          error: result.message,
        });
        await emitEvent(
          env.DB,
          env.EVENTS_QUEUE ?? null,
          {
            type: "mirror.failed",
            project: project.name,
            repo: `${mirror.repoOwner}/${mirror.repoName}`,
            reason: result.message,
          },
          { type: "system" },
          logger,
          project.id,
        );
        return { kind: "failed", error: result.message };
      }
      const delaySeconds = mirrorBackoffSeconds(attempt);
      await recordPushFailure(env.DB, logger, {
        projectId,
        error: result.message,
        nextAttemptAt: new Date(Date.now() + delaySeconds * 1000).toISOString(),
        lease,
      });
      logger.warn("Push mirror attempt failed; will retry", {
        projectId,
        attempt,
        delaySeconds,
        error: result.message,
      });
      return { kind: "retry", delaySeconds, error: result.message };
    }

    lastSha = result.sha;
    // More tags than one pass creates: count it as a request of its own, so
    // the success below keeps the lease and the loop goes round again.
    if (result.moreTags) await requestPush(env.DB, logger, projectId);
    const recorded = await recordPushSuccess(env.DB, logger, {
      projectId,
      seq,
      sha: result.sha,
      leaseMs: LEASE_MS,
      lease,
    });
    if (recorded.success && recorded.data.lost) {
      // This run outlived its lease and another claimed the row. The commits
      // are on GitHub, and a fast-forward cannot have undone anything, but the
      // row is the other run's to write.
      logger.warn("Push mirror run finished after losing its lease; leaving the row alone", {
        projectId,
        sha: result.sha,
      });
      return { kind: "busy" };
    }
    if (recorded.success && recorded.data.lease !== undefined) lease = recorded.data.lease;
    if (!recorded.success || recorded.data.released) {
      logger.info("Push mirror up to date", { projectId, sha: result.sha });
      return { kind: "pushed", sha: result.sha };
    }

    // A request arrived while this pass ran — a second merge, typically. Its
    // own queue message found the lease taken and was acked, so this run is
    // the only thing that will act on it.
    const refreshed = await getPushMirror(env.DB, logger, projectId);
    if (!refreshed.success || refreshed.data === null) break;
    mirror = refreshed.data;
  }

  // Requests kept arriving for MAX_PASSES pushes. Hand the rest to a fresh
  // invocation rather than hold this one open.
  await releasePushLease(env.DB, logger, projectId, lease);
  await sendNudge(env, logger, projectId);
  return { kind: "pushed", sha: lastSha };
}

/**
 * Recover mirror pushes the queue did not deliver: a send that failed, a retry
 * message that outlived the queue's own retry budget, a run that died holding
 * the lease. Runs on the five-minute cron.
 *
 * With no queue bound (local development, or a self-hosted instance that has
 * not created one) this is also the only thing that pushes, so it runs a few
 * inline; mirrors then lag merges by up to the cron interval.
 */
export async function sweepPushMirrors(env: MirrorEnv, logger: Logger): Promise<void> {
  const due = await listDuePushMirrors(env.DB, logger, SWEEP_BATCH_LIMIT);
  if (!due.success || due.data.length === 0) return;

  logger.info("Sweeping pending mirror pushes", { count: due.data.length });
  if (env.MIRROR_QUEUE) {
    for (const mirror of due.data) await sendNudge(env, logger, mirror.projectId);
    return;
  }
  for (const mirror of due.data.slice(0, SWEEP_INLINE_LIMIT)) {
    await runPushMirror(env, logger, mirror.projectId);
  }
}
