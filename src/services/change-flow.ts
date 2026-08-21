import {
  CompositeEvaluator,
  DiffEvaluator,
  LLMEvaluator,
  SandboxEvaluator,
  SecretScanEvaluator,
  WebhookEvaluator,
  loadPolicy,
} from "../evaluation";
import type { SandboxRepoAccess } from "../evaluation/sandbox-evaluator";
import type { EvalPolicy, EvalResult, Evaluator } from "../evaluation/types";
import { type EventActor, emitEvent } from "../queue/events";
import { getAgent } from "../storage/agents";
import { createChange, updateChangeStatus } from "../storage/changes";
import { type CostSample, recordCosts } from "../storage/costs";
import { recordEvalRuns } from "../storage/eval-runs";
import {
  artifactsRepoNameFromRemote,
  freshRepoToken,
  getCommitLog,
  getDiffBetweenRepos,
} from "../storage/git-ops";
import { readRepoSnapshot } from "../storage/repo-snapshot";
import { setWorkspace } from "../storage/state";
import { type Change, type Env, type ProjectEntry, getArtifactsRepoName } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { Result } from "../utils/result";
import { err, ok } from "../utils/result";

/**
 * The create-change + evaluate pipeline, extracted from the REST route so every
 * front door (REST `POST /changes`, gated `git push`, future queue consumers)
 * runs the identical gate. Behavior must stay in lockstep with what the route
 * historically did — the route's test suite is the contract.
 */

/** Current project HEAD: cheap KV snapshot first, single-commit clone as fallback. */
export async function resolveProjectHead(
  env: Env,
  project: ProjectEntry,
  logger: Logger,
): Promise<string | null> {
  if (project.namespace && project.slug) {
    const snapshotResult = await readRepoSnapshot(env.STATE, project, logger);
    if (snapshotResult.success) {
      const sha = snapshotResult.data?.commits[0]?.sha;
      if (sha) return sha;
    }
  }
  const readToken = await freshRepoToken(env.ARTIFACTS, project.remote, "read", logger);
  if (!readToken.success) return null;
  const logResult = await getCommitLog(project.remote, readToken.data, logger, 1);
  return logResult.success ? (logResult.data[0]?.sha ?? null) : null;
}

export class UnavailableEvaluator implements Evaluator {
  constructor(
    private evaluatorType: string,
    private reason: string,
  ) {}

  async evaluate(
    _diff: string,
    _policy: EvalPolicy,
    _logger: Logger,
  ): Promise<Result<EvalResult, AppError>> {
    return ok({
      score: 0,
      passed: false,
      reason: `${this.evaluatorType} unavailable: ${this.reason}`,
    });
  }
}

/**
 * Build the evaluator set for a policy: the always-on blocking secret scan plus
 * whatever the policy configures. Evaluators whose binding is missing become
 * UnavailableEvaluator (score 0, fail) rather than silently vanishing.
 *
 * `workspaceRepo` is read access to the workspace being evaluated (remote +
 * read token + the pinned evaluated commit); the sandbox evaluator needs it to
 * materialize the full tree it runs the test command against. Without it — or
 * without the SANDBOX binding (`[[sandboxes]]` in wrangler.toml, currently an
 * ops decision) — a policy naming `sandbox` fails closed with a reason that
 * says exactly which prerequisite is missing.
 */
export function buildEvaluators(
  env: Env,
  policy: EvalPolicy,
  projectName: string,
  logger: Logger,
  workspaceRepo?: SandboxRepoAccess,
): Array<{ type: string; evaluator: Evaluator }> {
  const evaluators: Array<{ type: string; evaluator: Evaluator }> = [
    { type: "secret_scan", evaluator: new SecretScanEvaluator() },
  ];

  evaluators.push(
    ...policy.evaluators.flatMap((cfg): Array<{ type: string; evaluator: Evaluator }> => {
      switch (cfg.type) {
        case "diff":
          return [{ type: "diff", evaluator: new DiffEvaluator() }];
        case "webhook":
          return [{ type: "webhook", evaluator: new WebhookEvaluator() }];
        case "llm":
          if (env.AI) return [{ type: "llm", evaluator: new LLMEvaluator(env.AI) }];
          return [
            {
              type: "llm",
              evaluator: new UnavailableEvaluator("llm", "AI binding is not configured"),
            },
          ];
        case "sandbox":
          if (!env.SANDBOX) {
            // Fail closed with an actionable reason: the [[sandboxes]] binding
            // is commented out in wrangler.toml until the beta is enabled, and
            // any policy naming `sandbox` blocks merges until it is (or the
            // evaluator is removed from the policy).
            return [
              {
                type: "sandbox",
                evaluator: new UnavailableEvaluator(
                  "sandbox",
                  "SANDBOX binding is not configured — enable [[sandboxes]] in wrangler.toml or remove the sandbox evaluator from the policy",
                ),
              },
            ];
          }
          if (!workspaceRepo) {
            return [
              {
                type: "sandbox",
                evaluator: new UnavailableEvaluator(
                  "sandbox",
                  "workspace repository access was not provided to the evaluation pipeline",
                ),
              },
            ];
          }
          return [{ type: "sandbox", evaluator: new SandboxEvaluator(env.SANDBOX, workspaceRepo) }];
        default:
          logger.warn(
            `Unknown evaluator type "${(cfg as { type: string }).type}" in policy for project ${projectName}`,
            { evaluatorType: (cfg as { type: string }).type, projectName },
          );
          return [];
      }
    }),
  );

  return evaluators;
}

export interface EvaluationRun {
  evaluatorType: string;
  result: EvalResult;
}

/**
 * Run every evaluator over a diff and aggregate the verdict, applying the
 * blocking secret-scan override (a failed secret scan fails the aggregate and
 * caps its score regardless of policy weighting). Shared by change creation
 * and the re-evaluate route so the two verdicts can't drift.
 */
export async function runEvaluation(
  evaluators: Array<{ type: string; evaluator: Evaluator }>,
  diff: string,
  policy: EvalPolicy,
  logger: Logger,
): Promise<{ evalRuns: EvaluationRun[]; evalResult: EvalResult }> {
  const evalRuns = await Promise.all(
    evaluators.map(async ({ type, evaluator }) => {
      const result = await evaluator.evaluate(diff, policy, logger);
      return {
        evaluatorType: type,
        result: result.success
          ? result.data
          : { score: 0, passed: false, reason: result.error.message },
      };
    }),
  );

  const composite = new CompositeEvaluator(evaluators.map(({ evaluator }) => evaluator));
  const aggregateResult = composite.aggregate(
    evalRuns.map(({ result }) => result),
    policy,
    logger,
  );
  const blockingFailure = evalRuns.find(
    ({ evaluatorType, result }) => evaluatorType === "secret_scan" && !result.passed,
  );
  const evalResult =
    blockingFailure === undefined
      ? aggregateResult
      : {
          score: Math.min(aggregateResult.score, blockingFailure.result.score),
          passed: false,
          reason:
            aggregateResult.reason === blockingFailure.result.reason
              ? blockingFailure.result.reason
              : `${blockingFailure.result.reason} ${aggregateResult.reason}`,
          issues: aggregateResult.issues,
        };
  return { evalRuns, evalResult };
}

type RecordedEvalRuns = Extract<
  Awaited<ReturnType<typeof recordEvalRuns>>,
  { success: true }
>["data"];

export interface ChangeCreationActor {
  userId?: string;
  agentId?: string;
}

export interface ChangeCreationOutcome {
  change: Change;
  evalResult: EvalResult;
  evalRuns: RecordedEvalRuns;
}

/**
 * Creates a change from a workspace and runs the complete evaluation flow synchronously.
 *
 * Callers must authorize the actor for project writes and verify that the workspace belongs to
 * the project and that the project is not being deleted. The change records provenance metadata,
 * evaluation runs, costs, status, commit metadata, and lifecycle events.
 *
 * Failures preserve the underlying status code where applicable. After the change is created,
 * returned errors include its identifier in the error context.
 */
export async function createChangeWithEvaluation(
  env: Env,
  logger: Logger,
  args: {
    project: ProjectEntry;
    projectName: string;
    workspaceName: string;
    workspaceRemote: string;
    actor: ChangeCreationActor;
  },
): Promise<Result<ChangeCreationOutcome, AppError>> {
  const { project, projectName, workspaceName, workspaceRemote, actor } = args;
  const { userId, agentId } = actor;

  const baseSha = await resolveProjectHead(env, project, logger);

  // Snapshot the authoring agent's model + prompt hash at creation, so
  // provenance records the model that did the work rather than the agent's
  // current (possibly later-changed) registration.
  let agentModel: string | undefined;
  let agentPromptHash: string | undefined;
  if (agentId !== undefined) {
    const agentResult = await getAgent(env.DB, agentId, logger);
    if (agentResult.success) {
      agentModel = agentResult.data.model;
      agentPromptHash = agentResult.data.promptHash;
    } else {
      // Best effort: provenance metadata must not block change creation. Log so a
      // persistent lookup failure is visible rather than silently dropping the
      // model/prompt snapshot.
      logger.warn("Could not load agent for provenance snapshot; continuing without it", {
        agentId,
        error: agentResult.error.message,
      });
    }
  }

  const changeResult = await createChange(env.DB, logger, {
    project: projectName,
    projectId: project.id,
    workspace: workspaceName,
    ...(agentId !== undefined ? { agentId } : {}),
    ...(baseSha !== null ? { baseSha } : {}),
    ...(agentModel !== undefined ? { agentModel } : {}),
    ...(agentPromptHash !== undefined ? { agentPromptHash } : {}),
  });
  if (!changeResult.success) {
    logger.error("Failed to create change", changeResult.error);
    // Preserve the storage layer's statusCode: a D1 failure is a 500, not the
    // caller's fault — flattening it to 400 misleads clients into retrying
    // with "fixed" input.
    return err(
      new AppError(
        changeResult.error.message,
        changeResult.error.code,
        changeResult.error.statusCode,
      ),
    );
  }
  const change = changeResult.data;

  const actorEvent: EventActor = agentId
    ? { type: "agent", id: agentId }
    : { type: "user", ...(userId !== undefined ? { id: userId } : {}) };

  await emitEvent(
    env.DB,
    env.EVENTS_QUEUE,
    {
      type: "change.created",
      project: projectName,
      changeId: change.id,
      workspace: workspaceName,
    },
    actorEvent,
    logger,
    project.id,
  );

  const [projectReadToken, workspaceReadToken] = await Promise.all([
    freshRepoToken(env.ARTIFACTS, project.remote, "read", logger),
    freshRepoToken(env.ARTIFACTS, workspaceRemote, "read", logger),
  ]);
  if (!projectReadToken.success) {
    return err(
      new AppError(projectReadToken.error.message, projectReadToken.error.code, 500, {
        changeId: change.id,
      }),
    );
  }
  if (!workspaceReadToken.success) {
    return err(
      new AppError(workspaceReadToken.error.message, workspaceReadToken.error.code, 500, {
        changeId: change.id,
      }),
    );
  }

  const policy = await loadPolicy(project.remote, projectReadToken.data, logger);

  const diffResult = await getDiffBetweenRepos(
    project.remote,
    projectReadToken.data,
    workspaceRemote,
    workspaceReadToken.data,
    logger,
  );
  if (!diffResult.success) {
    logger.error("Failed to get diff between repos", diffResult.error);
    return err(
      new AppError(diffResult.error.message, diffResult.error.code, 400, { changeId: change.id }),
    );
  }
  // workspaceOid === workspaceSha (same evaluated tip): #133 pins evaluatedSha +
  // tree oid for content-addressing, #115 pins workspaceHeadSha for the merge.
  const {
    diff,
    workspaceOid: evaluatedSha,
    workspaceTreeOid: evaluatedTreeOid,
    workspaceSha: workspaceHeadSha,
  } = diffResult.data;

  const evaluators = buildEvaluators(env, policy, projectName, logger, {
    remote: workspaceRemote,
    token: workspaceReadToken.data,
    ref: evaluatedSha,
  });
  const { evalRuns, evalResult } = await runEvaluation(evaluators, diff, policy, logger);

  const newStatus: Change["status"] = evalResult.passed ? "accepted" : "needs_changes";

  const recordResult = await recordEvalRuns(env.DB, logger, change.id, evalRuns);
  if (!recordResult.success) {
    logger.error("Failed to record eval runs", recordResult.error);
    return err(
      new AppError(recordResult.error.message, "DATABASE_ERROR", 500, { changeId: change.id }),
    );
  }

  // Best-effort cost tracking: the diff clones both repos, evaluators self-report.
  const createCostSamples: CostSample[] = [
    { kind: "git_ops", quantity: 2 },
    ...evalRuns.flatMap(({ result }) => result.costs ?? []),
  ];
  await recordCosts(
    env.DB,
    logger,
    { project: projectName, projectId: project.id, changeId: change.id, workspace: workspaceName },
    createCostSamples,
  );

  const updateResult = await updateChangeStatus(env.DB, logger, change.id, newStatus, {
    evalScore: evalResult.score,
    evalPassed: evalResult.passed,
    evalReason: evalResult.reason,
    evaluatedSha,
    evaluatedTreeOid,
    ...(workspaceHeadSha ? { workspaceHeadSha } : {}),
  });
  if (!updateResult.success) {
    logger.error("Failed to update change status", updateResult.error);
    return err(
      new AppError(
        updateResult.error.message,
        updateResult.error.code,
        updateResult.error.statusCode,
        {
          changeId: change.id,
        },
      ),
    );
  }

  await emitEvent(
    env.DB,
    env.EVENTS_QUEUE,
    {
      type: "change.evaluated",
      project: projectName,
      changeId: change.id,
      score: evalResult.score,
      passed: evalResult.passed,
    },
    { type: "system" },
    logger,
    project.id,
  );

  const updatedChange: Change = {
    ...change,
    status: newStatus,
    evalScore: evalResult.score,
    evalPassed: evalResult.passed,
    evalReason: evalResult.reason,
    evaluatedSha,
    evaluatedTreeOid,
    ...(workspaceHeadSha ? { workspaceHeadSha } : {}),
  };

  logger.info("Change created and evaluated", {
    changeId: change.id,
    project: projectName,
    workspace: workspaceName,
    status: newStatus,
    evalScore: evalResult.score,
  });

  return ok({ change: updatedChange, evalResult, evalRuns: recordResult.data });
}

/**
 * Fork a server-managed workspace from a project (used by the gated git push,
 * which needs a workspace to land the incoming pack on). Mirrors the REST
 * workspace-creation route's fork + KV registration + event; callers must have
 * already authorized write and checked the project isn't being deleted.
 */
export async function createWorkspaceFork(
  env: Env,
  logger: Logger,
  args: {
    project: ProjectEntry;
    workspaceName: string;
    actor: ChangeCreationActor & { agentOwnerId?: string };
  },
): Promise<Result<{ name: string; remote: string }, AppError>> {
  const { project, workspaceName, actor } = args;
  if (!project.namespace || !project.slug) {
    return err(new AppError("Project has no namespace/slug", "INVALID_PROJECT", 400));
  }

  const artifactsRepoName = getArtifactsRepoName(project.namespace, project.slug);
  let remote: string;
  try {
    const projectRepo = await env.ARTIFACTS.get(artifactsRepoName);
    const forked = await projectRepo.fork(workspaceName);
    remote = forked.remote;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed to fork workspace for push", error instanceof Error ? error : undefined, {
      workspaceName,
    });
    return err(new AppError(message, "ARTIFACTS_ERROR", 502));
  }

  const setResult = await setWorkspace(
    env.STATE,
    project.id,
    {
      name: workspaceName,
      remote,
      parent: project.id,
      createdAt: new Date().toISOString(),
      branchName: workspaceName,
      createdByUserId: actor.userId ?? actor.agentOwnerId,
      ...(actor.agentId !== undefined ? { createdByAgentId: actor.agentId } : {}),
    },
    logger,
  );
  if (!setResult.success) {
    // The fork exists but was never registered — deleting it here stops each
    // failed push from leaking an Artifacts repo. Log the coordinates either
    // way so a failed delete leaves a findable orphan, not a silent one.
    logger.error("Failed to register pushed workspace; removing orphaned fork", setResult.error, {
      remote,
      workspaceName,
      projectId: project.id,
    });
    const orphanRepoName = artifactsRepoNameFromRemote(remote);
    if (orphanRepoName) {
      await env.ARTIFACTS.delete(orphanRepoName).catch((error: unknown) => {
        logger.warn("Could not delete orphaned workspace fork", {
          repoName: orphanRepoName,
          remote,
          workspaceName,
          projectId: project.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return err(
      new AppError(setResult.error.message, setResult.error.code, setResult.error.statusCode),
    );
  }

  const actorEvent: EventActor = actor.agentId
    ? { type: "agent", id: actor.agentId }
    : { type: "user", ...(actor.userId !== undefined ? { id: actor.userId } : {}) };
  await emitEvent(
    env.DB,
    env.EVENTS_QUEUE,
    // Canonical `namespace/slug` (guaranteed by the guard above), matching the
    // change.* events this flow emits — not the mutable display name.
    {
      type: "workspace.created",
      project: `${project.namespace}/${project.slug}`,
      workspace: workspaceName,
    },
    actorEvent,
    logger,
    project.id,
  );

  return ok({ name: workspaceName, remote });
}
