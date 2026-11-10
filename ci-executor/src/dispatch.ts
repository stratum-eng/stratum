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
  type DeployCredential,
  type DeployTargetsResult,
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
 * Everything that differs between kinds of job: `ci` for a change nobody has
 * reviewed, `deploy` for a merge that has passed its gates (#416). Publish
 * jobs (#422) will be a third. Another image, another allowlist, credentials
 * injected by intercept — which is why these are fields of a job and not
 * constants of the executor.
 */
export interface JobProfile {
  name: "ci" | "deploy";
  /** Key into `ctx.container.images`. */
  image: string;
  /** Every hostname the container may reach without a credential, besides its repository. */
  allowedHosts: string[];
  /**
   * `deploy` only: hosts whose requests leave with a credential attached by
   * the intercept. Holds the NAME of each secret; the value is read by the
   * intercept handler per request and is never part of a job.
   */
  credentials?: DeployCredential[];
}

/** What a deploy job is, beyond what every job is. */
export interface DeployJob {
  deploymentId: string;
  projectId: string;
  environment: string;
  /** Plain variables the operator configured for this target. No secrets. */
  env: Record<string, string>;
  /** Present when the job rolls back rather than deploys. */
  rollback?: { version?: string };
}

/**
 * Where the change under test came from. `external` is a pull request opened
 * on the project's mirror by someone outside it.
 */
export type JobOrigin = "project" | "external";

/**
 * May a job with this origin run under this profile?
 *
 * ADR 012: a change from outside the project's trust boundary runs under the
 * CI profile — the registry allowlist, no injected credential — and nothing
 * else. Asked of every dispatch, before and independently of the check on
 * which profiles this executor implements, so that adding a deploy or publish
 * profile (#416, #422) cannot by itself make one reachable from a stranger's
 * pull request.
 */
export function profileAllowedForOrigin(profile: unknown, origin: JobOrigin): boolean {
  return origin !== "external" || profile === "ci";
}

/**
 * The origin a `job` names, or null when it names one this executor does not
 * know. Absent means a Stratum from before the field existed, which had no
 * external changes to send.
 */
function parseOriginOfJob(spec: Record<string, unknown>): JobOrigin | null {
  if (spec.origin === undefined) return "project";
  return spec.origin === "project" || spec.origin === "external" ? spec.origin : null;
}

export interface Job {
  /** The change under test; for a deploy job, the deployment id. */
  changeId: string;
  project: string;
  origin: JobOrigin;
  /** The commit the job checks out: a change's base, or the merge being deployed. */
  baseSha: string;
  headSha: string;
  /** Tree id the checkout must reproduce. Empty for a deploy job, which applies no diff. */
  headTreeSha: string;
  /** Empty for a deploy job: it runs a commit, not a commit plus a change. */
  diff: string;
  /** Present exactly when `profile.name` is `deploy`. */
  deploy?: DeployJob;
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

type Refusal = { ok: false; reason: string };

/** What the two kinds of dispatch validate the same way. */
interface CommonSpec {
  timeoutSeconds: number;
  instance: string;
  /** Hostnames the dispatch asked for beyond the defaults, already checked. */
  extraHosts: string[];
  repository: Job["repository"];
}

/**
 * Validate the parts of a `job` every profile has: its time limit, container
 * size, the hostnames it asks to reach and the repository it reads.
 */
function parseCommonSpec(
  spec: Record<string, unknown>,
  config: ExecutorConfig,
): { ok: true; common: CommonSpec } | Refusal {
  const refuse = (reason: string): Refusal => ({ ok: false, reason });

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
  const extraHosts: string[] = [];
  for (const host of spec.allowHosts as unknown[]) {
    if (typeof host !== "string" || !HOSTNAME.test(host) || host === GIT_HOST) {
      return refuse("allowHosts entries must be exact lowercase public hostnames");
    }
    if (DEFAULT_ALLOWED_HOSTS.includes(host) || extraHosts.includes(host)) continue;
    if (!config.allowProjectHosts) {
      return refuse(
        `this executor does not let a project extend the network allowlist ('${host}' is not on it)`,
      );
    }
    extraHosts.push(host);
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
    common: {
      timeoutSeconds,
      instance,
      extraHosts,
      repository: {
        url: repositoryUrl.toString().replace(/\/+$/, ""),
        authorization: `Basic ${btoa(`${username}:${password}`)}`,
        expiresAt,
      },
    },
  };
}

/**
 * Validate a step's name, command and time limit. The id and log URL it
 * reports under differ by profile and are supplied by the caller.
 */
function parseStepBasics(
  rawStep: unknown,
  seen: JobStep[],
  config: ExecutorConfig,
): { ok: true; name: string; run: string; timeoutSeconds: number } | Refusal {
  const refuse = (reason: string): Refusal => ({ ok: false, reason });
  if (!isRecord(rawStep)) return refuse("a step is not an object");
  const name = rawStep.name;
  if (typeof name !== "string" || !CHECK_NAME.test(name)) return refuse("a step has no valid name");
  if (seen.some((step) => step.name === name)) return refuse(`step '${name}' is listed twice`);
  const run = text(rawStep.run, MAX_RUN_LENGTH);
  if (run === null || run.includes("\0")) return refuse(`step '${name}' has no usable command`);
  const timeoutSeconds = seconds(rawStep.timeoutSeconds, config.maxJobSeconds);
  if (timeoutSeconds === null) return refuse(`step '${name}' has no usable time limit`);
  return { ok: true, name, run, timeoutSeconds };
}

/** What a deploy dispatch is checked against: the executor's own targets and secrets. */
export interface DeployContext {
  targets: DeployTargetsResult;
  /** Whether the named deploy secret is set on this Worker. Never returns the value. */
  hasSecret(name: string): boolean;
}

/**
 * Parse and validate a dispatch body that has already passed signature
 * verification.
 *
 * The event chooses the profile, and the two never mix: `checks.requested` can
 * only ever produce a `ci` job, which has no credentials field at all, and
 * `deploy.requested` only a `deploy` job. Without a {@link DeployContext} a
 * deploy dispatch is refused.
 */
export function parseDispatch(
  raw: string,
  config: ExecutorConfig,
  deploy?: DeployContext,
): DispatchResult {
  const refuse = (reason: string): DispatchResult => ({ ok: false, reason });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return refuse("the body is not JSON");
  }
  if (!isRecord(body)) return refuse("the body is not an object");
  if (body.event === "checks.requested") return parseCiDispatch(body, config);
  if (body.event === "deploy.requested") {
    if (deploy === undefined) return refuse("this executor does not run deploy jobs");
    return parseDeployDispatch(body, config, deploy);
  }
  return refuse("unsupported event");
}

/** The callback URL, if it is on the one Stratum this executor serves. */
function parseCallbackUrl(body: Record<string, unknown>, config: ExecutorConfig): string | null {
  // Reports carry no credential, but they do carry a signature made with the
  // shared secret; they go to the one Stratum this executor serves.
  const callbackOrigin = parseOrigin(typeof body.callbackUrl === "string" ? body.callbackUrl : "");
  if (callbackOrigin === null || callbackOrigin !== config.stratumOrigin) return null;
  return (body.callbackUrl as string).replace(/\/+$/, "");
}

/** A `checks.requested` dispatch: the steps of a change nobody has reviewed. */
function parseCiDispatch(body: Record<string, unknown>, config: ExecutorConfig): DispatchResult {
  const refuse = (reason: string): DispatchResult => ({ ok: false, reason });

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

  const callbackUrl = parseCallbackUrl(body, config);
  if (callbackUrl === null) return refuse("callbackUrl is not on this executor's STRATUM_ORIGIN");

  if (!isRecord(body.checkRunIds)) return refuse("checkRunIds must be an object");
  const spec = body.job;
  if (!isRecord(spec)) return refuse("job is required");
  const origin = parseOriginOfJob(spec);
  if (origin === null) return refuse("unsupported job origin");
  if (!profileAllowedForOrigin(spec.profile, origin)) {
    return refuse("a job for an external change can only run under the ci profile");
  }
  if (spec.profile !== "ci") return refuse("unsupported job profile");

  const parsed = parseCommonSpec(spec, config);
  if (!parsed.ok) return parsed;
  const { common } = parsed;

  if (!isRecord(spec.logUrls)) return refuse("logUrls must be an object");
  if (!Array.isArray(spec.steps) || spec.steps.length === 0 || spec.steps.length > MAX_STEPS) {
    return refuse(`steps must list from 1 to ${MAX_STEPS} steps`);
  }
  const steps: JobStep[] = [];
  for (const rawStep of spec.steps as unknown[]) {
    const basics = parseStepBasics(rawStep, steps, config);
    if (!basics.ok) return basics;
    const { name } = basics;
    const checkRunId = body.checkRunIds[name];
    if (typeof checkRunId !== "string" || !CHECK_RUN_ID.test(checkRunId)) {
      return refuse(`step '${name}' has no check run id`);
    }
    const logUrl = httpsUrl(spec.logUrls[name]) ?? localUrl(spec.logUrls[name], config);
    if (logUrl === null || logUrl.origin !== config.stratumOrigin) {
      return refuse(`step '${name}' has no log URL on this executor's STRATUM_ORIGIN`);
    }
    steps.push({
      name,
      run: basics.run,
      timeoutSeconds: basics.timeoutSeconds,
      checkRunId,
      logUrl: logUrl.toString(),
    });
  }

  return {
    ok: true,
    job: {
      changeId,
      project,
      origin,
      baseSha: body.baseSha as string,
      headSha: body.headSha as string,
      headTreeSha: body.headTreeSha as string,
      diff: body.diff,
      callbackUrl,
      deadline,
      // Built here, from constants: nothing in a CI dispatch can name a
      // credential, because a CI job's profile has no field to put one in.
      profile: {
        name: "ci",
        image: "ci",
        allowedHosts: [...DEFAULT_ALLOWED_HOSTS, ...common.extraHosts],
      },
      steps,
      timeoutSeconds: common.timeoutSeconds,
      instance: common.instance,
      repository: common.repository,
    },
  };
}

/** What a deploy job's id starts with, so the coordinator can find its Durable Object class. */
export const DEPLOY_JOB_ID_PREFIX = "deploy-";

/** Deployment ids are also log keys and callback path segments. */
const DEPLOYMENT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const ENVIRONMENT = /^[a-z][a-z0-9-]{0,31}$/;
/** A recorded version: a Worker version id, a tag, a commit. A label, never a path or a script. */
export const DEPLOY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;

/** The log key of one step of a deployment: `<deploymentId>-<index>`. */
export function deployStepLogId(deploymentId: string, index: number): string {
  return `${deploymentId}-${index}`;
}

/**
 * A `deploy.requested` dispatch: "deploy this merged commit to this
 * environment". Stratum sends no credential for the target. Which credentials
 * the job's requests leave with is decided here, from THIS Worker's
 * `DEPLOY_TARGETS`, by the project id and environment in the signed body — a
 * pair with no target is refused, and so is one whose secret is not set.
 */
function parseDeployDispatch(
  body: Record<string, unknown>,
  config: ExecutorConfig,
  context: DeployContext,
): DispatchResult {
  const refuse = (reason: string): DispatchResult => ({ ok: false, reason });

  const deploymentId = body.deploymentId;
  if (typeof deploymentId !== "string" || !DEPLOYMENT_ID.test(deploymentId)) {
    return refuse("deploymentId is required");
  }
  const projectId = body.projectId;
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) {
    return refuse("projectId is required");
  }
  const project = text(body.project, 400);
  if (project === null) return refuse("project is required");
  const environment = body.environment;
  if (typeof environment !== "string" || !ENVIRONMENT.test(environment)) {
    return refuse("environment must be a lowercase environment name");
  }
  if (typeof body.commitSha !== "string" || !OID.test(body.commitSha)) {
    return refuse("commitSha must be a full git object id");
  }
  const deadline = instant(body.deadline);
  if (deadline === null) return refuse("deadline must be an ISO 8601 instant");
  const callbackUrl = parseCallbackUrl(body, config);
  if (callbackUrl === null) return refuse("callbackUrl is not on this executor's STRATUM_ORIGIN");

  let rollback: DeployJob["rollback"];
  if (body.rollback !== undefined) {
    if (!isRecord(body.rollback)) return refuse("rollback must be an object");
    const version = body.rollback.version;
    if (version !== undefined && (typeof version !== "string" || !DEPLOY_VERSION.test(version))) {
      return refuse("rollback.version is not a usable version label");
    }
    rollback = typeof version === "string" ? { version } : {};
  }

  if (!context.targets.ok) {
    return refuse(`this executor's deploy targets are misconfigured: ${context.targets.reason}`);
  }
  const target = context.targets.targets[projectId]?.[environment];
  if (target === undefined) {
    return refuse(
      `this executor has no deploy target for project ${projectId}, environment '${environment}'; its operator adds one to DEPLOY_TARGETS`,
    );
  }
  for (const credential of target.credentials) {
    if (!context.hasSecret(credential.secret)) {
      return refuse(`deploy secret ${credential.secret} is not set on this executor`);
    }
  }

  const spec = body.job;
  if (!isRecord(spec)) return refuse("job is required");
  // Asked here too, and before the profile is accepted: this is the profile
  // that carries credentials, and the rule exists so that no dispatch naming
  // an external change can reach it.
  const origin = parseOriginOfJob(spec);
  if (origin === null) return refuse("unsupported job origin");
  if (!profileAllowedForOrigin(spec.profile, origin)) {
    return refuse("a job for an external change can only run under the ci profile");
  }
  if (spec.profile !== "deploy") return refuse("unsupported job profile");
  const parsed = parseCommonSpec(spec, config);
  if (!parsed.ok) return parsed;
  const { common } = parsed;

  const logUrl = httpsUrl(spec.logUrl) ?? localUrl(spec.logUrl, config);
  if (logUrl === null || logUrl.origin !== config.stratumOrigin) {
    return refuse("logUrl is not on this executor's STRATUM_ORIGIN");
  }
  if (!Array.isArray(spec.steps) || spec.steps.length === 0 || spec.steps.length > MAX_STEPS) {
    return refuse(`steps must list from 1 to ${MAX_STEPS} steps`);
  }
  const steps: JobStep[] = [];
  for (const rawStep of spec.steps as unknown[]) {
    const basics = parseStepBasics(rawStep, steps, config);
    if (!basics.ok) return basics;
    steps.push({
      name: basics.name,
      run: basics.run,
      timeoutSeconds: basics.timeoutSeconds,
      // Not a check run: the id each step's log is stored under.
      checkRunId: deployStepLogId(deploymentId, steps.length),
      logUrl: logUrl.toString(),
    });
  }

  // A host with a credential is reached through the credential intercept and
  // no other: it is taken off the plain allowlist so one hostname never has
  // two handlers to choose between.
  const credentialed = new Set(target.credentials.map((credential) => credential.host));
  const allowedHosts = [
    ...new Set([...DEFAULT_ALLOWED_HOSTS, ...target.allowHosts, ...common.extraHosts]),
  ].filter((host) => !credentialed.has(host));

  return {
    ok: true,
    job: {
      changeId: deploymentId,
      project,
      origin,
      baseSha: body.commitSha,
      headSha: body.commitSha,
      headTreeSha: "",
      diff: "",
      deploy: {
        deploymentId,
        projectId,
        environment,
        env: { ...target.env },
        ...(rollback !== undefined ? { rollback } : {}),
      },
      callbackUrl,
      deadline,
      profile: {
        name: "deploy",
        image: "deploy",
        allowedHosts,
        credentials: target.credentials.map((credential) => ({ ...credential })),
      },
      steps,
      timeoutSeconds: common.timeoutSeconds,
      instance: common.instance,
      repository: common.repository,
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
