/**
 * Asynchronous evaluation (#412, ADR 009): dispatching a run, executing it,
 * and recovering one that never finished.
 *
 * A change waiting on a verdict sits in status `evaluating` with an
 * `eval_run_id`. {@link dispatchEvaluationRun} hands that run to
 * `EVALUATION_QUEUE`; the consumer (`src/queue/evaluation-queue.ts`) calls
 * {@link runEvaluationJob}; the five-minute cron calls
 * {@link sweepStuckEvaluations} for any run that was lost on the way. Every
 * write a run makes is keyed to its run id (`src/storage/change-evaluation.ts`),
 * so only the run the change is currently waiting on can ever record a verdict.
 */
import { diffTouchesProtectedConfig } from "../evaluation";
import type { EvalResult } from "../evaluation/types";
import { buildEvaluationReport, reportEvaluationToGitHub } from "../github/sync";
import { emitEvent } from "../queue/events";
import { recordAudit } from "../storage/audit";
import {
  failEvaluationRun,
  finalizeEvaluationRun,
  getEvaluationRequester,
  listStuckEvaluations,
  newEvaluationRunId,
  redispatchEvaluationRun,
} from "../storage/change-evaluation";
import { getChange } from "../storage/changes";
import { type CostSample, recordCosts } from "../storage/costs";
import type { EvalRun } from "../storage/eval-runs";
import {
  getExternalPullRequestByChange,
  supersedeImportedChange,
} from "../storage/external-pull-requests";
import { getProject, getWorkspace } from "../storage/state";
import type { Change, Env, EvaluationQueueMessage } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { evaluateWorkspace } from "./change-flow";
import { dispatchChecks, dispatchTextOf } from "./check-runs";

/**
 * A run that could not produce a verdict. `permanent` decides whether the
 * consumer redelivers it: a change or workspace that no longer exists, or a
 * tree the diff refuses outright (submodules), fails the same way every time.
 */
export class EvaluationJobError extends AppError {
  constructor(
    message: string,
    code: string,
    statusCode: number,
    public readonly permanent: boolean,
  ) {
    super(message, code, statusCode);
    this.name = "EvaluationJobError";
  }
}

/** What a caller with a request in hand can lend a run. A queue consumer has neither. */
export interface EvaluationRunOptions {
  waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * Origin of the request that ran the evaluation inline. Only used to tell a
   * check runner where to report when the operator has not set `APP_URL`
   * (#414); a run executing on the queue has no request and relies on it.
   */
  requestOrigin?: string;
}

export type EvaluationJobOutcome =
  | { status: "applied"; change: Change; evalResult: EvalResult; evalRuns: EvalRun[] }
  /** The change no longer waits on this run; nothing was (or should be) written. */
  | { status: "superseded" };

/**
 * Diff codes that no retry can change. Everything else a diff can fail with is
 * a clone or network failure, which redelivery can fix.
 */
const PERMANENT_DIFF_CODES = new Set(["SUBMODULES_UNSUPPORTED", "FORK_POINT_NOT_FOUND"]);

/**
 * Execute one evaluation run and record its verdict — if, when it finishes,
 * the change is still waiting on it.
 *
 * Writes nothing for a superseded run, by construction rather than by a check
 * up front: the up-front check only saves the work, and the guarded batch in
 * `finalizeEvaluationRun` is what makes a stale verdict impossible to land,
 * however long the evaluators took.
 */
export async function runEvaluationJob(
  env: Env,
  logger: Logger,
  message: Pick<EvaluationQueueMessage, "changeId" | "runId">,
  options: EvaluationRunOptions = {},
): Promise<Result<EvaluationJobOutcome, EvaluationJobError>> {
  const { changeId, runId } = message;
  const { waitUntil } = options;
  const log = logger.child ? logger.child({ changeId, runId }) : logger;

  const changeResult = await getChange(env.DB, log, changeId);
  if (!changeResult.success) {
    if (changeResult.error.code === "NOT_FOUND") return ok({ status: "superseded" });
    return err(transient(changeResult.error));
  }
  const change = changeResult.data;
  if (change.status !== "evaluating" || change.evalRunId !== runId) {
    log.info("Evaluation run superseded before it started", {
      status: change.status,
      currentRunId: change.evalRunId,
    });
    return ok({ status: "superseded" });
  }

  // A change from a pull request on the mirror is evaluated only at the head
  // that was imported. An import that died after starting its run, or whose
  // look at the head failed, can leave a run for commits the pull request has
  // moved past; this is where every way of running it arrives (the queue, an
  // inline run, the sweep that recovers a stuck one). The change goes back to
  // `external` and nothing is evaluated. A failed lookup is retried, never
  // read as "no pull request".
  const origin = await getExternalPullRequestByChange(env.DB, log, changeId);
  if (!origin.success) return err(transient(origin.error));
  if (origin.data !== null && origin.data.headSha !== origin.data.importedHeadSha) {
    // Only as this run: by the time this write lands a maintainer may have
    // imported the new head and started another.
    const returned = await supersedeImportedChange(env.DB, log, changeId, { forRunId: runId });
    if (!returned.success) return err(transient(returned.error));
    log.info("Evaluation run dropped: the pull request has commits past the imported ones", {
      prNumber: origin.data.prNumber,
      headSha: origin.data.headSha,
      importedHeadSha: origin.data.importedHeadSha,
    });
    return ok({ status: "superseded" });
  }

  const projectResult = await getProject(env.STATE, change.project, log);
  if (!projectResult.success) {
    return err(
      projectResult.error.code === "NOT_FOUND"
        ? new EvaluationJobError("Project no longer exists", "NOT_FOUND", 404, true)
        : transient(projectResult.error),
    );
  }
  const project = projectResult.data;

  const workspaceResult = await getWorkspace(env.STATE, project.id, change.workspace, log);
  if (!workspaceResult.success) {
    return err(
      workspaceResult.error.code === "NOT_FOUND"
        ? new EvaluationJobError(
            `Workspace '${change.workspace}' no longer exists`,
            "NOT_FOUND",
            404,
            true,
          )
        : transient(workspaceResult.error),
    );
  }

  const requester = await getEvaluationRequester(env.DB, log, changeId);
  // The user an allowance follows: whoever asked for this run, else the
  // change's human author. A lookup failure falls back the same way — it
  // decides attribution, never whether the gate runs.
  const actorUserId = (requester.success ? requester.data : undefined) ?? change.createdByUserId;

  const evaluation = await evaluateWorkspace(env, log, {
    project,
    workspaceRemote: workspaceResult.data.remote,
    ...(actorUserId !== undefined ? { actorUserId } : {}),
    ...(waitUntil !== undefined ? { waitUntil } : {}),
  });
  if (!evaluation.success) {
    const { message: why, code, statusCode } = evaluation.error;
    return err(new EvaluationJobError(why, code, statusCode, PERMANENT_DIFF_CODES.has(code)));
  }
  const {
    diff,
    evaluatedSha,
    evaluatedTreeOid,
    workspaceHeadSha,
    baseOid,
    mergeBaseOid,
    evalRuns,
    evalResult,
    billingSubject,
    policy,
  } = evaluation.data;

  // Stale-approval dismissal, exactly as the inline re-evaluate route decides
  // it (#193): either endpoint of the diff moving invalidates an approval of
  // the old one. Absent pins (a change's first run) dismiss nothing on the tip,
  // and an approval given while the first run was pending is dismissed only if
  // the base it was looking at moved.
  const tipChanged = change.evaluatedSha !== undefined && change.evaluatedSha !== evaluatedSha;
  const baseChanged = change.baseSha !== undefined && change.baseSha !== baseOid;
  const newStatus = evalResult.passed ? "accepted" : "needs_changes";
  const statusOpts = {
    evalScore: evalResult.score,
    evalPassed: evalResult.passed,
    evalReason: evalResult.reason,
    evaluatedSha,
    evaluatedTreeOid,
    baseSha: baseOid,
    forkPointSha: mergeBaseOid,
    ...(workspaceHeadSha ? { workspaceHeadSha } : {}),
    touchesProtectedConfig: diffTouchesProtectedConfig(diff),
  };

  const finalized = await finalizeEvaluationRun(env.DB, log, {
    changeId,
    runId,
    status: newStatus,
    opts: statusOpts,
    evalRuns,
    dismissApprovals: tipChanged || baseChanged,
  });
  if (!finalized.success) return err(transient(finalized.error));

  // Recorded whether or not the verdict landed: the evaluators ran and the
  // spend happened either way, and a superseded run is still a real cost.
  const costSamples: CostSample[] = [
    { kind: "git_ops", quantity: 2 },
    ...evalRuns.flatMap(({ result }) => result.costs ?? []),
  ];
  await recordCosts(
    env.DB,
    log,
    {
      project: change.project,
      projectId: change.projectId ?? project.id,
      changeId,
      workspace: change.workspace,
      ...(billingSubject ?? {}),
      notify: {
        env,
        ...(actorUserId !== undefined ? { actorUserId } : {}),
        ...(waitUntil !== undefined ? { waitUntil } : {}),
      },
    },
    costSamples,
  );

  if (!finalized.data.applied) {
    log.info("Evaluation run superseded while running; verdict discarded", {
      passed: evalResult.passed,
    });
    return ok({ status: "superseded" });
  }

  // Only for a verdict that landed (#414): a superseded run's revision is not
  // the one the change is on, and the run that superseded it dispatches its
  // own. Before the event below, so a subscriber reacting to
  // `change.evaluated` finds the revision's checks already queued.
  await dispatchChecks(env, log, {
    changeId,
    ...dispatchTextOf(change),
    project,
    policy,
    diff,
    baseSha: mergeBaseOid,
    headSha: evaluatedSha,
    headTreeSha: evaluatedTreeOid,
    ...(options.requestOrigin !== undefined ? { requestOrigin: options.requestOrigin } : {}),
  });

  const { dismissedReviewerIds } = finalized.data;
  if (dismissedReviewerIds.length > 0) {
    const auditResult = await recordAudit(env.DB, log, {
      action: "review.approvals_dismissed",
      ...(requester.success && requester.data !== undefined
        ? { actorType: "user" as const, actorId: requester.data }
        : { actorType: "system" as const }),
      subject: changeId,
      project,
      detail: {
        project: change.project,
        dismissed: dismissedReviewerIds.length,
        dismissedReviewerIds,
        previousEvaluatedSha: change.evaluatedSha,
        evaluatedSha,
        previousBaseSha: change.baseSha,
        baseSha: baseOid,
        dismissedFor: tipChanged && baseChanged ? "tip+base" : tipChanged ? "tip" : "base",
      },
    });
    if (!auditResult.success) {
      log.error("Failed to audit approval dismissal", auditResult.error, { changeId });
    }
  }

  await emitEvent(
    env.DB,
    env.EVENTS_QUEUE,
    {
      type: "change.evaluated",
      project: change.project,
      changeId,
      score: evalResult.score,
      passed: evalResult.passed,
    },
    { type: "system" },
    log,
    change.projectId ?? project.id,
  );

  const updatedChange: Change = {
    ...change,
    // What the row landed on: a request for changes made while the run was
    // pending turns a pass into needs_changes.
    status: finalized.data.status ?? newStatus,
    evalScore: evalResult.score,
    evalPassed: evalResult.passed,
    evalReason: evalResult.reason,
    evaluatedSha,
    evaluatedTreeOid,
    baseSha: baseOid,
    forkPointSha: mergeBaseOid,
    ...(workspaceHeadSha ? { workspaceHeadSha } : {}),
  };

  // Best-effort by contract, as on every other evaluation path: a GitHub
  // failure never fails the evaluation.
  const report = reportEvaluationToGitHub(
    env,
    updatedChange,
    project,
    buildEvaluationReport(evalResult, evalRuns),
    log,
  );
  if (waitUntil) waitUntil(report);
  else await report;

  log.info("Evaluation run recorded", {
    status: updatedChange.status,
    evalScore: evalResult.score,
  });
  return ok({
    status: "applied",
    change: updatedChange,
    evalResult,
    evalRuns: finalized.data.runs,
  });
}

function transient(error: AppError | Error): EvaluationJobError {
  const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
  return new EvaluationJobError(error.message, code, 500, false);
}

/**
 * Fail a run closed and announce it. The event says `passed: false` because
 * that is what the gate now reports; a subscriber waiting for a verdict on
 * this change would otherwise wait forever.
 */
export async function failEvaluationJob(
  env: Env,
  logger: Logger,
  args: { changeId: string; runId: string | null; reason: string },
): Promise<void> {
  const failed = await failEvaluationRun(env.DB, logger, args);
  if (!failed.success || !failed.data.applied) return;

  const change = await getChange(env.DB, logger, args.changeId);
  if (!change.success) return;
  await emitEvent(
    env.DB,
    env.EVENTS_QUEUE,
    {
      type: "change.evaluated",
      project: change.data.project,
      changeId: args.changeId,
      score: 0,
      passed: false,
    },
    { type: "system" },
    logger,
    change.data.projectId,
  );
}

/** The reason recorded on a change whose run could not produce a verdict. */
export function evaluationFailureReason(detail: string): string {
  return `Evaluation did not complete: ${detail}. Re-evaluate the change to try again.`;
}

export type DispatchOutcome =
  | { mode: "queued" }
  /** The run executed inline because it could not be queued. */
  | {
      mode: "inline";
      result: Result<EvaluationJobOutcome, EvaluationJobError>;
    };

/**
 * Hand a run to the evaluation queue; run it inline if the queue is not bound
 * or the send fails.
 *
 * Inline is the degraded path, not an error: the change is already in
 * `evaluating` under this run, and the alternative — leaving it there until the
 * sweep notices — would stall a submitter for the sweep's whole threshold over
 * a queue blip. An inline run that cannot produce a verdict is failed closed
 * here, since no redelivery will come for it.
 */
export async function dispatchEvaluationRun(
  env: Env,
  logger: Logger,
  message: { changeId: string; runId: string },
  options: EvaluationRunOptions = {},
): Promise<DispatchOutcome> {
  if (env.EVALUATION_QUEUE) {
    try {
      await env.EVALUATION_QUEUE.send({ type: "change.evaluate", ...message });
      return { mode: "queued" };
    } catch (error) {
      logger.error(
        "Evaluation queue send failed; running the evaluation inline",
        error instanceof Error ? error : new Error(String(error)),
        message,
      );
    }
  }
  let result: Result<EvaluationJobOutcome, EvaluationJobError>;
  try {
    result = await runEvaluationJob(env, logger, message, options);
  } catch (error) {
    // `runEvaluationJob` returns a Result, but a runtime fault below it must
    // still fail the run closed: no redelivery will come for an inline run.
    const cause = error instanceof Error ? error : new Error(String(error));
    logger.error("Inline evaluation threw", cause, message);
    result = err(transient(cause));
  }
  if (!result.success) {
    await failEvaluationJob(env, logger, {
      ...message,
      reason: evaluationFailureReason(result.error.message),
    });
  }
  return { mode: "inline", result };
}

/**
 * How long a run may sit in `evaluating` before the sweep treats it as lost.
 *
 * Comfortably past the slowest legitimate run: every evaluator is bounded by
 * its own deadline (the sandbox's is the longest, ~160s), and the consumer gets
 * {@link MAX_EVALUATION_DELIVERIES} deliveries with a retry delay between them.
 * A sweep that fired inside that window would supersede a run that was about to
 * finish — harmless, since the old run's write is then discarded, but wasteful.
 */
export const STUCK_EVALUATION_AFTER_MS = 20 * 60_000;

/** Re-dispatches the sweep will make before failing a run closed. */
export const MAX_EVALUATION_REDISPATCHES = 2;

/**
 * Deliveries the consumer will make of one message before failing the run
 * closed. Mirrors `max_retries = 2` on the `stratum-evaluations` consumers in
 * wrangler.toml (one delivery plus two retries); if the two ever disagree the
 * sweep is still the backstop.
 */
export const MAX_EVALUATION_DELIVERIES = 3;

const SWEEP_BATCH_LIMIT = 25;

/**
 * Recover runs whose consumer crashed or whose message was lost (#412). Runs on
 * the five-minute cron.
 *
 * A stuck run is re-dispatched under a fresh run id up to
 * {@link MAX_EVALUATION_REDISPATCHES} times, then failed closed. With no
 * evaluation queue bound there is nothing to re-dispatch to, and running a
 * minutes-long evaluation inside the cron would share its budget with every
 * other sweep, so the run is failed closed straight away; re-evaluating the
 * change runs it again.
 */
export async function sweepStuckEvaluations(
  env: Env,
  logger: Logger,
  now: Date = new Date(),
): Promise<{ redispatched: number; failed: number }> {
  const cutoff = new Date(now.getTime() - STUCK_EVALUATION_AFTER_MS).toISOString();
  const stuck = await listStuckEvaluations(env.DB, logger, { cutoff, limit: SWEEP_BATCH_LIMIT });
  if (!stuck.success) return { redispatched: 0, failed: 0 };

  let redispatched = 0;
  let failed = 0;
  for (const run of stuck.data) {
    const queue = env.EVALUATION_QUEUE;
    if (!queue || run.attempts >= MAX_EVALUATION_REDISPATCHES) {
      await failEvaluationJob(env, logger, {
        changeId: run.changeId,
        runId: run.runId,
        reason: evaluationFailureReason(
          queue ? "the evaluation run never reported back" : "no evaluation queue is configured",
        ),
      });
      failed++;
      continue;
    }

    const runId = newEvaluationRunId();
    const swapped = await redispatchEvaluationRun(env.DB, logger, {
      changeId: run.changeId,
      previousRunId: run.runId,
      runId,
      now: now.toISOString(),
    });
    if (!swapped.success || !swapped.data.applied) continue;
    try {
      await queue.send({ type: "change.evaluate", changeId: run.changeId, runId });
      redispatched++;
    } catch (error) {
      // The attempt is already counted, so a queue that stays down still ends
      // in a closed failure rather than an endless loop of re-dispatches.
      logger.error(
        "Failed to re-dispatch a stuck evaluation run",
        error instanceof Error ? error : new Error(String(error)),
        { changeId: run.changeId },
      );
    }
  }

  if (redispatched > 0 || failed > 0) {
    logger.warn("Recovered stuck evaluation runs", { redispatched, failed });
  }
  return { redispatched, failed };
}
