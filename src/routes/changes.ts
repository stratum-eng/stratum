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
import { recordAudit } from "../storage/audit";
import { createChange, getChange, listChanges, updateChangeStatus } from "../storage/changes";
import { type CostSample, getChangeCostSummary, recordCosts } from "../storage/costs";
import { listEvalRuns, recordEvalRuns } from "../storage/eval-runs";
import {
  MergeConflictError,
  getDiffBetweenRepos,
  mergeWorkspaceIntoProject,
} from "../storage/git-ops";
import { getCommitLog } from "../storage/git-ops";
import { recordProvenance } from "../storage/provenance";
import { readRepoSnapshot } from "../storage/repo-snapshot";
import { getProject, getWorkspace } from "../storage/state";
import type { Change, Env, ProjectEntry } from "../types";
import { canReadProject, canWriteProject } from "../utils/authz";
import type { AppError } from "../utils/errors";
import { createLogger } from "../utils/logger";
import type { Logger } from "../utils/logger";
import { badRequest, created, forbidden, notFound, ok, unauthorized } from "../utils/response";
import { ok as okResult } from "../utils/result";

const app = new Hono<{ Bindings: Env }>();
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
  const logResult = await getCommitLog(project.remote, project.token, logger, 1);
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

  const changeResult = await createChange(c.env.DB, logger, {
    project: projectName,
    workspace: body.workspace,
    ...(agentId !== undefined ? { agentId } : {}),
    ...(baseSha !== null ? { baseSha } : {}),
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

  const policy = await loadPolicy(project.remote, project.token, logger);

  const diffResult = await getDiffBetweenRepos(
    project.remote,
    project.token,
    workspace.remote,
    workspace.token,
    logger,
  );
  if (!diffResult.success) {
    logger.error("Failed to get diff between repos", diffResult.error);
    return badRequest(diffResult.error.message);
  }
  const diff = diffResult.data;

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

  // Branch protection: the policy's merge rules gate every merge path.
  const mergePolicy = await loadPolicy(project.remote, project.token, logger);
  const forceAllowed = mergePolicy.merge?.allowForce !== false;
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
  }

  if (c.env.MERGE_QUEUE && strategy === "merge") {
    const doId = c.env.MERGE_QUEUE.idFromName(change.project);
    const stub = c.env.MERGE_QUEUE.get(doId);
    const result = await (
      stub as unknown as { merge(changeId: string): Promise<MergeOutcome> }
    ).merge(id);

    if (!result.success) {
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

  const mergeResult = await mergeWorkspaceIntoProject(
    project.remote,
    project.token,
    workspace.remote,
    workspace.token,
    logger,
    { strategy },
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

  const policy = await loadPolicy(project.remote, project.token, logger);

  const diffResult = await getDiffBetweenRepos(
    project.remote,
    project.token,
    workspace.remote,
    workspace.token,
    logger,
  );
  if (!diffResult.success) {
    logger.error("Failed to get diff between repos", diffResult.error);
    return badRequest(diffResult.error.message);
  }
  const diff = diffResult.data;

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

  const branch = `stratum/${change.id}`;
  const prBody =
    `## Stratum review\n\n- Change: \`${change.id}\`\n- Workspace: \`${change.workspace}\`\n- Evaluation: ${change.evalPassed ? "passed" : "failed"}, score ${change.evalScore ?? "n/a"}\n\n${body.body ?? ""}`.trim();

  const ghRes = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${project.token}`,
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
