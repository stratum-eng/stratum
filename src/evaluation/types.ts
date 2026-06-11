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

export interface Evaluator {
  evaluate(diff: string, policy: EvalPolicy, logger: Logger): Promise<Result<EvalResult, AppError>>;
}

export interface EvalPolicy {
  evaluators: EvaluatorConfig[];
  requireAll?: boolean;
  minScore?: number;
  merge?: MergePolicy;
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
  /** When false, the ?force=true override is rejected. Default true. */
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

export type EvaluatorConfig =
  | {
      type: "diff";
      maxLines?: number;
      maxFiles?: number;
      forbiddenPatterns?: string[];
      requiredPatterns?: string[];
    }
  | { type: "webhook"; url: string; secret?: string; timeoutMs?: number }
  | { type: "sandbox"; command?: string; timeoutMs?: number }
  | { type: "llm"; model?: string; threshold?: number };
