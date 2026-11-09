/**
 * The main Worker's side of the first-party CI executor (#415, ADR 012).
 *
 * The executor is a separate Worker (`ci-executor/`). It runs untrusted code,
 * so it is deployed apart from everything this Worker can reach: it has no
 * D1, no session store, no Artifacts binding. What it gets is what this file
 * sends it, once per job, in a signed request:
 *
 * - the same dispatch a project's own runner receives (`checks.requested`),
 * - the steps of the BASE branch's `.stratum/ci.yaml`, and
 * - one read-only, one-hour token for the project's repository.
 *
 * The token is why this is not just another `checks` entry. The executor
 * needs to fetch the base commit; a project runner brings its own access. The
 * token is for the executor Worker — it is attached to git requests OUTSIDE
 * the container, and the code a job runs never holds it.
 *
 * One secret, `CI_EXECUTOR_SECRET`, signs both directions and the log fetch.
 * It is the instance's, not a project's: a first-party check run is verified
 * against it and only it, so a project's own runner key cannot report one.
 */
import type { CiConfig, CiInstanceType } from "../evaluation/ci-config";
import { hmacSha256Hex } from "../evaluation/signing-secret";
import { extractTokenSecret } from "../storage/git-ops";
import type { Env } from "../types";
import type { Logger } from "../utils/logger";
import type { CheckDispatchPayload } from "./check-runs";

/**
 * What a first-party check run stores in `secret_ref`. A label, not a lookup:
 * project signing secrets must start with `WEBHOOK_`, so this name can never
 * be one, and the callback resolves the key from the environment by the row's
 * `ci_config_digest`, not by this string.
 */
export const CI_EXECUTOR_SECRET_REF = "CI_EXECUTOR_SECRET";

/** Same header and construction as every check dispatch and callback. */
const SIGNATURE_HEADER = "X-Stratum-Signature";
const TIMESTAMP_HEADER = "X-Stratum-Timestamp";

/** Shortest executor secret accepted. `openssl rand -hex 32` is 64 characters. */
export const MIN_CI_EXECUTOR_SECRET_LENGTH = 32;

/** How long the executor has to acknowledge a job or answer for a log. */
const EXECUTOR_REQUEST_TIMEOUT_MS = 10_000;

/**
 * How long a job may wait for a free slot on the executor before it is given
 * up. Part of the check deadline: a queued job's checks stay `queued`, and
 * this bounds how long they can.
 */
export const CI_QUEUE_ALLOWANCE_MS = 15 * 60_000;

/** Slack on top of the job's own limit for the last report to arrive. */
const CI_REPORT_ALLOWANCE_MS = 2 * 60_000;

/** A repository token's lifetime when it does not say (`freshRepoToken` mints for an hour). */
const DEFAULT_TOKEN_LIFETIME_MS = 60 * 60_000;

/** Used as the request URL when the executor is reached over a service binding only. */
const BINDING_ONLY_ORIGIN = "https://ci-executor.internal";

/**
 * Where the change a job tests came from: the project's own contributors, or a
 * pull request a stranger opened on its mirror (#420).
 */
export type CiJobOrigin = "project" | "external";

/**
 * May a job with this origin run under this profile?
 *
 * ADR 012: a change from outside the project's trust boundary runs under the
 * CI profile, with the registry allowlist and nothing else. Only `ci` exists
 * today, so this is true of every job that can be built — which is exactly why
 * it is written down as a rule and not left as a coincidence. When the deploy
 * and publish profiles arrive (#416, #422), whatever chooses a profile must
 * ask this first; the executor asks the same question of every dispatch it
 * receives.
 */
export function profileAllowedForOrigin(profile: string, origin: CiJobOrigin): boolean {
  return origin !== "external" || profile === "ci";
}

/** The job a first-party dispatch adds to the public payload. */
export interface CiJobSpec {
  /**
   * Which kind of job this is. Only `ci` exists. Deploy and publish jobs
   * (#416, #422) will be other profiles — a different image, allowlist and
   * set of injected credentials — which is why this is a field at all.
   */
  profile: "ci";
  /**
   * Sent so the executor can refuse, by itself, any profile but `ci` for an
   * external change — see {@link profileAllowedForOrigin}.
   */
  origin: CiJobOrigin;
  steps: Array<{ name: string; run: string; timeoutSeconds: number }>;
  /** Wall-clock limit for the whole job. */
  timeoutSeconds: number;
  instance?: CiInstanceType;
  /** Hostnames the base `ci.yaml` adds to the executor's default allowlist. */
  allowHosts: string[];
  repository: {
    /** Git smart-HTTP URL of the project's repository. */
    url: string;
    /** HTTP Basic credentials for it: read-only, short-lived. */
    username: string;
    password: string;
    /** ISO 8601 instant after which the credentials stop working. */
    expiresAt: string;
  };
  /** Check name to the URL its log is served from, on this Worker. */
  logUrls: Record<string, string>;
}

/** The body POSTed to `<executor>/jobs`: the public dispatch plus the job. */
export interface CiJobDispatch extends CheckDispatchPayload {
  headTreeSha: string;
  job: CiJobSpec;
}

export type CiExecutorConfig =
  | {
      status: "configured";
      /** Base URL, no trailing slash. */
      url: string;
      secret: string;
      /** Sends a request to the executor: the service binding when bound. */
      send: (request: Request) => Promise<Response>;
    }
  | { status: "unconfigured"; reason: string };

/** Is this a loopback host, the one place the executor may be reached without https? */
function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Resolve how to reach the executor, or why this instance cannot.
 *
 * The reason is safe to store on a check run and show: it names settings,
 * never their values.
 */
export function ciExecutorConfig(
  env: Pick<Env, "CI_EXECUTOR_URL" | "CI_EXECUTOR_SECRET" | "CI_EXECUTOR">,
): CiExecutorConfig {
  const secret = env.CI_EXECUTOR_SECRET?.trim() ?? "";
  const rawUrl = env.CI_EXECUTOR_URL?.trim() ?? "";
  const binding = env.CI_EXECUTOR;

  if (rawUrl === "" && binding === undefined) {
    return {
      status: "unconfigured",
      reason:
        "this instance has no CI executor; the operator must set CI_EXECUTOR_URL and CI_EXECUTOR_SECRET",
    };
  }
  if (secret.length < MIN_CI_EXECUTOR_SECRET_LENGTH) {
    return {
      status: "unconfigured",
      reason: `CI_EXECUTOR_SECRET is ${secret === "" ? "not set" : `shorter than ${MIN_CI_EXECUTOR_SECRET_LENGTH} characters`}; the operator must set it on both this Worker and the executor`,
    };
  }

  let url = BINDING_ONLY_ORIGIN;
  if (rawUrl !== "") {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { status: "unconfigured", reason: "CI_EXECUTOR_URL is not a valid URL" };
    }
    // The dispatch carries a repository token, so it only travels over TLS —
    // except to a local executor under `wrangler dev`.
    const allowed =
      parsed.protocol === "https:" || (parsed.protocol === "http:" && isLocalHost(parsed.hostname));
    if (!allowed || parsed.username !== "" || parsed.password !== "") {
      return {
        status: "unconfigured",
        reason: "CI_EXECUTOR_URL must be an https URL without credentials",
      };
    }
    url = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  }

  return {
    status: "configured",
    url,
    secret,
    send: binding !== undefined ? (request) => binding.fetch(request) : (request) => fetch(request),
  };
}

/** When a repository token stops working, from its `?expires=<unix seconds>` suffix. */
export function repositoryTokenExpiry(token: string, now: Date): string {
  const raw = /\?expires=(\d{1,12})$/.exec(token)?.[1];
  const seconds = raw === undefined ? Number.NaN : Number(raw);
  if (Number.isSafeInteger(seconds) && seconds * 1000 > now.getTime()) {
    return new Date(seconds * 1000).toISOString();
  }
  return new Date(now.getTime() + DEFAULT_TOKEN_LIFETIME_MS).toISOString();
}

/**
 * When the checks of a CI job dispatched at `now` are given up on: the job's
 * own limit, plus the longest it may wait for a slot, plus room for the last
 * report.
 */
export function ciCheckDeadline(config: CiConfig, now: Date): string {
  return new Date(
    now.getTime() + config.timeoutSeconds * 1000 + CI_QUEUE_ALLOWANCE_MS + CI_REPORT_ALLOWANCE_MS,
  ).toISOString();
}

/** Build the job half of a first-party dispatch from the base branch's config. */
export function buildCiJobSpec(args: {
  config: CiConfig;
  repositoryUrl: string;
  repositoryToken: string;
  logUrls: Record<string, string>;
  now: Date;
  /** Defaults to `project`. Pass `external` for a change from a mirror's pull request. */
  origin?: CiJobOrigin;
}): CiJobSpec {
  const { config } = args;
  return {
    profile: "ci",
    origin: args.origin ?? "project",
    // `required` stays here: whether a step gates a merge is this Worker's
    // business, and the executor runs every step the same way.
    steps: config.steps.map((step) => ({
      name: step.name,
      run: step.run,
      timeoutSeconds: step.timeoutSeconds,
    })),
    timeoutSeconds: config.timeoutSeconds,
    ...(config.instance !== undefined ? { instance: config.instance } : {}),
    allowHosts: [...config.allowHosts],
    repository: {
      url: args.repositoryUrl,
      // What `makeAuth` in git-ops sends: Artifacts ignores the username.
      username: "x",
      password: extractTokenSecret(args.repositoryToken),
      expiresAt: repositoryTokenExpiry(args.repositoryToken, args.now),
    },
    logUrls: args.logUrls,
  };
}

/**
 * Send one request to the executor, giving up after the request timeout.
 *
 * @returns The response, or whether the call timed out or never connected
 */
async function sendWithTimeout(
  config: Extract<CiExecutorConfig, { status: "configured" }>,
  request: Request,
): Promise<{ response: Response } | { failure: "timeout" | "unreachable"; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXECUTOR_REQUEST_TIMEOUT_MS);
  try {
    const response = await config.send(new Request(request, { signal: controller.signal }));
    return { response };
  } catch (error) {
    return {
      failure: controller.signal.aborted ? "timeout" : "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Submit one job. Returns `null` when the executor accepted it (running or
 * queued), or why it did not — a reason safe to store and show.
 */
export async function submitCiJob(
  config: Extract<CiExecutorConfig, { status: "configured" }>,
  logger: Logger,
  dispatch: CiJobDispatch,
): Promise<string | null> {
  const body = JSON.stringify(dispatch);
  const signature = await hmacSha256Hex(config.secret, body);
  const sent = await sendWithTimeout(
    config,
    new Request(`${config.url}/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Stratum-Event": dispatch.event,
        [SIGNATURE_HEADER]: `sha256=${signature}`,
      },
      body,
      // The body holds a repository token: it goes to the configured executor
      // and nowhere a redirect points.
      redirect: "manual",
    }),
  );
  if ("failure" in sent) {
    logger.warn("CI job submission failed", { changeId: dispatch.changeId, error: sent.detail });
    return sent.failure === "timeout"
      ? `the CI executor did not answer within ${EXECUTOR_REQUEST_TIMEOUT_MS}ms`
      : "the CI executor could not be reached";
  }
  const { response } = sent;
  if (response.ok) return null;

  // The executor's refusals carry a short machine-written reason. It is the
  // operator's own Worker, but the text is still bounded before it is stored.
  let detail = "";
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const message = (parsed as { error: unknown }).error;
      if (typeof message === "string") detail = message.slice(0, 300);
    }
  } catch {
    detail = "";
  }
  if (response.status === 429) {
    return `the CI executor is at capacity${detail ? ` (${detail})` : ""}; re-run the check once running jobs have finished`;
  }
  return `the CI executor answered HTTP ${response.status}${detail ? ` (${detail})` : ""}`;
}

/** What the executor signs a log request over. The path binds it to one check run. */
export function ciLogSigningInput(checkRunId: string, timestamp: string): string {
  return `GET\n/logs/${checkRunId}\n${timestamp}`;
}

export type CiLogResult =
  | { status: "ok"; body: ReadableStream<Uint8Array> | null }
  /** The executor has no log for this run (yet, or any more). */
  | { status: "missing" }
  | { status: "unavailable"; reason: string };

/**
 * Fetch one check run's log from the executor.
 *
 * The executor serves logs to nobody but this Worker: the request is signed,
 * and a signature is good for a few minutes and one check run. Whether the
 * person asking may read the log is decided by the caller, before this.
 */
export async function fetchCiLog(
  config: Extract<CiExecutorConfig, { status: "configured" }>,
  logger: Logger,
  checkRunId: string,
  now: Date = new Date(),
): Promise<CiLogResult> {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const signature = await hmacSha256Hex(config.secret, ciLogSigningInput(checkRunId, timestamp));
  const sent = await sendWithTimeout(
    config,
    new Request(`${config.url}/logs/${encodeURIComponent(checkRunId)}`, {
      method: "GET",
      headers: { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: `sha256=${signature}` },
      redirect: "manual",
    }),
  );
  if ("failure" in sent) {
    logger.warn("CI log fetch failed", { checkRunId, error: sent.detail });
    return { status: "unavailable", reason: "the CI executor could not be reached" };
  }
  if (sent.response.status === 404) return { status: "missing" };
  if (!sent.response.ok) {
    logger.warn("CI log fetch refused", { checkRunId, status: sent.response.status });
    return {
      status: "unavailable",
      reason: `the CI executor answered HTTP ${sent.response.status}`,
    };
  }
  return { status: "ok", body: sent.response.body };
}
