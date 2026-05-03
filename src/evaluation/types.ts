import type { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { Result } from "../utils/result";

export interface EvalResult {
  score: number;
  passed: boolean;
  reason: string;
  issues?: string[];
}

export interface Evaluator {
  evaluate(diff: string, policy: EvalPolicy, logger: Logger): Promise<Result<EvalResult, AppError>>;
}

export interface EvalPolicy {
  evaluators: EvaluatorConfig[];
  requireAll?: boolean;
  minScore?: number;
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
