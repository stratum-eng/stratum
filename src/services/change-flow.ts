import {
  CompositeEvaluator,
  DiffEvaluator,
  LLMEvaluator,
  SandboxEvaluator,
  SecretScanEvaluator,
  WebhookEvaluator,
  WorkersAiProvider,
  diffTouchesProtectedConfig,
  loadPolicy,
} from "../evaluation";
import { resolveLlmProvider } from "../evaluation/llm-byok";
import { llmProviderCatalog } from "../evaluation/llm-providers";
import type { SandboxRepoAccess } from "../evaluation/sandbox-evaluator";
import type {
  BillingContext,
  EvalPolicy,
  EvalResult,
  EvaluationContext,
  Evaluator,
} from "../evaluation/types";
import { buildEvaluationReport, reportEvaluationToGitHub } from "../github/sync";
import { type EventActor, emitEvent } from "../queue/events";
import { getAgent } from "../storage/agents";
import { createChange, updateChangeStatus } from "../storage/changes";
import {
  type BillingSubject,
  type CostSample,
  recordCosts,
  resolveBillingSubject,
} from "../storage/costs";
import { recordEvalRuns } from "../storage/eval-runs";
import {
  artifactsRepoNameFromRemote,
  freshRepoToken,
  getCommitLog,
  getDiffBetweenRepos,
} from "../storage/git-ops";
import { readRepoSnapshot } from "../storage/repo-snapshot";
import { setWorkspace } from "../storage/state";
import {
  type Change,
  type Env,
  type ProjectEntry,
  getArtifactsRepoName,
  projectDefaultBranch,
  projectDisplayName,
} from "../types";
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
  const logResult = await getCommitLog(
    project.remote,
    readToken.data,
    logger,
    1,
    projectDefaultBranch(project),
  );
  return logResult.success ? (logResult.data[0]?.sha ?? null) : null;
}

/**
 * Stands in for an evaluator whose prerequisites are missing.
 *
 * Exists so a misconfigured policy fails closed. Dropping the evaluator from
 * the list instead would let a change be scored — and merged — by whichever
 * evaluators happened to be wired up, with nothing in the result showing that
 * a required one never ran. Scoring 0 with the reason naming the missing
 * prerequisite turns silent under-evaluation into a visible failure.
 */
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
 * The evaluation-time view of an already-resolved billing subject, or
 * `undefined` when none could be named.
 *
 * Takes the subject rather than the `ProjectEntry` it came from, and that is the
 * whole point of the signature. `ownerType` admits `"agent"` and an agent is not
 * a payer — it belongs to one — so naming the payer means walking
 * `agents.owner_id`, which is D1 and therefore async. This function used to
 * refuse an agent-owned project instead, which left `LLMEvaluator` with no
 * billing context and so no meter check at all: the walk existed in
 * `resolveEnforcementSubject` and nothing ever reached it. Every call site now
 * resolves once with `resolveBillingSubject` and passes the result to both this
 * and `recordCosts`, so the allowance and the ledger cannot disagree about who
 * pays, and neither pays for two D1 reads of the same fact.
 *
 * `projectId` is checked because KV entries are cast without validation
 * (`src/storage/state.ts`) and legacy rows can lack fields the type promises. A
 * context keyed on `""` would be worse than none: spend that *looks* attributed
 * aggregates under an empty key no account will ever reconcile.
 *
 * @param subject - From `resolveBillingSubject`; `null` when nobody can be named
 * @param projectId - The project whose policy is being enforced
 * @param actorUserId - The user who ran the evaluation, when the caller knows
 *   one. Carried alongside the payer rather than instead of it: PRD §4a checks a
 *   limit against the actor while the ledger keeps recording the owner. For an
 *   agent-authored change this is the agent's OWNER.
 */
export function billingContextFor(
  subject: BillingSubject | null,
  projectId: string | undefined,
  actorUserId?: string,
): BillingContext | undefined {
  if (!subject || !projectId) return undefined;
  return {
    ownerId: subject.ownerId,
    ownerType: subject.ownerType,
    projectId,
    ...(actorUserId ? { actorUserId } : {}),
  };
}

/**
 * Build the evaluator set for a policy: the always-on blocking secret scan plus
 * whatever the policy configures. Evaluators whose binding is missing become
 * UnavailableEvaluator (score 0, fail) rather than silently vanishing.
 *
 * Takes the whole `ProjectEntry` rather than a display name because the payer
 * has to be nameable from it. Nothing built here receives the project: the
 * billing subject reaches evaluators on the `EvaluationContext` that
 * `runEvaluation` forwards, and inside this function the entry is used for the
 * log line below and nothing else.
 *
 * `workspaceRepo` is read access to the workspace being evaluated (remote +
 * read token + the pinned evaluated commit); the sandbox evaluator needs it to
 * materialize the full tree it runs the test command against. Without it — or
 * without the SANDBOX binding (`[[sandboxes]]` in wrangler.toml, currently an
 * ops decision) — a policy naming `sandbox` fails closed with a reason that
 * says exactly which prerequisite is missing.
 */
export async function buildEvaluators(
  env: Env,
  policy: EvalPolicy,
  project: ProjectEntry,
  logger: Logger,
  workspaceRepo?: SandboxRepoAccess,
  /**
   * Cloudflare Workers `ExecutionContext.waitUntil`, when the caller has one.
   *
   * Used by the metered evaluator for one thing: warming an ORG's entitlements
   * off the response path (PRD §4a). Auth middleware warms the caller, but it
   * knows the caller and not the project, so nothing before this point can warm
   * the org a project belongs to. Absent means no warm — the check then resolves
   * to the actor, which is the safe direction and the documented first-contact
   * behaviour, never a blocking fetch on the merge path.
   */
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Array<{ type: string; evaluator: Evaluator }>> {
  // Async only because of this: a policy that selects a BYOK provider needs the
  // project's credential resolved before the evaluator exists. It is a no-op —
  // no D1 read, no key derivation — for every policy that names no provider,
  // which is every policy that has not opted in.
  const llmProvider = await resolveLlmProvider(env, project, policy, logger);

  // Guarded, because a legacy entry can carry no namespace — see
  // `projectDisplayName`, and this file's own `resolveProjectHead`.
  const projectName = projectDisplayName(project);
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
        case "llm": {
          // Every failure to resolve a project-supplied credential lands here,
          // and NONE of them falls back to `env.AI`. Falling back would move
          // the spend to the operator's bill — the hole BYOK closes — and would
          // turn a misconfigured gate into one that quietly passes on someone
          // else's budget. Fail closed with the reason instead.
          if (llmProvider.status === "unavailable") {
            return [
              { type: "llm", evaluator: new UnavailableEvaluator("llm", llmProvider.reason) },
            ];
          }
          const enforcement = { env, ...(waitUntil !== undefined ? { waitUntil } : {}) };
          if (llmProvider.status === "byok") {
            return [
              {
                type: "llm",
                evaluator: new LLMEvaluator(llmProvider.provider, "byok", enforcement),
              },
            ];
          }
          if (env.AI)
            return [
              {
                type: "llm",
                evaluator: new LLMEvaluator(new WorkersAiProvider(env.AI), "platform", enforcement),
              },
            ];
          return [
            {
              type: "llm",
              evaluator: new UnavailableEvaluator("llm", "AI binding is not configured"),
            },
          ];
        }
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
  /** What the diff is a diff of, and who pays for evaluating it. Forwarded to
   * every evaluator so one that reproduces the change out-of-process can pin
   * the base it applies to (#274). Callers pass the base resolved from the
   * clone the diff came from, never a fresh read of the project head, and the
   * billing subject from `billingContextFor`.
   *
   * One object is shared by every evaluator in the `Promise.all` below, so it
   * must stay immutable data. Hanging a mutable balance or counter off it would
   * be a race across concurrently running evaluators, not a shared budget. */
  context?: EvaluationContext,
): Promise<{ evalRuns: EvaluationRun[]; evalResult: EvalResult }> {
  const evalRuns = await Promise.all(
    evaluators.map(async ({ type, evaluator }) => {
      // `evaluate` returns a Result by contract, and this catch is what keeps
      // that contract from being a promise the caller cannot rely on. One
      // evaluator that REJECTS — a Durable Object RPC that could not be
      // reached, a runtime fault — would otherwise reject this `Promise.all`
      // and take change creation down with it, discarding every other
      // evaluator's verdict on the way. A gate that could not run is a gate
      // that did not pass; it is reported as a failing verdict, exactly as a
      // returned error already is, and never as a missing one.
      try {
        const result = await evaluator.evaluate(diff, policy, logger, context);
        return {
          evaluatorType: type,
          result: result.success
            ? result.data
            : { score: 0, passed: false, reason: result.error.message },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          `Evaluator "${type}" threw instead of returning a result`,
          error instanceof Error ? error : new Error(message),
          { evaluatorType: type },
        );
        return {
          evaluatorType: type,
          result: { score: 0, passed: false, reason: `${type} evaluator failed: ${message}` },
        };
      }
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
  /** When the actor is an agent, its owning user. Recorded as the change's
   * human author so the owner's approval cannot satisfy requiredApprovals. */
  agentOwnerId?: string;
}

export interface ChangeCreationOutcome {
  change: Change;
  evalResult: EvalResult;
  evalRuns: RecordedEvalRuns;
}

/**
 * Create a change from a workspace and synchronously run the full evaluation
 * suite, recording eval runs, costs, status, and events. Callers must have
 * already authorized the actor for project write and verified the workspace
 * belongs to the project and the project is not being deleted.
 *
 * Errors preserve the underlying failure's statusCode (5xx for infrastructure
 * — D1 writes, token minting — 4xx otherwise) so HTTP front doors can map them
 * faithfully; once the change row exists, its id rides in the error context.
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
    /** Cloudflare Workers `ExecutionContext.waitUntil`, when the caller has one. */
    waitUntil?: (promise: Promise<unknown>) => void;
  },
): Promise<Result<ChangeCreationOutcome, AppError>> {
  const { project, projectName, workspaceName, workspaceRemote, actor, waitUntil } = args;
  const { userId, agentId } = actor;
  // The human author: the acting user, or (for agent-authored changes) the
  // agent's owner. Excluded from the required-approval count at merge time.
  const createdByUserId = userId ?? actor.agentOwnerId;

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
    ...(createdByUserId !== undefined ? { createdByUserId } : {}),
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

  const branch = projectDefaultBranch(project);
  const policy = await loadPolicy(
    project.remote,
    projectReadToken.data,
    logger,
    branch,
    llmProviderCatalog(env, logger),
  );

  const diffResult = await getDiffBetweenRepos(
    project.remote,
    projectReadToken.data,
    workspaceRemote,
    workspaceReadToken.data,
    logger,
    branch,
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
    baseOid,
  } = diffResult.data;

  const evaluators = await buildEvaluators(
    env,
    policy,
    project,
    logger,
    {
      remote: workspaceRemote,
      token: workspaceReadToken.data,
      ref: evaluatedSha,
    },
    waitUntil,
  );
  // `baseOid`, not the `baseSha` resolved further up: that one is read before
  // the diff clone, so the default branch can advance in between. The evaluated
  // base must be the one the diff was actually built against (#274).
  // Once per request, and before the evaluation rather than after it: the same
  // subject gates the meters below and is recorded in the ledger, so resolving
  // it twice would pay for two agent walks and could name two different payers.
  const createSubject = await resolveBillingSubject(env.DB, logger, project);
  const { evalRuns, evalResult } = await runEvaluation(evaluators, diff, policy, logger, {
    baseSha: baseOid,
    // The actor is the human behind the change — the agent's owner for an
    // agent-authored one — which is who an allowance follows under PRD §4a.
    billing: billingContextFor(createSubject, project.id, createdByUserId),
  });

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
    {
      project: projectName,
      projectId: project.id,
      changeId: change.id,
      workspace: workspaceName,
      ...(createSubject ?? {}),
      notify: {
        env,
        ...(createdByUserId !== undefined ? { actorUserId: createdByUserId } : {}),
        ...(waitUntil !== undefined ? { waitUntil } : {}),
      },
    },
    createCostSamples,
  );

  const updateResult = await updateChangeStatus(env.DB, logger, change.id, newStatus, {
    evalScore: evalResult.score,
    evalPassed: evalResult.passed,
    evalReason: evalResult.reason,
    evaluatedSha,
    evaluatedTreeOid,
    ...(workspaceHeadSha ? { workspaceHeadSha } : {}),
    // Flag a change that edits the merge-protection config so the merge gate can
    // require a human approval and forbid force-merging it (SA-3).
    touchesProtectedConfig: diffTouchesProtectedConfig(diff),
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

  // Layer mode: report the verdict to the change's linked GitHub PR (comment +
  // commit status). Best-effort by contract — a GitHub failure never fails the
  // evaluation — and a no-op unless the project has a GitHub source and the
  // change has a linked PR (freshly created changes normally don't yet).
  // Scheduled off the request path when the caller has a waitUntil to give us.
  const reportEvaluation = reportEvaluationToGitHub(
    env,
    updatedChange,
    project,
    buildEvaluationReport(evalResult, evalRuns),
    logger,
  );
  if (waitUntil) {
    waitUntil(reportEvaluation);
  } else {
    await reportEvaluation;
  }

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
