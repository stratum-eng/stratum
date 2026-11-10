/**
 * Admission control: how many jobs run at once, and how many may wait.
 *
 * This is the executor's only capacity limit. Cloudflare's `durable_object`
 * scheduling policy has no `max_instances`, so without this a burst of changes
 * is a burst of containers on the operator's bill. One Durable Object holds
 * this state for the whole executor; the class itself is pure — time comes in
 * as an argument and nothing here does I/O — so the rules can be tested as
 * rules.
 *
 * A slot is released two ways: the job says it has ended, or the time the job
 * was allowed runs out. The second does not depend on the job: a job object
 * that died, hung or never reported back still gives its slot up, so a lost
 * release cannot shrink the executor's capacity for good.
 *
 * Deploy jobs (#416) go through the same cap and hold a slot on the same
 * terms. They are not given a reserved slot: with the default cap of 2 a
 * reservation would halve CI's capacity all day for an event that happens a
 * few times a day. They are given PRIORITY instead. A waiting deploy job
 * takes the next slot that frees ahead of every waiting CI job, and waits in
 * its own short queue, so a queue full of CI jobs can neither refuse a deploy
 * nor stand in front of a rollback. The longest a deploy waits is the time
 * left on the shortest running job. Priority cannot starve CI in practice:
 * deploys are serialized per environment by Stratum and started only by a
 * merge or a person, so there are never many waiting.
 */

/** Slack past a job's own limit before its slot is taken back regardless. */
export const RELEASE_GRACE_MS = 2 * 60_000;

export interface AdmissionLimits {
  maxConcurrent: number;
  maxQueued: number;
  /** Priority (deploy) jobs that may wait. Counted apart from `maxQueued`. */
  maxQueuedPriority?: number;
}

export interface AdmissionRequest {
  /** The job's wall-clock limit. */
  timeoutMs: number;
  /** Latest instant the job may START and still finish in time to matter. */
  startBy: number;
  /** A deploy job: takes a freed slot ahead of waiting CI jobs. */
  priority?: boolean;
}

export interface AdmissionState {
  /** Job id to the instant its slot is reclaimed whatever the job says. */
  running: Record<string, number>;
  /** Waiting jobs, oldest first. */
  queue: Array<{ jobId: string; timeoutMs: number; startBy: number; priority?: boolean }>;
}

export type AdmissionDecision =
  | { decision: "start" }
  | { decision: "queued"; position: number }
  | { decision: "refused"; reason: string };

export interface SweepResult {
  /** Running jobs whose time ran out: their slots are already free. */
  timedOut: string[];
  /** Queued jobs that can no longer start in time. */
  expired: string[];
  /** Queued jobs that now have a slot. */
  start: string[];
}

export function emptyAdmissionState(): AdmissionState {
  return { running: {}, queue: [] };
}

export class Admission {
  constructor(
    readonly state: AdmissionState,
    private readonly limits: AdmissionLimits,
  ) {}

  private runningCount(): number {
    return Object.keys(this.state.running).length;
  }

  private occupy(jobId: string, timeoutMs: number, now: number): void {
    this.state.running[jobId] = now + timeoutMs + RELEASE_GRACE_MS;
  }

  submit(jobId: string, request: AdmissionRequest, now: number): AdmissionDecision {
    if (jobId in this.state.running || this.state.queue.some((entry) => entry.jobId === jobId)) {
      return { decision: "refused", reason: "this job was already submitted" };
    }
    if (request.startBy <= now) {
      return {
        decision: "refused",
        reason: "the job could not finish before its checks' deadline",
      };
    }
    const priority = request.priority === true;
    // Never jump the queue of one's own kind: a free slot with jobs waiting
    // belongs to them. A deploy job only has other deploy jobs ahead of it.
    const ahead = this.state.queue.filter((entry) => !priority || entry.priority === true);
    if (ahead.length === 0 && this.runningCount() < this.limits.maxConcurrent) {
      this.occupy(jobId, request.timeoutMs, now);
      return { decision: "start" };
    }
    const sameKind = this.state.queue.filter((entry) => (entry.priority === true) === priority);
    const limit = priority ? (this.limits.maxQueuedPriority ?? 0) : this.limits.maxQueued;
    if (sameKind.length >= limit) {
      return {
        decision: "refused",
        reason: `${this.runningCount()} job(s) running and ${sameKind.length}${priority ? " deploy job(s)" : ""} queued, which is this executor's limit`,
      };
    }
    this.state.queue.push({
      jobId,
      timeoutMs: request.timeoutMs,
      startBy: request.startBy,
      ...(priority ? { priority: true } : {}),
    });
    return { decision: "queued", position: ahead.length + 1 };
  }

  /** A job ended (or was dropped while queued). Returns the jobs to start now. */
  release(jobId: string, now: number): SweepResult {
    delete this.state.running[jobId];
    this.state.queue = this.state.queue.filter((entry) => entry.jobId !== jobId);
    return this.sweep(now);
  }

  /** Reclaim overdue slots, drop jobs that waited too long, fill free slots. */
  sweep(now: number): SweepResult {
    const result: SweepResult = { timedOut: [], expired: [], start: [] };
    for (const [jobId, releaseAt] of Object.entries(this.state.running)) {
      if (releaseAt <= now) {
        delete this.state.running[jobId];
        result.timedOut.push(jobId);
      }
    }
    const waiting: AdmissionState["queue"] = [];
    for (const entry of this.state.queue) {
      if (entry.startBy <= now) result.expired.push(entry.jobId);
      else waiting.push(entry);
    }
    while (waiting.length > 0 && this.runningCount() < this.limits.maxConcurrent) {
      // Deploy jobs first, oldest first; then CI jobs, oldest first.
      const at = Math.max(
        0,
        waiting.findIndex((entry) => entry.priority === true),
      );
      const [next] = waiting.splice(at, 1);
      if (next === undefined) break;
      this.occupy(next.jobId, next.timeoutMs, now);
      result.start.push(next.jobId);
    }
    this.state.queue = waiting;
    return result;
  }

  /** The next instant `sweep` has something to do, or null when idle. */
  nextWake(): number | null {
    const times = [
      ...Object.values(this.state.running),
      ...this.state.queue.map((entry) => entry.startBy),
    ];
    return times.length === 0 ? null : Math.min(...times);
  }
}

/** How long the coordinator waits before telling a promoted job to start again. */
export const START_RETRY_MS = 15_000;

/**
 * The promoted jobs that still have to be told to start: those already
 * waiting to be told, plus the ones just promoted, less any whose slot is gone.
 *
 * A job is promoted in the coordinator's own state before it is told, so a
 * call that fails would otherwise leave it holding a slot and never running
 * until its deadline. A job without a slot must not be told to start at all.
 */
export function pendingStarts(
  waiting: readonly string[],
  promoted: readonly string[],
  running: AdmissionState["running"],
): string[] {
  return [...new Set([...waiting, ...promoted])].filter((jobId) => jobId in running);
}
