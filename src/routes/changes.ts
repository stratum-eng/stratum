import { type Context, Hono } from "hono";
import { diffTouchesProtectedConfig, loadPolicy } from "../evaluation";
import { llmProviderCatalog } from "../evaluation/llm-providers";
import type { EvalPolicy } from "../evaluation/types";
import { GitHubClient } from "../github/client";
import { buildEvaluationReport, reportEvaluationToGitHub } from "../github/sync";
import { runPostMergeCheck } from "../merge/post-merge";
import { checkMergeProtection } from "../merge/protection";
import { enqueueMergeDeploy } from "../queue/deploy-queue";
import { emitEvent } from "../queue/events";
import type { MergeOutcome } from "../queue/merge-queue";
import {
  billingContextFor,
  buildEvaluators,
  createChangeWithEvaluation,
  resolveProjectHead,
  runEvaluation,
} from "../services/change-flow";
import { recordAudit } from "../storage/audit";
import {
  dismissApprovalsAndUpdateStatus,
  getChange,
  getChangesByIds,
  listChanges,
  markChangeMerged,
  mergeTransitionOpts,
  updateChangeStatus,
} from "../storage/changes";
import {
  type CostSample,
  getChangeCostSummary,
  recordCosts,
  resolveBillingSubject,
} from "../storage/costs";
import { isTargetDeleting } from "../storage/deletion";
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
  pushBranchToRemote,
  resolveLocalTip,
  stagedTreeKey,
  stagedTreeShaKey,
} from "../storage/git-ops";
import { parseRepoUrl } from "../storage/git-providers";
import { recordProvenance } from "../storage/provenance";
import { getProject, getWorkspace } from "../storage/state";
import { getProjectSourceUrl } from "../storage/sync";
import type { Change, Env, ProjectEntry } from "../types";
import { projectDefaultBranch } from "../types";
import { canReadProject, canWriteProject } from "../utils/authz";
import { getWaitUntil } from "../utils/execution-ctx";
import { newId } from "../utils/ids";
import { createLogger } from "../utils/logger";
import type { Logger } from "../utils/logger";
import { readJsonWithLimit } from "../utils/request-body";
import {
  appError,
  badRequest,
  created,
  forbidden,
  internalError,
  notFound,
  ok,
  unauthorized,
} from "../utils/response";

const app = new Hono<{ Bindings: Env }>();

// Change-creation body is just a workspace name.
const MAX_CHANGE_CREATE_BODY_BYTES = 1024 * 1024;
// changeIds is a list of ids, capped post-parse by MAX_MERGE_BATCH.
const MAX_MERGE_BATCH_BODY_BYTES = 1024 * 1024;
// GitHub PR promotion body is a handful of short strings.
const MAX_GITHUB_PR_BODY_BYTES = 1024 * 1024;

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
 * Loads a project's merge policy through a two-level cache — in-isolate Map,
 * then KV (shared across isolates), then a clone via `loadPolicy`.
 *
 * The cache exists because the hot merge paths would otherwise clone the repo
 * just to read `.stratum/policy.yaml`. Caching is gated on REPO_DO_ENABLED so
 * tests always load fresh with no KV access, and the TTL is the bound on how
 * long a branch-protection change takes to take effect here: shortening it
 * costs clones, lengthening it widens the window where a revoked rule still
 * applies.
 *
 * @param project - The project whose merge policy to load
 * @returns The project's merge policy
 * @throws If a read token cannot be minted or the policy cannot be loaded
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
      const loaded = await loadPolicy(
        project.remote,
        tok.data,
        logger,
        projectDefaultBranch(project),
        llmProviderCatalog(env, logger),
      );
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

/**
 * `base` arrives in the request body, so it is untrusted input on its way to
 * the GitHub API — this bounds it before it gets there.
 */
const MAX_BASE_REF_LENGTH = 200;

/**
 * Validates a Git branch reference for use as a GitHub pull request base branch.
 *
 * `base` arrives in the request body, so this is the boundary where untrusted
 * input is bounded before it reaches the GitHub API — an allowlist, not a
 * faithful reimplementation of git's parser.
 *
 * Two rules are easy to get wrong. git applies its per-component rules to
 * every slash-separated component, not just the whole ref, so `release/.hidden`
 * and `release/v1.lock` are invalid even though the full string neither starts
 * with `.` nor ends with `.lock`. And a bare `@` is rejected deliberately even
 * though git will happily create `refs/heads/@` (verified against git 2.43):
 * `@` is git's shorthand for HEAD, so `git checkout @` resolves to HEAD rather
 * than the branch. `@` inside a longer name is unambiguous and stays legal;
 * only the `@{` reflog syntax is a hard error.
 *
 * @param ref - The branch reference to validate
 * @returns `true` if the reference satisfies the allowed branch-name rules, `false` otherwise
 */
function isValidBaseRef(ref: string): boolean {
  if (ref.length === 0 || ref.length > MAX_BASE_REF_LENGTH) return false;
  if (ref === "@") return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are exactly what's rejected
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(ref)) return false;
  if (ref.startsWith("-") || ref.startsWith("/")) return false;
  if (ref.endsWith("/")) return false;
  if (ref.includes("..") || ref.includes("//") || ref.includes("@{")) return false;
  return ref
    .split("/")
    .every((c) => c.length > 0 && !c.startsWith(".") && !c.endsWith(".") && !c.endsWith(".lock"));
}

const MERGEABLE_STATUSES: Change["status"][] = ["approved", "accepted", "promoted"];

/** Default + hard cap for the paginated changes listing (bounds the response). */
const DEFAULT_CHANGES_PAGE = 100;
const MAX_CHANGES_PAGE = 500;

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

/**
 * Resolve a workspace's current tip commit sha, or null if it can't be read.
 * Workspaces have no KV snapshot fast-path, so this clones the workspace remote.
 * Used to reject a merge whose workspace moved since it was evaluated (SEC-2).
 */
async function resolveWorkspaceTip(
  env: Env,
  workspaceRemote: string,
  logger: Logger,
  branch = "main",
): Promise<string | null> {
  const readToken = await freshRepoToken(env.ARTIFACTS, workspaceRemote, "read", logger);
  if (!readToken.success) return null;
  const logResult = await getCommitLog(workspaceRemote, readToken.data, logger, 1, branch);
  return logResult.success ? (logResult.data[0]?.sha ?? null) : null;
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

  // Refuse writes while the project (or its owner) is being deleted — otherwise a
  // new change resurrects rows the cascade is removing and wedges the job as
  // `incomplete`. Best-effort (TOCTOU); the verifier re-run is the durable backstop.
  if (await isTargetDeleting(c.env, project, logger)) {
    return c.json({ error: "Project is being deleted", code: "TARGET_DELETING" }, 409);
  }

  const body = await readJsonWithLimit<{ workspace?: unknown }>(
    c,
    MAX_CHANGE_CREATE_BODY_BYTES,
    logger,
  ).catch(() => ({ workspace: undefined }));
  if (body instanceof Response) return body;
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

  const outcome = await createChangeWithEvaluation(c.env, logger, {
    project,
    projectName,
    workspaceName: body.workspace,
    workspaceRemote: workspace.remote,
    actor: {
      ...(userId !== undefined ? { userId } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
      ...(agentOwnerId !== undefined ? { agentOwnerId } : {}),
    },
    waitUntil: getWaitUntil(c),
  });
  if (!outcome.success) {
    // Post-creation failures leave an open change row; name it so the caller
    // can re-evaluate or reject that change instead of losing track of it.
    const stuckChangeId = outcome.error.context?.changeId;
    const message =
      typeof stuckChangeId === "string"
        ? `${outcome.error.message} (change ${stuckChangeId})`
        : outcome.error.message;
    return outcome.error.statusCode >= 500 ? internalError(message) : badRequest(message);
  }
  const { change: updatedChange, evalResult, evalRuns: recordedRuns } = outcome.data;
  return created({ change: updatedChange, eval: evalResult, evalRuns: recordedRuns });
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

  // Bound the response so a project with thousands of changes can't return them
  // all in one payload. Client may request fewer via ?limit=, capped at the max.
  const requested = Number(c.req.query("limit"));
  const limit =
    Number.isInteger(requested) && requested > 0
      ? Math.min(requested, MAX_CHANGES_PAGE)
      : DEFAULT_CHANGES_PAGE;

  const changesResult = await listChanges(c.env.DB, logger, projectName, status, {
    projectId: project.id,
    limit,
  });
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
  // A change that edits the merge-protection config can never be force-merged,
  // even where the policy allows force — force skips the approval gate that keeps
  // a protection relaxation from landing with no human review (SA-3).
  if (force && change.touchesProtectedConfig) {
    return badRequest(
      "This change modifies the merge-protection config and cannot be force-merged; it requires a human approval",
    );
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
        ? await resolveWorkspaceTip(
            c.env,
            workspaceResult.data.remote,
            logger,
            projectDefaultBranch(project),
          )
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

    // A concurrent request (or interleaved DO invocation) that found the change
    // already merged returns `transitioned: false`. Skip ALL post-merge side
    // effects for it — the change.merged event, the forced-merge audit, and the
    // post-merge policy check (which can auto-revert) — so a single logical merge
    // fires exactly one set of side effects. The winning request runs them below.
    if (result.transitioned === false) {
      logger.info(
        "Change already merged by a concurrent request; skipping post-merge side effects",
        {
          changeId: id,
        },
      );
      return okOrFormRedirect(c, id, {
        merged: true,
        changeId: id,
        project: change.project,
        workspace: change.workspace,
        commit: result.commit,
      });
    }

    await emitEvent(
      c.env.DB,
      c.env.EVENTS_QUEUE,
      {
        type: "change.merged",
        project: change.project,
        changeId: id,
        commit: result.commit ?? "",
      },
      { type: "user", id: userId },
      logger,
      change.projectId ?? project.id,
    );

    logger.info("Change merged via queue", {
      changeId: id,
      project: change.project,
      commit: result.commit,
      via: useRepoDo ? "repo-do" : "merge-queue",
    });

    if (force) {
      const auditResult = await recordAudit(c.env.DB, logger, {
        action: "merge.forced",
        actorType: "user",
        actorId: userId,
        subject: id,
        detail: { project: change.project },
      });
      if (!auditResult.success) {
        logger.error("Failed to audit forced merge", auditResult.error, { changeId: id });
      }
    }

    const postMergeViaQueue = result.commit
      ? await runPostMergeCheck(
          c.env,
          project,
          { changeId: id, mergeCommit: result.commit, policy: mergePolicy },
          logger,
        )
      : { status: "skipped" as const };

    // Deploys are triggered HERE, from the post-merge result — never from the
    // `change.merged` event emitted above. That event fires before the check
    // runs, and a post-merge failure auto-reverts the merge, so an
    // event-triggered deploy would publish the commit Stratum just reverted.
    await enqueueMergeDeploy(c.env, logger, {
      projectId: change.projectId ?? project.id,
      changeId: id,
      commitSha: result.commit ?? "",
      postMergeStatus: postMergeViaQueue.status,
    });

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
      branch: projectDefaultBranch(project),
      // Merge the exact evaluated commit (#115) AND assert the tip hasn't moved
      // since evaluation (SEC-2, applies even under force). Both pin to the same
      // evaluated revision; legacy changes without these fields merge the live tip.
      ...(change.workspaceHeadSha ? { workspaceSha: change.workspaceHeadSha } : {}),
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
          // The Change whose merge attempt hit this conflict. A manual resolution
          // is part of landing THIS change, not a change of its own — the
          // resolve route uses it to check the review trail this change already
          // has (SA-5 follow-up, #260) rather than demanding fresh approvals
          // with no UI to grant them against resolved bytes.
          changeId: id,
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
  const updateResult = await markChangeMerged(
    c.env.DB,
    logger,
    id,
    mergeTransitionOpts(change, mergedAt),
  );
  if (!updateResult.success) {
    logger.error("Failed to update change status to merged", updateResult.error);
    return badRequest(updateResult.error.message);
  }
  if (!updateResult.data.transitioned) {
    // A concurrent request already merged this change; the git merge we just ran
    // was redundant. Don't re-record costs/provenance or re-emit change.merged —
    // just report the change as merged (idempotent).
    logger.info("Change already merged by a concurrent request; skipping re-emit", {
      changeId: id,
    });
    return okOrFormRedirect(c, id, {
      merged: true,
      changeId: id,
      project: change.project,
      workspace: change.workspace,
      commit,
    });
  }

  const mergeSubject = await resolveBillingSubject(c.env.DB, logger, project);
  await recordCosts(
    c.env.DB,
    logger,
    {
      project: change.project,
      // Backfill project_id onto legacy (pre-migration) changes as they merge.
      projectId: change.projectId ?? project.id,
      changeId: id,
      workspace: change.workspace,
      // The project's owner now, not the author of the change: this is the
      // account the clone and push were spent against.
      ...(mergeSubject ?? {}),
    },
    [{ kind: "git_ops", quantity: 2 }],
  );

  const provenanceResult = await recordProvenance(c.env.DB, logger, {
    commitSha: commit,
    project: change.project,
    projectId: change.projectId ?? project.id,
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
    change.projectId ?? project.id,
  );

  logger.info("Change merged", {
    changeId: id,
    project: change.project,
    workspace: change.workspace,
    commit,
  });

  if (force) {
    const auditResult = await recordAudit(c.env.DB, logger, {
      action: "merge.forced",
      actorType: "user",
      actorId: userId,
      subject: id,
      detail: { project: change.project },
    });
    if (!auditResult.success) {
      logger.error("Failed to audit forced merge", auditResult.error, { changeId: id });
    }
  }

  const postMerge = await runPostMergeCheck(
    c.env,
    project,
    { changeId: id, mergeCommit: commit, policy: mergePolicy },
    logger,
  );

  // Same ordering constraint as the queue path above: the deploy trigger hangs
  // off the post-merge result, not the `change.merged` event, because a failed
  // post-merge check reverts the merge.
  await enqueueMergeDeploy(c.env, logger, {
    projectId: change.projectId ?? project.id,
    changeId: id,
    commitSha: commit,
    postMergeStatus: postMerge.status,
    // The merge time this route already stamped on the change. Deployment rows
    // are ordered by it rather than by when the queue delivers their message,
    // and the post-merge check above can take minutes — long enough for a later
    // merge to overtake this one on enqueue order alone.
    mergedAt,
  });

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

  const body = await readJsonWithLimit<{ changeIds?: unknown; force?: unknown }>(
    c,
    MAX_MERGE_BATCH_BODY_BYTES,
    logger,
  ).catch(() => ({ changeIds: undefined, force: undefined }));
  if (body instanceof Response) return body;
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
          ? await resolveWorkspaceTip(
              c.env,
              wsResult.data.remote,
              logger,
              projectDefaultBranch(project),
            )
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
    const cloned = await cloneRepo(project.remote, token.data, logger, {
      ref: projectDefaultBranch(project),
    });
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
    items.push({
      changeId: m.changeId,
      baseSha: m.baseSha,
      staged,
      // #124 defense in depth: re-validated inside batchMergeStagedTrees, right
      // where the synthetic commit is built (O(1) string compare).
      ...(evaluatedTreeOid !== undefined ? { expectedTreeOid: evaluatedTreeOid } : {}),
    });
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
    projectDefaultBranch(project),
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
    if (change?.workspace) {
      gcKeys.push(stagedTreeKey(project.id, change.workspace));
      // #124: GC the merged commit's immutable sha-keyed staged-tree copy too.
      const pinnedSha = change.workspaceHeadSha ?? change.evaluatedSha;
      if (pinnedSha !== undefined) {
        gcKeys.push(stagedTreeShaKey(project.id, change.workspace, pinnedSha));
      }
      mergedWorkspaces.push(change.workspace);
    }
    merged.push(r.changeId);
  }
  const mergedAt = new Date().toISOString();
  // D1 caps bound parameters at 100/statement: chunk so UPDATE (1 + ids) and the
  // multi-row INSERT (11 binds/row — project_id + model + prompt_hash) stay under
  // it. All chunks ride one batch().
  const UPDATE_CHUNK = 99;
  const PROVENANCE_BINDS_PER_ROW = 11;
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
    const rows = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const binds = chunk.flatMap((l) => [
      newId("prv"),
      l.commit,
      projectName,
      project.id,
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
        `INSERT INTO provenance (id, commit_sha, project, project_id, workspace, change_id, agent_id, eval_score, model, prompt_hash, merged_at) VALUES ${rows}`,
      ).bind(...binds),
    );
  }

  const persist = (async () => {
    if (statements.length > 0) await c.env.DB.batch(statements);
    // Force-merges bypass evaluation/approval gates, so every one must leave an
    // audit trail — the single-merge path records `merge.forced` too (SEC-2).
    if (force) {
      for (const changeId of merged) {
        const auditResult = await recordAudit(c.env.DB, logger, {
          action: "merge.forced",
          actorType: "user",
          actorId: userId,
          subject: changeId,
          detail: { project: projectName, batch: true },
        });
        if (!auditResult.success) {
          logger.error("Failed to audit forced batch merge", auditResult.error, { changeId });
        }
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
    change.projectId ?? project.id,
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

  const branch = projectDefaultBranch(project);
  const policy = await loadPolicy(
    project.remote,
    projectReadToken.data,
    logger,
    branch,
    llmProviderCatalog(c.env, logger),
  );

  const diffResult = await getDiffBetweenRepos(
    project.remote,
    projectReadToken.data,
    workspace.remote,
    workspaceReadToken.data,
    logger,
    branch,
  );
  if (!diffResult.success) {
    logger.error("Failed to get diff between repos", diffResult.error);
    return badRequest(diffResult.error.message);
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
    c.env,
    policy,
    project,
    logger,
    {
      remote: workspace.remote,
      token: workspaceReadToken.data,
      ref: evaluatedSha,
    },
    getWaitUntil(c),
  );
  // The base this re-evaluation's diff was built against — not `change.baseSha`,
  // which records the base at creation and is exactly the value that has gone
  // stale by the time a change is re-evaluated (#274).
  // One resolution for both the meters and the ledger below (see
  // `billingContextFor`): an agent-owned project's payer is a D1 walk, and
  // resolving it twice would pay for it twice and could name two payers.
  const evaluateSubject = await resolveBillingSubject(c.env.DB, logger, project);
  const { evalRuns, evalResult } = await runEvaluation(evaluators, diff, policy, logger, {
    baseSha: baseOid,
    // This route is user-credentialed (agent tokens are rejected above), so the
    // acting user is the caller — the subject PRD §4a checks a limit against.
    billing: billingContextFor(evaluateSubject, project.id, userId),
  });

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
    {
      project: change.project,
      projectId: change.projectId ?? project.id,
      changeId: id,
      workspace: change.workspace,
      ...(evaluateSubject ?? {}),
      notify: { env: c.env, actorUserId: userId, waitUntil: getWaitUntil(c) },
    },
    evaluateCostSamples,
  );

  const newStatus = evalResult.passed ? "accepted" : "needs_changes";
  const statusOpts = {
    evalScore: evalResult.score,
    evalPassed: evalResult.passed,
    evalReason: evalResult.reason,
    evaluatedSha,
    evaluatedTreeOid,
    // Re-pin the base as well as the tip. `change.baseSha` is what the merge
    // gate compares against the project head under `merge.requireFreshBase`;
    // left at its creation-time value, a change whose base advanced could never
    // be un-staled, and re-evaluating it — the documented remedy — would report
    // a fresh pass while the merge kept returning STALE_BASE.
    baseSha: baseOid,
    // Re-pin to the commit this re-evaluation actually ran against (#115).
    ...(workspaceHeadSha ? { workspaceHeadSha } : {}),
    // Recompute the protected-config flag from the diff this run actually saw
    // (SA-3). Re-evaluation re-pins evaluatedSha to the new tip, which is what
    // the merge route's staleness check compares against — so leaving the flag
    // at its creation-time value would let a change that was benign when opened
    // acquire a policy edit, pass the staleness check, and merge without the
    // approval the flag exists to force.
    touchesProtectedConfig: diffTouchesProtectedConfig(diff),
  };

  // Stale-approval dismissal (#193): a different evaluated sha means any prior
  // 'approve' verdicts were given for code the reviewer never saw — drop them
  // before re-pinning, so a re-push can't merge on approvals for the old
  // revision. request_changes verdicts survive, and a no-op re-evaluation of
  // the same sha (including legacy changes with no recorded sha) keeps
  // approvals.
  //
  // A changed BASE dismisses for the same reason, and this PR is what makes
  // that reachable. `baseSha` used to be frozen at creation, so a change whose
  // base advanced stayed permanently STALE_BASE and could not merge on an old
  // approval at all. Now that re-evaluation re-pins it (above), an unchanged
  // workspace tip against a moved base would clear the merge gate while
  // carrying approvals given for `diff(oldBase..tip)` — a different diff than
  // the one that would merge. Reviewers approve a diff, not a tip, so either
  // endpoint moving invalidates the verdict.
  //
  // The dismissal and the evaluatedSha/status re-pin run as ONE D1 batch
  // (#238): dismissApprovals (DELETE on change_reviews) and updateChangeStatus
  // (UPDATE on changes) used to be two separate writes, so a transient D1
  // failure on the second one could land the dismissal without ever re-pinning
  // the sha — losing the approvals for good while a retry against the old,
  // still-pinned sha found none left to lose. Batching them makes the two
  // writes all-or-nothing, and the review.approvals_dismissed audit entry is
  // only recorded once the batch itself has actually succeeded.
  // Absent on legacy rows; absence keeps approvals rather than dismissing on
  // every re-evaluation of a change that predates the field.
  const tipChanged = change.evaluatedSha !== undefined && change.evaluatedSha !== evaluatedSha;
  const baseChanged = change.baseSha !== undefined && change.baseSha !== baseOid;
  if (tipChanged || baseChanged) {
    const batchResult = await dismissApprovalsAndUpdateStatus(
      c.env.DB,
      logger,
      id,
      newStatus,
      statusOpts,
    );
    if (!batchResult.success) {
      logger.error(
        "Failed to atomically dismiss stale approvals and update change status",
        batchResult.error,
      );
      return internalError(batchResult.error.message);
    }
    const { dismissedReviewerIds } = batchResult.data;
    if (dismissedReviewerIds.length > 0) {
      const auditResult = await recordAudit(c.env.DB, logger, {
        action: "review.approvals_dismissed",
        actorType: "user",
        actorId: userId,
        subject: id,
        detail: {
          project: change.project,
          dismissed: dismissedReviewerIds.length,
          dismissedReviewerIds,
          previousEvaluatedSha: change.evaluatedSha,
          evaluatedSha,
          // Which endpoint moved — an audit reader otherwise cannot tell a
          // re-push from a base advance, and the two have different causes.
          previousBaseSha: change.baseSha,
          baseSha: baseOid,
          dismissedFor: tipChanged && baseChanged ? "tip+base" : tipChanged ? "tip" : "base",
        },
      });
      if (!auditResult.success) {
        // The dismissal + re-pin already landed together; do not fail the
        // request. Log the gap so a missing audit record for a real
        // dismissal is detectable.
        logger.error("Failed to audit approval dismissal", auditResult.error, { changeId: id });
      }
    }
  } else {
    const updateResult = await updateChangeStatus(c.env.DB, logger, id, newStatus, statusOpts);
    if (!updateResult.success) {
      logger.error("Failed to update change status", updateResult.error);
      return badRequest(updateResult.error.message);
    }
  }

  // Layer mode: report the verdict to the change's linked GitHub PR (comment
  // upsert + "stratum/evaluation" commit status). Best-effort — a GitHub
  // failure never fails the evaluation — and a no-op for changes without a
  // linked PR or projects without a GitHub source. Scheduled off the request
  // path since it's pure side effect the response doesn't depend on.
  const reportEvaluation = reportEvaluationToGitHub(
    c.env,
    { ...change, evaluatedSha, ...(workspaceHeadSha ? { workspaceHeadSha } : {}) },
    project,
    buildEvaluationReport(evalResult, evalRuns),
    logger,
  );
  const waitUntil = getWaitUntil(c);
  if (waitUntil) {
    waitUntil(reportEvaluation);
  } else {
    await reportEvaluation;
  }

  logger.info("Change re-evaluated", {
    changeId: id,
    evalScore: evalResult.score,
    passed: evalResult.passed,
  });
  return okOrFormRedirect(c, id, { changeId: id, eval: evalResult, evalRuns: recordResult.data });
});

/** The repository a promotion is targeting, as resolved from the project source. */
type GithubRepoTarget = { owner: string; repo: string };

interface GithubPr {
  number: number;
  html_url: string;
  state: string;
}

/**
 * Determines whether a value represents an open GitHub pull request.
 *
 * Validation is strict because these fields get persisted: `githubPrNumber`
 * and `githubPrUrl` are what a later re-promotion checks to decide the PR
 * already exists and skip creation entirely. A malformed record stored here
 * therefore strands the change permanently — every retry short-circuits to a
 * PR that isn't there — so both the create response and the duplicate-head
 * lookup are validated through this before anything is written.
 *
 * `html_url` is checked against the repository and number it is supposed to
 * describe, not merely parsed. A shape-only check passes values that are real
 * GitHub URLs but not this PR's page — `https://api.github.com/repos/o/r/pulls/1`
 * (an API endpoint, not a web link) and `https://github.com/login` both look
 * fine to a host-and-non-empty-path test. Persisting either strands the change
 * exactly as a malformed record would.
 *
 * @param value - The value to validate
 * @param target - The repository this promotion is pushing to
 * @returns `true` if the value contains a positive safe integer number, an `html_url` that is this PR's page in `target`, and an open state; `false` otherwise.
 */
function isUsableGithubPr(value: unknown, target: GithubRepoTarget): value is GithubPr {
  if (typeof value !== "object" || value === null) return false;
  const pr = value as Partial<GithubPr>;
  return (
    typeof pr.number === "number" &&
    Number.isSafeInteger(pr.number) &&
    pr.number > 0 &&
    typeof pr.html_url === "string" &&
    isUsableGithubUrl(pr.html_url, target, pr.number) &&
    pr.state === "open"
  );
}

/**
 * A PR link this app would be willing to store and hand back to a caller.
 *
 * The host must be exactly `github.com`: the promotion path is hard-coded to
 * github.com, and a suffix test would also accept `api.github.com` and
 * `gist.github.com`. The path must be the canonical PR page for this exact
 * repository and number, so a well-formed URL pointing somewhere else on
 * GitHub is rejected too. Owner and repo compare case-insensitively because
 * GitHub echoes its own canonical casing, which need not match the casing
 * parsed out of the project's source URL.
 *
 * Userinfo, query, and fragment are all rejected rather than ignored. A
 * canonical `html_url` carries none of them, and this string is persisted and
 * handed back to callers verbatim — so `https://user:pw@github.com/o/r/pull/1`
 * would store credentials, and `...?token=x` would store a secret in a
 * user-visible link. Checking the host and path alone accepts both, because
 * `hostname` and `pathname` exclude those components.
 */
function isUsableGithubUrl(raw: string, target: GithubRepoTarget, prNumber: number): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // `host`, not `hostname`: hostname discards the port entirely, so
  // `https://github.com:8443/o/r/pull/1` would pass a hostname check. `host`
  // keeps a non-default port and still normalises the default `:443` away, so
  // the canonical form is unaffected.
  if (url.protocol !== "https:" || url.host !== "github.com") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.search !== "" || url.hash !== "") return false;
  // Compared as-is rather than after trimming a trailing slash: a canonical
  // html_url has none, and this value is persisted and handed back, so the
  // stored string should be the canonical one rather than a variant of it.
  return (
    url.pathname.toLowerCase() === `/${target.owner}/${target.repo}/pull/${prNumber}`.toLowerCase()
  );
}

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

  // Accept the generic sourceUrl or the legacy githubUrl — bulk-imported
  // projects only set sourceUrl (#189) — as long as it points at github.com.
  // Via the shared accessor, so this can't drift from the precedence the rest
  // of the codebase uses: sourceUrl wins. A project migrated off githubUrl
  // keeps the stale value, and this URL is what the branch is force-pushed to,
  // so preferring the legacy field would publish to the wrong repository.
  const repoUrl = getProjectSourceUrl(project);
  if (!repoUrl) return badRequest("Project is not connected to GitHub");
  const parsedRepo = parseRepoUrl(repoUrl);
  if (!parsedRepo || parsedRepo.provider !== "github") {
    return badRequest("Project source is not a GitHub repository");
  }
  const repo = { owner: parsedRepo.info.owner, repo: parsedRepo.info.repo };

  const body = await readJsonWithLimit<{ title?: string; body?: string; draft?: boolean }>(
    c,
    MAX_GITHUB_PR_BODY_BYTES,
    logger,
  ).catch(() => ({}) as { title?: string; body?: string; draft?: boolean });
  if (body instanceof Response) return body;

  // The PR base is the project's own recorded default branch, never a
  // caller-supplied value (SA-6). This endpoint acts with the instance-wide
  // GitHub token, so honouring a body-supplied base would let any caller aim
  // that shared credential at a branch of its choosing on the linked repo — and
  // validating the string does not change that, because the problem is
  // authorization, not syntax. `base` is therefore no longer read from the body
  // at all; the request type above omits it.
  //
  // Through projectDefaultBranch rather than an inline `??` chain: the helper
  // uses `||`, so an empty-string sourceDefaultBranch falls through to the next
  // candidate instead of reaching GitHub as a branch name. Still validated after
  // that, because the record can carry a branch name that arrived through import
  // and was never checked by this app.
  const defaultBranch = projectDefaultBranch(project);
  if (!isValidBaseRef(defaultBranch)) {
    logger.error("Project default branch is not a valid git ref", undefined, {
      projectId: project.id,
      base: defaultBranch,
    });
    return badRequest("Project default branch is not a valid branch name");
  }
  const base = defaultBranch;

  // GitHub PR creation needs a GitHub credential — the Artifacts repo token (now
  // never persisted) was never valid here. Use the app's configured GitHub token.
  const githubToken = c.env.GITHUB_TOKEN;
  if (!githubToken) return badRequest("GitHub integration is not configured");

  // The PR's head ref must exist on GitHub before the PR is opened — a missing
  // head is a guaranteed 422 (#189). Clone the change's workspace fork and
  // (force-)push its tip to the Stratum-owned `stratum/<changeId>` ref first.
  const workspaceResult = await getWorkspace(c.env.STATE, project.id, change.workspace, logger);
  if (!workspaceResult.success) {
    if (workspaceResult.error.code === "NOT_FOUND") {
      return notFound("Workspace", change.workspace);
    }
    logger.error("Failed to get workspace", workspaceResult.error);
    return badRequest(workspaceResult.error.message);
  }
  const workspaceRemote = workspaceResult.data.remote;

  const branch = `stratum/${change.id}`;

  const repoTokenResult = await freshRepoToken(c.env.ARTIFACTS, workspaceRemote, "read", logger);
  if (!repoTokenResult.success) return internalError(repoTokenResult.error.message);
  // GitHub shares no objects with the workspace repo, so a shallow clone's
  // history would be incomplete once pushed there — clone in full.
  // `ref` is the project's default branch, which the workspace fork copies under
  // the same name. Since SA-6 that is also exactly `base` — the caller can no
  // longer supply one — but the two are kept distinct because they name
  // different things: a ref in the fork versus a branch on GitHub.
  const cloneResult = await cloneRepo(workspaceRemote, repoTokenResult.data, logger, {
    ref: defaultBranch,
    fullHistory: true,
    // Overrides cloneRepo's 30s default (#332): that budget is sized for a
    // shallow clone, and this one is deliberately full-history (see above).
    // Still a live request, not a background job, so this stays well under
    // backup's 300s — 120s matches importFromGitHub's existing budget for a
    // comparably-sized full clone elsewhere in this codebase.
    timeoutMs: 120_000,
  });
  if (!cloneResult.success) return appError(cloneResult.error);

  // The evaluation gate is only meaningful if the code published to GitHub is
  // the code that was evaluated. The clone above is a live read of the
  // workspace right now, which can have advanced past `change.evaluatedSha`
  // between evaluation and this request — same TOCTOU the merge path guards
  // against a few hundred lines up (SEC-2) and #223 pinned on the R2/DO fast
  // paths. Reject rather than push+promote against unevaluated content:
  // fails closed, and is the smaller change than re-targeting the push at the
  // pinned sha (that needs its own answer for what re-promotion then means).
  // Legacy changes with no evaluatedSha (pre migration 024) skip the check,
  // matching the merge path's behavior.
  let publishedSha: string | undefined;
  if (change.evaluatedSha !== undefined) {
    // Resolved against `defaultBranch`, matching the clone above: that clone is
    // singleBranch, so on a project whose default branch is not `main` it holds
    // that branch and nothing else. Asking for any other ref here throws inside
    // isomorphic-git and turns a valid promotion into a 502.
    const tipResult = await resolveLocalTip(
      cloneResult.data.fs,
      cloneResult.data.dir,
      defaultBranch,
    );
    if (!tipResult.success) return appError(tipResult.error);
    publishedSha = tipResult.data;
    if (publishedSha !== change.evaluatedSha) {
      logger.warn("Workspace advanced past the evaluated revision; rejecting promotion", {
        changeId: id,
        evaluatedSha: change.evaluatedSha,
        currentTip: publishedSha,
      });
      return c.json(
        {
          error:
            "Workspace is stale: it advanced since this change was evaluated. Re-evaluate before promoting.",
          code: "STALE_WORKSPACE",
          evaluatedSha: change.evaluatedSha,
          currentTip: publishedSha,
        },
        409,
      );
    }
  }

  const pushResult = await pushBranchToRemote(
    cloneResult.data.fs,
    cloneResult.data.dir,
    {
      url: `https://github.com/${repo.owner}/${repo.repo}.git`,
      remoteRef: `refs/heads/${branch}`,
      token: githubToken,
      // Must match the clone ref above: the clone is singleBranch, so on a
      // non-main-default project it holds only `defaultBranch` and a push of
      // `main` fails locally before the request is even made.
      localRef: defaultBranch,
      // The Stratum-owned ref: re-promotion must move it to the current tip.
      force: true,
    },
    logger,
  );
  if (!pushResult.success) {
    logger.error("Failed to push change branch to GitHub", pushResult.error, {
      changeId: id,
      branch,
    });
    return appError(pushResult.error);
  }

  // Re-promotion: the PR already exists and the force-push above refreshed its
  // head, so skip the create call (GitHub 422s on a duplicate head ref).
  //
  // The stored record is validated rather than trusted: rows written before
  // this route validated GitHub's responses can hold anything, and a closed PR
  // must not be handed back as a successful promotion. Falling through on a bad
  // record is the recovery path, not a failure — creation runs, and the
  // duplicate-head branch below repairs the stored values from GitHub's own
  // answer when an open PR does exist for this head.
  const storedPr = {
    number: change.githubPrNumber,
    html_url: change.githubPrUrl,
    state: change.githubPrState,
  };
  // The stored PR is only reusable if it belongs to the repository this
  // promotion is actually pushing to. `repo` is derived from the project's
  // source URL, which can change (a project migrated between GitHub repos, or
  // `sourceUrl` superseding a legacy `githubUrl`) — and when it does, the push
  // above lands in the new repository while these stored values still describe
  // a PR in the old one. Reusing them would answer with the new owner/repo
  // beside an unrelated PR URL. Legacy rows predating this persistence have the
  // fields undefined and so fall through, which is correct: creation plus
  // duplicate-head reconciliation rewrites them from GitHub's own answer.
  const storedPrMatchesTarget =
    change.githubOwner === repo.owner &&
    change.githubRepo === repo.repo &&
    change.githubBranch === branch;
  if (isUsableGithubPr(storedPr, repo) && storedPrMatchesTarget) {
    logger.info("Change branch re-pushed to existing GitHub PR", {
      changeId: id,
      prNumber: storedPr.number,
      repo: `${repo.owner}/${repo.repo}`,
    });
    // The force-push above moved the PR's head, so the stored `githubHeadSha`
    // now describes the PREVIOUS revision. This path is every re-promotion, so
    // without this write the recorded published revision is stale (or missing,
    // on rows predating the column) for every change promoted more than once,
    // and nothing surfaces the discrepancy. Undefined only for a legacy change
    // with no `evaluatedSha`, where the gate above never ran and there is no
    // confirmed revision to record — the same guard the create path uses.
    if (publishedSha !== undefined) {
      const headShaResult = await updateChangeStatus(c.env.DB, logger, id, "promoted", {
        githubHeadSha: publishedSha,
      });
      if (!headShaResult.success) {
        // Not fatal: the branch is pushed and the PR exists, so the promotion
        // genuinely happened. Failing here would let a transient D1 error break
        // a re-promotion that previously could not fail after the push, and the
        // degraded outcome is exactly the stale sha this write is fixing.
        // Contrast the create path below, where a failed write loses the PR
        // number itself and the next promotion would re-create the PR.
        logger.error(
          "Re-promotion succeeded but the published revision was not recorded",
          headShaResult.error,
          { changeId: id, publishedSha },
        );
      }
    }
    return okOrFormRedirect(c, id, {
      changeId: id,
      github: {
        owner: repo.owner,
        repo: repo.repo,
        branch,
        pullRequestNumber: storedPr.number,
        pullRequestUrl: storedPr.html_url,
      },
    });
  }
  if (change.githubPrNumber !== undefined || change.githubPrUrl !== undefined) {
    logger.warn("Stored GitHub PR record is unusable or targets another repo; re-creating", {
      changeId: id,
      prNumber: change.githubPrNumber,
      prState: change.githubPrState,
      storedTarget: `${change.githubOwner ?? "?"}/${change.githubRepo ?? "?"}#${change.githubBranch ?? "?"}`,
      currentTarget: `${repo.owner}/${repo.repo}#${branch}`,
    });
  }

  const prBody =
    `## Stratum review\n\n- Change: \`${change.id}\`\n- Workspace: \`${change.workspace}\`\n- Evaluation: ${change.evalPassed ? "passed" : "failed"}, score ${change.evalScore ?? "n/a"}\n\n${body.body ?? ""}`.trim();

  // Duplicate-head 422 → look up + reuse the open PR GitHub already has for
  // this head lives in the client (createOrReusePR): a re-promotion race, or
  // a retry after `updateChangeStatus` failed post-creation, both 422 here,
  // and the PR the caller wanted already exists either way.
  const client = new GitHubClient(githubToken, logger);
  const result = await client.createOrReusePR(
    {
      owner: repo.owner,
      repo: repo.repo,
      title: body.title ?? `Stratum: ${change.id}`,
      body: prBody,
      head: branch,
      base,
      draft: body.draft ?? true,
    },
    // A duplicate-head lookup hit is only worth reusing if it's a PR this
    // route would be willing to persist — otherwise the original create
    // error is the more useful thing to report (see isUsableGithubPr above).
    (candidate) => isUsableGithubPr(candidate, repo),
  );

  if (!result.success) {
    if (result.networkError) {
      logger.error("GitHub PR creation request failed", undefined, { changeId: id });
      return c.json(
        {
          error: "GitHub PR creation failed: request timed out or network error",
          code: "GITHUB_ERROR",
        },
        502,
      );
    }
    // The branch is already pushed by this point. A 2xx status with a body
    // the client couldn't parse as JSON is GitHub responding, just not
    // usefully — the same "unreadable response" the shape-validation failure
    // below reports for a 2xx body missing the expected fields, not a
    // GitHub-reported error to relay.
    if (result.status >= 200 && result.status < 300) {
      logger.error("GitHub PR creation returned an unparseable response body", undefined, {
        status: result.status,
        changeId: id,
      });
      return c.json(
        {
          error: "GitHub PR creation failed: unreadable response from GitHub",
          code: "GITHUB_ERROR",
          githubStatus: result.status,
        },
        502,
      );
    }
    // Surface GitHub's own status + message (never the token) instead of a
    // generic 400 — a 422 "head invalid" vs. a 404 repo tells the caller
    // exactly what to fix.
    const githubMessage = [
      result.githubMessage,
      ...result.errors.map((e) => e.message ?? (e.field ? `${e.field} ${e.code}` : e.code)),
    ]
      .filter(Boolean)
      .join("; ");
    logger.error("GitHub PR creation failed", undefined, {
      status: result.status,
      changeId: id,
      githubMessage,
    });
    return c.json(
      {
        error: `GitHub PR creation failed (${result.status})${githubMessage ? `: ${githubMessage}` : ""}`,
        code: "GITHUB_ERROR",
        githubStatus: result.status,
      },
      502,
    );
  }

  // The branch is already pushed by this point, so a malformed response body
  // (created or reused) must not escape as an unhandled rejection (a bare
  // 500): map it to the same structured 502 every other GitHub failure uses.
  if (!isUsableGithubPr(result.pr, repo)) {
    logger.error("GitHub PR creation returned an unusable response body", undefined, {
      status: result.status,
      changeId: id,
    });
    return c.json(
      {
        error: "GitHub PR creation failed: unreadable response from GitHub",
        code: "GITHUB_ERROR",
        githubStatus: result.status,
      },
      502,
    );
  }
  const pr: GithubPr = result.pr;

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
    // The revision actually force-pushed as this PR's head — only known
    // precisely when the evaluatedSha gate above ran (legacy changes with no
    // evaluatedSha have no pinned revision to record here).
    ...(publishedSha !== undefined ? { githubHeadSha: publishedSha } : {}),
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
