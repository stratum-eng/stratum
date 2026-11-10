/**
 * Break-glass resync (#418): fast-forward a project's default branch to the
 * same branch on its GitHub copy.
 *
 * This is the one deliberate exception to "the mirror is read-only". When
 * Stratum cannot merge, a fix lands on the GitHub mirror first; once Stratum is
 * healthy again, an admin runs this so the project catches up. Everything here
 * is built around the ways that could go wrong:
 *
 * - **Fast-forward only.** The project's tip must be an ancestor of the
 *   upstream tip. Anything else is refused with both commits named. Nothing is
 *   ever forced, rewritten, or merged — there is no code path here that could.
 * - **The source is not a parameter.** It is the project's configured push
 *   mirror, or failing that its linked GitHub repository
 *   ({@link resolveResyncSource}). A caller cannot point a resync at a
 *   repository of their choosing.
 * - **The credential is the narrow one.** A GitHub App installation token
 *   scoped to that one repository with read-only contents, through
 *   `openGitHubRemote`. Never the instance PAT, never anonymous.
 * - **The answer is certain or it is not given.** A shallow window is tried
 *   first because it is cheap; any conclusion it cannot prove is re-derived
 *   from full history rather than guessed ({@link classify}).
 *
 * What this module does NOT do is decide who may run it, or record that it
 * ran: authorization, the audit entry, the event and the mirror's state all
 * belong to the route (`src/routes/resync.ts`), which knows the actor.
 */

import git from "isomorphic-git";
import {
  type BranchFastForwardPush,
  type NodeFS,
  cloneRepo,
  freshRepoToken,
  pushBranchFastForward,
  readAdvertisedRefs,
  resolveLocalTip,
} from "../storage/git-ops";
import type { PushMirror } from "../storage/push-mirrors";
import { type Env, type ProjectEntry, projectDefaultBranch } from "../types";
import type { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, fromPromise } from "../utils/result";
import type { GitHubAuthEnv } from "./app-auth";
import {
  type GitHubRemote,
  type GitHubRepoRef,
  fetchGitHubBranch,
  listGitHubRefs,
  openGitHubRemote,
  parseGitHubRepo,
} from "./remote";
import { resolveGitHubRepo } from "./sync";

/**
 * The shallow window tried first, on both sides. A break-glass fix is a
 * handful of commits on top of the project's tip, so this almost always
 * settles it without loading the repository's history.
 */
const SHALLOW_DEPTH = 50;
/** Budget for the full-history clone and fetch a shallow window could not settle. */
const FULL_HISTORY_TIMEOUT_MS = 120_000;
/**
 * Budget for the push that moves the branch. Under 30s on purpose: with the
 * RepoDO enabled the push runs inside `blockConcurrencyWhile`, and the runtime
 * resets a Durable Object whose callback runs longer than that.
 */
const LAND_PUSH_TIMEOUT_MS = 25_000;
/** How many incoming commits a response, audit entry or event lists. */
export const RESYNC_COMMIT_LIST_LIMIT = 50;
const SUMMARY_MAX_CHARS = 120;
const AUTHOR_MAX_CHARS = 100;

/** Where a resync reads from. */
export interface ResyncSource extends GitHubRepoRef {
  /**
   * - `mirror` — the project's configured push mirror.
   * - `source` — the GitHub repository the project is linked to, for a project
   *   with no mirror.
   */
  kind: "mirror" | "source";
}

/** One commit a resync brought in. No e-mail address: these are audited and delivered to webhooks. */
export interface ResyncCommit {
  sha: string;
  /** First line of the commit message, truncated. */
  summary: string;
  /** The author's name as recorded in the commit. */
  author: string;
}

export type ResyncRefusalCode =
  | "GITHUB_APP_NOT_CONFIGURED"
  | "GITHUB_APP_NOT_INSTALLED"
  | "GITHUB_APP_NOT_AUTHORIZED"
  | "GITHUB_APP_PERMISSION_DENIED"
  | "GITHUB_ACCESS_DENIED"
  | "RESYNC_UPSTREAM_UNAVAILABLE"
  | "RESYNC_PROJECT_UNAVAILABLE"
  | "RESYNC_UPSTREAM_BRANCH_MISSING"
  | "RESYNC_PROJECT_BRANCH_MISSING"
  | "RESYNC_SHA_MISMATCH"
  | "RESYNC_DIVERGED"
  | "RESYNC_HISTORY_INCOMPLETE"
  | "RESYNC_PROJECT_MOVED"
  | "RESYNC_PUSH_REJECTED"
  | "RESYNC_PUSH_TIMEOUT"
  | "RESYNC_FAILED";

export type ResyncHttpStatus = 403 | 409 | 502 | 503 | 504;

/**
 * What a resync did. Plain data throughout, because with the RepoDO enabled
 * it crosses a Durable Object RPC boundary on its way back to the route.
 */
export type ResyncOutcome =
  | {
      status: "fast-forwarded";
      branch: string;
      /** The project's tip before. */
      oldSha: string;
      /** The project's tip now — the upstream tip. */
      newSha: string;
      /** From the new tip backwards, at most {@link RESYNC_COMMIT_LIST_LIMIT}. */
      commits: ResyncCommit[];
      /** How many commits came in, including any `commits` left out. */
      commitCount: number;
      commitsTruncated: boolean;
    }
  /** The upstream tip is the project's tip, or an ancestor of it. Nothing moved. */
  | { status: "up-to-date"; branch: string; projectSha: string; upstreamSha: string }
  | {
      status: "refused";
      code: ResyncRefusalCode;
      message: string;
      httpStatus: ResyncHttpStatus;
      branch: string;
      projectSha?: string;
      upstreamSha?: string;
    };

type PushResult = Result<BranchFastForwardPush, AppError>;

/**
 * Runs the one step that moves the project's branch. The default runs it
 * directly; `RepoDO.resync` supplies one that runs it behind the same input
 * gate merges take, so the two cannot interleave.
 *
 * @param newSha - The commit the branch will hold if `push` reports `pushed`
 * @param push - Performs the push. Call it exactly once.
 */
export type ResyncLanding = (
  newSha: string,
  push: () => Promise<PushResult>,
) => Promise<PushResult>;

export type ResyncEnv = GitHubAuthEnv & Pick<Env, "ARTIFACTS">;

/**
 * Chooses where a project's resync reads from, or `null` when it has nowhere.
 *
 * A configured push mirror wins, enabled or not: it is the repository this
 * project publishes to, so it is where a break-glass fix lands, and a mirror
 * someone disabled during the incident is still that repository. A project
 * with no mirror falls back to the GitHub repository it was imported from or
 * is linked to. Nothing else is a source — in particular, never a repository
 * named by the request.
 */
export function resolveResyncSource(
  project: ProjectEntry,
  mirror: Pick<PushMirror, "repoOwner" | "repoName"> | null,
): ResyncSource | null {
  if (mirror) {
    // Re-validated although the mirror route validated it on the way in: a
    // credential is about to be sent to a URL built from these two strings.
    const target = parseGitHubRepo(`${mirror.repoOwner}/${mirror.repoName}`);
    return target ? { kind: "mirror", ...target } : null;
  }
  const linked = resolveGitHubRepo(project);
  if (!linked) return null;
  const target = parseGitHubRepo(`${linked.owner}/${linked.repo}`);
  return target ? { kind: "source", ...target } : null;
}

/** `owner/repo`, for messages and records. */
export function resyncSourceRepo(source: GitHubRepoRef): string {
  return `${source.owner}/${source.repo}`;
}

interface WalkedCommit {
  oid: string;
  parents: string[];
  summary: string;
  author: string;
}

/** isomorphic-git's per-call object cache; shared so a walk parses each pack index once. */
type GitCache = Record<string, unknown>;

/**
 * Reads one commit, or `null` when this clone does not hold it — which, in a
 * shallow clone, is how the edge of the window shows up.
 */
async function readCommit(
  fs: NodeFS,
  dir: string,
  cache: GitCache,
  oid: string,
): Promise<WalkedCommit | null> {
  const read = await fromPromise(git.readCommit({ fs, dir, oid, cache }));
  if (!read.success) return null;
  const { parent, message, author } = read.data.commit;
  const firstLine = message.split("\n", 1)[0]?.trim() ?? "";
  return {
    oid,
    parents: parent,
    summary: firstLine.slice(0, SUMMARY_MAX_CHARS),
    author: (author?.name ?? "").slice(0, AUTHOR_MAX_CHARS),
  };
}

/**
 * Every commit known to be an ancestor of `tip` (itself included).
 *
 * A parent this clone cannot read is still recorded — a commit's parent is its
 * ancestor whether or not the object is here — but its own parents cannot be
 * followed, so `closed` reports whether the walk reached the roots of history
 * or stopped at the edge of a shallow window.
 */
async function projectAncestry(
  fs: NodeFS,
  dir: string,
  cache: GitCache,
  tip: string,
): Promise<{ known: Set<string>; closed: boolean }> {
  const known = new Set<string>([tip]);
  const pending = [tip];
  let closed = true;
  for (let oid = pending.pop(); oid !== undefined; oid = pending.pop()) {
    const commit = await readCommit(fs, dir, cache, oid);
    if (!commit) {
      closed = false;
      continue;
    }
    for (const parent of commit.parents) {
      if (!known.has(parent)) {
        known.add(parent);
        pending.push(parent);
      }
    }
  }
  return { known, closed };
}

type Classification =
  | { kind: "up-to-date" }
  | { kind: "fast-forward"; incoming: WalkedCommit[] }
  | { kind: "diverged" }
  /** This clone does not hold enough history to say. */
  | { kind: "inconclusive" };

/**
 * Decides what moving the project from `projectTip` to `upstreamTip` would be.
 *
 * In a shallow clone a missing object means "past the window", not "not
 * there", so only two answers can be trusted and everything else is
 * `inconclusive`, for the caller to re-ask with full history:
 *
 * - **up-to-date** — the upstream tip was found among the project tip's
 *   ancestors. Finding it is proof at any depth.
 * - **fast-forward** — the walk down from the upstream tip read every commit
 *   it met, ended only at commits known to be the project's, and passed
 *   through the project's tip. One more condition keeps the *list* of incoming
 *   commits honest: when the project's own window is truncated, a commit the
 *   walk met could be an old project commit from past that window, reached
 *   through a side branch. A commit that descends from the project's tip
 *   cannot also be its ancestor, so the shallow answer is only accepted when
 *   every incoming commit descends from the tip.
 *
 * With full history nothing is past any window: not reaching the project's
 * tip is divergence, and an unreadable commit is a broken clone.
 *
 * @param full - Whether both sides were loaded with their whole history
 */
async function classify(
  fs: NodeFS,
  dir: string,
  projectTip: string,
  upstreamTip: string,
  full: boolean,
): Promise<Classification> {
  const cache: GitCache = {};
  const { known, closed } = await projectAncestry(fs, dir, cache, projectTip);
  if (known.has(upstreamTip)) return { kind: "up-to-date" };

  // Breadth-first from the upstream tip, never descending into the project's
  // own history. What it visits is what a fast-forward would bring in.
  const incoming = new Map<string, WalkedCommit>();
  const queue = [upstreamTip];
  const seen = new Set(queue);
  let complete = true;
  for (let next = 0; next < queue.length; next++) {
    const commit = await readCommit(fs, dir, cache, queue[next] as string);
    if (!commit) {
      complete = false;
      continue;
    }
    incoming.set(commit.oid, commit);
    for (const parent of commit.parents) {
      if (known.has(parent) || seen.has(parent)) continue;
      seen.add(parent);
      queue.push(parent);
    }
  }

  // Which incoming commits descend from the project's tip: seed with its
  // direct children, then follow child links upwards.
  const children = new Map<string, string[]>();
  const descends = new Set<string>();
  const frontier: string[] = [];
  for (const commit of incoming.values()) {
    for (const parent of commit.parents) {
      if (parent === projectTip) {
        if (!descends.has(commit.oid)) {
          descends.add(commit.oid);
          frontier.push(commit.oid);
        }
      } else if (incoming.has(parent)) {
        const list = children.get(parent);
        if (list) list.push(commit.oid);
        else children.set(parent, [commit.oid]);
      }
    }
  }
  for (let oid = frontier.pop(); oid !== undefined; oid = frontier.pop()) {
    for (const child of children.get(oid) ?? []) {
      if (!descends.has(child)) {
        descends.add(child);
        frontier.push(child);
      }
    }
  }
  const reachesProject = descends.has(upstreamTip);

  if (full) {
    if (!complete || !closed) return { kind: "inconclusive" };
    return reachesProject
      ? { kind: "fast-forward", incoming: [...incoming.values()] }
      : { kind: "diverged" };
  }
  const listIsExact = closed || descends.size === incoming.size;
  return complete && reachesProject && listIsExact
    ? { kind: "fast-forward", incoming: [...incoming.values()] }
    : { kind: "inconclusive" };
}

/** Builds a refusal. A helper only so every refusal carries the branch. */
function refuse(
  branch: string,
  code: ResyncRefusalCode,
  httpStatus: ResyncHttpStatus,
  message: string,
  shas: { projectSha?: string; upstreamSha?: string } = {},
): ResyncOutcome {
  return { status: "refused", code, message, httpStatus, branch, ...shas };
}

/**
 * Turns a failure to reach GitHub into a refusal an admin can act on. The
 * App's own refusals keep their codes — they name what to fix — and get the
 * statuses the mirror routes give them. GitHub turning the token away at the
 * git endpoint is a 502 here, not the 403/404 it was upstream: on this route
 * those statuses mean something about the caller.
 */
function upstreamRefusal(branch: string, error: AppError): ResyncOutcome {
  switch (error.code) {
    case "GITHUB_APP_NOT_CONFIGURED":
    case "GITHUB_APP_KEY_INVALID":
      return refuse(branch, "GITHUB_APP_NOT_CONFIGURED", 503, error.message);
    case "GITHUB_APP_NOT_INSTALLED":
      return refuse(branch, "GITHUB_APP_NOT_INSTALLED", 409, error.message);
    case "GITHUB_APP_NOT_AUTHORIZED":
      return refuse(branch, "GITHUB_APP_NOT_AUTHORIZED", 403, error.message);
    case "GITHUB_APP_PERMISSION_DENIED":
      return refuse(branch, "GITHUB_APP_PERMISSION_DENIED", 403, error.message);
    case "GITHUB_ACCESS_DENIED":
      return refuse(branch, "GITHUB_ACCESS_DENIED", 502, error.message);
    default:
      return refuse(
        branch,
        "RESYNC_UPSTREAM_UNAVAILABLE",
        502,
        `GitHub could not be read: ${error.message}`,
      );
  }
}

/** The refusal for a project repository that could not be read. Nothing was written. */
function projectUnavailable(branch: string, error: AppError): ResyncOutcome {
  return refuse(
    branch,
    "RESYNC_PROJECT_UNAVAILABLE",
    502,
    `The project's repository could not be read: ${error.message}`,
  );
}

/** The refusal for an upstream tip that is not the commit the admin pinned. */
function shaMismatch(
  branch: string,
  source: ResyncSource,
  expectedSha: string,
  upstreamSha: string,
  projectSha: string | undefined,
): ResyncOutcome {
  return refuse(
    branch,
    "RESYNC_SHA_MISMATCH",
    409,
    `${resyncSourceRepo(source)} has '${branch}' at ${upstreamSha}, not the expected ${expectedSha}. Nothing was changed.`,
    { upstreamSha, ...(projectSha !== undefined ? { projectSha } : {}) },
  );
}

/**
 * Loads both sides into one in-memory repository: the project's branch as the
 * clone, GitHub's as a remote-tracking ref beside it.
 */
async function loadBothSides(
  project: ProjectEntry,
  token: string,
  remote: GitHubRemote,
  branch: string,
  full: boolean,
  logger: Logger,
): Promise<
  { fs: NodeFS; dir: string; projectSha: string; upstreamSha: string } | { refusal: ResyncOutcome }
> {
  const cloned = await cloneRepo(
    project.remote,
    token,
    logger,
    full
      ? { ref: branch, fullHistory: true, timeoutMs: FULL_HISTORY_TIMEOUT_MS }
      : { ref: branch, depth: SHALLOW_DEPTH },
  );
  if (!cloned.success) return { refusal: projectUnavailable(branch, cloned.error) };
  const { fs, dir } = cloned.data;

  const local = await resolveLocalTip(fs, dir, branch);
  if (!local.success) return { refusal: projectUnavailable(branch, local.error) };

  const fetched = await fetchGitHubBranch(
    fs,
    dir,
    remote,
    branch,
    full ? { timeoutMs: FULL_HISTORY_TIMEOUT_MS } : { depth: SHALLOW_DEPTH },
    logger,
  );
  if (!fetched.success) return { refusal: upstreamRefusal(branch, fetched.error) };

  return { fs, dir, projectSha: local.data, upstreamSha: fetched.data.tip };
}

/**
 * Moves the project's branch to `upstreamSha` and reports what happened.
 *
 * The push is the only write in the whole operation and it is not forced:
 * isomorphic-git refuses it locally unless the remote's current tip is an
 * ancestor, and the push names the old tip it saw, so Artifacts refuses it too
 * if a merge landed in between. Either refusal leaves the project untouched.
 */
async function land(
  project: ProjectEntry,
  token: string,
  loaded: { fs: NodeFS; dir: string; projectSha: string; upstreamSha: string },
  branch: string,
  incoming: WalkedCommit[],
  landing: ResyncLanding,
  logger: Logger,
): Promise<ResyncOutcome> {
  const { fs, dir, projectSha, upstreamSha } = loaded;
  const shas = { projectSha, upstreamSha };

  // `force` here overwrites a ref in this request's throwaway in-memory clone
  // — isomorphic-git will not repoint an existing local ref without it. It is
  // not a push option and nothing remote is forced; the push below is what
  // reaches the project, and it has no force to give.
  const pointed = await fromPromise(
    git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: upstreamSha, force: true }),
  );
  if (!pointed.success) {
    logger.error("Resync could not stage the fast-forward", pointed.error, { branch });
    return refuse(
      branch,
      "RESYNC_FAILED",
      502,
      "The fast-forward could not be prepared. Nothing was changed.",
      shas,
    );
  }

  const pushed = await landing(upstreamSha, () =>
    pushBranchFastForward(project.remote, token, fs, dir, branch, logger, LAND_PUSH_TIMEOUT_MS),
  );
  if (!pushed.success) {
    if (pushed.error.code === "PUSH_TIMEOUT") {
      return refuse(
        branch,
        "RESYNC_PUSH_TIMEOUT",
        504,
        `The push that fast-forwards '${branch}' to ${upstreamSha} did not finish in time. It may still land: check the branch before running the resync again.`,
        shas,
      );
    }
    return refuse(
      branch,
      "RESYNC_FAILED",
      502,
      `The push that fast-forwards '${branch}' failed: ${pushed.error.message}`,
      shas,
    );
  }

  if (pushed.data.status === "rejected") {
    // A refused push usually means a merge landed after the clone was taken.
    // Read the branch again rather than assume, so the message is true.
    const now = await readAdvertisedRefs(project.remote, token, logger);
    const current = now.success ? now.data.branches[branch] : undefined;
    if (current === upstreamSha) {
      return { status: "up-to-date", branch, projectSha: upstreamSha, upstreamSha };
    }
    if (current !== undefined && current !== projectSha) {
      return refuse(
        branch,
        "RESYNC_PROJECT_MOVED",
        409,
        `'${branch}' moved from ${projectSha} to ${current} while the resync was running. Nothing was changed by the resync; run it again.`,
        { projectSha: current, upstreamSha },
      );
    }
    logger.warn("Resync push refused with the project unmoved", {
      branch,
      detail: pushed.data.detail,
    });
    return refuse(
      branch,
      "RESYNC_PUSH_REJECTED",
      502,
      `The project's repository refused the fast-forward of '${branch}' to ${upstreamSha}: ${pushed.data.detail}. Nothing was changed.`,
      shas,
    );
  }

  return {
    status: "fast-forwarded",
    branch,
    oldSha: projectSha,
    newSha: upstreamSha,
    commits: incoming
      .slice(0, RESYNC_COMMIT_LIST_LIMIT)
      .map(({ oid, summary, author }) => ({ sha: oid, summary, author })),
    commitCount: incoming.length,
    commitsTruncated: incoming.length > RESYNC_COMMIT_LIST_LIMIT,
  };
}

/**
 * Fast-forwards `project`'s default branch to the same branch on `source`, if
 * and only if that is a fast-forward.
 *
 * Never throws for an expected failure: every refusal — no access, a missing
 * branch, divergence, a moved project — is a `refused` outcome that says what
 * happened and, where it knows them, names both commits.
 *
 * @param opts.expectedSha - Only fast-forward if the upstream tip is exactly
 *   this commit. Lets an admin pin the resync to the commit they reviewed, so
 *   something pushed to GitHub afterwards is not swept in with it.
 * @param opts.landing - Wraps the push that moves the branch; see
 *   {@link ResyncLanding}. Defaults to running it directly.
 */
export async function runResync(
  env: ResyncEnv,
  project: ProjectEntry,
  source: ResyncSource,
  opts: { expectedSha?: string; landing?: ResyncLanding },
  logger: Logger,
): Promise<ResyncOutcome> {
  const branch = projectDefaultBranch(project);
  const landing: ResyncLanding = opts.landing ?? ((_newSha, push) => push());

  const remote = await openGitHubRemote(env, project, source, "read", logger);
  if (!remote.success) return upstreamRefusal(branch, remote.error);

  // Write-scoped from the start: the same token reads the advertisement,
  // clones, and — only if this turns out to be a fast-forward — pushes.
  const token = await freshRepoToken(env.ARTIFACTS, project.remote, "write", logger);
  if (!token.success) return projectUnavailable(branch, token.error);

  const [projectRefs, upstreamRefs] = await Promise.all([
    readAdvertisedRefs(project.remote, token.data, logger),
    listGitHubRefs(remote.data, logger),
  ]);
  if (!upstreamRefs.success) return upstreamRefusal(branch, upstreamRefs.error);
  if (!projectRefs.success) return projectUnavailable(branch, projectRefs.error);

  const advertisedProject = projectRefs.data.branches[branch];
  const advertisedUpstream = upstreamRefs.data.branches[branch];
  if (advertisedUpstream === undefined) {
    return refuse(
      branch,
      "RESYNC_UPSTREAM_BRANCH_MISSING",
      409,
      `${resyncSourceRepo(source)} has no branch '${branch}', which is this project's default branch.`,
      advertisedProject !== undefined ? { projectSha: advertisedProject } : {},
    );
  }
  if (advertisedProject === undefined) {
    // An empty project has nothing to fast-forward FROM. Populating one is an
    // import, with an import's checks, not a break-glass action.
    return refuse(
      branch,
      "RESYNC_PROJECT_BRANCH_MISSING",
      409,
      `This project has no '${branch}' branch yet, so there is nothing to fast-forward. A resync does not populate an empty project.`,
      { upstreamSha: advertisedUpstream },
    );
  }
  if (opts.expectedSha !== undefined && advertisedUpstream !== opts.expectedSha) {
    return shaMismatch(branch, source, opts.expectedSha, advertisedUpstream, advertisedProject);
  }
  if (advertisedProject === advertisedUpstream) {
    return {
      status: "up-to-date",
      branch,
      projectSha: advertisedProject,
      upstreamSha: advertisedUpstream,
    };
  }

  for (const full of [false, true]) {
    const loaded = await loadBothSides(project, token.data, remote.data, branch, full, logger);
    if ("refusal" in loaded) return loaded.refusal;
    const { projectSha, upstreamSha } = loaded;

    // Checked again on what was actually fetched: GitHub's branch can move
    // between the advertisement above and the fetch.
    if (opts.expectedSha !== undefined && upstreamSha !== opts.expectedSha) {
      return shaMismatch(branch, source, opts.expectedSha, upstreamSha, projectSha);
    }

    const verdict = await classify(loaded.fs, loaded.dir, projectSha, upstreamSha, full);
    switch (verdict.kind) {
      case "up-to-date":
        return { status: "up-to-date", branch, projectSha, upstreamSha };
      case "fast-forward":
        return land(project, token.data, loaded, branch, verdict.incoming, landing, logger);
      case "diverged":
        return refuse(
          branch,
          "RESYNC_DIVERGED",
          409,
          `'${branch}' has diverged: this project is at ${projectSha} and ${resyncSourceRepo(source)} is at ${upstreamSha}, and neither contains the other. A resync only fast-forwards, so nothing was changed.`,
          { projectSha, upstreamSha },
        );
      case "inconclusive":
        if (full) {
          return refuse(
            branch,
            "RESYNC_HISTORY_INCOMPLETE",
            502,
            `The history between ${projectSha} and ${upstreamSha} could not be read completely, so the resync could not prove this is a fast-forward. Nothing was changed.`,
            { projectSha, upstreamSha },
          );
        }
        logger.info("Resync: shallow window inconclusive, loading full history", {
          projectId: project.id,
          branch,
        });
        break;
    }
  }
  // Unreachable: the full-history pass returns from every branch above.
  return refuse(branch, "RESYNC_FAILED", 502, "The resync could not be completed.");
}
