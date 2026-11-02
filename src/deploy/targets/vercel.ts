import type { Result } from "../../utils/result";
import { err, ok } from "../../utils/result";
import { MAX_TOTAL_BYTES } from "../limits";
import { redactAndTruncate } from "../redact";
import type { DeployFailure, DeployOutcome, DeployTarget, DeployTargetInput } from "./index";
import {
  enforceLimits,
  providerFailure,
  readJson,
  requireSecrets,
  secretValuesOf,
  selectFiles,
  toBase64,
  transportFailure,
} from "./shared";

/**
 * Publish a tree to Vercel with `POST /v13/deployments`, which builds the
 * uploaded source remotely.
 *
 * ## PRD Q1, resolved: files are inlined in the create-deployment body
 *
 * Vercel's current create-deployment reference documents both routes — "upload
 * files first via the file upload API, then reference them here by SHA — or
 * inline small files directly in the request body" — and the `files` array
 * accepts either `{ file, data, encoding }` (inline) or `{ file, sha, size }`
 * (by reference). Inlining wins here for a reason specific to running inside a
 * Worker: `POST /v2/files` is **one request per file**, so a 2,000-file tree
 * (`MAX_FILES`) would need 2,001 provider requests, while inlining needs
 * exactly one no matter how many files there are. The subrequest budget is the
 * scarce resource, not the request body.
 *
 * The cost of that choice, stated so the next person does not have to
 * rediscover it: base64 inflates the payload by about a third, so
 * `MAX_TOTAL_BYTES` (25 MB) becomes roughly a 33 MB request body. That is the
 * binding constraint on this target. **If `MAX_TOTAL_BYTES` is ever raised,
 * revisit this decision** — past some size the two-step upload-by-sha flow
 * becomes the only workable one, and it will need `MAX_FILES` lowered to fit
 * inside `MAX_SUBREQUESTS`.
 *
 * ## Asynchronous by design
 *
 * The API answers as soon as the deployment is *queued*: the response carries
 * `readyState` (`QUEUED` → `INITIALIZING` → `BUILDING` → `READY`/`ERROR`), not
 * a finished build. This target reports what the provider said and does not
 * poll — polling would hold a queue message open for the length of someone
 * else's build. `state` is on the outcome so the runner can decide.
 */

const API_BASE = "https://api.vercel.com";

const SERVICE = "Vercel";

/** One `POST`. The whole tree rides in its body — see the Q1 note above. */
const SUBREQUESTS_PER_DEPLOY = 1;

/** Roughly how much base64 inflates a payload, used only to explain the body size in a reason. */
const BASE64_INFLATION = 4 / 3;

/** `readyState` values that mean the deployment failed before it ever built. */
const FAILED_STATES = new Set(["ERROR", "CANCELED", "BLOCKED"]);

const REQUIRED_SECRETS = ["VERCEL_TOKEN", "VERCEL_PROJECT_ID"] as const;

/** A token scoped to a team must say which team, or the API resolves it against the personal account. */
const OPTIONAL_SECRETS = ["VERCEL_TEAM_ID"] as const;

async function deploy(input: DeployTargetInput): Promise<Result<DeployOutcome, DeployFailure>> {
  const secretValues = secretValuesOf(input.secrets);

  const required = requireSecrets(input.secrets, REQUIRED_SECRETS);
  if (!required.success) return required;
  const token = required.data.VERCEL_TOKEN;
  const projectId = required.data.VERCEL_PROJECT_ID;

  const selected = selectFiles(input.files, input.config.dir);
  if (!selected.success) return selected;

  const limits = enforceLimits(selected.data, () => SUBREQUESTS_PER_DEPLOY);
  if (!limits.success) return limits;

  const files = [...selected.data].map(([path, bytes]) => ({
    file: path,
    data: toBase64(bytes),
    encoding: "base64" as const,
  }));

  const query = new URLSearchParams({
    // Without this, an identical tree deduplicates to the previous deployment
    // and a manual retry would silently do nothing.
    forceNew: "1",
    // Vercel answers 400 and asks for confirmation when its framework
    // detection disagrees with the project's setting. There is no one here to
    // confirm, and the project's own setting is the one the owner chose.
    skipAutoDetectionConfirmation: "1",
  });
  const teamId = input.secrets.VERCEL_TEAM_ID;
  if (teamId) query.set("teamId", teamId);

  const body = {
    // Required by the API. `project` overrides it as the deployment's project,
    // so this is the display name only.
    name: input.config.name,
    project: projectId,
    // A post-merge deploy of the default branch is a production deploy; the
    // API defaults to `preview`, which would publish nowhere useful.
    target: "production",
    files,
    gitMetadata: { commitSha: input.commitSha },
  };

  let response: Response;
  try {
    response = await input.fetch(`${API_BASE}/v13/deployments?${query.toString()}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return err(transportFailure(SERVICE, error));
  }

  if (!response.ok) return err(await providerFailure(SERVICE, response, secretValues));

  const document = await readJson(SERVICE, response, secretValues);
  if (!document.success) return document;

  const readyState =
    typeof document.data.readyState === "string" ? document.data.readyState : undefined;

  if (readyState && FAILED_STATES.has(readyState)) {
    const message =
      typeof document.data.errorMessage === "string" ? document.data.errorMessage : undefined;
    return err({
      reason: `${SERVICE} deployment entered ${readyState}${message ? `: ${redactAndTruncate(message, secretValues)}` : ""}`,
      logTail: redactAndTruncate(JSON.stringify(document.data), secretValues),
      // BLOCKED and CANCELED are account- or request-level decisions; only an
      // ERROR is worth pressing Retry on.
      retryable: readyState === "ERROR",
    });
  }

  const outcome: DeployOutcome = {};
  if (typeof document.data.id === "string") outcome.providerId = document.data.id;
  if (readyState) outcome.state = readyState;
  // `url` is a bare host, e.g. "my-site-abc123.vercel.app".
  if (typeof document.data.url === "string" && document.data.url.length > 0) {
    outcome.url = `https://${document.data.url}`;
  }

  return ok(outcome);
}

/** The approximate request-body size an inlined deploy of `bytes` produces. Exported for tests and docs. */
export function inlineBodyBytes(bytes: number): number {
  return Math.ceil(bytes * BASE64_INFLATION);
}

/** The largest request body this target can produce, given the shared byte limit. */
export const MAX_INLINE_BODY_BYTES = inlineBodyBytes(MAX_TOTAL_BYTES);

/**
 * Peak heap one accepted deployment of this target holds, in bytes.
 *
 * Three live copies of the tree exist at the instant `fetch` is called: the raw
 * bytes the runner read (`MAX_TOTAL_BYTES`), the base64 strings in `files`, and
 * the string `JSON.stringify` produced from them. Nothing can be released
 * earlier — the runner still owns the raw map (it may have another deploy to
 * run from the same tree), and `JSON.stringify` cannot see the array lazily.
 *
 * **This number is why `MAX_DEPLOY_CONCURRENCY` is 1.** It is exported so that
 * relationship is asserted in the test suite rather than remembered: two of
 * these in one isolate exceed `ISOLATE_MEMORY_BYTES` (both in `../limits`), and
 * the isolate is killed before any `finally` can write a terminal deployment
 * status.
 *
 * The only way to cut it meaningfully is to stop materializing the body at all
 * — generate each file's base64 inside a `ReadableStream` and hand *that* to
 * `fetch`, which would hold one file at a time. That is deliberately not done
 * here: a streamed body is sent with `Transfer-Encoding: chunked`, whether
 * Vercel's create-deployment endpoint accepts a chunked body is not something
 * this repo's tests can establish (every target test injects `fetch`), and the
 * failure mode of guessing wrong is that every Vercel deploy 400s. The
 * concurrency bound removes the OOM without betting on that.
 */
export const MAX_PEAK_DEPLOY_BYTES = MAX_TOTAL_BYTES + 2 * MAX_INLINE_BODY_BYTES;

export const vercelTarget: DeployTarget = {
  name: "vercel",
  requiredSecrets: REQUIRED_SECRETS,
  optionalSecrets: OPTIONAL_SECRETS,
  deploy,
};
