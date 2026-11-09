/**
 * The executor's own configuration, read from its Worker's variables.
 *
 * Every limit here is the OPERATOR's. A project's `.stratum/ci.yaml` can ask
 * for a larger container or another hostname; this is where asking stops being
 * getting. A missing or unusable limit refuses every job rather than falling
 * back to "no limit": Cloudflare's `durable_object` scheduling policy has no
 * `max_instances`, so the cap in this file is the only one there is.
 */
import type { DurableObjectNamespace, R2Bucket } from "@cloudflare/workers-types";

export interface Env {
  /** Shared with Stratum (`CI_EXECUTOR_SECRET` there too). A Wrangler secret. */
  CI_EXECUTOR_SECRET?: string;
  /** Origin of the Stratum instance this executor serves, e.g. `https://stratum.example.com`. */
  STRATUM_ORIGIN?: string;
  CI_MAX_CONCURRENT_JOBS?: string;
  CI_MAX_QUEUED_JOBS?: string;
  CI_DEFAULT_INSTANCE?: string;
  CI_MAX_INSTANCE?: string;
  CI_MAX_JOB_MINUTES?: string;
  CI_ALLOW_PROJECT_HOSTS?: string;
  CI_GIT_HOST_SUFFIX?: string;
  CI_LOG_MAX_BYTES?: string;
  LOGS: R2Bucket;
  COORDINATOR: DurableObjectNamespace;
  JOB: DurableObjectNamespace;
}

/** Container sizes, smallest first: the names `ctx.container.start()` accepts. */
export const INSTANCE_TYPES = ["lite", "standard-1", "standard-2", "standard-3", "standard-4"];
export type InstanceType = string;

export const MIN_SECRET_LENGTH = 32;

/** A dispatch carries a whole diff. Well under the 8 MB a stored value may be. */
export const MAX_DISPATCH_BYTES = 4 * 1024 * 1024;

/**
 * Hosts every job may reach, because a Node project cannot install without
 * them: the npm registry, Yarn's alias of it, and nodejs.org (headers for
 * native addons, and Corepack's package-manager downloads).
 */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "nodejs.org",
];

/** The hostname a job fetches its repository from. It exists only as an intercept. */
export const GIT_HOST = "git.stratum.internal";

export interface ExecutorConfig {
  secret: string;
  /** Callbacks go to this origin and no other. */
  stratumOrigin: string;
  maxConcurrentJobs: number;
  maxQueuedJobs: number;
  defaultInstance: InstanceType;
  maxInstance: InstanceType;
  maxJobSeconds: number;
  /** Whether a project's `network.allow` may extend the default allowlist. */
  allowProjectHosts: boolean;
  /** The repository must be served from a host ending in this. */
  gitHostSuffix: string;
  logMaxBytes: number;
}

export type ConfigResult =
  | { ok: true; config: ExecutorConfig }
  /** Names the setting, never its value. */
  | { ok: false; reason: string };

function integer(raw: string | undefined, min: number, max: number): number | null {
  if (raw === undefined || !/^\d{1,9}$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value >= min && value <= max ? value : null;
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** An https origin (http only for a local `wrangler dev` Stratum), or null. */
export function parseOrigin(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const allowed =
    url.protocol === "https:" || (url.protocol === "http:" && isLocalHost(url.hostname));
  if (!allowed || url.username !== "" || url.password !== "") return null;
  return url.origin;
}

export function instanceRank(name: string): number {
  return INSTANCE_TYPES.indexOf(name);
}

export function readConfig(env: Partial<Env>): ConfigResult {
  const refuse = (reason: string): ConfigResult => ({ ok: false, reason });

  const secret = env.CI_EXECUTOR_SECRET?.trim() ?? "";
  if (secret.length < MIN_SECRET_LENGTH) {
    return refuse(`CI_EXECUTOR_SECRET is not set or shorter than ${MIN_SECRET_LENGTH} characters`);
  }
  const stratumOrigin = parseOrigin(env.STRATUM_ORIGIN);
  if (stratumOrigin === null) {
    return refuse("STRATUM_ORIGIN must be the https origin of the Stratum instance");
  }
  // Required, with no default in code: "unlimited" is not a value this has.
  const maxConcurrentJobs = integer(env.CI_MAX_CONCURRENT_JOBS, 1, 1000);
  if (maxConcurrentJobs === null) {
    return refuse("CI_MAX_CONCURRENT_JOBS must be a whole number from 1 to 1000");
  }
  const maxQueuedJobs = integer(env.CI_MAX_QUEUED_JOBS ?? "10", 0, 1000);
  if (maxQueuedJobs === null) {
    return refuse("CI_MAX_QUEUED_JOBS must be a whole number from 0 to 1000");
  }
  const defaultInstance = env.CI_DEFAULT_INSTANCE?.trim() || "standard-1";
  const maxInstance = env.CI_MAX_INSTANCE?.trim() || "standard-2";
  if (instanceRank(defaultInstance) < 0 || instanceRank(maxInstance) < 0) {
    return refuse(
      `CI_DEFAULT_INSTANCE and CI_MAX_INSTANCE must each be one of ${INSTANCE_TYPES.join(", ")}`,
    );
  }
  if (instanceRank(defaultInstance) > instanceRank(maxInstance)) {
    return refuse("CI_DEFAULT_INSTANCE is larger than CI_MAX_INSTANCE");
  }
  const maxJobMinutes = integer(env.CI_MAX_JOB_MINUTES ?? "60", 1, 300);
  if (maxJobMinutes === null) {
    return refuse("CI_MAX_JOB_MINUTES must be a whole number from 1 to 300");
  }
  const allowRaw = (env.CI_ALLOW_PROJECT_HOSTS ?? "true").trim();
  if (allowRaw !== "true" && allowRaw !== "false") {
    return refuse("CI_ALLOW_PROJECT_HOSTS must be true or false");
  }
  const gitHostSuffix = (env.CI_GIT_HOST_SUFFIX ?? ".artifacts.cloudflare.net").trim();
  if (!/^\.?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(gitHostSuffix) || !gitHostSuffix.includes(".")) {
    return refuse("CI_GIT_HOST_SUFFIX must be a hostname or a dot-prefixed domain suffix");
  }
  const logMaxBytes = integer(env.CI_LOG_MAX_BYTES ?? "1048576", 4096, 16 * 1024 * 1024);
  if (logMaxBytes === null) {
    return refuse("CI_LOG_MAX_BYTES must be a whole number from 4096 to 16777216");
  }

  return {
    ok: true,
    config: {
      secret,
      stratumOrigin,
      maxConcurrentJobs,
      maxQueuedJobs,
      defaultInstance,
      maxInstance,
      maxJobSeconds: maxJobMinutes * 60,
      allowProjectHosts: allowRaw === "true",
      gitHostSuffix,
      logMaxBytes,
    },
  };
}
