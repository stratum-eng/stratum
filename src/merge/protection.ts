import { diffTouchesProtectedConfig } from "../evaluation/policy-loader";
import type { EvalPolicy } from "../evaluation/types";
import { countApprovals } from "../storage/change-reviews";
import { type CheckRun, latestChecksForRevision } from "../storage/checks";
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

  // No verdict yet (#412). Checked before anything else so a pending run can
  // never be read as "no rules apply": a policy with no merge block would
  // otherwise allow it below. Once the run has recorded its result the change
  // leaves `evaluating` and every rule after this applies exactly as before.
  if (change.status === "evaluating") {
    return ok({ allowed: false, reasons: ["Evaluation is still pending"] });
  }

  const merge = policy.merge;
  // A change that edits the merge-protection config is gated even when the policy
  // has no merge block at all (SA-3), so we can't early-return on a missing merge.
  if (!merge && !change.touchesProtectedConfig) return ok({ allowed: true, reasons: [] });

  const reasons: string[] = [];

  if (merge?.requiredEvaluators && merge.requiredEvaluators.length > 0) {
    const runsResult = await listEvalRuns(db, logger, change.id);
    if (!runsResult.success) {
      return err(
        runsResult.error instanceof AppError
          ? runsResult.error
          : new AppError(runsResult.error.message, "DATABASE_ERROR", 500),
      );
    }

    // Two passes, because a type can appear both across rounds and within one.
    // The newest round wins over older ones — a re-evaluation must be able to
    // clear an earlier failure — but *within* that round every run of a type is
    // folded with AND, the same rule `requiredEvaluatorReasons` applies to the
    // in-memory path. A policy may declare the same type more than once (two
    // webhook receivers, two diff evaluators), and last-write-wins let a
    // passing duplicate mask a failing sibling recorded moments earlier (#336).
    //
    // Rounds are identified by `roundId`, not by equal `ranAt`: two passes can
    // share a millisecond, and reading them as one round would AND a superseded
    // failure into a later pass that passed, blocking the change until someone
    // re-evaluated again. `roundId` sorts chronologically as a string (it is
    // timestamp-prefixed, see recordEvalRuns), so the newest round is a plain
    // max. Rows predating migration 048 have none; they fall back to `ranAt`,
    // which is what grouping meant before the column existed.
    const roundKey = (run: { roundId?: string; ranAt: string }): string => run.roundId ?? run.ranAt;

    const latestRoundByType = new Map<string, string>();
    for (const run of runsResult.data) {
      const current = latestRoundByType.get(run.evaluatorType);
      const key = roundKey(run);
      if (current === undefined || key > current) {
        latestRoundByType.set(run.evaluatorType, key);
      }
    }

    const latestByType = new Map<string, { passed: boolean }>();
    for (const run of runsResult.data) {
      if (roundKey(run) !== latestRoundByType.get(run.evaluatorType)) continue;
      const current = latestByType.get(run.evaluatorType);
      latestByType.set(run.evaluatorType, { passed: (current?.passed ?? true) && run.passed });
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

  if (merge?.requiredChecks && merge.requiredChecks.length > 0) {
    // Read for the evaluated revision only (#414). A change with nothing
    // pinned has no checks to read, and every required one is then missing.
    let latest: CheckRun[] = [];
    if (change.evaluatedSha !== undefined) {
      const checksResult = await latestChecksForRevision(
        db,
        logger,
        change.id,
        change.evaluatedSha,
      );
      if (!checksResult.success) {
        return err(new AppError(checksResult.error.message, "DATABASE_ERROR", 500));
      }
      latest = checksResult.data;
    }
    reasons.push(...requiredCheckReasons(latest, merge.requiredChecks, new Date()));
  }

  // A change that edits the merge-protection config must always carry at least
  // one human approval, even if the policy sets requiredApprovals: 0 — otherwise
  // a writer could relax protection (allowForce, drop evaluators, zero approvals)
  // in a change that merges with no human ever looking (SA-3).
  const requiredApprovals = Math.max(
    merge?.requiredApprovals ?? 0,
    change.touchesProtectedConfig ? 1 : 0,
  );
  if (requiredApprovals > 0) {
    // The change author's own approval must not count toward requiredApprovals —
    // otherwise a lone writer opens a change, approves it, and self-merges.
    // createdByUserId is the acting user (or an agent's owner); NULL on legacy
    // rows, where no author is excluded.
    const approvalsResult = await countApprovals(db, logger, change.id, change.createdByUserId);
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

/**
 * Same reason strings `checkMergeProtection` produces for `requiredEvaluators`,
 * but sourced from an in-memory list of evaluation runs instead of a change's
 * persisted `eval_runs` history. Exported separately so it's independently
 * testable — see `checkResolutionMergeProtection` for why a manual conflict
 * resolution needs this instead of the DB-backed check.
 */
export function requiredEvaluatorReasons(
  evalRuns: Array<{ evaluatorType: string; result: { passed: boolean } }>,
  requiredEvaluators: string[] | undefined,
): string[] {
  if (!requiredEvaluators || requiredEvaluators.length === 0) return [];

  const passedByType = new Map<string, boolean>();
  for (const { evaluatorType, result } of evalRuns) {
    // A policy may list the same evaluator type more than once (e.g. two diff
    // evaluators with different forbiddenPatterns). Fold duplicates with AND:
    // a required type passes only when every run of it passed, so a passing
    // duplicate can never mask a failure.
    passedByType.set(evaluatorType, (passedByType.get(evaluatorType) ?? true) && result.passed);
  }

  const reasons: string[] = [];
  for (const required of requiredEvaluators) {
    const passed = passedByType.get(required);
    if (passed === undefined) {
      reasons.push(`Required evaluator '${required}' has not run`);
    } else if (!passed) {
      reasons.push(`Required evaluator '${required}' failed`);
    }
  }
  return reasons;
}

/**
 * Why each required check blocks, given the latest run of every check on the
 * evaluated revision (#414). Empty when all of them have passed.
 *
 * Fails closed on everything that is not `passed`: a check that was never
 * dispatched for this revision, one still `queued` or `running`, one that
 * `failed`, and one that `errored`. Only a terminal `passed` on the newest
 * attempt opens the gate, so a runner that never reports — or a deadline sweep
 * that has not run yet — can never be read as a pass. A pending run past its
 * deadline is reported as overdue even before the sweep has flipped it.
 *
 * @param latest - Newest attempt per check name for the evaluated revision
 */
export function requiredCheckReasons(
  latest: Array<Pick<CheckRun, "name" | "status" | "deadlineAt">>,
  requiredChecks: string[] | undefined,
  now: Date,
): string[] {
  if (!requiredChecks || requiredChecks.length === 0) return [];

  const byName = new Map(latest.map((check) => [check.name, check]));
  const nowIso = now.toISOString();
  const reasons: string[] = [];
  for (const required of requiredChecks) {
    const check = byName.get(required);
    if (!check) {
      reasons.push(`Required check '${required}' has not been reported for the evaluated revision`);
      continue;
    }
    switch (check.status) {
      case "passed":
        break;
      case "queued":
      case "running":
        reasons.push(
          check.deadlineAt <= nowIso
            ? `Required check '${required}' did not report before its deadline`
            : `Required check '${required}' is ${check.status === "queued" ? "queued" : "still running"}`,
        );
        break;
      case "failed":
        reasons.push(`Required check '${required}' failed`);
        break;
      default:
        // `errored`, and any status a future migration adds: not a pass.
        reasons.push(`Required check '${required}' errored`);
    }
  }
  return reasons;
}

/**
 * Merge-protection check for a manual conflict resolution (issue #260,
 * SA-5 follow-up).
 *
 * A manual resolution has no Change row of its own — its content exists only
 * as the caller-supplied {file, content} pairs, evaluated once, inline, right
 * before resolveConflict pushes. That shapes two deliberate differences from
 * `checkMergeProtection`:
 *
 * - `requiredEvaluators` is checked against the `evalRuns` this exact
 *   resolution diff just produced (passed in), not a DB history keyed by some
 *   change id — there is no earlier row for THIS content, and the whole point
 *   of this gate is judging it, not whatever an earlier, different diff
 *   scored.
 * - `requiredApprovals` is checked against the approvals already recorded on
 *   `originatingChange`, the Change whose merge attempt produced this
 *   conflict. Resolving a conflict is part of landing that already-reviewed
 *   change, not a new change of its own — there is no UI to grant a fresh
 *   approval against the exact resolved bytes — so it reuses that change's
 *   review trail (still excluding the change author's own approval, same as
 *   `checkMergeProtection`). When no originating change is known (only
 *   possible for a conflict recorded before this check existed), any
 *   required approval fails closed rather than being silently skipped.
 *
 * `touchesProtectedConfig` is computed fresh from the resolution's own diff
 * rather than copied from the originating change: the resolution can add,
 * remove, or leave alone a `.stratum/policy.yaml` edit independently of what
 * the original change's diff did (SA-3).
 */
export async function checkResolutionMergeProtection(
  db: D1Database,
  logger: Logger,
  args: {
    diff: string;
    evalRuns: Array<{ evaluatorType: string; result: { passed: boolean } }>;
    originatingChange?: { id: string; createdByUserId?: string };
  },
  policy: EvalPolicy,
): Promise<Result<ProtectionVerdict, AppError>> {
  if (policy.configError) {
    return ok({ allowed: false, reasons: [policy.configError] });
  }

  const merge = policy.merge;
  const touchesProtectedConfig = diffTouchesProtectedConfig(args.diff);
  if (!merge && !touchesProtectedConfig) return ok({ allowed: true, reasons: [] });

  const reasons: string[] = requiredEvaluatorReasons(args.evalRuns, merge?.requiredEvaluators);

  // Required checks cannot be met here, and that is the answer rather than a
  // gap (#414). A check run is bound to an evaluated revision of a change; a
  // manual resolution is content with no revision, evaluated once inline and
  // pushed. Skipping the rule would make conflict resolution the way to land
  // code no runner ever saw, so it fails closed: put the resolution in the
  // workspace and re-evaluate the change instead.
  for (const required of merge?.requiredChecks ?? []) {
    reasons.push(
      `Required check '${required}' cannot run against a manual conflict resolution; commit the resolution to the workspace and re-evaluate the change`,
    );
  }

  const requiredApprovals = Math.max(merge?.requiredApprovals ?? 0, touchesProtectedConfig ? 1 : 0);
  if (requiredApprovals > 0) {
    if (!args.originatingChange) {
      reasons.push(
        `Requires ${requiredApprovals} approval${requiredApprovals === 1 ? "" : "s"}, but this resolution has no linked change to verify approvals against`,
      );
    } else {
      const approvalsResult = await countApprovals(
        db,
        logger,
        args.originatingChange.id,
        args.originatingChange.createdByUserId,
      );
      if (!approvalsResult.success) return err(approvalsResult.error);
      if (approvalsResult.data < requiredApprovals) {
        reasons.push(
          `Requires ${requiredApprovals} approval${requiredApprovals === 1 ? "" : "s"}, has ${approvalsResult.data}`,
        );
      }
    }
  }

  if (reasons.length > 0) {
    logger.info("Manual conflict resolution blocked by branch protection", { reasons });
  }
  return ok({ allowed: reasons.length === 0, reasons });
}
