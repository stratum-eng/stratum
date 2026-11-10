/**
 * The admission coordinator: one Durable Object for the whole executor
 * (`idFromName("coordinator")`), holding who is running and who is waiting.
 *
 * It is the single writer of that state, which is what makes the limit a
 * limit: two dispatches arriving together are two calls on one object, and a
 * Durable Object runs them one after the other.
 */
import { DurableObject } from "cloudflare:workers";
import {
  Admission,
  type AdmissionDecision,
  type AdmissionRequest,
  type AdmissionState,
  START_RETRY_MS,
  type SweepResult,
  emptyAdmissionState,
  pendingStarts,
} from "./admission";
import { type Env, readConfig } from "./config";
import type { JobRunner } from "./job-object";

const STATE_KEY = "admission";
/** Promoted jobs that have not yet confirmed they were told to start. */
const PENDING_STARTS_KEY = "pendingStarts";

export class Coordinator extends DurableObject<Env> {
  private async load(): Promise<Admission | null> {
    const config = readConfig(this.env);
    if (!config.ok) return null;
    const state = (await this.ctx.storage.get<AdmissionState>(STATE_KEY)) ?? emptyAdmissionState();
    return new Admission(state, {
      maxConcurrent: config.config.maxConcurrentJobs,
      maxQueued: config.config.maxQueuedJobs,
    });
  }

  /**
   * Save what was decided and return the result to act on, with every job
   * that still has to be told to start in `start`: the ones just promoted and
   * the ones an earlier call failed to reach.
   */
  private async save(admission: Admission, result: SweepResult): Promise<SweepResult> {
    const waiting = (await this.ctx.storage.get<string[]>(PENDING_STARTS_KEY)) ?? [];
    const start = pendingStarts(waiting, result.start, admission.state.running);
    await this.ctx.storage.put(STATE_KEY, admission.state);
    await this.ctx.storage.put(PENDING_STARTS_KEY, start);
    const sweepAt = admission.nextWake();
    // While a start is unconfirmed, wake soon to try it again.
    const retryAt = start.length > 0 ? Date.now() + START_RETRY_MS : null;
    const wake = [sweepAt, retryAt].filter((at): at is number => at !== null);
    if (wake.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...wake));
    return { ...result, start };
  }

  /** These jobs were told to start; stop retrying them. */
  private async confirmStarted(jobIds: string[]): Promise<void> {
    if (jobIds.length === 0) return;
    const waiting = (await this.ctx.storage.get<string[]>(PENDING_STARTS_KEY)) ?? [];
    await this.ctx.storage.put(
      PENDING_STARTS_KEY,
      waiting.filter((jobId) => !jobIds.includes(jobId)),
    );
  }

  private job(jobId: string): DurableObjectStub<JobRunner> {
    const namespace = this.env.JOB as unknown as DurableObjectNamespace<JobRunner>;
    return namespace.get(namespace.idFromName(jobId));
  }

  /**
   * Tell the jobs what was decided about them. Each call is independent. A
   * job that cannot be told it expired or timed out is left: its slot was
   * reclaimed anyway. A job that cannot be told to START is different, since
   * it holds a slot and would sit there until its deadline, so it stays in
   * the pending list and the alarm tries again. `begin()` does nothing to a
   * job that has already begun, so telling one twice is safe.
   */
  private notify(result: SweepResult): void {
    const starts = result.start.map((id) =>
      this.job(id)
        .begin()
        .then(() => id),
    );
    const others = [
      ...result.expired.map((id) => this.job(id).expire()),
      ...result.timedOut.map((id) => this.job(id).abandon()),
    ];
    const report = (outcomes: PromiseSettledResult<unknown>[]) => {
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          console.error("coordinator: could not notify a job", String(outcome.reason));
        }
      }
    };
    this.ctx.waitUntil(
      Promise.all([
        Promise.allSettled(starts).then(async (outcomes) => {
          report(outcomes);
          await this.confirmStarted(
            outcomes.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : [])),
          );
        }),
        Promise.allSettled(others).then(report),
      ]),
    );
  }

  async submit(jobId: string, request: AdmissionRequest): Promise<AdmissionDecision> {
    const admission = await this.load();
    if (admission === null) {
      return { decision: "refused", reason: "the executor is not configured" };
    }
    const now = Date.now();
    // A dispatch is also a chance to notice time passing, so a free slot is
    // never withheld because an alarm has yet to fire.
    const swept = admission.sweep(now);
    const decision = admission.submit(jobId, request, now);
    this.notify(await this.save(admission, swept));
    return decision;
  }

  async release(jobId: string): Promise<void> {
    const admission = await this.load();
    if (admission === null) return;
    const result = admission.release(jobId, Date.now());
    this.notify(await this.save(admission, result));
  }

  override async alarm(): Promise<void> {
    const admission = await this.load();
    if (admission === null) return;
    const result = admission.sweep(Date.now());
    this.notify(await this.save(admission, result));
  }
}
