/**
 * The Durable Object that owns one job and its container.
 *
 * All the decisions are in {@link JobMachine}; this class is the wiring: the
 * real `ctx.container`, the real storage, the log bucket, the callback to
 * Stratum, and the alarm that drives the machine. One object per job
 * (`idFromName(jobId)`), so a container is never shared between jobs and is
 * destroyed with the job it was started for.
 */
import { DurableObject } from "cloudflare:workers";
import { type Env, readConfig } from "./config";
import type { Coordinator } from "./coordinator";
import type { Job } from "./dispatch";
import type { AllowlistProps, GitProxyProps } from "./egress";
import { type JobContainer, type JobDeps, JobMachine, type JobStorage } from "./job";
import { logKey } from "./logs";
import { sendReport } from "./report";

/** The loopback bindings `ctx.exports` holds for this Worker's entrypoints. */
interface EgressExports {
  GitProxy(options: { props: GitProxyProps }): Fetcher;
  EgressAllowlist(options: { props: AllowlistProps }): Fetcher;
}

const DEFAULT_LOG_MAX_BYTES = 1024 * 1024;

export class JobRunner extends DurableObject<Env> {
  /** Calls into the machine run one at a time; an alarm must not interleave with an RPC. */
  private queue: Promise<unknown> = Promise.resolve();

  private machine(jobId: string): JobMachine {
    const container = this.ctx.container;
    if (container === undefined) {
      throw new Error("JobRunner has no container: check the `containers` entry in wrangler.toml");
    }
    const config = readConfig(this.env);
    const secret = config.ok ? config.config.secret : "";
    const exports = this.ctx.exports as unknown as EgressExports;
    const coordinator = this.env.COORDINATOR as unknown as DurableObjectNamespace<Coordinator>;
    const deps: JobDeps = {
      container: container as unknown as JobContainer,
      images: container.images,
      storage: this.ctx.storage as unknown as JobStorage,
      now: () => Date.now(),
      egress: {
        git: (props) => exports.GitProxy({ props }),
        allowlist: (props) => exports.EgressAllowlist({ props }),
      },
      send: (job, report) => sendReport(secret, job, report),
      putLog: async (checkRunId, body) => {
        await this.env.LOGS.put(logKey(checkRunId), body, {
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
        });
      },
      release: () => coordinator.get(coordinator.idFromName("coordinator")).release(jobId),
      logMaxBytes: config.ok ? config.config.logMaxBytes : DEFAULT_LOG_MAX_BYTES,
    };
    return new JobMachine(deps);
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Run one machine call, then arm the alarm for whatever it asked for. */
  private async drive(call: (machine: JobMachine) => Promise<number | null>): Promise<void> {
    await this.serialized(async () => {
      const jobId = await this.ctx.storage.get<string>("jobId");
      if (jobId === undefined) return;
      const delay = await call(this.machine(jobId));
      if (delay !== null) await this.ctx.storage.setAlarm(Date.now() + delay);
    });
  }

  /** Store a validated dispatch. False when this object already holds a job. */
  accept(jobId: string, job: Job): Promise<boolean> {
    return this.serialized(async () => {
      const accepted = await this.machine(jobId).accept(job);
      if (accepted) {
        await this.ctx.storage.put("jobId", jobId);
        // A stored job always has an alarm, so one that is never started and
        // never discarded still deletes itself (and its repository token)
        // once its checks' deadline has passed. `begin()` re-arms it sooner.
        await this.ctx.storage.setAlarm(job.deadline + 60_000);
      }
      return accepted;
    });
  }

  discard(): Promise<void> {
    return this.serialized(async () => {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    });
  }

  begin(): Promise<void> {
    return this.drive((machine) => machine.begin());
  }

  expire(): Promise<void> {
    return this.drive((machine) => machine.expire());
  }

  abandon(): Promise<void> {
    return this.drive((machine) => machine.abandon());
  }

  override alarm(): Promise<void> {
    return this.drive((machine) => machine.tick());
  }
}
