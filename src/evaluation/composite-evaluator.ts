import type { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { Result } from "../utils/result";
import { err, ok } from "../utils/result";
import type { EvalPolicy, EvalResult, Evaluator } from "./types";

export class CompositeEvaluator {
  constructor(private evaluators: Evaluator[]) {}

  async evaluate(
    diff: string,
    policy: EvalPolicy,
    logger: Logger,
  ): Promise<Result<EvalResult[], AppError>> {
    logger.debug("Starting composite evaluation", { evaluatorCount: this.evaluators.length });

    try {
      const results: EvalResult[] = [];
      for (const evaluator of this.evaluators) {
        const result = await evaluator.evaluate(diff, policy, logger);
        if (result.success) {
          results.push(result.data);
        } else {
          logger.error("Evaluator failed", result.error);
          return err(result.error);
        }
      }

      logger.info("Composite evaluation complete", { resultCount: results.length });
      return ok(results);
    } catch (error) {
      const appError = error instanceof Error ? error : new Error(String(error));
      logger.error("Composite evaluation failed", appError);
      return err(appError as AppError);
    }
  }

  async evaluateAndAggregate(
    diff: string,
    policy: EvalPolicy,
    logger: Logger,
  ): Promise<Result<EvalResult, AppError>> {
    logger.debug("Starting aggregated evaluation");

    const results = await this.evaluate(diff, policy, logger);
    if (!results.success) {
      return results;
    }

    const aggregated = this.aggregate(results.data, policy, logger);
    return ok(aggregated);
  }

  aggregate(results: EvalResult[], policy: EvalPolicy, logger: Logger): EvalResult {
    logger.debug("Aggregating evaluation results", { resultCount: results.length });

    if (results.length === 0) {
      return { score: 0, passed: false, reason: "No evaluators ran." };
    }

    const requireAll = policy.requireAll ?? true;

    const passed = requireAll ? results.every((r) => r.passed) : results.some((r) => r.passed);

    const score = requireAll
      ? results.reduce((sum, r) => sum + r.score, 0) / (results.length || 1)
      : Math.max(...results.map((r) => r.score));

    const failingReasons = results.filter((r) => !r.passed).map((r) => r.reason);
    const reason =
      failingReasons.length === 0 ? "All evaluators passed." : failingReasons.join(" ");

    const issues = results.flatMap((r) => r.issues ?? []);

    logger.info("Aggregation complete", { score, passed, issueCount: issues.length });

    return {
      score,
      passed,
      reason,
      ...(issues.length > 0 ? { issues } : {}),
    };
  }
}
