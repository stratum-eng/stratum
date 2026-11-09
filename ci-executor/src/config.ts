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
  /**
   * Which projects and environments this executor may deploy, and which of its
   * own secrets each one's requests leave with (#416). JSON; see
   * {@link readDeployTargets}. Names secrets, never holds one.
   */
  DEPLOY_TARGETS?: string;
  DEPLOY_MAX_QUEUED_JOBS?: string;
  LOGS: R2Bucket;
  COORDINATOR: DurableObjectNamespace;
  JOB: DurableObjectNamespace;
  /** The deploy profile's own Durable Object class, and so its own container class. */
  DEPLOY_JOB: DurableObjectNamespace;
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
  /** Deploy jobs that may wait for a slot. Counted apart from CI's queue. */
  maxQueuedDeployJobs: number;
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
  const maxQueuedDeployJobs = integer(env.DEPLOY_MAX_QUEUED_JOBS ?? "4", 0, 100);
  if (maxQueuedDeployJobs === null) {
    return refuse("DEPLOY_MAX_QUEUED_JOBS must be a whole number from 0 to 100");
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
      maxQueuedDeployJobs,
      defaultInstance,
      maxInstance,
      maxJobSeconds: maxJobMinutes * 60,
      allowProjectHosts: allowRaw === "true",
      gitHostSuffix,
      logMaxBytes,
    },
  };
}

// ------------------------------------------------------------------ deploys

/**
 * The only names a deploy credential may have. A prefix, so `DEPLOY_TARGETS`
 * cannot be pointed at `CI_EXECUTOR_SECRET` — the one other secret this Worker
 * holds — and have it sent to a host of the operator's (or a typo's) choosing.
 */
export const DEPLOY_SECRET_NAME = /^DEPLOY_CRED_[A-Z0-9_]{1,64}$/;

const DEPLOY_ENVIRONMENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const DEPLOY_ENV_VAR_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const DEPLOY_HOSTNAME =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_DEPLOY_CREDENTIALS = 8;
const MAX_DEPLOY_ENV_VARS = 32;
const MAX_DEPLOY_ENV_VALUE = 1000;
const MAX_DEPLOY_TARGET_HOSTS = 16;

/**
 * Variables a target's `env` may not set: the ones the executor sets itself,
 * and the ones that would let configuration redirect a credentialed tool
 * (`CLOUDFLARE_API_BASE_URL` would point Wrangler away from the one host the
 * credential is attached for).
 */
const RESERVED_DEPLOY_ENV =
  /^(?:STRATUM_.*|CI|HOME|PATH|LANG|NODE_EXTRA_CA_CERTS|GIT_.*|CLOUDFLARE_API_TOKEN|CLOUDFLARE_API_KEY|CLOUDFLARE_EMAIL|CLOUDFLARE_API_BASE_URL|CF_API_.*)$/;

/** One host whose requests leave a deploy job with a credential attached. */
export interface DeployCredential {
  /** Exact hostname. The credential is sent there and nowhere else. */
  host: string;
  /** NAME of a secret on this Worker ({@link DEPLOY_SECRET_NAME}). Never its value. */
  secret: string;
}

/** What one environment of one project may do. */
export interface DeployTarget {
  credentials: DeployCredential[];
  /** Plain, non-secret variables every step of the job sees. */
  env: Record<string, string>;
  /** Hostnames the job may reach without a credential, e.g. the deployed site for a smoke test. */
  allowHosts: string[];
}

/** Project id, then environment name, to what that pair may do. */
export type DeployTargets = Record<string, Record<string, DeployTarget>>;

export type DeployTargetsResult =
  | { ok: true; targets: DeployTargets }
  /** Names the problem, never a secret's value. */
  | { ok: false; reason: string };

/** Whether a parsed JSON value is an object, as opposed to an array or a scalar. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate one `DEPLOY_TARGETS[project][environment]` entry, or say what is wrong with it. */
function parseDeployTarget(raw: unknown, at: string): DeployTarget | string {
  if (!isPlainObject(raw)) return `${at} must be an object`;
  const stray = Object.keys(raw).find((key) => !["credentials", "env", "allowHosts"].includes(key));
  if (stray !== undefined) return `${at} has an unrecognized field '${stray.slice(0, 40)}'`;

  const credentials: DeployCredential[] = [];
  const rawCredentials = raw.credentials ?? [];
  if (!Array.isArray(rawCredentials) || rawCredentials.length > MAX_DEPLOY_CREDENTIALS) {
    return `${at}.credentials must be a list of at most ${MAX_DEPLOY_CREDENTIALS} entries`;
  }
  for (const entry of rawCredentials as unknown[]) {
    if (!isPlainObject(entry)) return `${at}.credentials entries must be objects`;
    const { host, secret } = entry;
    if (typeof host !== "string" || !DEPLOY_HOSTNAME.test(host) || host === GIT_HOST) {
      return `${at}.credentials[].host must be an exact lowercase public hostname`;
    }
    if (typeof secret !== "string" || !DEPLOY_SECRET_NAME.test(secret)) {
      return `${at}.credentials[].secret must be the NAME of a secret starting with DEPLOY_CRED_`;
    }
    // One credential per host: with two, which one a request left with would
    // depend on registration order.
    if (credentials.some((existing) => existing.host === host)) {
      return `${at}.credentials names '${host}' twice`;
    }
    credentials.push({ host, secret });
  }

  const env: Record<string, string> = {};
  const rawEnv = raw.env ?? {};
  if (!isPlainObject(rawEnv) || Object.keys(rawEnv).length > MAX_DEPLOY_ENV_VARS) {
    return `${at}.env must be an object of at most ${MAX_DEPLOY_ENV_VARS} variables`;
  }
  for (const [name, value] of Object.entries(rawEnv)) {
    if (!DEPLOY_ENV_VAR_NAME.test(name) || RESERVED_DEPLOY_ENV.test(name)) {
      return `${at}.env may not set '${name.slice(0, 40)}'`;
    }
    if (typeof value !== "string" || value.length > MAX_DEPLOY_ENV_VALUE || value.includes("\0")) {
      return `${at}.env.${name} must be a string of at most ${MAX_DEPLOY_ENV_VALUE} characters`;
    }
    env[name] = value;
  }

  const allowHosts: string[] = [];
  const rawHosts = raw.allowHosts ?? [];
  if (!Array.isArray(rawHosts) || rawHosts.length > MAX_DEPLOY_TARGET_HOSTS) {
    return `${at}.allowHosts must be a list of at most ${MAX_DEPLOY_TARGET_HOSTS} hostnames`;
  }
  for (const host of rawHosts as unknown[]) {
    if (typeof host !== "string" || !DEPLOY_HOSTNAME.test(host) || host === GIT_HOST) {
      return `${at}.allowHosts entries must be exact lowercase public hostnames`;
    }
    if (!allowHosts.includes(host)) allowHosts.push(host);
  }
  return { credentials, env, allowHosts };
}

/**
 * Read `DEPLOY_TARGETS`: which project and environment pairs this executor
 * deploys, and with which of its secrets.
 *
 * Kept apart from {@link readConfig} on purpose. A mistake here refuses every
 * deploy job and leaves CI running, where a mistake in a CI limit refuses
 * everything: the deploy profile is an addition to an executor, and must not
 * be able to take the merge gate down with it.
 *
 * Unset means "this executor deploys nothing", which is the default and is
 * not an error.
 */
export function readDeployTargets(env: Pick<Env, "DEPLOY_TARGETS">): DeployTargetsResult {
  const raw = env.DEPLOY_TARGETS?.trim() ?? "";
  if (raw === "") return { ok: true, targets: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "DEPLOY_TARGETS is not valid JSON" };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: "DEPLOY_TARGETS must be an object keyed by project id" };
  }
  const targets: DeployTargets = {};
  for (const [projectId, environments] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(projectId) || !isPlainObject(environments)) {
      return {
        ok: false,
        reason:
          "DEPLOY_TARGETS keys must be project ids, each mapping environment names to targets",
      };
    }
    const byEnvironment: Record<string, DeployTarget> = {};
    for (const [environment, rawTarget] of Object.entries(environments)) {
      if (!DEPLOY_ENVIRONMENT_NAME.test(environment)) {
        return {
          ok: false,
          reason: `DEPLOY_TARGETS.${projectId} has an invalid environment name '${environment.slice(0, 40)}'`,
        };
      }
      const target = parseDeployTarget(rawTarget, `DEPLOY_TARGETS.${projectId}.${environment}`);
      if (typeof target === "string") return { ok: false, reason: target };
      byEnvironment[environment] = target;
    }
    targets[projectId] = byEnvironment;
  }
  return { ok: true, targets };
}

/**
 * The value of one deploy credential, or undefined when it is not set.
 *
 * The single place a deploy credential is read. It is called from the
 * credential intercept, per request, and from nowhere that has a container, a
 * job or storage in reach: the value goes from the Worker's secret store into
 * one outbound request header and is never held.
 */
export function readDeploySecret(env: unknown, name: string): string | undefined {
  if (!DEPLOY_SECRET_NAME.test(name) || typeof env !== "object" || env === null) return undefined;
  const value = (env as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
