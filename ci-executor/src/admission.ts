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
 */

/** Slack past a job's own limit before its slot is taken back regardless. */
export const RELEASE_GRACE_MS = 2 * 60_000;

export interface AdmissionLimits {
  maxConcurrent: number;
  maxQueued: number;
}

export interface AdmissionRequest {
  /** The job's wall-clock limit. */
  timeoutMs: number;
  /** Latest instant the job may START and still finish in time to matter. */
  startBy: number;
}

export interface AdmissionState {
  /** Job id to the instant its slot is reclaimed whatever the job says. */
  running: Record<string, number>;
  /** Waiting jobs, oldest first. */
  queue: Array<{ jobId: string; timeoutMs: number; startBy: number }>;
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
    // Never jump the queue: a free slot with jobs waiting belongs to them.
    if (this.state.queue.length === 0 && this.runningCount() < this.limits.maxConcurrent) {
      this.occupy(jobId, request.timeoutMs, now);
      return { decision: "start" };
    }
    if (this.state.queue.length >= this.limits.maxQueued) {
      return {
        decision: "refused",
        reason: `${this.runningCount()} job(s) running and ${this.state.queue.length} queued, which is this executor's limit`,
      };
    }
    this.state.queue.push({ jobId, timeoutMs: request.timeoutMs, startBy: request.startBy });
    return { decision: "queued", position: this.state.queue.length };
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
      const next = waiting.shift();
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
