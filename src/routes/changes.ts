import { type Context, Hono } from "hono";
import {
  CompositeEvaluator,
  DiffEvaluator,
  LLMEvaluator,
  SandboxEvaluator,
  SecretScanEvaluator,
  WebhookEvaluator,
  loadPolicy,
} from "../evaluation";
import type { EvalPolicy, EvalResult } from "../evaluation/types";
import type { Evaluator } from "../evaluation/types";
import { runPostMergeCheck } from "../merge/post-merge";
import { checkMergeProtection } from "../merge/protection";
import { type EventActor, emitEvent } from "../queue/events";
import type { MergeOutcome } from "../queue/merge-queue";
import { getAgent } from "../storage/agents";
import { recordAudit } from "../storage/audit";
import {
  createChange,
  getChange,
  getChangesByIds,
  listChanges,
  updateChangeStatus,
} from "../storage/changes";
import { type CostSample, getChangeCostSummary, recordCosts } from "../storage/costs";
import { listEvalRuns, recordEvalRuns } from "../storage/eval-runs";
import {
  MergeConflictError,
  type NodeFS,
  type StagedTreeItem,
  batchMergeStagedTrees,
  cloneRepo,
  freshRepoToken,
  getCommitLog,
  getDiffBetweenRepos,
  mergeWorkspaceIntoProject,
  parseStagedTree,
} from "../storage/git-ops";
import { recordProvenance } from "../storage/provenance";
import { readRepoSnapshot } from "../storage/repo-snapshot";
import { getProject, getWorkspace } from "../storage/state";
import type { Change, Env, ProjectEntry } from "../types";
import { canReadProject, canWriteProject } from "../utils/authz";
import type { AppError } from "../utils/errors";
import { newId } from "../utils/ids";
import { createLogger } from "../utils/logger";
import type { Logger } from "../utils/logger";
import {
  badRequest,
  created,
  forbidden,
  internalError,
  notFound,
  ok,
  unauthorized,
} from "../utils/response";
import { ok as okResult } from "../utils/result";

const app = new Hono<{ Bindings: Env }>();

// Merge-policy cache (ADR 004). Reading the policy clones the repo; under a swarm
// of concurrent merges that per-request clone both throttles and de-coalesces the
// DO group-commit. Cache per project with a short TTL AND deduplicate concurrent
// loads (one clone per burst, not N). Gated on REPO_DO_ENABLED so tests — which
// don't set the flag — always call loadPolicy fresh (no cross-test pollution).
const POLICY_CACHE_TTL_MS = 60_000;
const policyCache = new Map<string, { policy: EvalPolicy; expires: number }>();
const policyInflight = new Map<string, Promise<EvalPolicy>>();

const policyKvKey = (projectId: string) => `policy:${projectId}`;

/**
 * Load a project's merge policy through a two-level cache so the hot merge paths
 * don't clone the repo just to read `.stratum/policy.yaml`:
 *   in-isolate Map  ->  KV (shared across isolates)  ->  clone (loadPolicy).
 * Request-coalesced per project. Gated on REPO_DO_ENABLED so tests always load
 * fresh (no KV access). The cache TTL bounds how long a branch-protection change
 * takes to apply on these paths. Throws if the read token can't be minted.
 */
async function loadMergePolicyCached(
  env: Env,
  project: ProjectEntry,
  logger: Logger,
): Promise<EvalPolicy> {
  const cacheable = env.REPO_DO_ENABLED === "true";
  const cached = cacheable ? policyCache.get(project.id) : undefined;
  if (cached && cached.expires > Date.now()) return cached.policy;
  let inflight = cacheable ? policyInflight.get(project.id) : undefined;
  if (!inflight) {
    inflight = (async () => {
      // Cross-isolate KV cache — avoids the repo clone on a cold isolate.
      if (cacheable) {
        const kvHit = await env.STATE.get<EvalPolicy>(policyKvKey(project.id), "json").catch(
          () => null,
        );
        if (kvHit) {
          policyCache.set(project.id, { policy: kvHit, expires: Date.now() + POLICY_CACHE_TTL_MS });
          return kvHit;
        }
      }
      const tok = await freshRepoToken(env.ARTIFACTS, project.remote, "read", logger);
      if (!tok.success) throw new Error(tok.error.message);
      const loaded = await loadPolicy(project.remote, tok.data, logger);
      if (cacheable) {
        policyCache.set(project.id, { policy: loaded, expires: Date.now() + POLICY_CACHE_TTL_MS });
        await env.STATE.put(policyKvKey(project.id), JSON.stringify(loaded), {
          expirationTtl: 60,
        }).catch(() => {});
      }
      return loaded;
    })();
    if (cacheable) {
      policyInflight.set(project.id, inflight);
      void inflight.finally(() => policyInflight.delete(project.id));
    }
  }
  return inflight;
}

function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/\s]+?)(?:\.git|\/)?$/i);
  if (!match || !match[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2] };
}

const MERGEABLE_STATUSES: Change["status"][] = ["approved", "accepted", "promoted"];

/**
 * Success response for endpoints that the change-detail UI posts to with plain HTML forms.
 * Browsers send a form content type; API/CLI/agent callers send JSON or no body at all,
 * so only form posts are redirected back to the change page.
 */
function okOrFormRedirect<T>(c: Context<{ Bindings: Env }>, changeId: string, data: T): Response {
  const contentType = c.req.header("content-type") ?? "";
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    return c.redirect(`/changes/${changeId}`, 302);
  }
  return ok(data);
}

/** Current project HEAD: cheap KV snapshot first, single-commit clone as fallback. */
async function resolveProjectHead(
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

/**
 * Resolve a workspace's current tip commit sha, or null if it can't be read.
 * Workspaces have no KV snapshot fast-path, so this clones the workspace remote.
 * Used to reject a merge whose workspace moved since it was evaluated (SEC-2).
 */
async function resolveWorkspaceTip(
  env: Env,
  workspaceRemote: string,
  logger: Logger,
): Promise<string | null> {
  const readToken = await freshRepoToken(env.ARTIFACTS, workspaceRemote, "read", logger);
  if (!readToken.success) return null;
  const logResult = await getCommitLog(workspaceRemote, readToken.data, logger, 1);
  return logResult.success ? (logResult.data[0]?.sha ?? null) : null;
}

class UnavailableEvaluator implements Evaluator {
  constructor(
    private evaluatorType: string,
    private reason: string,
  ) {}

  async evaluate(
    _diff: string,
    _policy: EvalPolicy,
    _logger: Logger,
  ): Promise<{ success: true; data: EvalResult } | { success: false; error: AppError }> {
    return okResult({
      score: 0,
      passed: false,
      reason: `${this.evaluatorType} unavailable: ${this.reason}`,
    });
  }
}

app.post("/projects/:name/changes", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentId = c.get("agentId");
  const agentOwnerId = c.get("agentOwnerId");
  if (!userId && !agentId) return unauthorized("Authentication required");

  const { name: projectName } = c.req.param();

  const projectResult = await getProject(c.env.STATE, projectName, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") {
      return notFound("Project", projectName);
    }
    logger.error("Failed to get project", projectResult.error);
    return badRequest(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!(await canWriteProject(c.env.DB, project, userId, agentOwnerId)))
    return forbidden("Project access denied");

  const body = await c.req.json<{ workspace?: unknown }>().catch(() => ({ workspace: undefined }));
  if (typeof body.workspace !== "string" || !body.workspace.trim()) {
    return badRequest("workspace is required");
  }

  const workspaceResult = await getWorkspace(c.env.STATE, project.id, body.workspace, logger);
  if (!workspaceResult.success) {
    if (workspaceResult.error.code === "NOT_FOUND") {
      return notFound("Workspace", body.workspace);
    }
    logger.error("Failed to get workspace", workspaceResult.error);
    return badRequest(workspaceResult.error.message);
  }
  const workspace = workspaceResult.data;

  // Workspaces created via the namespaced API store the project id in `parent`;
  // legacy workspaces stored the project name.
  if (workspace.parent !== project.id && workspace.parent !== projectName) {
    return badRequest(`Workspace '${body.workspace}' does not belong to project '${projectName}'`);
  }

  const baseSha = await resolveProjectHead(c.env, project, logger);

  // Snapshot the authoring agent's model + prompt hash at creation, so
  // provenance records the model that did the work rather than the agent's
  // current (possibly later-changed) registration.
  let agentModel: string | undefined;
  let agentPromptHash: string | undefined;
  if (agentId !== undefined) {
    const agentResult = await getAgent(c.env.DB, agentId, logger);
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

  const changeResult = await createChange(c.env.DB, logger, {
    project: projectName,
    workspace: body.workspace,
    ...(agentId !== undefined ? { agentId } : {}),
    ...(baseSha !== null ? { baseSha } : {}),
    ...(agentModel !== undefined ? { agentModel } : {}),
    ...(agentPromptHash !== undefined ? { agentPromptHash } : {}),
  });
  if (!changeResult.success) {
    logger.error("Failed to create change", changeResult.error);
    return badRequest(changeResult.error.message);
  }
  const change = changeResult.data;

  const actor: EventActor = agentId
    ? { type: "agent", id: agentId }
    : { type: "user", ...(userId !== undefined ? { id: userId } : {}) };

  await emitEvent(
    c.env.DB,
    c.env.EVENTS_QUEUE,
    {
      type: "change.created",
      project: projectName,
      changeId: change.id,
      workspace: body.workspace,
    },
    actor,
    logger,
  );

  const [projectReadToken, workspaceReadToken] = await Promise.all([
    freshRepoToken(c.env.ARTIFACTS, project.remote, "read", logger),
    freshRepoToken(c.env.ARTIFACTS, workspace.remote, "read", logger),
  ]);
  if (!projectReadToken.success) return internalError(projectReadToken.error.message);
  if (!workspaceReadToken.success) return internalError(workspaceReadToken.error.message);

  const policy = await loadPolicy(project.remote, projectReadToken.data, logger);

  const diffResult = await getDiffBetweenRepos(
    project.remote,
    projectReadToken.data,
    workspace.remote,
    workspaceReadToken.data,
    logger,
  );
  if (!diffResult.success) {
    logger.error("Failed to get diff between repos", diffResult.error);
    return badRequest(diffResult.error.message);
  }
  const { diff, workspaceOid: evaluatedSha, workspaceTreeOid: evaluatedTreeOid } = diffResult.data;

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
          if (c.env.AI) return [{ type: "llm", evaluator: new LLMEvaluator(c.env.AI) }];
          return [
            {
              type: "llm",
              evaluator: new UnavailableEvaluator("llm", "AI binding is not configured"),
            },
          ];
        case "sandbox":
          if (c.env.SANDBOX) {
            return [{ type: "sandbox", evaluator: new SandboxEvaluator(c.env.SANDBOX) }];
          }
          return [
            {
              type: "sandbox",
              evaluator: new UnavailableEvaluator("sandbox", "SANDBOX binding is not configured"),
            },
          ];
        default:
          logger.warn(
            `Unknown evaluator type "${(cfg as { type: string }).type}" in policy for project ${projectName}`,
            { evaluatorType: (cfg as { type: string }).type, projectName },
          );
          return [];
      }
    }),
  );

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

  const newStatus: Change["status"] = evalResult.passed ? "accepted" : "needs_changes";

  const recordResult = await recordEvalRuns(c.env.DB, logger, change.id, evalRuns);
  if (!recordResult.success) {
    logger.error("Failed to record eval runs", recordResult.error);
    return badRequest(recordResult.error.message);
  }

  // Best-effort cost tracking: the diff clones both repos, evaluators self-report.
  const createCostSamples: CostSample[] = [
    { kind: "git_ops", quantity: 2 },
    ...evalRuns.flatMap(({ result }) => result.costs ?? []),
  ];
  await recordCosts(
    c.env.DB,
    logger,
    { project: projectName, changeId: change.id, workspace: body.workspace },
    createCostSamples,
  );

  const updateResult = await updateChangeStatus(c.env.DB, logger, change.id, newStatus, {
    evalScore: evalResult.score,
    evalPassed: evalResult.passed,
    evalReason: evalResult.reason,
    evaluatedSha,
    evaluatedTreeOid,
  });
  if (!updateResult.success) {
    logger.error("Failed to update change status", updateResult.error);
    return badRequest(updateResult.error.message);
  }

  await emitEvent(
    c.env.DB,
    c.env.EVENTS_QUEUE,
    {
      type: "change.evaluated",
      project: projectName,
      changeId: change.id,
      score: evalResult.score,
      passed: evalResult.passed,
    },
    { type: "system" },
    logger,
  );

  const updatedChange: Change = {
    ...change,
    status: newStatus,
    evalScore: evalResult.score,
    evalPassed: evalResult.passed,
    evalReason: evalResult.reason,
    evaluatedSha,
    evaluatedTreeOid,
  };

  logger.info("Change created and evaluated", {
    changeId: change.id,
    project: projectName,
    workspace: body.workspace,
    status: newStatus,
    evalScore: evalResult.score,
  });
  return created({ change: updatedChange, eval: evalResult, evalRuns: recordResult.data });
});

app.get("/projects/:name/changes", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { name: projectName } = c.req.param();

  const projectResult = await getProject(c.env.STATE, projectName, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") {
      return notFound("Project", projectName);
    }
    logger.error("Failed to get project", projectResult.error);
    return badRequest(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId)))
    return notFound("Project", `${project.namespace}/${project.slug}`);

  const statusParam = c.req.query("status");
  const validStatuses: Change["status"][] = [
    "open",
    "needs_changes",
    "accepted",
    "approved",
    "promoted",
    "merged",
    "rejected",
  ];
  const status =
    statusParam && (validStatuses as string[]).includes(statusParam)
      ? (statusParam as Change["status"])
      : undefined;

  const changesResult = await listChanges(c.env.DB, logger, projectName, status);
  if (!changesResult.success) {
    logger.error("Failed to list changes", changesResult.error);
    return badRequest(changesResult.error.message);
  }

  logger.info("Changes listed", { project: projectName, status, count: changesResult.data.length });
  return ok({ project: projectName, changes: changesResult.data });
});

app.get("/changes/:id", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { id } = c.req.param();

  const changeResult = await getChange(c.env.DB, logger, id);
  if (!changeResult.success) {
    if (changeResult.error.code === "NOT_FOUND") {
      return notFound("Change", id);
    }
    logger.error("Failed to get change", changeResult.error);
    return badRequest(changeResult.error.message);
  }
  const change = changeResult.data;

  const projectResult = await getProject(c.env.STATE, change.project, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") {
      return notFound("Project", change.project);
    }
    logger.error("Failed to get project", projectResult.error);
    return badRequest(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId)))
    return notFound("Project", `${project.namespace}/${project.slug}`);

  const evalRunsResult = await listEvalRuns(c.env.DB, logger, id);
  if (!evalRunsResult.success) {
    logger.error("Failed to list eval runs", evalRunsResult.error);
    return badRequest(evalRunsResult.error.message);
  }

  const costsResult = await getChangeCostSummary(c.env.DB, logger, id);

  logger.info("Change retrieved", { changeId: id });
  return ok({
    change,
    evalRuns: evalRunsResult.data,
    costs: costsResult.success ? costsResult.data : [],
  });
});

app.post("/changes/:id/merge", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  if (!userId) return unauthorized("Only authenticated users can trigger merges directly");

  const { id } = c.req.param();
  const force = c.req.query("force") === "true";
  const strategyParam = c.req.query("strategy");
  const strategy = strategyParam === "squash" ? "squash" : "merge";
  if (strategyParam !== undefined && strategyParam !== "squash" && strategyParam !== "merge") {
    return badRequest("strategy must be 'merge' or 'squash'");
  }

  const changeResult = await getChange(c.env.DB, logger, id);
  if (!changeResult.success) {
    if (changeResult.error.code === "NOT_FOUND") {
      return notFound("Change", id);
    }
    logger.error("Failed to get change", changeResult.error);
    return badRequest(changeResult.error.message);
  }
  const change = changeResult.data;

  const projectResult = await getProject(c.env.STATE, change.project, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") {
      return notFound("Project", change.project);
    }
    logger.error("Failed to get project", projectResult.error);
    return badRequest(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!(await canWriteProject(c.env.DB, project, userId)))
    return forbidden("Project access denied");

  // Branch protection: the policy's merge rules gate every merge path. Cached +
  // coalesced so a swarm of merges doesn't each clone the repo for the policy file.
  let mergePolicy: EvalPolicy;
  try {
    mergePolicy = await loadMergePolicyCached(c.env, project, logger);
  } catch (e) {
    return internalError(e instanceof Error ? e.message : "Failed to load policy");
  }
  // Force merge is deny-by-default: it bypasses every evaluation and approval
  // gate, so a new repo with no policy file must be safe. Opt in explicitly
  // with `merge.allowForce: true`.
  const forceAllowed = mergePolicy.merge?.allowForce === true;
  if (force && !forceAllowed) {
    return badRequest("Force merge is disabled by this project's policy");
  }

  if (!MERGEABLE_STATUSES.includes(change.status) && !force) {
    return badRequest("Change must be approved, accepted, or promoted before merging");
  }

  if (!force) {
    const protectionResult = await checkMergeProtection(c.env.DB, logger, change, mergePolicy);
    if (!protectionResult.success) {
      logger.error("Failed to evaluate merge protection", protectionResult.error);
      return badRequest(protectionResult.error.message);
    }
    if (!protectionResult.data.allowed) {
      return c.json(
        {
          error: "Merge blocked by branch protection",
          code: "PROTECTION_BLOCKED",
          reasons: protectionResult.data.reasons,
        },
        403,
      );
    }

    if (mergePolicy.merge?.requireFreshBase && change.baseSha !== undefined) {
      const currentHead = await resolveProjectHead(c.env, project, logger);
      if (currentHead !== null && currentHead !== change.baseSha) {
        return c.json(
          {
            error: "Change base is stale: the project advanced since this change was evaluated",
            code: "STALE_BASE",
            baseSha: change.baseSha,
            currentHead,
          },
          409,
        );
      }
    }

    // SEC-2: the evaluation gate is only meaningful if the code merged is the
    // code that was evaluated. Reject if the workspace tip moved since the
    // change was evaluated. Runs for every merge backend (this block is shared,
    // before the RepoDO/MergeQueue/cold branch). Legacy changes with no
    // evaluatedSha (created before migration 024) skip the check.
    //
    // Fail CLOSED: if we can't resolve the current workspace tip, we can't prove
    // the code is unchanged since eval, so we block rather than merge. The R2/DO
    // backends merge a staged tree without a live clone, so a silently-skipped
    // check here would be a real bypass.
    if (change.evaluatedSha !== undefined) {
      const workspaceResult = await getWorkspace(c.env.STATE, project.id, change.workspace, logger);
      const currentTip = workspaceResult.success
        ? await resolveWorkspaceTip(c.env, workspaceResult.data.remote, logger)
        : null;
      if (currentTip === null) {
        logger.warn("Could not verify workspace freshness for merge", {
          changeId: id,
          workspace: change.workspace,
        });
        return c.json(
          {
            error:
              "Could not verify the workspace is unchanged since evaluation. Try again, or re-evaluate.",
            code: "WORKSPACE_UNVERIFIABLE",
          },
          409,
        );
      }
      if (currentTip !== change.evaluatedSha) {
        return c.json(
          {
            error:
              "Workspace is stale: it advanced since this change was evaluated. Re-evaluate before merging.",
            code: "STALE_WORKSPACE",
            evaluatedSha: change.evaluatedSha,
            currentTip,
          },
          409,
        );
      }
    }
  }

  // Route serialized merges through a per-repo Durable Object. When REPO_DO_ENABLED
  // is set, use the RepoDO ref authority (fast-forward fast path, ADR 004 Phase 1);
  // otherwise the classic MergeQueue cold path. Both share the post-merge tail below.
  // RepoDO is keyed by the canonical project.id so one repo maps to exactly one DO
  // (change.project may be a name OR id depending on the creating path, which would
  // otherwise split a repo's ref cache across DOs).
  const useRepoDo = c.env.REPO_DO_ENABLED === "true" && c.env.REPO_DO !== undefined;
  if ((useRepoDo || c.env.MERGE_QUEUE) && strategy === "merge") {
    let result: MergeOutcome;
    if (useRepoDo && c.env.REPO_DO) {
      const stub = c.env.REPO_DO.get(c.env.REPO_DO.idFromName(project.id)) as unknown as {
        mergeViaR2(changeId: string): Promise<MergeOutcome | { fallback: true }>;
        advance(changeId: string): Promise<MergeOutcome>;
      };
      // Prefer the R2 fetch-free path; fall back to the Phase-1 FF/cold path when the
      // change has no staged tree (e.g. committed before R2 staging was enabled).
      const r2 = await stub.mergeViaR2(id);
      result = "fallback" in r2 ? await stub.advance(id) : r2;
    } else {
      // biome-ignore lint/style/noNonNullAssertion: guarded by the if condition
      const queue = c.env.MERGE_QUEUE!;
      const stub = queue.get(queue.idFromName(change.project));
      result = await (stub as unknown as { merge(changeId: string): Promise<MergeOutcome> }).merge(
        id,
      );
    }

    if (!result.success) {
      // Preserve the structured 409 for a stale workspace (matches the cold path),
      // rather than flattening every queue-path failure to a generic 400.
      if (result.code === "STALE_WORKSPACE") {
        return c.json({ error: result.error ?? "Workspace changed", code: "STALE_WORKSPACE" }, 409);
      }
      return badRequest(result.error ?? "Merge failed");
    }

    await emitEvent(
      c.env.DB,
      c.env.EVENTS_QUEUE,
      { type: "change.merged", project: change.project, changeId: id, commit: result.commit ?? "" },
      { type: "user", id: userId },
      logger,
    );

    logger.info("Change merged via queue", {
      changeId: id,
      project: change.project,
      commit: result.commit,
      via: useRepoDo ? "repo-do" : "merge-queue",
    });

    if (force) {
      await recordAudit(c.env.DB, logger, {
        action: "merge.forced",
        actorType: "user",
        actorId: userId,
        subject: id,
        detail: { project: change.project },
      });
    }

    const postMergeViaQueue = result.commit
      ? await runPostMergeCheck(
          c.env,
          project,
          { changeId: id, mergeCommit: result.commit, policy: mergePolicy },
          logger,
        )
      : { status: "skipped" as const };

    return okOrFormRedirect(c, id, {
      merged: true,
      changeId: id,
      project: change.project,
      workspace: change.workspace,
      commit: result.commit,
      postMerge: postMergeViaQueue,
    });
  }

  const workspaceResult = await getWorkspace(c.env.STATE, project.id, change.workspace, logger);
  if (!workspaceResult.success) {
    if (workspaceResult.error.code === "NOT_FOUND") {
      return notFound("Workspace", change.workspace);
    }
    logger.error("Failed to get workspace", workspaceResult.error);
    return badRequest(workspaceResult.error.message);
  }
  const workspace = workspaceResult.data;

  // Merge clones the workspace fork (read) and pushes to the project (write).
  const [projectMergeToken, workspaceMergeToken] = await Promise.all([
    freshRepoToken(c.env.ARTIFACTS, project.remote, "write", logger),
    freshRepoToken(c.env.ARTIFACTS, workspace.remote, "read", logger),
  ]);
  if (!projectMergeToken.success) return internalError(projectMergeToken.error.message);
  if (!workspaceMergeToken.success) return internalError(workspaceMergeToken.error.message);

  const mergeResult = await mergeWorkspaceIntoProject(
    project.remote,
    projectMergeToken.data,
    workspace.remote,
    workspaceMergeToken.data,
    logger,
    {
      strategy,
      // SEC-2: the cold path merges the freshly-fetched tip, so pin it to the
      // evaluated sha (content-address check, applies even under force). Legacy
      // changes with no evaluatedSha skip it.
      ...(change.evaluatedSha !== undefined ? { expectedWorkspaceSha: change.evaluatedSha } : {}),
    },
  );
  if (!mergeResult.success) {
    if (mergeResult.error instanceof MergeConflictError) {
      const conflictId = crypto.randomUUID();
      await c.env.STATE.put(
        `conflict:${conflictId}`,
        JSON.stringify({
          conflictId,
          namespace: project.namespace,
          slug: project.slug,
          workspaceName: change.workspace,
          conflictingFiles: mergeResult.error.conflictingFiles,
          detectedAt: new Date().toISOString(),
        }),
        { expirationTtl: 7 * 24 * 60 * 60 },
      );
      logger.info("Merge conflict detected, wrote conflict context", {
        conflictId,
        changeId: id,
        conflictingFiles: mergeResult.error.conflictingFiles,
      });
      return c.json(
        {
          error: "Merge conflict",
          code: "MERGE_CONFLICT",
          conflictId,
          conflictingFiles: mergeResult.error.conflictingFiles,
          message: mergeResult.error.message,
        },
        409,
      );
    }
    if (mergeResult.error.code === "STALE_WORKSPACE") {
      return c.json({ error: mergeResult.error.message, code: "STALE_WORKSPACE" }, 409);
    }
    logger.error("Failed to merge workspace into project", mergeResult.error);
    return badRequest(mergeResult.error.message);
  }
  const commit = mergeResult.data;

  const mergedAt = new Date().toISOString();
  const updateResult = await updateChangeStatus(c.env.DB, logger, id, "merged", {
    ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
    ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
    ...(change.evalReason !== undefined ? { evalReason: change.evalReason } : {}),
    mergedAt,
  });
  if (!updateResult.success) {
    logger.error("Failed to update change status to merged", updateResult.error);
    return badRequest(updateResult.error.message);
  }

  await recordCosts(
    c.env.DB,
    logger,
    { project: change.project, changeId: id, workspace: change.workspace },
    [{ kind: "git_ops", quantity: 2 }],
  );

  const provenanceResult = await recordProvenance(c.env.DB, logger, {
    commitSha: commit,
    project: change.project,
    workspace: change.workspace,
    changeId: id,
    ...(change.agentId !== undefined ? { agentId: change.agentId } : {}),
    ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
    ...(change.agentModel !== undefined ? { model: change.agentModel } : {}),
    ...(change.agentPromptHash !== undefined ? { promptHash: change.agentPromptHash } : {}),
  });
  if (!provenanceResult.success) {
    logger.error("Failed to record provenance", provenanceResult.error);
    // Don't fail the request if provenance recording fails
  }

  await emitEvent(
    c.env.DB,
    c.env.EVENTS_QUEUE,
    { type: "change.merged", project: change.project, changeId: id, commit },
    { type: "user", id: userId },
    logger,
  );

  logger.info("Change merged", {
    changeId: id,
    project: change.project,
    workspace: change.workspace,
    commit,
  });

  if (force) {
    await recordAudit(c.env.DB, logger, {
      action: "merge.forced",
      actorType: "user",
      actorId: userId,
      subject: id,
      detail: { project: change.project },
    });
  }

  const postMerge = await runPostMergeCheck(
    c.env,
    project,
    { changeId: id, mergeCommit: commit, policy: mergePolicy },
    logger,
  );

  return okOrFormRedirect(c, id, {
    merged: true,
    changeId: id,
    project: change.project,
    workspace: change.workspace,
    commit,
    postMerge,
  });
});

// POST /api/projects/:name/changes/merge-batch — merge MANY changes into one repo
// in a single request (ADR 004). Per-request merge RPCs serialize at the Durable
// Object (~one at a time), so the way to realize the group-commit throughput
// (proven ~31 c/s) is to batch server-side: clone once, 3-way merge each staged
// change onto the head, ONE push. Body: { changeIds: string[] }.
app.post("/projects/:name/changes/merge-batch", async (c) => {
  const tStart = Date.now();
  const logger = createLogger({ requestId: crypto.randomUUID(), userId: c.get("userId") });
  const userId = c.get("userId");
  if (!userId) return unauthorized("Authentication required");

  const { name: projectName } = c.req.param();
  const projectResult = await getProject(c.env.STATE, projectName, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") return notFound("Project", projectName);
    logger.error("Failed to get project", projectResult.error);
    return internalError(projectResult.error.message);
  }
  const project = projectResult.data;
  if (!(await canWriteProject(c.env.DB, project, userId)))
    return forbidden("Project access denied");

  const body = await c.req
    .json<{ changeIds?: unknown; force?: unknown }>()
    .catch(() => ({ changeIds: undefined, force: undefined }));
  if (!Array.isArray(body.changeIds) || body.changeIds.length === 0) {
    return badRequest("changeIds (non-empty array) is required");
  }
  const force = body.force === true;

  // Branch-protection gate (same as the single-merge path; the batch path must not
  // be a bypass). The policy + current-head reads are independent of the staged-tree
  // resolve, so load them in PARALLEL with it — the policy-file read doesn't add
  // serial latency to the hot path. Marked handled to avoid an unhandled rejection
  // on an early return; the real awaits below surface failures.
  const policyPromise = loadMergePolicyCached(c.env, project, logger);
  void policyPromise.catch(() => {});
  const headPromise: Promise<string | null> = force
    ? Promise.resolve(null)
    : resolveProjectHead(c.env, project, logger);
  // Dedupe: a repeated id would otherwise merge twice and write two provenance rows.
  const changeIds = [
    ...new Set(body.changeIds.filter((id): id is string => typeof id === "string")),
  ];
  // Bound the per-request batch: very large N risks the Worker CPU/time limit in the
  // single-FS merge loop. Callers should chunk above this; throughput is already
  // maximized well under it (~27-30 c/s server-side at N=40-64).
  const MAX_MERGE_BATCH = 80;
  if (changeIds.length > MAX_MERGE_BATCH) {
    return badRequest(`merge-batch accepts at most ${MAX_MERGE_BATCH} changes per request`);
  }

  // Resolve every change in ONE D1 query and policy-gate it here; the MERGE runs in
  // the per-repo Durable Object, which reads staged trees from its LOCAL SQLite hot
  // index (microseconds) instead of a per-change R2 GET, on a warm reused clone.
  const tResolve = Date.now();
  const skipped: { changeId: string; reason: string }[] = [];
  const changeById = new Map<string, Change>();
  const mergeItems: { changeId: string; workspace: string; baseSha: string }[] = [];
  const changesResult = await getChangesByIds(c.env.DB, logger, changeIds);
  if (!changesResult.success) return internalError(changesResult.error.message);
  const changeMap = new Map(changesResult.data.map((ch) => [ch.id, ch]));
  const resolved = await Promise.all(
    changeIds.map(async (id) => {
      const change = changeMap.get(id);
      if (!change) return { id, skip: "not found" };
      if (change.project !== projectName && change.project !== project.id)
        return { id, skip: "wrong project" };
      if (!MERGEABLE_STATUSES.includes(change.status)) return { id, skip: "not mergeable" };
      if (!change.baseSha) return { id, skip: "no base" };
      if (!force) {
        let mergePolicy: EvalPolicy;
        try {
          mergePolicy = await policyPromise;
        } catch {
          return { id, skip: "policy load failed" };
        }
        const protection = await checkMergeProtection(c.env.DB, logger, change, mergePolicy);
        if (!protection.success) return { id, skip: "protection check failed" };
        if (!protection.data.allowed) return { id, skip: "blocked by branch protection" };
        if (mergePolicy.merge?.requireFreshBase === true) {
          const currentHead = await headPromise;
          if (currentHead !== null && change.baseSha !== currentHead) {
            return { id, skip: "stale base" };
          }
        }
      }
      return { id, change };
    }),
  );
  // SEC-2 for the batch path: reject any change whose workspace advanced since
  // it was evaluated. Resolving a workspace tip clones the workspace remote, so
  // dedupe by distinct workspace. Skipped when forcing or for legacy changes
  // with no evaluatedSha.
  const staleWorkspaceSkips = new Map<string, string>();
  if (!force) {
    const candidates = resolved
      .filter((r): r is { id: string; change: Change } => "change" in r && Boolean(r.change))
      .map((r) => r.change)
      .filter((ch) => ch.evaluatedSha !== undefined);
    const distinctWorkspaces = [...new Set(candidates.map((ch) => ch.workspace))];
    const tipByWorkspace = new Map<string, string | null>();
    await Promise.all(
      distinctWorkspaces.map(async (ws) => {
        const wsResult = await getWorkspace(c.env.STATE, project.id, ws, logger);
        const tip = wsResult.success
          ? await resolveWorkspaceTip(c.env, wsResult.data.remote, logger)
          : null;
        tipByWorkspace.set(ws, tip);
      }),
    );
    for (const ch of candidates) {
      const tip = tipByWorkspace.get(ch.workspace) ?? null;
      // Fail closed: a change whose workspace tip we can't resolve (null) can't be
      // proven unchanged since eval, so skip it rather than merge it.
      if (tip === null) {
        staleWorkspaceSkips.set(ch.id, "workspace unverifiable");
      } else if (tip !== ch.evaluatedSha) {
        staleWorkspaceSkips.set(ch.id, "stale workspace");
      }
    }
  }

  for (const r of resolved) {
    if ("skip" in r && r.skip) {
      skipped.push({ changeId: r.id, reason: r.skip });
    } else if ("change" in r && r.change && r.change.baseSha) {
      const staleReason = staleWorkspaceSkips.get(r.id);
      if (staleReason) {
        skipped.push({ changeId: r.id, reason: staleReason });
        continue;
      }
      changeById.set(r.id, r.change);
      mergeItems.push({ changeId: r.id, workspace: r.change.workspace, baseSha: r.change.baseSha });
    }
  }

  // Enforce the force-allowed policy (loaded in parallel above). Deny-by-default:
  // force is only permitted when the policy explicitly sets allowForce: true.
  if (force) {
    let mergePolicy: EvalPolicy;
    try {
      mergePolicy = await policyPromise;
    } catch (e) {
      return internalError(e instanceof Error ? e.message : "Failed to load policy");
    }
    if (mergePolicy.merge?.allowForce !== true) {
      return badRequest("Force merge is disabled by this project's policy");
    }
  }

  if (mergeItems.length === 0) {
    return badRequest(`No eligible changes to merge (${skipped.length} skipped)`);
  }
  const resolveMs = Date.now() - tResolve;

  // Merge inside the per-repo DO: local SQLite hot-index reads + warm reused clone +
  // one push. Keyed by project.id (same key the commit route seeds the index under).
  if (!c.env.REPO_DO) return internalError("RepoDO not bound");
  const stub = c.env.REPO_DO.get(c.env.REPO_DO.idFromName(project.id)) as unknown as {
    getStagedTrees(workspaces: string[]): Promise<{ workspace: string; value: Uint8Array }[]>;
    gcStagedTrees(workspaces: string[]): Promise<void>;
  };

  const tBatch = Date.now();
  // Clone in the Worker (the merge runs faster here than inside the DO), overlapped
  // with the SINGLE SQLite hot-index read that replaces N per-change R2 GETs.
  const clonePromise = (async () => {
    const token = await freshRepoToken(c.env.ARTIFACTS, project.remote, "write", logger);
    if (!token.success) throw new Error(token.error.message);
    const cloned = await cloneRepo(project.remote, token.data, logger);
    if (!cloned.success) throw new Error(cloned.error.message);
    return { token: token.data, fs: cloned.data.fs, dir: cloned.data.dir };
  })();

  const workspaces = [...new Set(mergeItems.map((m) => m.workspace))];
  let stagedList: { workspace: string; value: Uint8Array }[];
  try {
    stagedList = await stub.getStagedTrees(workspaces);
  } catch (e) {
    clonePromise.catch(() => {});
    return internalError(e instanceof Error ? e.message : "Failed to read staged trees");
  }
  const stagedByWs = new Map(stagedList.map((s) => [s.workspace, s.value]));
  const items: StagedTreeItem[] = [];
  for (const m of mergeItems) {
    const value = stagedByWs.get(m.workspace);
    if (!value) {
      skipped.push({ changeId: m.changeId, reason: "not staged" });
      continue;
    }
    let staged: ReturnType<typeof parseStagedTree>;
    try {
      staged = parseStagedTree(value);
    } catch (e) {
      // One malformed/truncated staged tree must not 500 the whole batch — skip it.
      logger.error(
        "Failed to parse staged tree in merge-batch",
        e instanceof Error ? e : undefined,
        { changeId: m.changeId },
      );
      skipped.push({ changeId: m.changeId, reason: "corrupt staged tree" });
      continue;
    }
    // SEC-2: content-address the staged tree against the evaluated revision, so a
    // workspace re-committed between the pre-merge freshness check and this read
    // can't land unevaluated code. Unconditional (even under force): it is a cheap,
    // network-free integrity check, and recording eval evidence for a tree that
    // was never evaluated would corrupt provenance. Only changes that were
    // actually evaluated carry evaluatedTreeOid; the rest skip it.
    const evaluatedTreeOid = changeById.get(m.changeId)?.evaluatedTreeOid;
    if (evaluatedTreeOid !== undefined && staged.treeOid !== evaluatedTreeOid) {
      skipped.push({ changeId: m.changeId, reason: "workspace changed since evaluation" });
      continue;
    }
    items.push({ changeId: m.changeId, baseSha: m.baseSha, staged });
  }
  if (items.length === 0) {
    clonePromise.catch(() => {});
    return badRequest(`No eligible changes to merge (${skipped.length} skipped)`);
  }

  let cloneData: { token: string; fs: NodeFS; dir: string };
  try {
    cloneData = await clonePromise;
  } catch (e) {
    return internalError(e instanceof Error ? e.message : "Failed to prepare repo");
  }
  const mergeResult = await batchMergeStagedTrees(
    cloneData.fs,
    cloneData.dir,
    project.remote,
    cloneData.token,
    items,
    logger,
  );
  if (!mergeResult.success) return internalError(mergeResult.error.message);
  const batchMs = Date.now() - tBatch;

  // Bookkeeping after a durable push (deferred): status + provenance, and GC both the
  // SQLite hot index (DO) and the R2 mirror of the staged tree.
  const tPersist = Date.now();
  const merged: string[] = [];
  const conflicted: string[] = [];
  const landed: { changeId: string; commit: string; change: Change | undefined }[] = [];
  const gcKeys: string[] = [];
  const mergedWorkspaces: string[] = [];
  for (const r of mergeResult.data) {
    if (!r.merged || !r.commit) {
      conflicted.push(r.changeId);
      continue;
    }
    const change = changeById.get(r.changeId);
    landed.push({ changeId: r.changeId, commit: r.commit, change });
    gcKeys.push(`repos/${project.id}/ws/${change?.workspace}`);
    if (change?.workspace) mergedWorkspaces.push(change.workspace);
    merged.push(r.changeId);
  }
  const mergedAt = new Date().toISOString();
  // D1 caps bound parameters at 100/statement: chunk so UPDATE (1 + ids) and the
  // multi-row INSERT stay under it. All chunks ride one batch().
  const UPDATE_CHUNK = 99;
  const PROVENANCE_BINDS_PER_ROW = 10;
  // Leave headroom below D1's 100-param cap rather than sitting exactly on it.
  const INSERT_CHUNK = Math.floor(90 / PROVENANCE_BINDS_PER_ROW);
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < landed.length; i += UPDATE_CHUNK) {
    const chunk = landed.slice(i, i + UPDATE_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    statements.push(
      c.env.DB.prepare(
        `UPDATE changes SET status = 'merged', merged_at = ? WHERE id IN (${placeholders})`,
      ).bind(mergedAt, ...chunk.map((l) => l.changeId)),
    );
  }
  for (let i = 0; i < landed.length; i += INSERT_CHUNK) {
    const chunk = landed.slice(i, i + INSERT_CHUNK);
    const rows = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const binds = chunk.flatMap((l) => [
      newId("prv"),
      l.commit,
      projectName,
      l.change?.workspace ?? "",
      l.changeId,
      l.change?.agentId ?? null,
      l.change?.evalScore ?? null,
      l.change?.agentModel ?? null,
      l.change?.agentPromptHash ?? null,
      mergedAt,
    ]);
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO provenance (id, commit_sha, project, workspace, change_id, agent_id, eval_score, model, prompt_hash, merged_at) VALUES ${rows}`,
      ).bind(...binds),
    );
  }

  const persist = (async () => {
    if (statements.length > 0) await c.env.DB.batch(statements);
    // Force-merges bypass evaluation/approval gates, so every one must leave an
    // audit trail — the single-merge path records `merge.forced` too (SEC-2).
    if (force) {
      for (const changeId of merged) {
        await recordAudit(c.env.DB, logger, {
          action: "merge.forced",
          actorType: "user",
          actorId: userId,
          subject: changeId,
          detail: { project: projectName, batch: true },
        });
      }
    }
    await stub.gcStagedTrees(mergedWorkspaces).catch(() => {});
    const objects = c.env.REPO_OBJECTS;
    if (objects) await Promise.all(gcKeys.map((k) => objects.delete(k).catch(() => {})));
  })();
  if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(persist);
  else await persist;

  return ok({
    merged,
    conflicted,
    skipped,
    timings: {
      resolveMs,
      batchMs,
      persistMs: Date.now() - tPersist,
      serverMs: Date.now() - tStart,
    },
  });
});

app.post("/changes/:id/reject", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  if (!userId) return unauthorized("Only authenticated users can reject changes");

  const { id } = c.req.param();

  const changeResult = await getChange(c.env.DB, logger, id);
  if (!changeResult.success) {
    if (changeResult.error.code === "NOT_FOUND") {
      return notFound("Change", id);
    }
    logger.error("Failed to get change", changeResult.error);
    return badRequest(changeResult.error.message);
  }
  const change = changeResult.data;

  const projectResult = await getProject(c.env.STATE, change.project, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") {
      return notFound("Project", change.project);
    }
    logger.error("Failed to get project", projectResult.error);
    return badRequest(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!(await canWriteProject(c.env.DB, project, userId)))
    return forbidden("Project access denied");

  if (change.status === "merged") {
    return badRequest("Cannot reject a merged change");
  }

  const updateResult = await updateChangeStatus(c.env.DB, logger, id, "rejected", {
    ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
    ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
    ...(change.evalReason !== undefined ? { evalReason: change.evalReason } : {}),
  });
  if (!updateResult.success) {
    logger.error("Failed to update change status to rejected", updateResult.error);
    return badRequest(updateResult.error.message);
  }

  await emitEvent(
    c.env.DB,
    c.env.EVENTS_QUEUE,
    { type: "change.rejected", project: change.project, changeId: id },
    { type: "user", id: userId },
    logger,
  );

  logger.info("Change rejected", { changeId: id, project: change.project });
  return okOrFormRedirect(c, id, { rejected: true, changeId: id });
});

app.post("/changes/:id/evaluate", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  if (!userId) return unauthorized("Only authenticated users can run evaluations");

  const { id } = c.req.param();

  const changeResult = await getChange(c.env.DB, logger, id);
  if (!changeResult.success) {
    if (changeResult.error.code === "NOT_FOUND") {
      return notFound("Change", id);
    }
    logger.error("Failed to get change", changeResult.error);
    return badRequest(changeResult.error.message);
  }
  const change = changeResult.data;

  const projectResult = await getProject(c.env.STATE, change.project, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") {
      return notFound("Project", change.project);
    }
    logger.error("Failed to get project", projectResult.error);
    return badRequest(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!(await canWriteProject(c.env.DB, project, userId)))
    return forbidden("Project access denied");

  if (change.status === "merged" || change.status === "rejected" || change.status === "promoted") {
    return badRequest(`Cannot re-evaluate a ${change.status} change`);
  }

  const workspaceResult = await getWorkspace(c.env.STATE, project.id, change.workspace, logger);
  if (!workspaceResult.success) {
    if (workspaceResult.error.code === "NOT_FOUND") {
      return badRequest("Change references missing project/workspace");
    }
    logger.error("Failed to get workspace", workspaceResult.error);
    return badRequest(workspaceResult.error.message);
  }
  const workspace = workspaceResult.data;

  const [projectReadToken, workspaceReadToken] = await Promise.all([
    freshRepoToken(c.env.ARTIFACTS, project.remote, "read", logger),
    freshRepoToken(c.env.ARTIFACTS, workspace.remote, "read", logger),
  ]);
  if (!projectReadToken.success) return internalError(projectReadToken.error.message);
  if (!workspaceReadToken.success) return internalError(workspaceReadToken.error.message);

  const policy = await loadPolicy(project.remote, projectReadToken.data, logger);

  const diffResult = await getDiffBetweenRepos(
    project.remote,
    projectReadToken.data,
    workspace.remote,
    workspaceReadToken.data,
    logger,
  );
  if (!diffResult.success) {
    logger.error("Failed to get diff between repos", diffResult.error);
    return badRequest(diffResult.error.message);
  }
  const { diff, workspaceOid: evaluatedSha, workspaceTreeOid: evaluatedTreeOid } = diffResult.data;

  const evaluators: Array<{ type: string; evaluator: Evaluator }> = [
    { type: "secret_scan", evaluator: new SecretScanEvaluator() },
    ...policy.evaluators.flatMap((cfg): Array<{ type: string; evaluator: Evaluator }> => {
      switch (cfg.type) {
        case "diff":
          return [{ type: "diff", evaluator: new DiffEvaluator() }];
        case "webhook":
          return [{ type: "webhook", evaluator: new WebhookEvaluator() }];
        case "llm":
          return c.env.AI
            ? [{ type: "llm", evaluator: new LLMEvaluator(c.env.AI) }]
            : [
                {
                  type: "llm",
                  evaluator: new UnavailableEvaluator("llm", "AI binding is not configured"),
                },
              ];
        case "sandbox":
          return c.env.SANDBOX
            ? [{ type: "sandbox", evaluator: new SandboxEvaluator(c.env.SANDBOX) }]
            : [
                {
                  type: "sandbox",
                  evaluator: new UnavailableEvaluator(
                    "sandbox",
                    "SANDBOX binding is not configured",
                  ),
                },
              ];
        default:
          return [];
      }
    }),
  ];

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

  const recordResult = await recordEvalRuns(c.env.DB, logger, id, evalRuns);
  if (!recordResult.success) {
    logger.error("Failed to record eval runs", recordResult.error);
    return badRequest(recordResult.error.message);
  }

  const evaluateCostSamples: CostSample[] = [
    { kind: "git_ops", quantity: 2 },
    ...evalRuns.flatMap(({ result }) => result.costs ?? []),
  ];
  await recordCosts(
    c.env.DB,
    logger,
    { project: change.project, changeId: id, workspace: change.workspace },
    evaluateCostSamples,
  );

  const updateResult = await updateChangeStatus(
    c.env.DB,
    logger,
    id,
    evalResult.passed ? "accepted" : "needs_changes",
    {
      evalScore: evalResult.score,
      evalPassed: evalResult.passed,
      evalReason: evalResult.reason,
      evaluatedSha,
      evaluatedTreeOid,
    },
  );
  if (!updateResult.success) {
    logger.error("Failed to update change status", updateResult.error);
    return badRequest(updateResult.error.message);
  }

  logger.info("Change re-evaluated", {
    changeId: id,
    evalScore: evalResult.score,
    passed: evalResult.passed,
  });
  return okOrFormRedirect(c, id, { changeId: id, eval: evalResult, evalRuns: recordResult.data });
});

app.post("/changes/:id/github-pr", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  if (!userId) return unauthorized("Authentication required");

  const { id } = c.req.param();

  const changeResult = await getChange(c.env.DB, logger, id);
  if (!changeResult.success) {
    if (changeResult.error.code === "NOT_FOUND") {
      return notFound("Change", id);
    }
    logger.error("Failed to get change", changeResult.error);
    return badRequest(changeResult.error.message);
  }
  const change = changeResult.data;

  if (change.status !== "accepted" && change.status !== "promoted") {
    return badRequest("Change must be accepted before promotion");
  }

  const projectResult = await getProject(c.env.STATE, change.project, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") {
      return notFound("Project", change.project);
    }
    logger.error("Failed to get project", projectResult.error);
    return badRequest(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!(await canWriteProject(c.env.DB, project, userId)))
    return forbidden("Project access denied");
  if (!project?.githubUrl) return badRequest("Project is not connected to GitHub");

  const repo = parseGitHubRepo(project.githubUrl);
  if (!repo) return badRequest("Project githubUrl is invalid");

  const body = await c.req
    .json<{ title?: string; body?: string; base?: string; draft?: boolean }>()
    .catch(() => ({}) as { title?: string; body?: string; base?: string; draft?: boolean });

  // GitHub PR creation needs a GitHub credential — the Artifacts repo token (now
  // never persisted) was never valid here. Use the app's configured GitHub token.
  const githubToken = c.env.GITHUB_TOKEN;
  if (!githubToken) return badRequest("GitHub integration is not configured");

  const branch = `stratum/${change.id}`;
  const prBody =
    `## Stratum review\n\n- Change: \`${change.id}\`\n- Workspace: \`${change.workspace}\`\n- Evaluation: ${change.evalPassed ? "passed" : "failed"}, score ${change.evalScore ?? "n/a"}\n\n${body.body ?? ""}`.trim();

  const ghRes = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${githubToken}`,
      "User-Agent": "stratum",
    },
    body: JSON.stringify({
      title: body.title ?? `Stratum: ${change.id}`,
      body: prBody,
      head: branch,
      base: body.base ?? project.githubDefaultBranch ?? "main",
      draft: body.draft ?? true,
    }),
  });

  if (!ghRes.ok) {
    logger.error("GitHub PR creation failed", undefined, { status: ghRes.status, changeId: id });
    return badRequest(`GitHub PR creation failed (${ghRes.status})`);
  }

  const pr = (await ghRes.json()) as { number: number; html_url: string; state: string };
  const promotedAt = new Date().toISOString();

  const updateResult = await updateChangeStatus(c.env.DB, logger, id, "promoted", {
    ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
    ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
    ...(change.evalReason !== undefined ? { evalReason: change.evalReason } : {}),
    githubOwner: repo.owner,
    githubRepo: repo.repo,
    githubBranch: branch,
    githubPrNumber: pr.number,
    githubPrUrl: pr.html_url,
    githubPrState: pr.state,
    promotedAt,
    promotedBy: userId,
  });
  if (!updateResult.success) {
    logger.error("Failed to update change status to promoted", updateResult.error);
    return badRequest(updateResult.error.message);
  }

  logger.info("Change promoted to GitHub PR", {
    changeId: id,
    prNumber: pr.number,
    repo: `${repo.owner}/${repo.repo}`,
  });
  return okOrFormRedirect(c, id, {
    changeId: id,
    github: {
      owner: repo.owner,
      repo: repo.repo,
      branch,
      pullRequestNumber: pr.number,
      pullRequestUrl: pr.html_url,
    },
  });
});

export { app as changesRouter };
