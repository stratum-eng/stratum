import type { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { Result } from "../utils/result";

export interface EvalResult {
  score: number;
  passed: boolean;
  reason: string;
  issues?: string[];
  /**
   * Resource usage the evaluator incurred, recorded for cost tracking.
   *
   * Structurally a subset of `CostSample` (src/storage/costs.ts) rather than an
   * import of it, so the evaluation layer does not depend on storage. `source`
   * is what lets an evaluator running on the project's own provider credential
   * say so: every recording site flattens this array straight into
   * `recordCosts`, so a field missing here is a distinction that cannot be made
   * at all.
   * Omitted means `"platform"` — the operator paid.
   */
  costs?: Array<{
    kind: "llm_tokens" | "sandbox_ms";
    quantity: number;
    estimated?: boolean;
    source?: "platform" | "byok";
  }>;
}

/**
 * Who pays for the metered resources an evaluation consumes.
 *
 * The LLM evaluator spends the operator's Workers AI budget on every call, and
 * before this existed nothing at the evaluator layer could say whose change
 * caused it. Carrying the subject on the evaluation context is what makes that
 * spend attributable, and later meterable, without every evaluator having to
 * grow a project-shaped constructor argument.
 *
 * `ownerType` is narrower than `ProjectEntry.ownerType`, which also admits
 * `"agent"`: an agent is not a billing subject, it resolves to the user that
 * owns it. `billingContextFor` yields nothing rather than performing that
 * resolution.
 */
export interface BillingContext {
  /** The paying user or org. Never an agent id — see `ownerType`. */
  ownerId: string;
  ownerType: "user" | "org";
  /** The project whose policy is being enforced. */
  projectId: string;
  /**
   * The user who ran this evaluation, when the call site knows one.
   *
   * Not the payer, and deliberately a separate field from `ownerId`: PRD §4a
   * separates the subject a spend is RECORDED against from the subject a LIMIT
   * is checked against, because an org-owned project bills the org and an org
   * costs nothing to create. Recording still names the owner above; enforcement
   * uses this. Absent where no acting user exists (a queue consumer), which is
   * not the same as free — it means the check falls back to the recorded
   * subject.
   *
   * Like every other field here, it must never be forwarded off-box: the
   * webhook evaluator names the fields it sends for exactly this reason.
   */
  actorUserId?: string;
}

/**
 * What an evaluation is *of*, and who pays for it: the tree the diff applies
 * to, plus the billing subject. A diff alone does not identify the tree, so an
 * evaluator that reproduces the change out-of-process (the webhook evaluator)
 * cannot tell which base it should apply the hunks to (#274).
 *
 * **Nothing on this type may be forwarded off-box wholesale.** The webhook
 * evaluator POSTs to a URL taken from `.stratum/policy.yaml` — repository
 * content — and it stays safe only because it names the fields it sends
 * (`diff`, sanitized policy, `baseSha`) instead of spreading this object. A
 * `...context` there would ship `billing.ownerId` to an arbitrary endpoint the
 * policy file chose. Add a field here and that exclusion is one careless
 * refactor away; `tests/evaluator-billing-context.test.ts` pins it.
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
  /**
   * Who pays for whatever this evaluation spends.
   *
   * Optional so evaluators that consume nothing metered — every evaluator
   * today except `llm` — can ignore it entirely. Absent where no billing
   * subject can be named, which is deliberately not the same as free: an
   * agent-owned project has a payer, it just has to be resolved first.
   */
  billing?: BillingContext;
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

export type EvaluatorConfig =
  | {
      type: "diff";
      maxLines?: number;
      maxFiles?: number;
      forbiddenPatterns?: string[];
      requiredPatterns?: string[];
    }
  | { type: "webhook"; url: string; secret?: string; timeoutMs?: number }
  | SandboxEvaluatorConfig
  | LlmEvaluatorConfig;

/**
 * The `llm` evaluator's slice of `.stratum/policy.yaml`.
 *
 * Named rather than inlined for the reason `SandboxEvaluatorConfig` is: two
 * places narrow this shape out of a policy (`LLMEvaluator`, and the BYOK
 * provider resolution), and an inline re-declaration in either would drift.
 *
 * Produced only by `sanitizeLlmConfig` (`policy-loader.ts`), which is a
 * whitelist: these four fields are the whole surface a repository's policy file
 * may set. There is deliberately **no `baseUrl`** — see `llm-providers.ts`.
 */
export interface LlmEvaluatorConfig {
  type: "llm";
  /**
   * Selects one of the operator's `LLM_PROVIDERS` entries by name, running the
   * evaluation on the project's own credential (BYOK). Absent means Workers AI,
   * on the operator's bill. A name the operator has not configured is not a
   * fallback: it fails the policy file closed.
   */
  provider?: string;
  model?: string;
  /** Score at or above which the model's verdict is allowed to pass. */
  threshold?: number;
  /** Diff characters sent to the model; clamped again by the evaluator. */
  maxDiffChars?: number;
}
