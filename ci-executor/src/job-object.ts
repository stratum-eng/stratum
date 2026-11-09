/**
 * The Durable Objects that own one job and its container.
 *
 * All the decisions are in {@link JobMachine}; these classes are the wiring:
 * the real `ctx.container`, the real storage, the log bucket, the callback to
 * Stratum, and the alarm that drives the machine. One object per job
 * (`idFromName(jobId)`), so a container is never shared between jobs and is
 * destroyed with the job it was started for.
 *
 * There are two classes because there are two profiles (ADR 012, "Deploy
 * credentials are a separate profile"). {@link JobRunner} runs CI jobs: code
 * from a change nobody has reviewed. {@link DeployRunner} runs deploy jobs: a
 * merged commit, for a project and environment the operator configured. Each
 * is its own container application with its own image, and — the part that
 * matters — only `DeployRunner` is ever given the means to register a
 * credentialed intercept. See {@link egressFor}.
 */
import { DurableObject } from "cloudflare:workers";
import { type Env, readConfig } from "./config";
import type { Coordinator } from "./coordinator";
import type { Job } from "./dispatch";
import type { AllowlistProps, CredentialProxyProps, GitProxyProps } from "./egress";
import { type JobContainer, type JobDeps, JobMachine, type JobStorage } from "./job";
import { logKey } from "./logs";
import { sendDeployReport, sendReport } from "./report";

/** The loopback bindings `ctx.exports` holds for this Worker's entrypoints. */
export interface EgressExports {
  GitProxy(options: { props: GitProxyProps }): Fetcher;
  EgressAllowlist(options: { props: AllowlistProps }): Fetcher;
  DeployCredentialProxy(options: { props: CredentialProxyProps }): Fetcher;
}

export type RunnerProfile = "ci" | "deploy";

const DEFAULT_LOG_MAX_BYTES = 1024 * 1024;

/**
 * The intercept handlers a job's machine can register, by profile.
 *
 * This function is where "a CI job cannot obtain a deploy credential" is
 * decided structurally rather than by a check: the `ci` branch returns an
 * object with no `credential` factory, so the machine that runs unreviewed
 * code has no way to construct the handler that holds one, whatever its job
 * says.
 */
export function egressFor(profile: RunnerProfile, exports: EgressExports): JobDeps["egress"] {
  const plain: JobDeps["egress"] = {
    git: (props) => exports.GitProxy({ props }),
    allowlist: (props) => exports.EgressAllowlist({ props }),
  };
  if (profile !== "deploy") return plain;
  return { ...plain, credential: (props) => exports.DeployCredentialProxy({ props }) };
}

/** Everything the two runner classes share. Which profile it serves is the subclass's. */
abstract class ProfileRunner extends DurableObject<Env> {
  protected abstract readonly profile: RunnerProfile;

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
      egress: egressFor(this.profile, exports),
      send: (job, report) =>
        this.profile === "deploy"
          ? sendDeployReport(secret, job, report)
          : sendReport(secret, job, report),
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

  /**
   * Store a validated dispatch. False when this object already holds a job, or
   * the job is for the other profile: a deploy job never runs in the CI class
   * and a CI job never runs in the class that can attach credentials.
   */
  accept(jobId: string, job: Job): Promise<boolean> {
    return this.serialized(async () => {
      if (job.profile.name !== this.profile) return false;
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

/** Runs CI jobs: code from a change nobody has reviewed. Holds no credential path. */
export class JobRunner extends ProfileRunner {
  protected readonly profile = "ci" as const;
}

/**
 * Runs deploy jobs: a merged commit, in its own container class, with the
 * operator's credentials attached to specific hosts from outside the
 * container.
 */
export class DeployRunner extends ProfileRunner {
  protected readonly profile = "deploy" as const;
}
