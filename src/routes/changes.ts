import { type Context, Hono } from "hono";
import { diffTouchesProtectedConfig, loadPolicy } from "../evaluation";
import { llmProviderCatalog } from "../evaluation/llm-providers";
import type { EvalPolicy } from "../evaluation/types";
import { resolveGitHubToken } from "../github/app-auth";
import { GitHubClient } from "../github/client";
import { requestPushMirror } from "../github/mirror";
import { importPullRequest, toExternalPullRequestView } from "../github/mirror-pulls";
import { coAuthorTrailers } from "../github/pull-request-content";
import {
  buildEvaluationReport,
  latestEvaluationReport,
  reportEvaluationToGitHub,
} from "../github/sync";
import { runPostMergeCheck } from "../merge/post-merge";
import { checkMergeProtection } from "../merge/protection";
import { cannotMintLegacyCredential } from "../middleware/auth";
import { enqueueMergeDeploy } from "../queue/deploy-queue";
import { emitEvent } from "../queue/events";
import type { MergeOutcome } from "../queue/merge-queue";
import {
  createChangeWithEvaluation,
  evaluateWorkspace,
  resolveProjectHead,
} from "../services/change-flow";
import { dispatchChecks } from "../services/check-runs";
import { type DispatchOutcome, dispatchEvaluationRun } from "../services/evaluation-run";
import { dropRejectedConnection, resolvePrAuthor } from "../services/github-pr-author";
import { getCommitLogPreferNative } from "../storage/artifacts-reads";
import { recordAudit } from "../storage/audit";
import {
  TERMINAL_CHANGE_STATUSES,
  beginEvaluationRun,
  newEvaluationRunId,
} from "../storage/change-evaluation";
import {
  type GithubPrLink,
  getChange,
  getChangesByIds,
  listChanges,
  markChangeMerged,
  mergeTransitionOpts,
  recordGithubPrLink,
  recordReevaluation,
  updateChangeStatus,
  updateChangeText,
} from "../storage/changes";
import {
  type CostSample,
  getChangeCostSummary,
  recordCosts,
  resolveBillingSubject,
} from "../storage/costs";
import { isTargetDeleting } from "../storage/deletion";
import { listEvalRuns } from "../storage/eval-runs";
import {
  getExternalPullRequestByChange,
  listExternalChangeIds,
  supersedeImportedChange,
} from "../storage/external-pull-requests";
import {
  MergeConflictError,
  type NodeFS,
  type StagedTreeItem,
  batchMergeStagedTrees,
  cloneRepo,
  freshRepoToken,
  mergeWorkspaceIntoProject,
  parseStagedTree,
  pushBranchToRemote,
  resolveLocalTip,
  rootEntryDiffers,
  stagedTreeKey,
  stagedTreeShaKey,
} from "../storage/git-ops";
import { parseRepoUrl } from "../storage/git-providers";
import { projectPrincipal } from "../storage/github-installations";
import { recordProvenance } from "../storage/provenance";
import { pushMirrorMode } from "../storage/push-mirrors";
import { getProject, getWorkspace } from "../storage/state";
import { getProjectSourceUrl } from "../storage/sync";
import type { Change, Env, ProjectEntry } from "../types";
import { isBehindProject, projectDefaultBranch } from "../types";
import {
  canReadProject,
  canWriteProject,
  credentialBindingFrom,
  refuseProjectAccess,
} from "../utils/authz";
import { parseChangeText } from "../utils/change-text";
import { durableObjectNamespace } from "../utils/durable-objects";
import { getWaitUntil } from "../utils/execution-ctx";
import { newId } from "../utils/ids";
import { createLogger } from "../utils/logger";
import type { Logger } from "../utils/logger";
import { readJsonWithLimit } from "../utils/request-body";
import {
  appError,
  badRequest,
  created,
  internalError,
  notFound,
  ok,
  unauthorized,
} from "../utils/response";

/** The author's login in a pull request GitHub returned, when it names one. */
function githubLoginOf(pr: unknown): string | undefined {
  if (typeof pr !== "object" || pr === null) return undefined;
  const user = (pr as { user?: unknown }).user;
  if (typeof user !== "object" || user === null) return undefined;
  const login = (user as { login?: unknown }).login;
  // Bot logins end in "[bot]"; nothing else outside letters, digits and hyphens is a login.
  return typeof login === "string" && /^[A-Za-z0-9-]{1,64}(\[bot\])?$/.test(login)
    ? login
    : undefined;
}

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
/**
 * Why a batch merge skipped a change whose base could not be compared with the
 * project head. Named because the batch route tells this skip apart from the
 * others: it is the one that means "try again".
 */
const BASE_UNVERIFIABLE_SKIP = "base freshness could not be verified";

/** Default + hard cap for the paginated changes listing (bounds the response). */
const DEFAULT_CHANGES_PAGE = 100;
const MAX_CHANGES_PAGE = 500;

/**
 * Success response for endpoints that the change-detail UI posts to with plain HTML forms.
 * Browsers send a form content type; API/CLI/agent callers send JSON or no body at all,
 * so only form posts are redirected back to the change page.
 */
function okOrFormRedirect<T>(
  c: Context<{ Bindings: Env }>,
  changeId: string,
  data: T,
  status = 200,
): Response {
  const contentType = c.req.header("content-type") ?? "";
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    return c.redirect(`/changes/${changeId}`, 302);
  }
  return ok(data, status);
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
  const logResult = await getCommitLogPreferNative(
    env.ARTIFACTS,
    workspaceRemote,
    readToken.data,
    logger,
    1,
    branch,
  );
  return logResult.success ? (logResult.data[0]?.sha ?? null) : null;
}

/**
 * A change evaluated under asynchronous evaluation (#412) whose run ended
 * without pinning a revision — it failed closed. There is nothing to merge
 * against: force bypasses a failing verdict, not a missing one.
 */
function lacksEvaluatedRevision(change: Change): boolean {
  return change.evaluatedSha === undefined && change.evalRunId !== undefined;
}

/** The pull request coordinates and head a promotion set on its copy of the change. */
function pullRequestFieldsOf(change: Change): Partial<Change> {
  const fields: Partial<Change> = {};
  if (change.githubOwner !== undefined) fields.githubOwner = change.githubOwner;
  if (change.githubRepo !== undefined) fields.githubRepo = change.githubRepo;
  if (change.githubPrNumber !== undefined) fields.githubPrNumber = change.githubPrNumber;
  if (change.githubHeadSha !== undefined) fields.githubHeadSha = change.githubHeadSha;
  return fields;
}

/**
 * Post the change's latest verdict to the pull request it was just promoted to:
 * the comment and the `stratum/evaluation` commit status.
 *
 * Evaluation reports to GitHub only once a pull request is linked, and a change
 * is evaluated before it is promoted, so this is the first moment its verdict
 * has somewhere to go. Without it a promoted pull request carries no Stratum
 * status at all, and `stratum/evaluation` cannot be made a required check.
 *
 * Best-effort, and off the response path where the runtime allows: the pull
 * request exists either way, and a later evaluation reports again.
 */
async function reportVerdictOnPromotion(
  c: Context<{ Bindings: Env }>,
  logger: Logger,
  change: Change,
  project: ProjectEntry,
): Promise<void> {
  const report = async (): Promise<void> => {
    try {
      // Re-read: this runs after the response, and an evaluation may have
      // started or finished since the request read the change. Posting the
      // request's copy could then overwrite a newer verdict with an older one.
      // That evaluation reports for itself, so stand aside unless the change
      // still holds the verdict for the revision that was just pushed.
      const fresh = await getChange(c.env.DB, logger, change.id);
      if (!fresh.success) {
        logger.warn("Could not re-read the change; the promoted PR gets no verdict yet", {
          changeId: change.id,
          error: fresh.error.message,
        });
        return;
      }
      const current = fresh.data;
      if (current.status === "evaluating" || current.evaluatedSha !== change.evaluatedSha) {
        logger.info("Evaluation moved on since promotion; leaving the verdict to it", {
          changeId: change.id,
          status: current.status,
        });
        return;
      }
      const runs = await listEvalRuns(c.env.DB, logger, change.id);
      if (!runs.success) {
        logger.warn("Could not read eval runs; the promoted PR gets no verdict yet", {
          changeId: change.id,
          error: runs.error.message,
        });
        return;
      }
      const evaluation = latestEvaluationReport(current, runs.data);
      if (evaluation === null) return;
      // The stored row for the verdict and the comment id; the pull request
      // coordinates and pushed head from this promotion, in case recording
      // them failed (they are what GitHub has now either way).
      await reportEvaluationToGitHub(
        c.env,
        { ...current, ...pullRequestFieldsOf(change) },
        project,
        evaluation,
        logger,
      );
    } catch (error) {
      logger.warn("Posting the verdict to the promoted PR threw; the promotion stands", {
        changeId: change.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const waitUntil = getWaitUntil(c);
  if (waitUntil) waitUntil(report());
  else await report();
}

/**
 * A promotion whose `promoted` write a pending run held back (#412): a
 * re-evaluation began while the branch was being pushed. The PR exists on
 * GitHub regardless, so its link is kept — otherwise the next promotion opens
 * a duplicate — but the change is not promoted: the run owns its status, and
 * the pushed head may not be the revision it judges. Promoting again once it
 * finishes re-pushes to this PR.
 */
async function promotionHeldByEvaluation(
  c: Context<{ Bindings: Env }>,
  logger: Logger,
  changeId: string,
  pr: {
    owner: string;
    repo: string;
    branch: string;
    prNumber: number;
    prUrl: string;
    link: GithubPrLink;
  },
): Promise<Response> {
  const linkResult = await recordGithubPrLink(c.env.DB, logger, changeId, pr.link);
  if (!linkResult.success) {
    logger.error("Pushed to the PR but did not record its link", linkResult.error, {
      changeId,
      prNumber: pr.prNumber,
    });
  }
  return c.json(
    {
      error:
        "Evaluation started while the change was being promoted; promote again once it has finished",
      code: "EVALUATION_PENDING",
      github: {
        owner: pr.owner,
        repo: pr.repo,
        branch: pr.branch,
        pullRequestNumber: pr.prNumber,
        pullRequestUrl: pr.prUrl,
      },
    },
    409,
  );
}

/**
 * The response for a change whose evaluation run was just dispatched (#412).
 *
 * Queued: `202` with the change in `evaluating` and no verdict — the caller
 * polls `GET /changes/:id` until the status leaves `evaluating`. Run inline
 * because the queue was unavailable: the verdict exists, so the response is
 * what the synchronous API always returned (`201` on creation, `200` on
 * re-evaluation). An inline run that could not finish is reported as the
 * error it is, naming the change so the caller can re-evaluate it rather than
 * open a duplicate.
 */
function respondToDispatch(
  c: Context<{ Bindings: Env }>,
  dispatched: DispatchOutcome,
  change: Change,
  opts: { inlineStatus: 200 | 201 },
): Response {
  if (dispatched.mode === "queued") {
    return okOrFormRedirect(
      c,
      change.id,
      { change, evaluation: { status: "evaluating", runId: change.evalRunId } },
      202,
    );
  }
  const { result } = dispatched;
  if (!result.success) {
    const message = `${result.error.message} (change ${change.id})`;
    return result.error.statusCode >= 500 ? internalError(message) : badRequest(message);
  }
  if (result.data.status === "superseded") {
    // Something moved the change on while the inline run was executing (a
    // reject, a newer run): report where it is rather than a verdict that was
    // never recorded.
    return okOrFormRedirect(c, change.id, { change, evaluation: { status: "superseded" } }, 202);
  }
  const { change: evaluated, evalResult, evalRuns } = result.data;
  const body = { change: evaluated, changeId: evaluated.id, eval: evalResult, evalRuns };
  return opts.inlineStatus === 201
    ? created(body)
    : okOrFormRedirect(c, change.id, body, opts.inlineStatus);
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

  if (!(await canWriteProject(c.env.DB, project, credentialBindingFrom(c), userId, agentOwnerId)))
    return refuseProjectAccess(credentialBindingFrom(c), project, () =>
      notFound("Project", projectName),
    );

  // Refuse writes while the project (or its owner) is being deleted — otherwise a
  // new change resurrects rows the cascade is removing and wedges the job as
  // `incomplete`. Best-effort (TOCTOU); the verifier re-run is the durable backstop.
  if (await isTargetDeleting(c.env, project, logger)) {
    return c.json({ error: "Project is being deleted", code: "TARGET_DELETING" }, 409);
  }

  const body = await readJsonWithLimit<{
    workspace?: unknown;
    title?: unknown;
    description?: unknown;
  }>(c, MAX_CHANGE_CREATE_BODY_BYTES, logger).catch(
    () =>
      ({ workspace: undefined }) as { workspace?: unknown; title?: unknown; description?: unknown },
  );
  if (body instanceof Response) return body;
  if (typeof body.workspace !== "string" || !body.workspace.trim()) {
    return badRequest("workspace is required");
  }
  const text = parseChangeText(body);
  if (!text.success) return badRequest(text.error);

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

  // With an evaluation queue bound, the change is created in `evaluating` and
  // the evaluators run on the queue consumer, so creation latency no longer
  // includes them (#412). Without one, evaluation runs inline as it always did.
  const queueRun = c.env.EVALUATION_QUEUE ? { runId: newEvaluationRunId() } : undefined;
  const waitUntil = getWaitUntil(c);
  const outcome = await createChangeWithEvaluation(c.env, logger, {
    project,
    projectName,
    workspaceName: body.workspace,
    workspaceRemote: workspace.remote,
    ...(typeof text.data.title === "string" ? { title: text.data.title } : {}),
    ...(typeof text.data.description === "string" ? { description: text.data.description } : {}),
    actor: {
      ...(userId !== undefined ? { userId } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
      ...(agentOwnerId !== undefined ? { agentOwnerId } : {}),
    },
    waitUntil,
    requestOrigin: new URL(c.req.url).origin,
    ...(queueRun ? { queueRun } : {}),
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
  if (outcome.data.mode === "evaluated") {
    const { change: updatedChange, evalResult, evalRuns: recordedRuns } = outcome.data;
    return created({ change: updatedChange, eval: evalResult, evalRuns: recordedRuns });
  }
  return respondToDispatch(
    c,
    await dispatchEvaluationRun(
      c.env,
      logger,
      { changeId: outcome.data.change.id, runId: outcome.data.runId },
      { requestOrigin: new URL(c.req.url).origin, ...(waitUntil ? { waitUntil } : {}) },
    ),
    outcome.data.change,
    { inlineStatus: 201 },
  );
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

  if (!(await canReadProject(c.env.DB, project, credentialBindingFrom(c), userId, agentOwnerId)))
    return notFound("Project", `${project.namespace}/${project.slug}`);

  const statusParam = c.req.query("status");
  const validStatuses: Change["status"][] = [
    "open",
    "evaluating",
    "external",
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

  if (!(await canReadProject(c.env.DB, project, credentialBindingFrom(c), userId, agentOwnerId)))
    return notFound("Project", `${project.namespace}/${project.slug}`);

  const evalRunsResult = await listEvalRuns(c.env.DB, logger, id);
  if (!evalRunsResult.success) {
    logger.error("Failed to list eval runs", evalRunsResult.error);
    return badRequest(evalRunsResult.error.message);
  }

  const costsResult = await getChangeCostSummary(c.env.DB, logger, id);
  // Present only for a change that came from the mirror's pull request (#420).
  const external = await getExternalPullRequestByChange(c.env.DB, logger, id);

  logger.info("Change retrieved", { changeId: id });
  return ok({
    change,
    evalRuns: evalRunsResult.data,
    costs: costsResult.success ? costsResult.data : [],
    ...(external.success && external.data !== null
      ? { externalPullRequest: toExternalPullRequestView(external.data) }
      : {}),
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

  if (!(await canWriteProject(c.env.DB, project, credentialBindingFrom(c), userId)))
    return refuseProjectAccess(credentialBindingFrom(c), project, () => notFound("Change", id));

  // A pull request nobody has imported (#420). Refused before force is even
  // considered: force bypasses a verdict, and this change has no workspace
  // content a maintainer chose to bring in, let alone a verdict on it.
  if (change.status === "external") {
    return c.json(
      {
        error: "This pull request has not been imported; import it before merging",
        code: "EXTERNAL_NOT_IMPORTED",
      },
      409,
    );
  }
  // Whether the change began as a pull request on the mirror. It decides only
  // how the merge is written, never whether it is allowed: such a change takes
  // the paths that keep its commits, so the people who wrote them stay the
  // authors of what lands. A failed lookup stops the merge instead of quietly
  // choosing a path that would drop them.
  const externalOrigin = await getExternalPullRequestByChange(c.env.DB, logger, id);
  if (!externalOrigin.success) return internalError("Failed to read the change's origin");
  const fromPullRequest = externalOrigin.data;
  // The one thing it does refuse: commits the pull request has moved past. A
  // push normally sends the change back to `external`, but that takes two
  // writes, and an import that died between starting its run and noticing
  // the new head leaves the old commits evaluating, and later mergeable.
  // This reads the stored record, so it holds whatever was interrupted, and
  // it is not something `force` may skip.
  if (fromPullRequest !== null && fromPullRequest.headSha !== fromPullRequest.importedHeadSha) {
    // Finish what was interrupted: the change goes back to `external`, the
    // only state an import accepts. Without this the refusal would ask for
    // an import the API then refuses.
    const superseded = await supersedeImportedChange(c.env.DB, logger, id);
    if (!superseded.success) return internalError("Failed to return the change to external");
    return c.json(
      {
        error: `Pull request #${fromPullRequest.prNumber} has commits newer than the ones that were imported; import them before merging`,
        code: "PR_HEAD_MOVED",
        headSha: fromPullRequest.headSha,
      },
      409,
    );
  }

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

  // Refused even under force (#412). Force bypasses a verdict; it cannot bypass
  // the absence of one. A change still evaluating has no evaluated revision
  // pinned — or, on a re-evaluation, a pin the pending run is about to replace
  // — so the merge would land code no gate has judged.
  if (change.status === "evaluating") {
    return c.json(
      {
        error: "Evaluation is still pending; merge once it has finished",
        code: "EVALUATION_PENDING",
      },
      409,
    );
  }

  // The same rule once a run has ended without a verdict: one that failed
  // closed (retries exhausted, the sweep gave up, the workspace vanished)
  // leaves the change needs_changes with nothing pinned, and a merge — forced,
  // or after a human approved it anyway — would land the live workspace tip.
  // Changes from before asynchronous evaluation carry no run id and keep their
  // old behaviour; every change since has one.
  if (lacksEvaluatedRevision(change)) {
    return c.json(
      {
        error: "This change has no evaluated revision; re-evaluate it before merging",
        code: "EVALUATION_MISSING",
      },
      409,
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

    if (mergePolicy.merge?.requireFreshBase) {
      // Fails closed both ways it used to skip (#415, ADR 012). A project that
      // gates on CI relies on this rule to mean "what merges is what was
      // tested": checks run against base + change, so a change with no
      // recorded base, or a head nobody could read, has no such guarantee —
      // and "could not check" must not be read as "fresh".
      if (change.baseSha === undefined) {
        return c.json(
          {
            error:
              "Change has no recorded base, so its freshness cannot be verified; re-evaluate the change",
            code: "STALE_BASE",
          },
          409,
        );
      }
      const currentHead = await resolveProjectHead(c.env, project, logger);
      if (currentHead === null) {
        return c.json(
          {
            error:
              "Could not read the project's current head to verify the change's base is fresh; try again",
            code: "BASE_UNVERIFIABLE",
            baseSha: change.baseSha,
          },
          503,
        );
      }
      if (currentHead !== change.baseSha) {
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
  const repoDo =
    c.env.REPO_DO_ENABLED === "true" ? durableObjectNamespace(c.env, "REPO_DO") : undefined;
  const mergeQueue = durableObjectNamespace(c.env, "MERGE_QUEUE");
  let serializedMerge: (() => Promise<MergeOutcome>) | undefined;
  if (repoDo) {
    serializedMerge = async () => {
      const stub = repoDo.get(repoDo.idFromName(project.id)) as unknown as {
        mergeViaR2(changeId: string): Promise<MergeOutcome | { fallback: true }>;
        advance(changeId: string): Promise<MergeOutcome>;
      };
      // Prefer the R2 fetch-free path; fall back to the Phase-1 FF/cold path when the
      // change has no staged tree (e.g. committed before R2 staging was enabled).
      // A change from a pull request always takes the second (#420): the R2
      // path lands a commit of its own built from the staged tree, which
      // would discard the contributor's commits and their authorship.
      const r2 = fromPullRequest !== null ? { fallback: true as const } : await stub.mergeViaR2(id);
      return "fallback" in r2 ? await stub.advance(id) : r2;
    };
  } else if (mergeQueue) {
    serializedMerge = async () => {
      const stub = mergeQueue.get(mergeQueue.idFromName(change.project));
      return await (stub as unknown as { merge(changeId: string): Promise<MergeOutcome> }).merge(
        id,
      );
    };
  }
  if (serializedMerge && strategy === "merge") {
    const result = await serializedMerge();

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
      via: repoDo ? "repo-do" : "merge-queue",
    });

    // Push mirror (#417). Asked for here, once the merge has landed, and before
    // the post-merge check, which can run for minutes. The mirror pushes
    // whatever the branch is when it runs, so asking early costs nothing if the
    // check then reverts: the revert is a new commit on top, and is requested
    // again below. Never throws, and a project with no mirror is one no-op
    // UPDATE.
    await requestPushMirror(c.env, logger, change.projectId ?? project.id, "change merged");

    if (force) {
      const auditResult = await recordAudit(c.env.DB, logger, {
        action: "merge.forced",
        actorType: "user",
        actorId: userId,
        subject: id,
        project,
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
    if (postMergeViaQueue.status === "reverted") {
      await requestPushMirror(c.env, logger, change.projectId ?? project.id, "merge reverted");
    }

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
      // A squash drops the contributor's commits, so name them on the one it
      // writes (#420). The trailers are rebuilt from sanitized stored authors.
      ...(fromPullRequest !== null && strategy === "squash"
        ? { messageTrailers: coAuthorTrailers(fromPullRequest.commitAuthors) }
        : {}),
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
    if (
      mergeResult.error.code === "STALE_WORKSPACE" ||
      mergeResult.error.code === "WORKSPACE_BEHIND"
    ) {
      return c.json({ error: mergeResult.error.message, code: mergeResult.error.code }, 409);
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

  // Push mirror (#417): same placement and reasoning as the queue path above.
  await requestPushMirror(c.env, logger, change.projectId ?? project.id, "change merged");

  if (force) {
    const auditResult = await recordAudit(c.env.DB, logger, {
      action: "merge.forced",
      actorType: "user",
      actorId: userId,
      subject: id,
      project,
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

  if (postMerge.status === "reverted") {
    await requestPushMirror(c.env, logger, change.projectId ?? project.id, "merge reverted");
  }

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
  if (!(await canWriteProject(c.env.DB, project, credentialBindingFrom(c), userId)))
    return refuseProjectAccess(credentialBindingFrom(c), project, () =>
      notFound("Project", projectName),
    );

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
  // A batch lands each change as a commit of its own, which would discard a
  // pull request's commits and their authors (#420). Those merge one at a time.
  const fromPullRequests = await listExternalChangeIds(c.env.DB, logger, changeIds);
  if (!fromPullRequests.success) return internalError(fromPullRequests.error.message);
  const resolved = await Promise.all(
    changeIds.map(async (id) => {
      const change = changeMap.get(id);
      if (!change) return { id, skip: "not found" };
      if (fromPullRequests.data.has(id)) {
        return {
          id,
          skip: "came from a pull request; merge it on its own so its commits are kept",
        };
      }
      if (change.project !== projectName && change.project !== project.id)
        return { id, skip: "wrong project" };
      if (change.status === "evaluating") return { id, skip: "evaluation pending" };
      if (lacksEvaluatedRevision(change)) return { id, skip: "no evaluated revision" };
      if (!MERGEABLE_STATUSES.includes(change.status)) return { id, skip: "not mergeable" };
      if (!change.baseSha) return { id, skip: "no base" };
      // A batch lands each workspace's whole tree on top of `baseSha`, which
      // for a workspace that is behind is more than was evaluated. Not waived
      // by `force`: it is about what would land, not about a gate.
      if (isBehindProject(change)) {
        return { id, skip: "workspace is behind the project; merge this change on its own" };
      }
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
          // An unreadable head skips the change rather than merging it
          // unchecked — the same fail-closed rule as the single-merge path.
          if (currentHead === null) return { id, skip: BASE_UNVERIFIABLE_SKIP };
          if (change.baseSha !== currentHead) return { id, skip: "stale base" };
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
    // Nothing can merge, and at least one change was held back only because
    // the head could not be read. That is a fault to retry, not a batch with
    // nothing eligible in it, so answer as the single-merge route does.
    if (skipped.some((s) => s.reason === BASE_UNVERIFIABLE_SKIP)) {
      return c.json(
        {
          error:
            "Could not read the project's current head to verify that the changes' bases are fresh; try again",
          code: "BASE_UNVERIFIABLE",
          skipped,
        },
        503,
      );
    }
    // The reasons ride along: "0 of 1 merged" with no reason sends a caller
    // looking for a fault where there is a rule.
    return c.json(
      { error: `No eligible changes to merge (${skipped.length} skipped)`, skipped },
      400,
    );
  }
  const resolveMs = Date.now() - tResolve;

  // Merge inside the per-repo DO: local SQLite hot-index reads + warm reused clone +
  // one push. Keyed by project.id (same key the commit route seeds the index under).
  const repoDo = durableObjectNamespace(c.env, "REPO_DO");
  if (!repoDo) return internalError("RepoDO not bound");
  const stub = repoDo.get(repoDo.idFromName(project.id)) as unknown as {
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

  // Push mirror (#417): the batch has been pushed to the project, so the
  // default branch moved if anything in it merged. One request covers the
  // whole batch — the mirror pushes the branch tip, not individual commits.
  if (mergeResult.data.some((r) => r.merged)) {
    await requestPushMirror(c.env, logger, project.id, "batch merged");
  }

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
    // One deploy for the whole batch, of its FINAL commit (#416). A batch is
    // one push: its last synthetic commit contains every change that landed,
    // so deploying each change's own commit in turn would publish N
    // intermediate trees to reach the same place. The deployment is recorded
    // against the last change that landed. A batch runs no post-merge check,
    // so there is nothing that could have reverted it: `skipped`.
    //
    // After the status write, and inside it, on purpose: the deploy runner
    // re-reads the change and refuses one that is not `merged` yet.
    const last = landed[landed.length - 1];
    if (last !== undefined) {
      await enqueueMergeDeploy(c.env, logger, {
        projectId: project.id,
        changeId: last.changeId,
        commitSha: last.commit,
        postMergeStatus: "skipped",
        mergedAt,
      });
    }
    // Force-merges bypass evaluation/approval gates, so every one must leave an
    // audit trail — the single-merge path records `merge.forced` too (SEC-2).
    if (force) {
      for (const changeId of merged) {
        const auditResult = await recordAudit(c.env.DB, logger, {
          action: "merge.forced",
          actorType: "user",
          actorId: userId,
          subject: changeId,
          project,
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

/**
 * Outcomes of an import the change page knows how to describe. A form
 * round-trip carries one of these codes and nothing else; a refusal that is a
 * property of the pull request is stored on it and shown from there.
 */
export const IMPORT_NOTICES = {
  CONTRIBUTOR_AGREEMENT_REQUIRED:
    "Confirm that the contributor has agreed to this project's contributor agreement, then import again.",
  PR_HEAD_MOVED: "The pull request has new commits. Look at it again before importing.",
  PR_NOT_OPEN: "The pull request is no longer open against the default branch on the mirror.",
  EXTERNAL_IMPORT_UNAVAILABLE: "This project's mirror no longer accepts pull requests.",
  NOT_EXTERNAL: "This change is not waiting to be imported.",
  REFUSED: "The pull request cannot be imported as it stands. The reason is shown below.",
  FAILED: "The pull request could not be imported. Try again shortly.",
} as const;

/** The message for an `?import=` code, or undefined for anything else. */
export function importNotice(code: string | undefined): string | undefined {
  return code !== undefined && Object.hasOwn(IMPORT_NOTICES, code)
    ? IMPORT_NOTICES[code as keyof typeof IMPORT_NOTICES]
    : undefined;
}

/** Refusals that are stored on the pull request and shown on its change. */
const STORED_REFUSALS = new Set([
  "PR_TOO_MANY_COMMITS",
  "PR_TOO_MANY_FILES",
  "PR_TOO_LARGE",
  "PR_UNRELATED_HISTORY",
  "PR_CONFLICTS",
  "PR_EMPTY",
  "SUBMODULES_UNSUPPORTED",
  "LFS_UNSUPPORTED",
]);

/**
 * POST /api/changes/:id/import — bring an external change's pull request into
 * a workspace and start its evaluation (#420).
 *
 * A person with write access to the project, and nobody else: an agent
 * credential is refused, as it is for a merge. This is the decision to run a
 * stranger's code through the project's evaluators and CI, and the place the
 * contributor agreement is confirmed.
 *
 * Body (JSON or form): `agreementConfirmed` — required where the project asks
 * for it; `headSha` — the head the caller looked at, so that an import of
 * commits pushed since is refused.
 */
app.post("/changes/:id/import", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  if (!userId) return unauthorized("Only authenticated users can import a pull request");

  const { id } = c.req.param();
  const changeResult = await getChange(c.env.DB, logger, id);
  if (!changeResult.success) {
    if (changeResult.error.code === "NOT_FOUND") return notFound("Change", id);
    logger.error("Failed to get change", changeResult.error);
    return internalError(changeResult.error.message);
  }
  const change = changeResult.data;

  const projectResult = await getProject(c.env.STATE, change.project, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") return notFound("Project", change.project);
    logger.error("Failed to get project", projectResult.error);
    return internalError(projectResult.error.message);
  }
  const project = projectResult.data;

  if (!(await canWriteProject(c.env.DB, project, credentialBindingFrom(c), userId)))
    return refuseProjectAccess(credentialBindingFrom(c), project, () => notFound("Change", id));

  const contentType = c.req.header("content-type") ?? "";
  const isForm =
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data");
  const refuse = (code: string, message: string, status: number) => {
    if (isForm) {
      const notice = STORED_REFUSALS.has(code)
        ? "REFUSED"
        : Object.hasOwn(IMPORT_NOTICES, code)
          ? code
          : "FAILED";
      return c.redirect(`/changes/${id}?import=${notice}`, 302);
    }
    return c.json({ error: message, code }, status as 400 | 409 | 422 | 500 | 502);
  };

  if (await isTargetDeleting(c.env, project, logger)) {
    return refuse("TARGET_DELETING", "Project is being deleted", 409);
  }

  let agreementConfirmed = false;
  let expectedHeadSha: string | undefined;
  if (isForm) {
    const form = await c.req.parseBody();
    // A checkbox is present when ticked and absent otherwise.
    agreementConfirmed = form.agreementConfirmed !== undefined;
    if (typeof form.headSha === "string" && form.headSha !== "") expectedHeadSha = form.headSha;
  } else {
    const body = await readJsonWithLimit<{ agreementConfirmed?: unknown; headSha?: unknown }>(
      c,
      MAX_CHANGE_CREATE_BODY_BYTES,
      logger,
    ).catch(() => ({}) as { agreementConfirmed?: unknown; headSha?: unknown });
    if (body instanceof Response) return body;
    agreementConfirmed = body.agreementConfirmed === true;
    if (typeof body.headSha === "string" && body.headSha !== "") expectedHeadSha = body.headSha;
  }

  const waitUntil = getWaitUntil(c);
  const imported = await importPullRequest(c.env, logger, {
    project,
    change,
    userId,
    agreementConfirmed,
    ...(expectedHeadSha !== undefined ? { expectedHeadSha } : {}),
    requestOrigin: new URL(c.req.url).origin,
    ...(waitUntil ? { waitUntil } : {}),
  });
  if (!imported.success) {
    const { code, message, statusCode } = imported.error;
    if (statusCode >= 500) logger.error("Pull request import failed", imported.error);
    // GitHub refusing the App's token arrives carrying GitHub's own 401, 403
    // or 404. Passed on, a caller would read those as a bad Stratum
    // credential or a missing change; it is the upstream that said no.
    const status =
      code === "GITHUB_ACCESS_DENIED"
        ? 502
        : statusCode >= 500 && statusCode !== 502
          ? 500
          : statusCode;
    return refuse(code, message, status);
  }

  if (isForm) return c.redirect(`/changes/${id}`, 302);
  const current = await getChange(c.env.DB, logger, id);
  return ok(
    {
      change: current.success ? current.data : imported.data.change,
      externalPullRequest: toExternalPullRequestView(imported.data.record),
      evaluation: { runId: imported.data.runId, mode: imported.data.dispatched.mode },
    },
    202,
  );
});

// PATCH /changes/:id — set or clear the title and description.
//
// Open to anyone who can write to the project, agents included: the text is the
// author's account of the change, not a gate, and nothing reads it to decide
// whether the change may merge.
app.patch("/changes/:id", async (c) => {
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

  const { id } = c.req.param();
  const changeResult = await getChange(c.env.DB, logger, id);
  if (!changeResult.success) {
    if (changeResult.error.code === "NOT_FOUND") return notFound("Change", id);
    logger.error("Failed to get change", changeResult.error);
    return internalError(changeResult.error.message);
  }
  const change = changeResult.data;

  const projectResult = await getProject(c.env.STATE, change.project, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") return notFound("Project", change.project);
    logger.error("Failed to get project", projectResult.error);
    return internalError(projectResult.error.message);
  }
  const project = projectResult.data;
  if (!(await canWriteProject(c.env.DB, project, credentialBindingFrom(c), userId, agentOwnerId)))
    return refuseProjectAccess(credentialBindingFrom(c), project, () => notFound("Change", id));

  const body = await readJsonWithLimit<{ title?: unknown; description?: unknown }>(
    c,
    MAX_CHANGE_CREATE_BODY_BYTES,
    logger,
  ).catch(() => ({}) as { title?: unknown; description?: unknown });
  if (body instanceof Response) return body;
  const text = parseChangeText(body);
  if (!text.success) return badRequest(text.error);
  if (text.data.title === undefined && text.data.description === undefined) {
    return badRequest("Give a title, a description, or both");
  }

  const updated = await updateChangeText(c.env.DB, logger, id, text.data);
  if (!updated.success) {
    // The change can be deleted between the lookup above and the write.
    if (updated.error.code === "NOT_FOUND") return notFound("Change", id);
    logger.error("Failed to update change text", updated.error);
    return internalError(updated.error.message);
  }
  logger.info("Change text updated", { changeId: id });
  return c.json({ change: updated.data });
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

  if (!(await canWriteProject(c.env.DB, project, credentialBindingFrom(c), userId)))
    return refuseProjectAccess(credentialBindingFrom(c), project, () => notFound("Change", id));

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

  if (!(await canWriteProject(c.env.DB, project, credentialBindingFrom(c), userId)))
    return refuseProjectAccess(credentialBindingFrom(c), project, () => notFound("Change", id));

  // The same list the recording batch guards on, so a change that cannot take
  // a verdict is refused before anything is spent on evaluating it.
  if (TERMINAL_CHANGE_STATUSES.includes(change.status)) {
    return badRequest(`Cannot re-evaluate a ${change.status} change`);
  }
  // An evaluation is what an import starts, once a maintainer has chosen to
  // bring the pull request's commits in (#420). Evaluating without importing
  // would spend on, and dispatch CI for, content nobody has accepted — or, for
  // an imported change whose pull request moved, pass a verdict on the old
  // commits and make them mergeable again.
  if (change.status === "external") {
    return c.json(
      {
        error: "This pull request has not been imported; import it to evaluate it",
        code: "EXTERNAL_NOT_IMPORTED",
      },
      409,
    );
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

  // With an evaluation queue bound, re-evaluation re-enqueues (#412): the
  // change moves to `evaluating` under a fresh run, which supersedes any run
  // still in flight, and the verdict lands when the consumer records it.
  if (c.env.EVALUATION_QUEUE) {
    const runId = newEvaluationRunId();
    const begun = await beginEvaluationRun(c.env.DB, logger, {
      changeId: id,
      runId,
      requestedBy: userId,
    });
    if (!begun.success) return internalError(begun.error.message);
    if (!begun.data.started) return badRequest("Change can no longer be re-evaluated");
    const waitUntil = getWaitUntil(c);
    const dispatched = await dispatchEvaluationRun(
      c.env,
      logger,
      { changeId: id, runId },
      { requestOrigin: new URL(c.req.url).origin, ...(waitUntil ? { waitUntil } : {}) },
    );
    logger.info("Change re-evaluation dispatched", { changeId: id, runId, mode: dispatched.mode });
    return respondToDispatch(
      c,
      dispatched,
      {
        ...change,
        status: "evaluating",
        evalRunId: runId,
        evalRequestedAt: begun.data.requestedAt,
      },
      { inlineStatus: 200 },
    );
  }

  // The base this re-evaluation's diff is built against — not `change.baseSha`,
  // which records the base at creation and is exactly the value that has gone
  // stale by the time a change is re-evaluated (#274). This route is
  // user-credentialed (agent tokens are rejected above), so the acting user is
  // the caller — the subject PRD §4a checks a limit against.
  const evaluation = await evaluateWorkspace(c.env, logger, {
    project,
    workspaceRemote: workspace.remote,
    actorUserId: userId,
    ...(getWaitUntil(c) ? { waitUntil: getWaitUntil(c) } : {}),
  });
  if (!evaluation.success) {
    return evaluation.error.statusCode >= 500
      ? internalError(evaluation.error.message)
      : badRequest(evaluation.error.message);
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
    billingSubject: evaluateSubject,
    policy: evaluatedPolicy,
  } = evaluation.data;

  // The runs are recorded below, in the same batch as the verdict (issue #5).
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
    forkPointSha: mergeBaseOid,
    // Re-pin to the commit this re-evaluation actually ran against (#115).
    ...(workspaceHeadSha ? { workspaceHeadSha } : {}),
    // Recompute the protected-config flag from the diff this run actually saw
    // (SA-3). Re-evaluation re-pins evaluatedSha to the new tip, which is what
    // the merge route's staleness check compares against — so leaving the flag
    // at its creation-time value would let a change that was benign when opened
    // acquire a policy edit, pass the staleness check, and merge without the
    // approval the flag exists to force.
    touchesProtectedConfig: diffTouchesProtectedConfig(diff),
    // May replace `evaluating` (a change queued on an instance whose queue has
    // since been unbound): `recordReevaluation` always allows that.
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
  // The runs, the dismissal and the re-pin land together or not at all, and
  // not at all if the change reached a final status while this ran
  // (issue #5): inline evaluation does not hold the change in `evaluating`, so
  // a final decision can overtake it, and must not be overwritten by it.
  const recorded = await recordReevaluation(c.env.DB, logger, {
    changeId: id,
    evalRuns,
    dismissApprovals: tipChanged || baseChanged,
    status: newStatus,
    opts: statusOpts,
  });
  if (!recorded.success) {
    logger.error("Failed to record the re-evaluation", recorded.error);
    return internalError(recorded.error.message);
  }
  if (!recorded.data.applied) {
    // Say what actually happened to it: finalized, or deleted outright.
    const now = await getChange(c.env.DB, logger, id);
    if (!now.success && now.error.code === "NOT_FOUND") return notFound("Change", id);
    const finalStatus = now.success ? now.data.status : undefined;
    return c.json(
      {
        error: `The change was ${finalStatus ?? "finalized"} while it was being evaluated, so this evaluation's results and verdict were discarded.`,
        code: "CHANGE_FINALIZED",
        ...(finalStatus !== undefined ? { status: finalStatus } : {}),
      },
      409,
    );
  }
  const { dismissedReviewerIds, runs: recordedRuns } = recorded.data;
  if (dismissedReviewerIds.length > 0) {
    const auditResult = await recordAudit(c.env.DB, logger, {
      action: "review.approvals_dismissed",
      actorType: "user",
      actorId: userId,
      subject: id,
      project,
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

  // The revision is pinned; announce it to the project's check runner (#414).
  // A new set of runs replaces whatever the previous revision's were waiting on.
  await dispatchChecks(c.env, logger, {
    changeId: id,
    project,
    policy: evaluatedPolicy,
    diff,
    baseSha: mergeBaseOid,
    headSha: evaluatedSha,
    headTreeSha: evaluatedTreeOid,
    requestOrigin: new URL(c.req.url).origin,
  });

  // Layer mode: report the verdict to the change's linked GitHub PR (comment
  // upsert + "stratum/evaluation" commit status). Best-effort — a GitHub
  // failure never fails the evaluation — and a no-op for changes without a
  // linked PR or projects without a GitHub source. Scheduled off the request
  // path since it's pure side effect the response doesn't depend on.
  //
  // From the committed row, not the one read at entry: a pull request linked
  // while this ran (a promotion held by it, say) is where the verdict belongs.
  const reportEvaluation = (async () => {
    const committed = await getChange(c.env.DB, logger, id);
    const reported = committed.success
      ? committed.data
      : { ...change, evaluatedSha, ...(workspaceHeadSha ? { workspaceHeadSha } : {}) };
    await reportEvaluationToGitHub(
      c.env,
      reported,
      project,
      buildEvaluationReport(evalResult, evalRuns),
      logger,
    );
  })();
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
  return okOrFormRedirect(c, id, { changeId: id, eval: evalResult, evalRuns: recordedRuns });
});

/** The repository a promotion is targeting, as resolved from the project source. */
type GithubRepoTarget = { owner: string; repo: string };

interface GithubPr {
  number: number;
  html_url: string;
  state: string;
  draft?: boolean;
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

// POST /changes/:id/github-pr/ready — take the change's pull request out of draft.
//
// Promotion opens a draft, so that publishing a change and asking people to
// review it stay two decisions. This is the second one, and unlike promotion
// it is still a person's: agent credentials are refused.
app.post("/changes/:id/github-pr/ready", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  // A browser session, not a scoped API token or an OAuth grant: those act for
  // a person but are exactly what an agent is handed, and marking ready is the
  // step that lets the pull request's code run with the repository's secrets
  // (its preview deploy) and asks people to review it. Checked before the
  // `userId` test so an OAuth grant bound to an agent, which carries no
  // `userId`, gets this answer too and not a bare 401.
  if (cannotMintLegacyCredential(c)) {
    return c.json(
      {
        error:
          "Only a person signed in to Stratum can mark a pull request ready for review; a scoped API token or an OAuth connection cannot.",
        code: "READY_NEEDS_PERSON",
      },
      403,
    );
  }
  const userId = c.get("userId");
  if (!userId) return unauthorized("Authentication required");

  const { id } = c.req.param();
  const changeResult = await getChange(c.env.DB, logger, id);
  if (!changeResult.success) {
    if (changeResult.error.code === "NOT_FOUND") return notFound("Change", id);
    logger.error("Failed to get change", changeResult.error);
    return internalError(changeResult.error.message);
  }
  const change = changeResult.data;

  const projectResult = await getProject(c.env.STATE, change.project, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") return notFound("Project", change.project);
    logger.error("Failed to get project", projectResult.error);
    return internalError(projectResult.error.message);
  }
  const project = projectResult.data;
  if (!(await canWriteProject(c.env.DB, project, credentialBindingFrom(c), userId)))
    return refuseProjectAccess(credentialBindingFrom(c), project, () => notFound("Change", id));

  // The pull request this change was promoted to, as recorded then. Not the
  // project's current source URL: that can be repointed, and this must act on
  // the pull request the change actually has.
  const { githubOwner: owner, githubRepo: repo, githubPrNumber: prNumber } = change;
  if (change.status !== "promoted" || !owner || !repo || prNumber === undefined) {
    return c.json(
      { error: "This change has no open GitHub pull request", code: "NOT_PROMOTED" },
      409,
    );
  }

  const tokenResult = await resolveGitHubToken(
    c.env,
    { owner, repo, principal: projectPrincipal(project), project },
    logger,
  );
  if (!tokenResult.success) {
    const { statusCode, message, code } = tokenResult.error;
    return c.json(
      { error: message, code },
      statusCode === 403 || statusCode === 409 ? statusCode : 400,
    );
  }

  const marked = await new GitHubClient(tokenResult.data.token, logger).markPRReady(
    owner,
    repo,
    prNumber,
  );
  if (!marked.success && marked.closed) {
    // Not GitHub failing: the pull request was closed or merged there and this
    // change never heard (a missed webhook). Record it, so the page stops
    // offering the button instead of failing the same way on every click.
    const noted = await recordGithubPrLink(c.env.DB, logger, id, { githubPrState: "closed" });
    if (!noted.success) {
      logger.error("Could not record that the pull request is closed", noted.error, {
        changeId: id,
      });
    }
    return c.json(
      { error: "The pull request is closed on GitHub", code: "PULL_REQUEST_CLOSED" },
      409,
    );
  }
  if (!marked.success) {
    logger.error("Failed to mark the pull request ready", undefined, {
      changeId: id,
      prNumber,
      reason: marked.error,
    });
    return c.json(
      {
        error: `GitHub did not mark the pull request ready: ${marked.error}`,
        code: "GITHUB_ERROR",
      },
      502,
    );
  }

  const recorded = await recordGithubPrLink(c.env.DB, logger, id, { githubPrDraft: false });
  if (!recorded.success) {
    // The pull request is ready on GitHub either way; the page will offer the
    // button again and the next click finds nothing to do.
    logger.error("Marked the pull request ready but did not record it", recorded.error, {
      changeId: id,
    });
  }
  logger.info("Pull request marked ready for review", {
    changeId: id,
    prNumber,
    alreadyReady: marked.alreadyReady,
  });
  return okOrFormRedirect(c, id, {
    ready: true,
    changeId: id,
    alreadyReady: marked.alreadyReady,
    github: { owner, repo, prNumber, ...(change.githubPrUrl ? { url: change.githubPrUrl } : {}) },
  });
});

/** Where GitHub reads workflows, shared actions and review rules from. */
const GITHUB_CONFIG_DIR = ".github";

/** The promote route's answer for a workspace that moved on from the evaluated
 * revision. One place, so its two checks cannot come to answer differently. */
function staleWorkspaceResponse(
  c: Context<{ Bindings: Env }>,
  evaluatedSha: string | undefined,
  currentTip: string,
): Response {
  return c.json(
    {
      error:
        "Workspace is stale: it advanced since this change was evaluated. Re-evaluate before promoting.",
      code: "STALE_WORKSPACE",
      evaluatedSha,
      currentTip,
    },
    409,
  );
}

/** Why a delegated credential may not promote a change as it stands. */
type PromotionRefusal =
  /** Only a person signed in to the browser may promote it. */
  | { kind: "needs-person"; reason: string }
  /** The workspace moved on from the evaluated revision. Re-evaluating fixes
   * it, and a person is no better placed to promote it than an agent. */
  | { kind: "stale"; currentTip: string };

/**
 * Why this change may not be promoted by the caller's credential, or null if
 * it may.
 *
 * Fails closed: a repository that cannot be read, or a workspace that is not
 * at the revision that was evaluated, is a reason to ask a person, not a
 * reason to let it through.
 */
async function promotionNeedsPerson(
  env: Env,
  logger: Logger,
  args: {
    change: Change;
    project: ProjectEntry;
    workspaceRemote: string;
    workspaceToken: string;
    branch: string;
    /** The repository the pull request will be opened on, and its base branch. */
    github: { token: string; owner: string; repo: string; base: string };
  },
): Promise<PromotionRefusal | null> {
  const { change, project, workspaceRemote, workspaceToken, branch, github } = args;
  const needsPerson = (reason: string): PromotionRefusal => ({ kind: "needs-person", reason });
  const askPerson =
    "A person with write access to the project has to promote it, signed in on the change page.";
  if (change.touchesProtectedConfig) {
    return needsPerson(`This change edits the project's merge-protection config. ${askPerson}`);
  }
  if (change.evaluatedSha === undefined) {
    return needsPerson(`This change has no evaluated revision on record. ${askPerson}`);
  }
  const projectToken = await freshRepoToken(env.ARTIFACTS, project.remote, "read", logger);
  const compared = projectToken.success
    ? await rootEntryDiffers(
        project.remote,
        projectToken.data,
        workspaceRemote,
        workspaceToken,
        logger,
        GITHUB_CONFIG_DIR,
        branch,
      )
    : projectToken;
  if (!compared.success) {
    logger.error("Could not compare .github to check a promotion", compared.error, {
      changeId: change.id,
    });
    return needsPerson(`The change's files could not be checked right now. ${askPerson}`);
  }
  if (compared.data.workspaceOid !== change.evaluatedSha) {
    return { kind: "stale", currentTip: compared.data.workspaceOid };
  }
  if (compared.data.differs) {
    return needsPerson(
      `The workspace's ${GITHUB_CONFIG_DIR}/ differs from the project's. A pull request runs the workflows on its own branch with the repository's secrets, as soon as it opens. ${askPerson} If the change does not touch ${GITHUB_CONFIG_DIR}/, the workspace is behind the project: bring it up to date and evaluate again.`,
    );
  }

  // The same question asked of GitHub itself. The project is a copy of the
  // repository as of its last sync, and the pull request runs on the
  // repository as it is now: a workspace forked from a project that has
  // fallen behind would publish the workflows of that older day, which may be
  // the very ones a later commit on GitHub fixed.
  const onGitHub = await new GitHubClient(github.token, logger).getRootTreeEntryOid(
    github.owner,
    github.repo,
    github.base,
    GITHUB_CONFIG_DIR,
  );
  if (!onGitHub.success) {
    logger.error("Could not read .github from GitHub to check a promotion", undefined, {
      changeId: change.id,
      reason: onGitHub.error,
    });
    return needsPerson(
      `The repository's ${GITHUB_CONFIG_DIR}/ on GitHub could not be checked right now. ${askPerson}`,
    );
  }
  if (onGitHub.oid !== compared.data.workspaceEntryOid) {
    return needsPerson(
      `The workspace's ${GITHUB_CONFIG_DIR}/ differs from ${github.base} on GitHub, so the project is behind its GitHub repository. Sync the project, bring the workspace up to date and evaluate again. ${askPerson}`,
    );
  }
  return null;
}

app.post("/changes/:id/github-pr", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  // Agents may promote, as well as people. A change can only be promoted once
  // it is accepted, so the gates have already passed on what gets published,
  // and the caller still needs write access to the project (an agent has its
  // owner's). Merging the pull request remains GitHub's decision.
  const userId = c.get("userId");
  const agentId = c.get("agentId");
  const agentOwnerId = c.get("agentOwnerId");
  if (!userId && !agentId) return unauthorized("Authentication required");

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

  if (!(await canWriteProject(c.env.DB, project, credentialBindingFrom(c), userId, agentOwnerId)))
    return refuseProjectAccess(credentialBindingFrom(c), project, () => notFound("Change", id));

  // After authorization, not before: the change's state is not the caller's to
  // learn until they may act on it.
  if (change.status !== "accepted" && change.status !== "promoted") {
    return badRequest("Change must be accepted before promotion");
  }

  // Accept the generic sourceUrl or the legacy githubUrl — bulk-imported
  // projects only set sourceUrl (#189) — as long as it points at github.com.
  // Via the shared accessor, so this can't drift from the precedence the rest
  // of the codebase uses: sourceUrl wins. A project migrated off githubUrl
  // keeps the stale value, and this URL is what the branch is force-pushed to,
  // so preferring the legacy field would publish to the wrong repository.
  // A project is in layer mode or forge mode, not both (#417). With a push
  // mirror enabled its GitHub repository is a read-only copy: a pull request
  // opened there could only ever be merged on GitHub, which is exactly the
  // divergence the mirror then stops on.
  const mirrorMode = await pushMirrorMode(c.env.DB, logger, project.id);
  if (mirrorMode === "unknown") {
    return c.json(
      {
        error:
          "Could not check whether this project mirrors to GitHub, so the change was not promoted. Try again.",
        code: "PUSH_MIRROR_UNKNOWN",
      },
      503,
    );
  }
  if (mirrorMode === "forge") {
    return c.json(
      {
        error:
          "This project mirrors to GitHub, so changes merge in Stratum and are not promoted to GitHub pull requests",
        code: "PUSH_MIRROR_ENABLED",
      },
      409,
    );
  }

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

  // Opening a pull request and asking people to review it are two decisions,
  // and the second is a person's: `/github-pr/ready` refuses delegated
  // credentials. One that could promote with `draft: false` would make both at
  // once. "A person" is a browser session here, as for the `.github/` check
  // below: an API token or an OAuth grant acts for a user but is exactly what
  // an agent is handed. It matters beyond review: a ready pull request runs
  // this repository's preview deploy, with its secrets, on every push.
  const delegated = userId === undefined || cannotMintLegacyCredential(c);
  // Anything but an explicit or absent `true` is a request not to open a
  // draft; GitHub is not left to decide what `"false"` or `0` means.
  if (delegated && body.draft !== undefined && body.draft !== true) {
    return c.json(
      {
        error:
          "Only a person signed in to Stratum can open a pull request that is not a draft; an agent, a scoped API token or an OAuth connection opens a draft. Leave `draft` out, and ask a person to mark the pull request ready for review.",
        code: "PROMOTION_NEEDS_PERSON",
      },
      403,
    );
  }

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
  // never persisted) was never valid here. The GitHub App's installation token
  // for this repo when installed, else the instance GITHUB_TOKEN; the same
  // token drives both the push and the PR API call below.
  // On behalf of the project's owner: the installation must be linked to them,
  // since anyone can point a project's source URL at any repository.
  // A write, so the project must also be the repo's canonical target.
  const tokenResult = await resolveGitHubToken(
    c.env,
    { ...repo, principal: projectPrincipal(project), project },
    logger,
  );
  if (!tokenResult.success) {
    const { statusCode, message, code } = tokenResult.error;
    return c.json(
      { error: message, code },
      statusCode === 403 || statusCode === 409 ? statusCode : 400,
    );
  }
  const githubToken = tokenResult.data.token;

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
      return staleWorkspaceResponse(c, change.evaluatedSha, publishedSha);
    }
  }

  // Any credential with write access may publish a change the gates accepted,
  // with two exceptions that need a person signed in to the browser. A pull
  // request from a branch of the repository itself runs that branch's own
  // workflow files with the repository's secrets, so a change under `.github/`
  // would run as written the moment it is promoted. And a change to the
  // project's merge-protection config needs a human approval to merge; it
  // should not reach GitHub on an agent's say-so either.
  //
  // "A person" means a browser session, as it does for approvals: an API token
  // or an OAuth grant acts for a user but is exactly what an agent is handed.
  if (delegated) {
    const refusal = await promotionNeedsPerson(c.env, logger, {
      change,
      project,
      workspaceRemote,
      workspaceToken: repoTokenResult.data,
      branch: defaultBranch,
      github: { token: githubToken, owner: repo.owner, repo: repo.repo, base },
    });
    if (refusal?.kind === "stale") {
      // Reachable only if the workspace advanced between the clone checked
      // above and this one. The same answer as that check gives.
      return staleWorkspaceResponse(c, change.evaluatedSha, refusal.currentTip);
    }
    if (refusal) {
      logger.warn("Refusing promotion by a delegated credential", {
        changeId: id,
        agentId,
        reason: refusal.reason,
      });
      return c.json({ error: refusal.reason, code: "PROMOTION_NEEDS_PERSON" }, 403);
    }
  }

  // New commits on a delegated credential's say-so must not land on a pull
  // request a person has already marked ready: that would put them in front of
  // reviewers, and through the preview deploy run them with the repository's
  // secrets, without anyone choosing to. So such a pull request goes back to
  // draft first, and a person marks it ready again. This is every re-promotion
  // after review asked for changes, and also the rarer case of a pull request
  // that exists on GitHub but not on the change's record.
  if (delegated) {
    const toDraft = await new GitHubClient(githubToken, logger).returnHeadPRsToDraft(
      repo.owner,
      repo.repo,
      branch,
    );
    if (!toDraft.success) {
      logger.error("Could not return the change's pull request to draft", undefined, {
        changeId: id,
        branch,
        error: toDraft.error,
      });
      return c.json(
        {
          error: `Promoting again on a delegated credential first returns the open pull request to draft, and GitHub refused: ${toDraft.error}. Nothing was pushed.`,
          code: "GITHUB_ERROR",
        },
        502,
      );
    }
    if (toDraft.converted.length > 0) {
      logger.info("Returned the change's pull request to draft before pushing", {
        changeId: id,
        prNumbers: toDraft.converted,
      });
      // The change page offers "Mark ready for review" only while the record
      // says draft, and the `converted_to_draft` webhook may be late or lost.
      // Not fatal: the pull request is a draft either way, which is the safe
      // side; the webhook still corrects the record when it arrives.
      const noted = await recordGithubPrLink(c.env.DB, logger, id, { githubPrDraft: true });
      if (!noted.success) {
        logger.error("Returned the pull request to draft but did not record it", noted.error, {
          changeId: id,
        });
      }
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
        // Whoever pushed this revision, person or agent: this write can be the
        // one that marks the change promoted, and must not do so anonymously.
        promotedBy: userId ?? agentId,
      });
      if (!headShaResult.success && headShaResult.error.code === "EVALUATION_PENDING") {
        return promotionHeldByEvaluation(c, logger, id, {
          owner: repo.owner,
          repo: repo.repo,
          branch,
          prNumber: storedPr.number,
          prUrl: storedPr.html_url,
          link: { githubHeadSha: publishedSha },
        });
      }
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
    await reportVerdictOnPromotion(
      c,
      logger,
      {
        ...change,
        ...(publishedSha !== undefined ? { githubHeadSha: publishedSha } : {}),
      },
      project,
    );
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
    `## Stratum review\n\n- Change: \`${change.id}\`\n- Workspace: \`${change.workspace}\`\n- Evaluation: ${change.evalPassed ? "passed" : "failed"}, score ${change.evalScore ?? "n/a"}\n\n${body.body ?? change.description ?? ""}`.trim();

  // Duplicate-head 422 → look up + reuse the open PR GitHub already has for
  // this head lives in the client (createOrReusePR): a re-promotion race, or
  // a retry after `updateChangeStatus` failed post-creation, both 422 here,
  // and the PR the caller wanted already exists either way.
  const prOptions = {
    owner: repo.owner,
    repo: repo.repo,
    title: body.title ?? change.title ?? `Stratum: ${change.id}`,
    body: prBody,
    head: branch,
    base,
    draft: body.draft ?? true,
  };
  // A duplicate-head lookup hit is only worth reusing if it's a PR this
  // route would be willing to persist — otherwise the original create
  // error is the more useful thing to report (see isUsableGithubPr above).
  const isReusable = (candidate: unknown) => isUsableGithubPr(candidate, repo);

  // The branch was pushed with the app's token above and stays that way; only
  // this call decides the pull request's author. As the person promoting when
  // they have connected GitHub, as the app otherwise, and as the app again if
  // GitHub will not have it from them: their access to this repository is not
  // something a promotion should fail on.
  // An agent promoting acts for its owner, the person answerable for it: the
  // pull request is theirs, and GitHub then stops them approving it themselves.
  let author = await resolvePrAuthor(c.env, userId ?? agentOwnerId, logger);
  let result =
    author.kind === "user"
      ? await new GitHubClient(author.token, logger, { personal: true }).createOrReusePR(
          prOptions,
          isReusable,
        )
      : undefined;
  if (author.kind === "user" && result !== undefined && !result.success) {
    logger.warn("GitHub would not open the pull request as the person; opening it as the app", {
      changeId: id,
      userId: author.userId,
      status: result.status,
    });
    if (result.status === 401) await dropRejectedConnection(c.env, author.userId, logger);
    author = { kind: "app", reason: "github_refused" };
    result = undefined;
  }
  result ??= await new GitHubClient(githubToken, logger).createOrReusePR(prOptions, isReusable);

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

  const prLink: GithubPrLink = {
    githubOwner: repo.owner,
    githubRepo: repo.repo,
    githubBranch: branch,
    githubPrNumber: pr.number,
    githubPrUrl: pr.html_url,
    githubPrState: pr.state,
    // As GitHub reports it. A reused pull request keeps whatever it was, and
    // one whose response omits the field was opened as this request asked.
    githubPrDraft: pr.draft ?? body.draft ?? true,
    // The revision actually force-pushed as this PR's head — only known
    // precisely when the evaluatedSha gate above ran (legacy changes with no
    // evaluatedSha have no pinned revision to record here).
    ...(publishedSha !== undefined ? { githubHeadSha: publishedSha } : {}),
  };
  const updateResult = await updateChangeStatus(c.env.DB, logger, id, "promoted", {
    ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
    ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
    ...(change.evalReason !== undefined ? { evalReason: change.evalReason } : {}),
    ...prLink,
    promotedAt,
    // The agent itself when one promoted, not its owner: this is the record of
    // who published the change.
    ...(userId !== undefined || agentId !== undefined ? { promotedBy: userId ?? agentId } : {}),
  });
  if (!updateResult.success) {
    if (updateResult.error.code === "EVALUATION_PENDING") {
      return promotionHeldByEvaluation(c, logger, id, {
        owner: repo.owner,
        repo: repo.repo,
        branch,
        prNumber: pr.number,
        prUrl: pr.html_url,
        link: prLink,
      });
    }
    logger.error("Failed to update change status to promoted", updateResult.error);
    return badRequest(updateResult.error.message);
  }

  await reportVerdictOnPromotion(c, logger, { ...change, ...prLink }, project);

  // Who GitHub says the author is, which on a reused pull request is whoever
  // opened it the first time and not who was chosen just now.
  const prAuthorLogin = githubLoginOf(result.pr);
  const openedAs = result.reused ? undefined : author.kind;
  logger.info("Change promoted to GitHub PR", {
    changeId: id,
    prNumber: pr.number,
    repo: `${repo.owner}/${repo.repo}`,
    reused: result.reused,
    ...(openedAs !== undefined ? { openedAs } : {}),
    ...(author.kind === "app" ? { openedAsAppBecause: author.reason } : {}),
  });
  return okOrFormRedirect(c, id, {
    changeId: id,
    github: {
      owner: repo.owner,
      repo: repo.repo,
      branch,
      pullRequestNumber: pr.number,
      pullRequestUrl: pr.html_url,
      ...(prAuthorLogin !== undefined ? { pullRequestAuthor: prAuthorLogin } : {}),
      ...(openedAs !== undefined ? { openedAs } : {}),
      // Only where there was a choice: a deployment without the feature has
      // nothing to explain, and neither has a pull request that already existed.
      ...(openedAs === "app" && author.kind === "app" && author.reason !== "not_configured"
        ? { openedAsAppBecause: author.reason }
        : {}),
    },
  });
});

export { app as changesRouter };
