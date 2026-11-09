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
  type SweepResult,
  emptyAdmissionState,
} from "./admission";
import { type Env, readConfig } from "./config";
import type { JobRunner } from "./job-object";

const STATE_KEY = "admission";

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

  private async save(admission: Admission): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, admission.state);
    const wake = admission.nextWake();
    if (wake === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(wake);
  }

  private job(jobId: string): DurableObjectStub<JobRunner> {
    const namespace = this.env.JOB as unknown as DurableObjectNamespace<JobRunner>;
    return namespace.get(namespace.idFromName(jobId));
  }

  /**
   * Tell the jobs what was decided about them. Each call is independent and
   * best-effort: the admission state is already saved, and a job that cannot
   * be told it timed out is one whose slot was reclaimed anyway.
   */
  private notify(result: SweepResult): void {
    const calls = [
      ...result.start.map((id) => this.job(id).begin()),
      ...result.expired.map((id) => this.job(id).expire()),
      ...result.timedOut.map((id) => this.job(id).abandon()),
    ];
    this.ctx.waitUntil(
      Promise.allSettled(calls).then((outcomes) => {
        for (const outcome of outcomes) {
          if (outcome.status === "rejected") {
            console.error("coordinator: could not notify a job", String(outcome.reason));
          }
        }
      }),
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
    await this.save(admission);
    this.notify(swept);
    return decision;
  }

  async release(jobId: string): Promise<void> {
    const admission = await this.load();
    if (admission === null) return;
    const result = admission.release(jobId, Date.now());
    await this.save(admission);
    this.notify(result);
  }

  override async alarm(): Promise<void> {
    const admission = await this.load();
    if (admission === null) return;
    const result = admission.sweep(Date.now());
    await this.save(admission);
    this.notify(result);
  }
}
