import type { DeployConfig, DeployTargetName } from "../../evaluation/types";
import type { Logger } from "../../utils/logger";
import type { Result } from "../../utils/result";
import { cloudflarePagesTarget } from "./cloudflare-pages";
import { cloudflareWorkersTarget } from "./cloudflare-workers";
import { vercelTarget } from "./vercel";

/**
 * The `fetch` a target uses to reach its provider.
 *
 * Injected rather than taken from the global scope for the same reason
 * `SandboxEvaluator` injects `readFiles` and `now`: it is the only seam that
 * keeps the test suite off the network. Nothing in `src/deploy/targets/`
 * references `globalThis.fetch`.
 *
 * `init` is required — every provider call here sets at least a method and an
 * `Authorization` header — which keeps the real `fetch` assignable to this
 * type while making an accidental bare GET a type error.
 */
export type DeployFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Everything a target needs to publish one commit. Assembled by the deploy runner. */
export interface DeployTargetInput {
  /**
   * The merged tree as repo-relative path → raw bytes, exactly as
   * `readRepoFiles` returns it.
   *
   * Passed whole: each target narrows it to `config.dir` itself, so the limit
   * checks in `enforceLimits` run against the bytes that are actually uploaded
   * rather than against the whole repository.
   */
  files: ReadonlyMap<string, Uint8Array>;
  /** Decrypted project secrets by name. Never logged, never echoed into a reason or a log tail. */
  secrets: Readonly<Record<string, string>>;
  /** The sanitized `deploys:` entry being run. */
  config: DeployConfig;
  /** The pinned merge commit being published, for provider-side deployment metadata. */
  commitSha: string;
  logger: Logger;
  fetch: DeployFetch;
}

/** What a successful provider call produced. */
export interface DeployOutcome {
  /**
   * Where the commit is published, when the provider returns one or it can be
   * derived from configuration the user supplied. Absent is an honest answer,
   * not a failure: deriving a URL from an API shape we have not verified would
   * be worse than returning none.
   */
  url?: string;
  /** The provider's own identifier for the deployment, so a support ticket can name it. */
  providerId?: string;
  /**
   * The provider's state at the instant the API returned. Some providers build
   * asynchronously, so this is not the same as "the commit is live".
   */
  state?: string;
  /** Redacted, truncated provider detail worth persisting even on success. */
  logTail?: string;
}

/**
 * Why a deployment did not happen.
 *
 * A dedicated type rather than `AppError` because a deploy failure is
 * *persisted and rendered*, not mapped to an HTTP status: the row needs a
 * reason a human can act on, a redacted payload, and a retryable flag that
 * decides whether the Retry button is worth pressing. Returning it as a value
 * also keeps provider 4xx/5xx from crossing the module boundary as a throw.
 */
export interface DeployFailure {
  /** Actionable and safe to persist and render. Never contains a secret value. */
  reason: string;
  /** The provider's payload, redacted then truncated to `MAX_LOG_TAIL`. */
  logTail?: string;
  /** True when the same inputs could plausibly succeed later (5xx, 429, network). */
  retryable: boolean;
}

/** One provider's implementation of "publish this tree". */
export interface DeployTarget {
  /** The `target:` value in `.stratum/policy.yaml` that selects this implementation. */
  readonly name: DeployTargetName;
  /**
   * Secret names that must be present before anything is attempted. The runner
   * may check these to fail early; every target also checks them itself so it
   * is safe to call directly.
   */
  readonly requiredSecrets: readonly string[];
  /** Secret names the target uses when present. Absence changes behaviour, never fails the deploy. */
  readonly optionalSecrets: readonly string[];
  deploy(input: DeployTargetInput): Promise<Result<DeployOutcome, DeployFailure>>;
}

/**
 * Every target, keyed by the name a policy file uses.
 *
 * Typed as a total `Record<DeployTargetName, …>` so adding a member to
 * `DeployTargetName` fails the build here rather than at runtime on the first
 * merge that uses it.
 */
export const DEPLOY_TARGET_REGISTRY: Readonly<Record<DeployTargetName, DeployTarget>> = {
  "cloudflare-pages": cloudflarePagesTarget,
  "cloudflare-workers": cloudflareWorkersTarget,
  vercel: vercelTarget,
};

/** Look up a target. Total over `DeployTargetName`, so it cannot fail. */
export function getDeployTarget(name: DeployTargetName): DeployTarget {
  return DEPLOY_TARGET_REGISTRY[name];
}
