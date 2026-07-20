import type { EvalPolicy } from "../evaluation/types";
import { countApprovals } from "../storage/change-reviews";
import { listEvalRuns } from "../storage/eval-runs";
import type { Change } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export interface ProtectionVerdict {
  allowed: boolean;
  /** Human-readable reasons the merge is blocked. Empty when allowed. */
  reasons: string[];
}

/**
 * Evaluate the policy's merge-protection rules against a change.
 *
 * Required evaluators check the LATEST run per evaluator type — an earlier
 * failed run that was superseded by a passing re-run does not block.
 */
export async function checkMergeProtection(
  db: D1Database,
  logger: Logger,
  change: Change,
  policy: EvalPolicy,
): Promise<Result<ProtectionVerdict, AppError>> {
  // Fail closed on a malformed policy file rather than silently running on the
  // permissive default.
  if (policy.configError) {
    return ok({ allowed: false, reasons: [policy.configError] });
  }

  const merge = policy.merge;
  if (!merge) return ok({ allowed: true, reasons: [] });

  const reasons: string[] = [];

  if (merge.requiredEvaluators && merge.requiredEvaluators.length > 0) {
    const runsResult = await listEvalRuns(db, logger, change.id);
    if (!runsResult.success) {
      return err(
        runsResult.error instanceof AppError
          ? runsResult.error
          : new AppError(runsResult.error.message, "DATABASE_ERROR", 500),
      );
    }

    const latestByType = new Map<string, { passed: boolean; ranAt: string }>();
    for (const run of runsResult.data) {
      const current = latestByType.get(run.evaluatorType);
      if (!current || run.ranAt >= current.ranAt) {
        latestByType.set(run.evaluatorType, { passed: run.passed, ranAt: run.ranAt });
      }
    }

    for (const required of merge.requiredEvaluators) {
      const latest = latestByType.get(required);
      if (!latest) {
        reasons.push(`Required evaluator '${required}' has not run`);
      } else if (!latest.passed) {
        reasons.push(`Required evaluator '${required}' failed`);
      }
    }
  }

  const requiredApprovals = merge.requiredApprovals ?? 0;
  if (requiredApprovals > 0) {
    // NOTE: self-approval exclusion (countApprovals' excludeUserId arg) is wired in a
    // follow-up — the `changes` table records no creating-user id yet (only agentId),
    // so excluding the author requires a schema addition. Tracked in TASKS.md.
    const approvalsResult = await countApprovals(db, logger, change.id);
    if (!approvalsResult.success) return err(approvalsResult.error);
    if (approvalsResult.data < requiredApprovals) {
      reasons.push(
        `Requires ${requiredApprovals} approval${requiredApprovals === 1 ? "" : "s"}, has ${approvalsResult.data}`,
      );
    }
  }

  if (reasons.length > 0) {
    logger.info("Merge blocked by branch protection", { changeId: change.id, reasons });
  }
  return ok({ allowed: reasons.length === 0, reasons });
}
