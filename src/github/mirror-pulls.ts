/**
 * Pull requests from the GitHub mirror, as Stratum changes (#420).
 *
 * In forge mode the GitHub repository is a read-only copy of the project, and
 * people with no Stratum account still open pull requests there. This module
 * is the whole path from such a pull request to a merged change:
 *
 * 1. {@link handleMirrorPullRequest} — a `pull_request` webhook records the
 *    pull request as a change in status `external`. Nothing is fetched and
 *    nothing runs.
 * 2. {@link importPullRequest} — a maintainer brings its commits into a
 *    workspace. From there it is an ordinary change: evaluated, checked,
 *    reviewed, merged.
 * 3. {@link settleMergedPullRequests} — once the merge has been mirrored, the
 *    pull request is commented on and, unless GitHub marked it merged by
 *    itself, closed.
 *
 * ## Trust
 *
 * A pull request is written by someone with no account and no trust. Its
 * title, its author's commit names and emails, and every byte of its branch
 * are chosen by that person. The numbers GitHub reports about it are GitHub's,
 * but they are numbers about content that person chose. So:
 *
 * - **Nothing happens without a maintainer.** A webhook writes two rows. It
 *   starts no evaluation (an LLM evaluator costs money), dispatches no CI job
 *   (the executor is one small queue for the whole instance, and a job runs the
 *   pull request's own scripts), and cannot reach a merge, a deployment or a
 *   post-merge command, all of which need a mergeable change. Each new head of
 *   the pull request needs a maintainer again: new commits send an imported
 *   change back to `external`.
 * - **A pull request cannot choose its gate.** `.stratum/policy.yaml` and
 *   `.stratum/ci.yaml` are read from the project's base branch by the
 *   evaluation and merge code, as for every change; nothing here reads either
 *   from the pull request. One that edits them is flagged by the evaluation and
 *   needs an approval from someone other than the maintainer who imported it.
 * - **Only the configured mirror counts.** An event is acted on only when the
 *   repository GitHub names is an enabled mirror target that an admin has
 *   switched pull requests on for, and the pull request targets that
 *   repository's copy of the project's default branch.
 * - **The fork is never contacted.** Commits are read from the mirror
 *   repository's `refs/pull/<n>/head` with an installation token narrowed to
 *   that one repository.
 * - **Text is data.** The title is stored as one line and rendered escaped. The
 *   body is not stored at all. Neither, nor any commit message, is passed to an
 *   evaluator: evaluators receive the diff, as they do for every change.
 */

import { emitEvent } from "../queue/events";
import { createWorkspaceFork } from "../services/change-flow";
import { type DispatchOutcome, dispatchEvaluationRun } from "../services/evaluation-run";
import { recordAudit } from "../storage/audit";
import { beginEvaluationRun, newEvaluationRunId } from "../storage/change-evaluation";
import { getChange } from "../storage/changes";
import {
  type ExternalPullRequest,
  closeExternalPullRequest,
  createExternalChange,
  getExternalPullRequest,
  getExternalPullRequestByChange,
  listProjectsWithPullRequestsToSettle,
  listPullRequestsToSettle,
  recordExternalImport,
  recordExternalRefusal,
  recordPullRequestClosure,
  supersedeImportedChange,
  updateExternalPullRequestHead,
} from "../storage/external-pull-requests";
import {
  artifactsRepoNameFromRemote,
  cloneRepo,
  extractTokenSecret,
  freshRepoToken,
  pushBranchToRemote,
} from "../storage/git-ops";
import {
  type PushMirror,
  getEnabledPushMirrorByRepo,
  getPushMirror,
  hasPendingPush,
} from "../storage/push-mirrors";
import { deleteWorkspace, getProjectByPath, getWorkspace } from "../storage/state";
import { type Change, type Env, type ProjectEntry, projectDefaultBranch } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { GitHubClient } from "./client";
import {
  type PullRequestLimits,
  type PullRequestRefusal,
  landPullRequest,
  refusalError,
  singleLine,
} from "./pull-request-content";
import {
  fetchPullRequestHead,
  isPermanentRemoteRefusal,
  openGitHubPullRequests,
  parseGitHubRepo,
} from "./remote";

/**
 * What a pull request may be, to be brought in. Fixed for the instance: a
 * limit a project could raise is a limit a compromised project admin could
 * raise, and these protect the Worker's memory, not the project.
 */
export const EXTERNAL_PR_LIMITS = {
  /** Commits a pull request may add. */
  maxCommits: 100,
  /** Files it may add, change or delete. */
  maxChangedFiles: 300,
  /** Bytes of file content it may add or change. */
  maxChangedBytes: 5 * 1024 * 1024,
  /** Bytes GitHub may send when its commits are fetched. */
  maxFetchBytes: 20 * 1024 * 1024,
  /** Changes in status `external` one project may hold at a time. */
  maxOpenPerProject: 50,
} as const;

/** History of the workspace read to find where the pull request branched. */
const WORKSPACE_CLONE_DEPTH = 250;

/** Characters of a pull request title that are kept. */
const MAX_TITLE_LENGTH = 200;

/** Attempts at settling one pull request on GitHub before it is left `failed`. */
export const MAX_CLOSURE_ATTEMPTS = 5;

/**
 * How long after the link is posted Stratum waits before closing a pull
 * request that is still open. GitHub marks a pull request merged by itself
 * when its commits arrive on the base branch, shortly after the push; closing
 * it first would leave it "closed" where it should read "merged".
 */
export const CLOSURE_GRACE_MS = 2 * 60_000;

/** Pull requests settled per pass, so one pass has a bounded subrequest count. */
const SETTLE_BATCH_LIMIT = 10;
/** Projects the sweep settles per tick. */
const SETTLE_SWEEP_PROJECTS = 10;

const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** A GitHub login, with the `[bot]` suffix App accounts carry. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

/** The parts of a `pull_request` event this module trusts enough to act on. */
export interface PullRequestEvent {
  action: string;
  number: number;
  /** The repository the event was delivered for. */
  repoOwner: string;
  repoName: string;
  /** Branch the pull request asks to be merged into. */
  baseRef: string;
  headSha: string;
  authorLogin: string;
  title: string;
  /** Whether GitHub considers the pull request merged. */
  merged: boolean;
  commits?: number;
  changedFiles?: number;
}

/** A count from a webhook payload, if it is a usable one: a whole number that is not negative. */
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Narrows a `pull_request` webhook payload, or returns null when it is not one
 * this module can act on.
 *
 * The payload is signed by GitHub, so its structure is GitHub's — but every
 * string in it that a person typed is that person's, and a field this code
 * does not check is a field it must not use. Whatever fails a check here drops
 * the event; nothing is repaired or guessed.
 *
 * The base repository inside the pull request must be the repository the event
 * was delivered for. That is always so for a genuine event, and checking it
 * means the rest of the module never has to wonder which of the two names it
 * matched the mirror against.
 */
export function parsePullRequestEvent(data: unknown): PullRequestEvent | null {
  const payload = data as {
    action?: unknown;
    number?: unknown;
    repository?: { owner?: { login?: unknown }; name?: unknown };
    pull_request?: {
      number?: unknown;
      title?: unknown;
      merged?: unknown;
      commits?: unknown;
      changed_files?: unknown;
      user?: { login?: unknown };
      head?: { sha?: unknown };
      base?: { ref?: unknown; repo?: { full_name?: unknown } };
    };
  } | null;
  const pr = payload?.pull_request;
  if (!payload || !pr || typeof payload.action !== "string") return null;

  const repo = parseGitHubRepo(
    `${String(payload.repository?.owner?.login)}/${String(payload.repository?.name)}`,
  );
  if (repo === null) return null;
  const baseRepo = pr.base?.repo?.full_name;
  if (
    typeof baseRepo !== "string" ||
    baseRepo.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase()
  ) {
    return null;
  }

  const number = count(payload.number) ?? count(pr.number);
  if (number === undefined || number === 0) return null;
  const headSha = pr.head?.sha;
  if (typeof headSha !== "string" || !COMMIT_SHA.test(headSha)) return null;
  const baseRef = pr.base?.ref;
  if (typeof baseRef !== "string" || baseRef === "" || baseRef.length > 255) return null;
  const login = pr.user?.login;
  if (typeof login !== "string" || !GITHUB_LOGIN.test(login)) return null;

  const title = typeof pr.title === "string" ? singleLine(pr.title, MAX_TITLE_LENGTH) : "";
  const commits = count(pr.commits);
  const changedFiles = count(pr.changed_files);
  return {
    action: payload.action,
    number,
    repoOwner: repo.owner,
    repoName: repo.repo,
    baseRef,
    headSha,
    authorLogin: login,
    title: title === "" ? "(untitled)" : title,
    merged: pr.merged === true,
    ...(commits !== undefined ? { commits } : {}),
    ...(changedFiles !== undefined ? { changedFiles } : {}),
  };
}

/**
 * The refusal GitHub's own counts already justify, if any. A pull request
 * that is over a limit by GitHub's arithmetic is refused the moment it is
 * seen, without anything being fetched. The same limits are enforced again,
 * on the objects themselves, when it is imported.
 */
export function refusalFromCounts(
  facts: Pick<PullRequestEvent, "commits" | "changedFiles">,
  limits: Pick<PullRequestLimits, "maxCommits" | "maxChangedFiles"> = EXTERNAL_PR_LIMITS,
): PullRequestRefusal | undefined {
  if (facts.commits !== undefined && facts.commits > limits.maxCommits) {
    return {
      code: "PR_TOO_MANY_COMMITS",
      reason: `The pull request has ${facts.commits} commits; the most that can be brought in is ${limits.maxCommits}`,
    };
  }
  if (facts.changedFiles !== undefined && facts.changedFiles > limits.maxChangedFiles) {
    return {
      code: "PR_TOO_MANY_FILES",
      reason: `The pull request changes ${facts.changedFiles} files; the most that can be brought in is ${limits.maxChangedFiles}`,
    };
  }
  return undefined;
}

type PullsEnv = Env;

/** `namespace/slug`, the name a project is shown by. */
const projectLabel = (project: ProjectEntry): string => `${project.namespace}/${project.slug}`;

/** The pull request's page, built from the mirror's own name, never from a payload. */
export function pullRequestUrl(
  record: Pick<ExternalPullRequest, "repoOwner" | "repoName" | "prNumber">,
): string {
  return `https://github.com/${record.repoOwner}/${record.repoName}/pull/${record.prNumber}`;
}

/**
 * Record that GitHub closed (or merged) a pull request, close its change if
 * that is still open, and write the audit entry when this call closed it.
 */
async function closeFromGitHub(
  env: PullsEnv,
  logger: Logger,
  project: ProjectEntry,
  record: ExternalPullRequest,
  prState: "closed" | "merged",
  reason: string,
): Promise<void> {
  const closed = await closeExternalPullRequest(env.DB, logger, {
    projectId: project.id,
    prNumber: record.prNumber,
    changeId: record.changeId,
    prState,
  });
  if (!closed.success) throw closed.error;
  if (!closed.data.changeClosed) return;

  logger.info("External change closed with its pull request", {
    projectId: project.id,
    changeId: record.changeId,
    prNumber: record.prNumber,
    reason,
  });
  await recordAudit(env.DB, logger, {
    action: "external_change.closed",
    actorType: "system",
    subject: record.changeId,
    project,
    detail: { project: project.name, pullRequest: record.prNumber, reason },
  });
  await emitEvent(
    env.DB,
    env.EVENTS_QUEUE ?? null,
    { type: "change.rejected", project: projectLabel(project), changeId: record.changeId },
    { type: "system" },
    logger,
    project.id,
  );
}

/**
 * Handles a `pull_request` webhook for a repository that is a project's push
 * mirror.
 *
 * @returns `not-a-mirror` when the repository is not an enabled mirror target,
 *   so the caller may hand the event to the layer-mode handler; `handled` in
 *   every other case, including every case where the event was ignored. An
 *   event for a mirror must never reach the layer-mode handler: that handler
 *   matches pull requests to workspaces by branch name, and a stranger chooses
 *   the branch name of their own pull request.
 * @throws When storage fails. The webhook route records a thrown delivery, so a
 *   pull request lost to a database error is visible instead of acknowledged.
 */
export async function handleMirrorPullRequest(
  env: PullsEnv,
  data: unknown,
  logger: Logger,
): Promise<"handled" | "not-a-mirror"> {
  const repository = (
    data as { repository?: { owner?: { login?: unknown }; name?: unknown } } | null
  )?.repository;
  const repo = parseGitHubRepo(`${String(repository?.owner?.login)}/${String(repository?.name)}`);
  if (repo === null) return "not-a-mirror";

  const found = await getEnabledPushMirrorByRepo(env.DB, logger, repo.owner, repo.repo);
  if (!found.success) throw found.error;
  const mirror = found.data;
  if (mirror === null) return "not-a-mirror";

  if (!mirror.acceptPullRequests) {
    logger.debug("Mirror does not accept pull requests; event ignored", {
      projectId: mirror.projectId,
    });
    return "handled";
  }

  const event = parsePullRequestEvent(data);
  if (event === null) {
    logger.warn("Pull request event for a mirror could not be read; ignored", {
      projectId: mirror.projectId,
    });
    return "handled";
  }

  const located = await getProjectByPath(env.STATE, mirror.namespace, mirror.slug, logger);
  if (!located.success) {
    if (located.error.code === "NOT_FOUND") return "handled";
    throw located.error;
  }
  const project = located.data;
  // The path now belongs to a different project than the one that configured
  // this mirror: nothing here is that project's to receive.
  if (project.id !== mirror.projectId) return "handled";

  const existingResult = await getExternalPullRequest(env.DB, logger, project.id, event.number);
  if (!existingResult.success) throw existingResult.error;
  const existing = existingResult.data;

  if (event.action === "closed") {
    if (existing !== null) {
      await closeFromGitHub(
        env,
        logger,
        project,
        existing,
        event.merged ? "merged" : "closed",
        event.merged ? "merged on GitHub" : "closed on GitHub",
      );
    }
    return "handled";
  }

  if (!["opened", "reopened", "synchronize", "edited"].includes(event.action)) {
    logger.debug("Unhandled pull request action for a mirror", { action: event.action });
    return "handled";
  }

  const branch = projectDefaultBranch(project);
  if (event.baseRef !== branch) {
    // Never brought in. And one that WAS, and has since been retargeted away
    // from the default branch, is no longer a proposal to change it.
    if (existing !== null) {
      await closeFromGitHub(
        env,
        logger,
        project,
        existing,
        "closed",
        "retargeted to another branch",
      );
    } else {
      logger.debug("Pull request does not target the default branch; ignored", {
        projectId: project.id,
        baseRef: event.baseRef,
        branch,
      });
    }
    return "handled";
  }

  const refusal = refusalFromCounts(event);
  const facts = {
    projectId: project.id,
    projectName: projectLabel(project),
    prNumber: event.number,
    repoOwner: mirror.repoOwner,
    repoName: mirror.repoName,
    authorLogin: event.authorLogin,
    title: event.title,
    headSha: event.headSha,
    ...(event.commits !== undefined ? { commits: event.commits } : {}),
    ...(event.changedFiles !== undefined ? { changedFiles: event.changedFiles } : {}),
    ...(refusal !== undefined ? { refusal } : {}),
  };

  if (existing === null) {
    const created = await createExternalChange(
      env.DB,
      logger,
      facts,
      EXTERNAL_PR_LIMITS.maxOpenPerProject,
    );
    if (!created.success) throw created.error;
    if (created.data.status === "capped") {
      logger.warn("Project is at its limit of external changes; pull request not brought in", {
        projectId: project.id,
        prNumber: event.number,
        limit: EXTERNAL_PR_LIMITS.maxOpenPerProject,
      });
      return "handled";
    }
    if (created.data.status === "created") {
      logger.info("External change created for pull request", {
        projectId: project.id,
        changeId: created.data.record.changeId,
        prNumber: event.number,
        refused: refusal?.code,
      });
      return "handled";
    }
    // Another delivery got there first; fall through and update what it made.
  }

  const record = existing ?? (await reread(env, logger, project.id, event.number));
  if (record === null) return "handled";

  const changeResult = await getChange(env.DB, logger, record.changeId);
  if (!changeResult.success) {
    if (changeResult.error.code === "NOT_FOUND") return "handled";
    throw changeResult.error;
  }
  const change = changeResult.data;

  if (change.status === "merged" || change.status === "reverted") {
    logger.debug("Pull request event for a merged change; ignored", { changeId: change.id });
    return "handled";
  }
  if (change.status === "rejected") {
    // Closed and reopened on GitHub: a new proposal, with a new change. A push
    // to a pull request whose change a maintainer rejected does not bring it
    // back — only reopening does.
    if (event.action !== "reopened") return "handled";
    const replaced = await createExternalChange(
      env.DB,
      logger,
      facts,
      EXTERNAL_PR_LIMITS.maxOpenPerProject,
      { replace: true },
    );
    if (!replaced.success) throw replaced.error;
    logger.info("Reopened pull request", {
      projectId: project.id,
      prNumber: event.number,
      outcome: replaced.data.status,
    });
    return "handled";
  }

  const headMoved = event.headSha !== record.headSha;
  // A refusal describes one head. With the head unchanged, what was found
  // when a maintainer tried to import it still stands.
  const carried =
    refusal ??
    (!headMoved && record.refusalCode !== undefined && record.refusalReason !== undefined
      ? { code: record.refusalCode, reason: record.refusalReason }
      : undefined);
  const updated = await updateExternalPullRequestHead(env.DB, logger, {
    projectId: project.id,
    prNumber: event.number,
    headSha: event.headSha,
    title: event.title,
    ...(event.commits !== undefined ? { commits: event.commits } : {}),
    ...(event.changedFiles !== undefined ? { changedFiles: event.changedFiles } : {}),
    ...(carried !== undefined ? { refusal: carried } : {}),
  });
  if (!updated.success) throw updated.error;

  // Not decided from `change.status`: that was read before the head was
  // recorded, and an import may have started evaluating the old head since.
  // The statement itself moves only a change that is past `external` now.
  if (headMoved) {
    const superseded = await supersedeImportedChange(env.DB, logger, change.id);
    if (!superseded.success) throw superseded.error;
    if (superseded.data.superseded) {
      logger.info("Pull request has new commits; change returned to external", {
        changeId: change.id,
        prNumber: event.number,
        dismissedApprovals: superseded.data.dismissedReviewerIds.length,
      });
      if (superseded.data.dismissedReviewerIds.length > 0) {
        await recordAudit(env.DB, logger, {
          action: "review.approvals_dismissed",
          actorType: "system",
          subject: change.id,
          project,
          detail: {
            reason: "pull request has new commits",
            pullRequest: event.number,
            dismissed: superseded.data.dismissedReviewerIds,
          },
        });
      }
    }
  }
  return "handled";
}

/** Read a pull request's record again, after a write that may have raced another delivery. */
async function reread(
  env: PullsEnv,
  logger: Logger,
  projectId: string,
  prNumber: number,
): Promise<ExternalPullRequest | null> {
  const again = await getExternalPullRequest(env.DB, logger, projectId, prNumber);
  if (!again.success) throw again.error;
  return again.data;
}

/** What GitHub says about a pull request right now, narrowed. */
interface LivePullRequest {
  open: boolean;
  merged: boolean;
  baseRef: string;
  baseRepo: string;
  headSha: string;
  commits?: number;
  changedFiles?: number;
}

/** The fields of GitHub's pull request object an import relies on, or null if they are not there. */
function narrowLivePullRequest(data: unknown): LivePullRequest | null {
  const pr = data as {
    state?: unknown;
    merged?: unknown;
    commits?: unknown;
    changed_files?: unknown;
    head?: { sha?: unknown };
    base?: { ref?: unknown; repo?: { full_name?: unknown } };
  } | null;
  if (!pr || typeof pr.state !== "string") return null;
  const headSha = pr.head?.sha;
  const baseRef = pr.base?.ref;
  const baseRepo = pr.base?.repo?.full_name;
  if (typeof headSha !== "string" || !COMMIT_SHA.test(headSha)) return null;
  if (typeof baseRef !== "string" || typeof baseRepo !== "string") return null;
  const commits = count(pr.commits);
  const changedFiles = count(pr.changed_files);
  return {
    open: pr.state === "open",
    merged: pr.merged === true,
    baseRef,
    baseRepo,
    headSha,
    ...(commits !== undefined ? { commits } : {}),
    ...(changedFiles !== undefined ? { changedFiles } : {}),
  };
}

/** Removes a workspace this import created and could not use. Best effort. */
async function discardWorkspace(
  env: PullsEnv,
  logger: Logger,
  projectId: string,
  workspace: { name: string; remote: string },
): Promise<void> {
  const repoName = artifactsRepoNameFromRemote(workspace.remote);
  if (repoName) {
    await env.ARTIFACTS.delete(repoName).catch((error: unknown) => {
      logger.warn("Could not delete the workspace of a refused import", {
        repoName,
        workspace: workspace.name,
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  const removed = await deleteWorkspace(env.STATE, projectId, workspace.name, logger);
  if (!removed.success) {
    logger.warn("Could not delete the workspace entry of a refused import", {
      workspace: workspace.name,
      projectId,
      error: removed.error.message,
    });
  }
}

export interface ImportPullRequestInput {
  project: ProjectEntry;
  change: Change;
  /** The maintainer importing it. A person: agents are refused by the route. */
  userId: string;
  /** The maintainer's confirmation that the contributor agreement is in place. */
  agreementConfirmed: boolean;
  /**
   * The head the maintainer was looking at, when the caller knows it. An
   * import of a different head is refused: what gets brought in must be what
   * was decided on.
   */
  expectedHeadSha?: string;
  requestOrigin?: string;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface ImportPullRequestResult {
  change: Change;
  record: ExternalPullRequest;
  runId: string;
  dispatched: DispatchOutcome;
}

/**
 * Brings a pull request's commits into the change's workspace and starts the
 * change's evaluation: the one action that turns an external change into an
 * ordinary one.
 *
 * The caller has already established that `userId` is a person who may write
 * to the project. Everything else is decided here, from GitHub's answer now and
 * from the commits themselves — not from what a webhook recorded earlier:
 *
 * - the mirror is enabled and accepts pull requests, and the project's
 *   contributor-agreement setting is met;
 * - the pull request is open, on the mirror, against the default branch, and
 *   its head is the one the maintainer saw;
 * - its commits are within every limit and carry no submodule or Git LFS
 *   pointer, and merge with the workspace without conflict.
 *
 * The contributor's commits are kept exactly as written, so their authorship
 * is in the history that merges. The workspace is pushed only after every
 * check has passed. A refusal is recorded against the head it was found on,
 * shown on the change, and returned as a 422.
 *
 * The importing maintainer becomes the change's author of record, so their
 * own approval does not count towards the approvals the change needs.
 *
 * @returns The change, now `evaluating`; or `EXTERNAL_IMPORT_UNAVAILABLE`,
 *   `CONTRIBUTOR_AGREEMENT_REQUIRED`, `PR_HEAD_MOVED`, `PR_NOT_OPEN`, a
 *   refusal code from {@link PullRequestRefusal}, or a GitHub/storage error
 */
export async function importPullRequest(
  env: PullsEnv,
  logger: Logger,
  input: ImportPullRequestInput,
): Promise<Result<ImportPullRequestResult, AppError>> {
  const { project, change, userId } = input;
  if (change.status !== "external") {
    return err(new AppError("This change is not waiting to be imported", "NOT_EXTERNAL", 409));
  }
  const recordResult = await getExternalPullRequestByChange(env.DB, logger, change.id);
  if (!recordResult.success) return recordResult;
  const record = recordResult.data;
  if (record === null || record.projectId !== project.id) {
    return err(new AppError("This change has no pull request to import", "NOT_EXTERNAL", 409));
  }

  const mirrorResult = await getPushMirror(env.DB, logger, project.id);
  if (!mirrorResult.success) return mirrorResult;
  const mirror = mirrorResult.data;
  if (
    mirror === null ||
    !mirror.enabled ||
    !mirror.acceptPullRequests ||
    mirror.repoOwner.toLowerCase() !== record.repoOwner.toLowerCase() ||
    mirror.repoName.toLowerCase() !== record.repoName.toLowerCase()
  ) {
    return err(
      new AppError(
        "This project's mirror no longer accepts pull requests from that repository",
        "EXTERNAL_IMPORT_UNAVAILABLE",
        409,
      ),
    );
  }
  if (mirror.requireContributorAgreement && !input.agreementConfirmed) {
    return err(
      new AppError(
        "This project requires a maintainer to confirm the contributor agreement before a pull request is imported",
        "CONTRIBUTOR_AGREEMENT_REQUIRED",
        422,
      ),
    );
  }

  const target = { owner: mirror.repoOwner, repo: mirror.repoName };
  const opened = await openGitHubPullRequests(env, project, target, "import", logger);
  if (!opened.success) return opened;
  const remote = opened.data;

  const fetchedPr = await new GitHubClient(remote.token, logger).getPullRequest(
    target.owner,
    target.repo,
    record.prNumber,
  );
  if (!fetchedPr.success) {
    return err(
      new AppError(
        `GitHub could not be asked about pull request #${record.prNumber}: ${fetchedPr.error}`,
        "GITHUB_ERROR",
        fetchedPr.status === 404 || fetchedPr.status === 403 ? 409 : 502,
      ),
    );
  }
  const live = narrowLivePullRequest(fetchedPr.data);
  if (live === null) {
    return err(
      new AppError("GitHub's answer about the pull request was unreadable", "GITHUB_ERROR", 502),
    );
  }
  const branch = projectDefaultBranch(project);
  if (
    !live.open ||
    live.baseRef !== branch ||
    live.baseRepo.toLowerCase() !== `${target.owner}/${target.repo}`.toLowerCase()
  ) {
    return err(
      new AppError(
        `Pull request #${record.prNumber} is no longer open against '${branch}' on ${target.owner}/${target.repo}`,
        "PR_NOT_OPEN",
        409,
      ),
    );
  }
  const expected = input.expectedHeadSha ?? record.headSha;
  if (live.headSha !== expected) {
    // Record the head GitHub has now, so reloading the change shows it even if
    // the webhook that should have said so never arrived.
    if (live.headSha !== record.headSha) {
      await updateExternalPullRequestHead(env.DB, logger, {
        projectId: project.id,
        prNumber: record.prNumber,
        headSha: live.headSha,
        title: record.title,
        ...(live.commits !== undefined ? { commits: live.commits } : {}),
        ...(live.changedFiles !== undefined ? { changedFiles: live.changedFiles } : {}),
      });
    }
    return err(
      new AppError(
        `Pull request #${record.prNumber} has new commits since this page was loaded. Look at it again before importing`,
        "PR_HEAD_MOVED",
        409,
        { headSha: live.headSha },
      ),
    );
  }

  /** Records the refusal against this head and reports it. */
  const refuse = async (
    refusal: PullRequestRefusal,
  ): Promise<Result<ImportPullRequestResult, AppError>> => {
    await recordExternalRefusal(env.DB, logger, {
      projectId: project.id,
      prNumber: record.prNumber,
      headSha: live.headSha,
      code: refusal.code,
      reason: refusal.reason,
    });
    logger.info("Pull request import refused", {
      changeId: change.id,
      prNumber: record.prNumber,
      code: refusal.code,
    });
    return err(refusalError(refusal));
  };

  const overCount = refusalFromCounts(live);
  if (overCount !== undefined) return refuse(overCount);

  // The workspace is created by the first import. A re-import after new
  // commits lands them on top of what is already there, which keeps anything
  // a maintainer committed in between.
  let workspace: { name: string; remote: string };
  let createdWorkspace = false;
  const existingWorkspace = await getWorkspace(env.STATE, project.id, change.workspace, logger);
  if (existingWorkspace.success) {
    workspace = { name: existingWorkspace.data.name, remote: existingWorkspace.data.remote };
  } else if (existingWorkspace.error.code === "NOT_FOUND") {
    const forked = await createWorkspaceFork(env, logger, {
      project,
      workspaceName: change.workspace,
      actor: { userId },
    });
    if (!forked.success) return forked;
    workspace = forked.data;
    createdWorkspace = true;
  } else {
    return err(new AppError(existingWorkspace.error.message, existingWorkspace.error.code, 500));
  }

  /** Undoes a workspace this call created, then passes the result through. */
  const abandon = async <T>(result: T): Promise<T> => {
    if (createdWorkspace) await discardWorkspace(env, logger, project.id, workspace);
    return result;
  };

  const writeToken = await freshRepoToken(env.ARTIFACTS, workspace.remote, "write", logger);
  if (!writeToken.success) {
    return abandon(err(new AppError(writeToken.error.message, writeToken.error.code, 500)));
  }
  const cloned = await cloneRepo(workspace.remote, writeToken.data, logger, {
    ref: branch,
    depth: WORKSPACE_CLONE_DEPTH,
  });
  if (!cloned.success) return abandon(cloned);
  const repo = cloned.data;

  const fetched = await fetchPullRequestHead(
    repo.fs,
    repo.dir,
    remote,
    record.prNumber,
    { depth: EXTERNAL_PR_LIMITS.maxCommits + 1, maxBytes: EXTERNAL_PR_LIMITS.maxFetchBytes },
    logger,
  );
  if (!fetched.success) {
    if (fetched.error.code === "PR_FETCH_TOO_LARGE") {
      return abandon(await refuse({ code: "PR_TOO_LARGE", reason: fetched.error.message }));
    }
    return abandon(fetched);
  }
  if (fetched.data !== live.headSha) {
    // GitHub's API and its git endpoint disagree: the head moved in between.
    return abandon(
      err(
        new AppError(
          `Pull request #${record.prNumber} changed while it was being imported. Look at it again before importing`,
          "PR_HEAD_MOVED",
          409,
        ),
      ),
    );
  }

  const landed = await landPullRequest(
    repo,
    { prNumber: record.prNumber, head: fetched.data, branch, limits: EXTERNAL_PR_LIMITS },
    logger,
  );
  if (!landed.success) return abandon(landed);
  if (landed.data.status === "refused") return abandon(await refuse(landed.data.refusal));
  // "Already there" in a workspace forked a moment ago means already on the
  // default branch: there is nothing to propose. In a workspace that existed,
  // it means an earlier import pushed these commits and then failed before
  // recording it — which this attempt can simply finish.
  if (landed.data.status === "already-present" && createdWorkspace) {
    return abandon(
      await refuse({
        code: "PR_EMPTY",
        reason: `The pull request has no commits that are not already on '${branch}'`,
      }),
    );
  }

  if (landed.data.status === "landed") {
    const pushed = await pushBranchToRemote(
      repo.fs,
      repo.dir,
      {
        url: workspace.remote,
        remoteRef: branch,
        localRef: branch,
        token: extractTokenSecret(writeToken.data),
      },
      logger,
    );
    if (!pushed.success) return abandon(pushed);
  }

  const stored = await recordExternalImport(env.DB, logger, {
    projectId: project.id,
    prNumber: record.prNumber,
    changeId: change.id,
    importedHeadSha: live.headSha,
    importedBy: userId,
    // A re-import that found nothing new keeps the authors already recorded.
    commitAuthors: landed.data.status === "landed" ? landed.data.authors : record.commitAuthors,
    agreementConfirmed: mirror.requireContributorAgreement && input.agreementConfirmed,
  });
  if (!stored.success) return stored;

  // A push to the pull request that arrived while this import was running has
  // already recorded a newer head, and found nothing to send back to
  // `external` because the change was still there. Evaluating now would make
  // the older commits mergeable with no sign that newer ones exist. So stop:
  // the change stays `external`, and the next import adds the new commits to
  // what this one landed.
  const current = await getExternalPullRequestByChange(env.DB, logger, change.id);
  if (!current.success) return current;
  if (current.data !== null && current.data.headSha !== live.headSha) {
    return err(
      new AppError(
        `Pull request #${record.prNumber} got new commits while it was being imported. Look at it again before importing`,
        "PR_HEAD_MOVED",
        409,
        { headSha: current.data.headSha },
      ),
    );
  }

  const auditDetail = {
    project: project.name,
    repo: `${target.owner}/${target.repo}`,
    pullRequest: record.prNumber,
    author: record.authorLogin,
    headSha: live.headSha,
  };
  await recordAudit(env.DB, logger, {
    action: "external_change.imported",
    actorType: "user",
    actorId: userId,
    subject: change.id,
    project,
    detail: {
      ...auditDetail,
      ...(landed.data.status === "landed"
        ? { commits: landed.data.newCommits, changedFiles: landed.data.changedFiles }
        : {}),
    },
  });
  if (mirror.requireContributorAgreement) {
    await recordAudit(env.DB, logger, {
      action: "contributor_agreement.confirmed",
      actorType: "user",
      actorId: userId,
      subject: change.id,
      project,
      detail: auditDetail,
    });
  }

  // From here it is the ordinary flow: the same run a re-evaluation starts.
  // It reads the policy and the CI steps from the project's base branch,
  // flags protected config from the diff, and dispatches checks for the
  // revision it pins.
  const runId = newEvaluationRunId();
  const begun = await beginEvaluationRun(env.DB, logger, {
    changeId: change.id,
    runId,
    requestedBy: userId,
  });
  if (!begun.success) return begun;
  if (!begun.data.started) {
    return err(new AppError("This change can no longer be evaluated", "NOT_EXTERNAL", 409));
  }

  // The head check above and the start of the run are two statements, and a
  // push can land between them. Its webhook then records the new head while
  // the change is still `external`, finds nothing to supersede, and is done.
  // So look once more now that the change has left `external`: a webhook that
  // arrives after this point supersedes the run by itself, and one that
  // arrived before it is caught here. Either way no run on the old head
  // survives a newer head.
  const settled = await getExternalPullRequestByChange(env.DB, logger, change.id);
  if (!settled.success) return settled;
  if (settled.data !== null && settled.data.headSha !== live.headSha) {
    const superseded = await supersedeImportedChange(env.DB, logger, change.id);
    if (!superseded.success) return superseded;
    return err(
      new AppError(
        `Pull request #${record.prNumber} got new commits while it was being imported. Look at it again before importing`,
        "PR_HEAD_MOVED",
        409,
        { headSha: settled.data.headSha },
      ),
    );
  }
  const dispatched = await dispatchEvaluationRun(
    env,
    logger,
    { changeId: change.id, runId },
    {
      ...(input.requestOrigin !== undefined ? { requestOrigin: input.requestOrigin } : {}),
      ...(input.waitUntil !== undefined ? { waitUntil: input.waitUntil } : {}),
    },
  );

  const after = await getExternalPullRequestByChange(env.DB, logger, change.id);
  logger.info("Pull request imported", {
    changeId: change.id,
    prNumber: record.prNumber,
    headSha: live.headSha,
    mode: dispatched.mode,
  });
  return ok({
    change: {
      ...change,
      status: "evaluating",
      createdByUserId: userId,
      evalRunId: runId,
      evalRequestedAt: begun.data.requestedAt,
    },
    record: after.success && after.data !== null ? after.data : record,
    runId,
    dispatched,
  });
}

/** The comment left on a pull request whose change merged in Stratum. */
export function mergedComment(input: {
  changeId: string;
  branch: string;
  appUrl?: string;
  /** GitHub has not marked the pull request merged, so Stratum is closing it. */
  closing: boolean;
}): string {
  const origin = input.appUrl?.replace(/\/+$/, "");
  const change =
    origin !== undefined && origin !== ""
      ? `[change \`${input.changeId}\`](${origin}/changes/${input.changeId})`
      : `change \`${input.changeId}\``;
  const lines = [
    `This pull request was merged in Stratum as ${change}, and the result is on \`${input.branch}\` here.`,
    "",
    "This repository is a read-only mirror: changes are reviewed and merged in Stratum, and pushed here afterwards.",
  ];
  if (input.closing) {
    lines.push(
      "",
      "GitHub shows this pull request as closed instead of merged because the merge wrote a new commit instead of keeping this branch's own, so GitHub cannot see that the work landed.",
    );
  }
  return lines.join("\n");
}

/** A GitHub refusal no retry will change: the App may not do this here. */
function isPermanentStatus(status: number | undefined): boolean {
  return status === 401 || status === 403 || status === 404 || status === 410 || status === 422;
}

/**
 * Settles, on GitHub, the pull requests of one project whose changes have
 * merged: posts the link back to the change and makes sure the pull request
 * does not stay open.
 *
 * Runs after a mirror push that succeeded, and from the five-minute sweep. It
 * acts only once the mirror has pushed since the change merged — a comment
 * saying "the result is on main here" before it is would be false.
 *
 * Two steps, never in one pass:
 *
 * 1. Post the comment. If GitHub already shows the pull request merged or
 *    closed, that is the end.
 * 2. After {@link CLOSURE_GRACE_MS}, look again. GitHub marks a pull request
 *    merged by itself once its head commit is reachable from the base branch,
 *    which a merge that kept the contributor's commits achieves through the
 *    mirror push. If it is still open — a squash wrote a new commit, so the
 *    head never became reachable — close it through the API.
 *
 * Never throws. A failed step is counted and retried by the next pass, and
 * left `failed` with the reason after {@link MAX_CLOSURE_ATTEMPTS}.
 */
export async function settleMergedPullRequests(
  env: PullsEnv,
  logger: Logger,
  projectId: string,
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    await settleUnsafe(env, logger, projectId, nowMs);
  } catch (error) {
    logger.error(
      "Settling merged pull requests threw",
      error instanceof Error ? error : new Error(String(error)),
      { projectId },
    );
  }
}

/**
 * One settlement pass over a project's merged pull requests. "Unsafe" because
 * it may throw: the caller is what turns a throw into a logged failure.
 */
async function settleUnsafe(
  env: PullsEnv,
  logger: Logger,
  projectId: string,
  nowMs: number,
): Promise<void> {
  const pending = await listPullRequestsToSettle(env.DB, logger, {
    projectId,
    commentedBefore: new Date(nowMs - CLOSURE_GRACE_MS).toISOString(),
    limit: SETTLE_BATCH_LIMIT,
  });
  if (!pending.success || pending.data.length === 0) return;

  const mirrorResult = await getPushMirror(env.DB, logger, projectId);
  if (!mirrorResult.success || mirrorResult.data === null) return;
  const mirror = mirrorResult.data;
  if (!mirror.enabled || mirror.state !== "ok" || hasPendingPush(mirror)) return;
  const pushedAt = mirror.lastPushedAt;
  if (pushedAt === undefined) return;

  const located = await getProjectByPath(env.STATE, mirror.namespace, mirror.slug, logger);
  if (!located.success || located.data.id !== projectId) return;
  const project = located.data;

  const due = pending.data.filter(
    ({ record, mergedAt }) =>
      mergedAt <= pushedAt &&
      record.repoOwner.toLowerCase() === mirror.repoOwner.toLowerCase() &&
      record.repoName.toLowerCase() === mirror.repoName.toLowerCase(),
  );
  if (due.length === 0) return;

  const target = { owner: mirror.repoOwner, repo: mirror.repoName };
  const opened = await openGitHubPullRequests(env, project, target, "settle", logger);
  if (!opened.success) {
    const permanent = isPermanentRemoteRefusal(opened.error);
    for (const { record } of due) {
      await failClosure(env, logger, record, opened.error.message, permanent);
    }
    return;
  }
  const client = new GitHubClient(opened.data.token, logger);
  for (const { record } of due) {
    await settleOne(env, logger, { client, mirror, project, record });
  }
}

/**
 * Record a failed attempt to comment on or close a pull request. A permanent
 * failure, or the last allowed attempt, stops the retries.
 */
async function failClosure(
  env: PullsEnv,
  logger: Logger,
  record: ExternalPullRequest,
  message: string,
  permanent: boolean,
): Promise<void> {
  const exhausted = permanent || record.closureAttempts + 1 >= MAX_CLOSURE_ATTEMPTS;
  await recordPullRequestClosure(env.DB, logger, {
    projectId: record.projectId,
    prNumber: record.prNumber,
    from: record.closureState,
    to: exhausted ? "failed" : record.closureState,
    error: message,
    failedAttempt: true,
  });
  logger.warn("Could not settle a merged pull request on GitHub", {
    changeId: record.changeId,
    prNumber: record.prNumber,
    exhausted,
    error: message,
  });
}

/**
 * Take one merged pull request one step further on GitHub: post the link back
 * to the change, or close the pull request once the grace period has passed.
 */
async function settleOne(
  env: PullsEnv,
  logger: Logger,
  ctx: {
    client: GitHubClient;
    mirror: PushMirror;
    project: ProjectEntry;
    record: ExternalPullRequest;
  },
): Promise<void> {
  const { client, mirror, project, record } = ctx;
  const target = { owner: mirror.repoOwner, repo: mirror.repoName };

  const fetched = await client.getPullRequest(target.owner, target.repo, record.prNumber);
  if (!fetched.success) {
    await failClosure(env, logger, record, fetched.error, isPermanentStatus(fetched.status));
    return;
  }
  const live = narrowLivePullRequest(fetched.data);
  if (live === null) {
    await failClosure(
      env,
      logger,
      record,
      "GitHub's answer about the pull request was unreadable",
      false,
    );
    return;
  }
  const liveState = live.merged ? "merged" : live.open ? "open" : "closed";
  const branch = projectDefaultBranch(project);

  if (record.closureState === "none") {
    // Claim the step before posting, so a pass racing this one does not post
    // a second comment. A post that then fails puts the claim back.
    const next = live.open ? "commented" : "done";
    const claimed = await recordPullRequestClosure(env.DB, logger, {
      projectId: record.projectId,
      prNumber: record.prNumber,
      from: "none",
      to: next,
      prState: liveState,
    });
    if (!claimed.success || !claimed.data) return;
    const posted = await client.postComment({
      owner: target.owner,
      repo: target.repo,
      issue_number: record.prNumber,
      body: mergedComment({
        changeId: record.changeId,
        branch,
        ...(env.APP_URL !== undefined ? { appUrl: env.APP_URL } : {}),
        closing: false,
      }),
    });
    if (!posted.success) {
      const exhausted =
        isPermanentStatus(posted.status) || record.closureAttempts + 1 >= MAX_CLOSURE_ATTEMPTS;
      await recordPullRequestClosure(env.DB, logger, {
        projectId: record.projectId,
        prNumber: record.prNumber,
        from: next,
        to: exhausted ? "failed" : "none",
        error: posted.error,
        failedAttempt: true,
      });
      logger.warn("Could not comment on a merged pull request", {
        changeId: record.changeId,
        prNumber: record.prNumber,
        exhausted,
        error: posted.error,
      });
      return;
    }
    await recordPullRequestClosure(env.DB, logger, {
      projectId: record.projectId,
      prNumber: record.prNumber,
      from: next,
      to: next,
      commentId: posted.id,
    });
    return;
  }

  // `commented`, and the grace period has passed.
  if (!live.open) {
    await recordPullRequestClosure(env.DB, logger, {
      projectId: record.projectId,
      prNumber: record.prNumber,
      from: "commented",
      to: "done",
      prState: liveState,
    });
    return;
  }
  const closed = await client.updatePR({
    owner: target.owner,
    repo: target.repo,
    pull_number: record.prNumber,
    state: "closed",
  });
  if (!closed.success) {
    await failClosure(env, logger, record, closed.error, isPermanentStatus(closed.status));
    return;
  }
  await recordPullRequestClosure(env.DB, logger, {
    projectId: record.projectId,
    prNumber: record.prNumber,
    from: "commented",
    to: "done",
    prState: "closed",
  });
  await recordAudit(env.DB, logger, {
    action: "external_change.pull_request_closed",
    actorType: "system",
    subject: record.changeId,
    project,
    detail: {
      project: project.name,
      repo: `${target.owner}/${target.repo}`,
      pullRequest: record.prNumber,
    },
  });
  // Best effort, and after the close so a failure here cannot leave the pull
  // request open: say why it reads "closed" and not "merged".
  if (record.closureCommentId !== undefined) {
    await client.updateComment({
      owner: target.owner,
      repo: target.repo,
      comment_id: record.closureCommentId,
      body: mergedComment({
        changeId: record.changeId,
        branch,
        ...(env.APP_URL !== undefined ? { appUrl: env.APP_URL } : {}),
        closing: true,
      }),
    });
  }
}

/**
 * Settles merged pull requests for every project that has some outstanding.
 * Runs on the five-minute cron: it is what performs the second step (closing a
 * pull request GitHub did not mark merged), and what retries a failed first.
 */
export async function sweepMergedPullRequests(env: PullsEnv, logger: Logger): Promise<void> {
  const projects = await listProjectsWithPullRequestsToSettle(
    env.DB,
    logger,
    SETTLE_SWEEP_PROJECTS,
  );
  if (!projects.success) return;
  for (const projectId of projects.data) {
    await settleMergedPullRequests(env, logger, projectId);
  }
}

/** What the API and the change page show for a change's pull request. */
export interface ExternalPullRequestView {
  /** `owner/repo` of the mirror. */
  repo: string;
  number: number;
  url: string;
  /** GitHub login of whoever opened it. */
  author: string;
  title: string;
  /** Newest head commit GitHub reported. */
  headSha: string;
  /** Head commit the workspace holds, or null before the first import. */
  importedHeadSha: string | null;
  /** GitHub's counts, as last reported. */
  commits: number | null;
  changedFiles: number | null;
  /** GitHub's state of the pull request. */
  state: ExternalPullRequest["prState"];
  /** Why the newest head cannot be imported, or null. */
  refusal: { code: string; reason: string } | null;
  importedBy: string | null;
  importedAt: string | null;
  agreementConfirmedBy: string | null;
  agreementConfirmedAt: string | null;
  /** Authors of the imported commits. */
  commitAuthors: ExternalPullRequest["commitAuthors"];
  /** Closing the pull request on GitHub after the change merged. */
  closure: { state: ExternalPullRequest["closureState"]; error: string | null };
}

/** The public shape of a pull request record. */
export function toExternalPullRequestView(record: ExternalPullRequest): ExternalPullRequestView {
  return {
    repo: `${record.repoOwner}/${record.repoName}`,
    number: record.prNumber,
    url: pullRequestUrl(record),
    author: record.authorLogin,
    title: record.title,
    headSha: record.headSha,
    importedHeadSha: record.importedHeadSha ?? null,
    commits: record.commits ?? null,
    changedFiles: record.changedFiles ?? null,
    state: record.prState,
    refusal:
      record.refusalCode !== undefined && record.refusalReason !== undefined
        ? { code: record.refusalCode, reason: record.refusalReason }
        : null,
    importedBy: record.importedBy ?? null,
    importedAt: record.importedAt ?? null,
    agreementConfirmedBy: record.agreementConfirmedBy ?? null,
    agreementConfirmedAt: record.agreementConfirmedAt ?? null,
    commitAuthors: record.commitAuthors,
    closure: { state: record.closureState, error: record.closureError ?? null },
  };
}
