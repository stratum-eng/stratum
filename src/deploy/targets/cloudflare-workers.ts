import type { Result } from "../../utils/result";
import { err, ok } from "../../utils/result";
import { redactAndTruncate } from "../redact";
import type { DeployFailure, DeployOutcome, DeployTarget, DeployTargetInput } from "./index";
import {
  enforceLimits,
  providerFailure,
  readJson,
  requireSecrets,
  secretValuesOf,
  selectFiles,
  transportFailure,
} from "./shared";

/**
 * Publish a Worker script with Cloudflare's single-shot script-upload API:
 *
 *   `PUT /accounts/{account_id}/workers/scripts/{script_name}` (multipart/form-data)
 *
 * **Why this endpoint and not the versions/deployments pair.** Cloudflare now
 * offers `workers/beta/workers/versions` followed by
 * `workers/scripts/{name}/deployments` with a percentage strategy, which is
 * what the TypeScript SDK wraps. That is two subrequests and a gradual-rollout
 * model this feature has no way to express — v1 publishes one commit, all
 * traffic. The multipart `PUT` is still documented as supported, implicitly
 * creates the version and the deployment, and costs one request. When
 * per-version control (rollback, a canary percentage) becomes a goal, this is
 * the call site to change.
 *
 * Only ECMAScript modules are uploaded. A Worker's tree may contain a README
 * or a lockfile; those are not modules and failing the deploy over them would
 * be absurd, so they are skipped and the count is reported on the outcome
 * rather than dropped in silence. A tree of static files belongs on the
 * `cloudflare-pages` target, which publishes assets.
 */

const API_BASE = "https://api.cloudflare.com/client/v4";

const SERVICE = "Cloudflare";

/** One `PUT`. The multipart body carries every module, so file count does not drive request count. */
const SUBREQUESTS_PER_DEPLOY = 1;

/** File extensions uploaded as ES modules. Everything else in the tree is skipped. */
const MODULE_EXTENSIONS = [".js", ".mjs"] as const;

/** The content type the script-upload API expects for an ES module part. */
const MODULE_CONTENT_TYPE = "application/javascript+module";

/**
 * Entry points tried, in order, when `CLOUDFLARE_WORKER_MAIN_MODULE` is unset.
 *
 * Deliberately short and predictable: guessing widely would let a rename
 * silently change which file is deployed.
 */
const ENTRYPOINT_CANDIDATES = [
  "worker.js",
  "worker.mjs",
  "index.js",
  "index.mjs",
  "src/index.js",
  "src/index.mjs",
] as const;

/**
 * The `compatibility_date` sent with every upload from this target.
 *
 * Pinned, not `new Date()`: a date computed at deploy time means the same
 * commit deployed twice can get two different runtime behaviours, and a
 * Cloudflare runtime change would then break a redeploy of code nobody
 * touched. Bump this deliberately, with a changelog entry.
 */
const COMPATIBILITY_DATE = "2026-08-20";

const REQUIRED_SECRETS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] as const;

const OPTIONAL_SECRETS = [
  "CLOUDFLARE_WORKER_NAME",
  "CLOUDFLARE_WORKER_MAIN_MODULE",
  "CLOUDFLARE_WORKERS_SUBDOMAIN",
] as const;

async function deploy(input: DeployTargetInput): Promise<Result<DeployOutcome, DeployFailure>> {
  const secretValues = secretValuesOf(input.secrets);

  const required = requireSecrets(input.secrets, REQUIRED_SECRETS);
  if (!required.success) return required;
  const apiToken = required.data.CLOUDFLARE_API_TOKEN;
  const accountId = required.data.CLOUDFLARE_ACCOUNT_ID;

  const selected = selectFiles(input.files, input.config.dir);
  if (!selected.success) return selected;

  const modules = new Map<string, Uint8Array>();
  for (const [path, bytes] of selected.data) {
    if (MODULE_EXTENSIONS.some((extension) => path.endsWith(extension))) modules.set(path, bytes);
  }

  if (modules.size === 0) {
    return err({
      reason: `no ${MODULE_EXTENSIONS.join(" or ")} module found to deploy as a Worker script`,
      retryable: false,
    });
  }

  const mainModule = resolveMainModule(modules, input.secrets.CLOUDFLARE_WORKER_MAIN_MODULE);
  if (!mainModule.success) return mainModule;

  const limits = enforceLimits(modules, () => SUBREQUESTS_PER_DEPLOY);
  if (!limits.success) return limits;

  const scriptName = input.secrets.CLOUDFLARE_WORKER_NAME || input.config.name;

  const form = new FormData();
  form.append(
    "metadata",
    new Blob(
      [JSON.stringify({ main_module: mainModule.data, compatibility_date: COMPATIBILITY_DATE })],
      { type: "application/json" },
    ),
  );
  for (const [path, bytes] of modules) {
    form.append(path, new Blob([bytes], { type: MODULE_CONTENT_TYPE }), path);
  }

  const url = `${API_BASE}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}`;

  let response: Response;
  try {
    // No Content-Type header: `fetch` must set it so the multipart boundary
    // matches the body it generated.
    response = await input.fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${apiToken}` },
      body: form,
    });
  } catch (error) {
    return err(transportFailure(SERVICE, error));
  }

  if (!response.ok) return err(await providerFailure(SERVICE, response, secretValues));

  const document = await readJson(SERVICE, response, secretValues);
  if (!document.success) return document;

  // Cloudflare can answer 200 with `success: false`; the status alone is not
  // proof the script was accepted.
  if (document.data.success !== true) {
    const body = JSON.stringify(document.data);
    return err({
      reason: `${SERVICE} rejected the script upload`,
      logTail: redactAndTruncate(body, secretValues),
      retryable: false,
    });
  }

  const skipped = selected.data.size - modules.size;
  const outcome: DeployOutcome = {};

  const result = document.data.result;
  if (typeof result === "object" && result !== null) {
    const id = (result as Record<string, unknown>).id;
    if (typeof id === "string") outcome.providerId = id;
  }

  // Derived only from a value the user supplied. The account's workers.dev
  // subdomain is not in the API surface this target was written against, and
  // inventing an endpoint to look it up would be a guess.
  const subdomain = input.secrets.CLOUDFLARE_WORKERS_SUBDOMAIN;
  if (subdomain) outcome.url = `https://${scriptName}.${subdomain}.workers.dev`;

  if (skipped > 0) {
    outcome.logTail = `Uploaded ${modules.size} module(s); skipped ${skipped} non-module file(s).`;
  }

  return ok(outcome);
}

/**
 * Decide which module is the Worker's entry point.
 *
 * An explicit `CLOUDFLARE_WORKER_MAIN_MODULE` wins and is validated against
 * the tree, so a typo fails with a reason instead of deploying whichever file
 * the candidate list happened to match.
 */
function resolveMainModule(
  modules: ReadonlyMap<string, Uint8Array>,
  configured: string | undefined,
): Result<string, DeployFailure> {
  if (configured) {
    if (!modules.has(configured)) {
      return err({
        reason: `CLOUDFLARE_WORKER_MAIN_MODULE names "${configured}", which is not in the deployed tree`,
        retryable: false,
      });
    }
    return ok(configured);
  }

  for (const candidate of ENTRYPOINT_CANDIDATES) {
    if (modules.has(candidate)) return ok(candidate);
  }

  return err({
    reason: `no Worker entry point found — expected one of ${ENTRYPOINT_CANDIDATES.join(", ")}, or set the CLOUDFLARE_WORKER_MAIN_MODULE secret`,
    retryable: false,
  });
}

export const cloudflareWorkersTarget: DeployTarget = {
  name: "cloudflare-workers",
  requiredSecrets: REQUIRED_SECRETS,
  optionalSecrets: OPTIONAL_SECRETS,
  deploy,
};
