/**
 * Validation of a job dispatch: the body Stratum POSTs to `/jobs`.
 *
 * It arrives signed, so it is Stratum speaking — but this Worker runs
 * untrusted code on the strength of it, holds a repository credential because
 * of it, and makes requests to the URLs in it. So every field is checked
 * against what THIS deployment allows before anything is stored, and what
 * comes out is a fresh object holding only the fields this file read.
 */
import {
  DEFAULT_ALLOWED_HOSTS,
  type ExecutorConfig,
  GIT_HOST,
  INSTANCE_TYPES,
  instanceRank,
  parseOrigin,
} from "./config";

export interface JobStep {
  name: string;
  run: string;
  timeoutSeconds: number;
  checkRunId: string;
  logUrl: string;
}

/**
 * Everything that differs between kinds of job. Only `ci` exists; deploy and
 * publish jobs (#416, #422) are other profiles — another image, another
 * allowlist, credentials injected by intercept — which is why these are
 * fields of a job and not constants of the executor.
 */
export interface JobProfile {
  name: "ci";
  /** Key into `ctx.container.images`. */
  image: string;
  /** Every hostname the container may reach, besides its repository. */
  allowedHosts: string[];
}

export interface Job {
  changeId: string;
  project: string;
  baseSha: string;
  headSha: string;
  headTreeSha: string;
  diff: string;
  callbackUrl: string;
  /** Epoch ms after which Stratum gives the checks up. */
  deadline: number;
  profile: JobProfile;
  steps: JobStep[];
  timeoutSeconds: number;
  instance: string;
  repository: {
    url: string;
    /** `Basic …`, ready to send. Held by the Worker; never enters the container. */
    authorization: string;
    expiresAt: number;
  };
}

export type DispatchResult = { ok: true; job: Job } | { ok: false; reason: string };

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Stratum's own rule for a check name. A name is a label here, never a path. */
const CHECK_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const CHECK_RUN_ID = /^[A-Za-z0-9_-]{1,100}$/;
const HOSTNAME =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const MAX_STEPS = 16;
export const MAX_RUN_LENGTH = 4000;
export const MAX_PROJECT_HOSTS = 16;
const MIN_TIMEOUT_SECONDS = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value !== "" && value.length <= max ? value : null;
}

function seconds(value: unknown, max: number): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_TIMEOUT_SECONDS &&
    value <= max
    ? value
    : null;
}

function instant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** An https URL with no credentials in it, or null. */
function httpsUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url : null;
  } catch {
    return null;
  }
}

function hostMatchesSuffix(hostname: string, suffix: string): boolean {
  return suffix.startsWith(".") ? hostname.endsWith(suffix) : hostname === suffix;
}

/** Parse and validate a dispatch body that has already passed signature verification. */
export function parseDispatch(raw: string, config: ExecutorConfig): DispatchResult {
  const refuse = (reason: string): DispatchResult => ({ ok: false, reason });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return refuse("the body is not JSON");
  }
  if (!isRecord(body)) return refuse("the body is not an object");
  if (body.event !== "checks.requested") return refuse("unsupported event");

  const changeId = text(body.changeId, 200);
  const project = text(body.project, 400);
  if (changeId === null || project === null) return refuse("changeId and project are required");
  for (const field of ["baseSha", "headSha", "headTreeSha"] as const) {
    if (typeof body[field] !== "string" || !OID.test(body[field])) {
      return refuse(`${field} must be a full git object id`);
    }
  }
  if (typeof body.diff !== "string") return refuse("diff must be a string");
  const deadline = instant(body.deadline);
  if (deadline === null) return refuse("deadline must be an ISO 8601 instant");

  // Reports carry no credential, but they do carry a signature made with the
  // shared secret; they go to the one Stratum this executor serves.
  const callbackOrigin = parseOrigin(typeof body.callbackUrl === "string" ? body.callbackUrl : "");
  if (callbackOrigin === null || callbackOrigin !== config.stratumOrigin) {
    return refuse("callbackUrl is not on this executor's STRATUM_ORIGIN");
  }
  const callbackUrl = (body.callbackUrl as string).replace(/\/+$/, "");

  if (!isRecord(body.checkRunIds)) return refuse("checkRunIds must be an object");
  const spec = body.job;
  if (!isRecord(spec)) return refuse("job is required");
  if (spec.profile !== "ci") return refuse("unsupported job profile");

  const timeoutSeconds = seconds(spec.timeoutSeconds, config.maxJobSeconds);
  if (timeoutSeconds === null) {
    return refuse(
      `the job's time limit must be from 1 to ${config.maxJobSeconds / 60} minutes on this executor`,
    );
  }

  let instance = config.defaultInstance;
  if (spec.instance !== undefined) {
    if (typeof spec.instance !== "string" || !INSTANCE_TYPES.includes(spec.instance)) {
      return refuse(`instance must be one of ${INSTANCE_TYPES.join(", ")}`);
    }
    if (instanceRank(spec.instance) > instanceRank(config.maxInstance)) {
      return refuse(
        `instance '${spec.instance}' is larger than this executor allows (${config.maxInstance})`,
      );
    }
    instance = spec.instance;
  }

  if (!Array.isArray(spec.allowHosts) || spec.allowHosts.length > MAX_PROJECT_HOSTS) {
    return refuse(`allowHosts must be a list of at most ${MAX_PROJECT_HOSTS} hostnames`);
  }
  const allowedHosts = [...DEFAULT_ALLOWED_HOSTS];
  for (const host of spec.allowHosts as unknown[]) {
    if (typeof host !== "string" || !HOSTNAME.test(host) || host === GIT_HOST) {
      return refuse("allowHosts entries must be exact lowercase public hostnames");
    }
    if (allowedHosts.includes(host)) continue;
    if (!config.allowProjectHosts) {
      return refuse(
        `this executor does not let a project extend the network allowlist ('${host}' is not on it)`,
      );
    }
    allowedHosts.push(host);
  }

  if (!isRecord(spec.logUrls)) return refuse("logUrls must be an object");
  if (!Array.isArray(spec.steps) || spec.steps.length === 0 || spec.steps.length > MAX_STEPS) {
    return refuse(`steps must list from 1 to ${MAX_STEPS} steps`);
  }
  const steps: JobStep[] = [];
  for (const rawStep of spec.steps as unknown[]) {
    if (!isRecord(rawStep)) return refuse("a step is not an object");
    const name = rawStep.name;
    if (typeof name !== "string" || !CHECK_NAME.test(name))
      return refuse("a step has no valid name");
    if (steps.some((step) => step.name === name)) return refuse(`step '${name}' is listed twice`);
    const run = text(rawStep.run, MAX_RUN_LENGTH);
    if (run === null || run.includes("\0")) return refuse(`step '${name}' has no usable command`);
    const stepTimeout = seconds(rawStep.timeoutSeconds, config.maxJobSeconds);
    if (stepTimeout === null) return refuse(`step '${name}' has no usable time limit`);
    const checkRunId = body.checkRunIds[name];
    if (typeof checkRunId !== "string" || !CHECK_RUN_ID.test(checkRunId)) {
      return refuse(`step '${name}' has no check run id`);
    }
    const logUrl = httpsUrl(spec.logUrls[name]) ?? localUrl(spec.logUrls[name], config);
    if (logUrl === null || logUrl.origin !== config.stratumOrigin) {
      return refuse(`step '${name}' has no log URL on this executor's STRATUM_ORIGIN`);
    }
    steps.push({ name, run, timeoutSeconds: stepTimeout, checkRunId, logUrl: logUrl.toString() });
  }

  const repository = spec.repository;
  if (!isRecord(repository)) return refuse("repository is required");
  const repositoryUrl = httpsUrl(repository.url);
  if (
    repositoryUrl === null ||
    repositoryUrl.port !== "" ||
    repositoryUrl.search !== "" ||
    repositoryUrl.hash !== "" ||
    !hostMatchesSuffix(repositoryUrl.hostname, config.gitHostSuffix)
  ) {
    return refuse("repository.url is not an https URL on this executor's CI_GIT_HOST_SUFFIX");
  }
  const username = text(repository.username, 200);
  const password = text(repository.password, 4000);
  const expiresAt = instant(repository.expiresAt);
  if (username === null || password === null || expiresAt === null) {
    return refuse("repository credentials are incomplete");
  }
  // Basic credentials are `user:password` in Latin-1; anything else would be
  // mangled into a different credential rather than refused.
  const printable = /^[\x21-\x7e]+$/;
  if (username.includes(":") || !printable.test(username) || !printable.test(password)) {
    return refuse("repository credentials must be printable ASCII, with no ':' in the username");
  }

  return {
    ok: true,
    job: {
      changeId,
      project,
      baseSha: body.baseSha as string,
      headSha: body.headSha as string,
      headTreeSha: body.headTreeSha as string,
      diff: body.diff,
      callbackUrl,
      deadline,
      profile: { name: "ci", image: "ci", allowedHosts },
      steps,
      timeoutSeconds,
      instance,
      repository: {
        url: repositoryUrl.toString().replace(/\/+$/, ""),
        authorization: `Basic ${btoa(`${username}:${password}`)}`,
        expiresAt,
      },
    },
  };
}

/** A log URL on a local `wrangler dev` Stratum, the one http case there is. */
function localUrl(value: unknown, config: ExecutorConfig): URL | null {
  if (typeof value !== "string" || !config.stratumOrigin.startsWith("http://")) return null;
  try {
    const url = new URL(value);
    return url.origin === config.stratumOrigin ? url : null;
  } catch {
    return null;
  }
}
