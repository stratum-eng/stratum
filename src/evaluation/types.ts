import type { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { Result } from "../utils/result";

export interface EvalResult {
  score: number;
  passed: boolean;
  reason: string;
  issues?: string[];
  /** Resource usage the evaluator incurred, recorded for cost tracking. */
  costs?: Array<{ kind: "llm_tokens" | "sandbox_ms"; quantity: number; estimated?: boolean }>;
}

/**
 * What the diff is a diff *of*. A diff alone does not identify the tree it
 * applies to, so an evaluator that reproduces the change out-of-process (the
 * webhook evaluator) cannot tell which base it should apply the hunks to
 * (#274).
 */
export interface EvaluationContext {
  /**
   * The base commit the diff was computed against, resolved from the same
   * clone that produced it.
   *
   * Absent only where the caller genuinely has no base to name. It is never a
   * best-guess re-resolution of the project head: `main` can advance between
   * diff generation and delivery, and a receiver that checked out the newer
   * commit would report a verdict for a combination the change never proposed.
   */
  baseSha?: string;
}

export interface Evaluator {
  evaluate(
    diff: string,
    policy: EvalPolicy,
    logger: Logger,
    context?: EvaluationContext,
  ): Promise<Result<EvalResult, AppError>>;
}

export interface EvalPolicy {
  evaluators: EvaluatorConfig[];
  requireAll?: boolean;
  minScore?: number;
  merge?: MergePolicy;
  /** Set when a policy file is present but malformed. The merge gate treats this
   * as fail-closed (blocks) rather than silently running on the default, so a
   * typo in a stricter policy can't quietly downgrade governance. */
  configError?: string;
  /**
   * Post-merge deploys declared under `deploys:`, after sanitization. Only
   * entries that passed every rule in `sanitizeDeploys` appear here; anything
   * rejected is in `deployRejections` instead, never silently absent.
   */
  deploys?: DeployConfig[];
  /**
   * Deploy entries the policy declared but that could not be used, with the
   * reason. Carried on the policy rather than logged and dropped because each
   * one becomes a persisted *failed* deployment: a deploy the author wrote and
   * that never runs must be visible, not a `logger.warn` nobody reads.
   */
  deployRejections?: DeployRejection[];
}

/** Deploy targets the runner can drive. Each is a provider HTTP API. */
export type DeployTargetName = "cloudflare-pages" | "cloudflare-workers" | "vercel";

/**
 * One entry of the `deploys:` list in `.stratum/policy.yaml`.
 *
 * Produced only by `sanitizeDeploys` (`src/deploy/config.ts`) — a value of this
 * type is always a freshly built object, never a slice of the parsed policy
 * file, so nothing downstream can reach back into user-supplied input.
 */
export interface DeployConfig {
  /** `^[a-z][a-z0-9-]{0,31}$`, unique within the list. Identifies the deploy target across merges. */
  name: string;
  target: DeployTargetName;
  /** Names of project secrets the target needs. Values live in D1, never in the policy file. */
  secrets?: string[];
  /** Output directory to publish, relative to the repo root. Consumed by `cloudflare-pages`. */
  dir?: string;
  /** Always set by the sanitizer, so an approval gate is never `undefined` downstream. */
  requiresApproval?: boolean;
}

/** A `deploys:` entry that was rejected, and why. Becomes a failed deployment row. */
export interface DeployRejection {
  /** The entry's declared `name`, or null when it had no usable one. */
  name: string | null;
  /** Human-readable, safe to persist and render: derived from the policy file, never from a secret. */
  reason: string;
}

/**
 * Branch-protection rules enforced at the merge step.
 * Configured under `merge:` in .stratum/policy.yaml.
 */
export interface MergePolicy {
  /** Human approvals required before a change can merge. Default 0. */
  requiredApprovals?: number;
  /** Evaluator types whose latest run must have passed (e.g. ["secret_scan", "diff"]). */
  requiredEvaluators?: string[];
  /** The ?force=true override is rejected unless this is explicitly true. Default false. */
  allowForce?: boolean;
  /** When true, a change whose recorded base is behind project HEAD cannot merge. */
  requireFreshBase?: boolean;
  /** Smoke command run in a sandbox against the merged HEAD (e.g. "npm test"). */
  postMergeCommand?: string;
  /** Timeout for the post-merge command. Default 60s. */
  postMergeTimeoutMs?: number;
  /** Revert the merge commit when the post-merge command fails. Default true. */
  autoRevert?: boolean;
}

/**
 * The `sandbox` evaluator's slice of `.stratum/policy.yaml`.
 *
 * Named rather than inlined into `EvaluatorConfig` because the evaluator needs
 * to refer to exactly this shape when it narrows its own config out of the
 * policy; an inline re-declaration there would silently drift from this one.
 */
export interface SandboxEvaluatorConfig {
  type: "sandbox";
  /** Scored command. Default `npm test`. */
  command?: string;
  /** Timeout for the scored command. */
  timeoutMs?: number;
  /** Timeout for dependency install and the in-sandbox binary decode step. */
  installTimeoutMs?: number;
  /**
   * Total wall clock the whole evaluation may spend before failing closed.
   * Bounds the sum of the phases, which the per-phase timeouts do not.
   */
  totalBudgetMs?: number;
  /**
   * Run npm lifecycle scripts (`preinstall`/`install`/`postinstall`) during
   * dependency install. Default false — the evaluated tree is untrusted, so
   * installs pass `--ignore-scripts` unless a project owner opts in.
   */
  allowInstallScripts?: boolean;
}

/**
 * The `webhook` evaluator's slice of `.stratum/policy.yaml`.
 *
 * Named for the same reason {@link SandboxEvaluatorConfig} is, and with a
 * sharper edge: a policy may declare several `webhook` entries, so the
 * evaluator must be handed *its own* entry rather than searching the policy for
 * one at evaluation time (#336). An inline re-declaration in the evaluator
 * would silently drift from this one.
 */
export interface WebhookEvaluatorConfig {
  type: "webhook";
  url: string;
  secret?: string;
  timeoutMs?: number;
}

export type EvaluatorConfig =
  | {
      type: "diff";
      maxLines?: number;
      maxFiles?: number;
      forbiddenPatterns?: string[];
      requiredPatterns?: string[];
    }
  | WebhookEvaluatorConfig
  | SandboxEvaluatorConfig
  | { type: "llm"; model?: string; threshold?: number; maxDiffChars?: number };
