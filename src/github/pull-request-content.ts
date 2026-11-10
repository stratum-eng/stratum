/**
 * Deciding whether a fetched pull request may enter a workspace (#420), and
 * joining it to the workspace's branch if it may.
 *
 * Everything here runs on a throwaway in-memory clone that already holds the
 * pull request's commits (see `fetchPullRequestHead`). Those commits were
 * written by someone with no account and no trust, so every question is asked
 * of the objects themselves — how many commits, which files, how many bytes —
 * and never of what GitHub or the pull request says about them.
 *
 * Nothing in this file runs code from the pull request, checks out a submodule,
 * or follows a URL the content names. The only thing it does with the content
 * is count it, look at the first bytes of small files, and merge trees.
 */

import git from "isomorphic-git";
import type { CommitAuthor } from "../storage/external-pull-requests";
import { type NodeFS, scanForSubmoduleContent } from "../storage/git-ops";
import { AppError, ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, fromPromise, ok } from "../utils/result";

/** What a pull request may be, to be brought in. */
export interface PullRequestLimits {
  /** Commits the pull request may add to the branch it targets. */
  maxCommits: number;
  /** Files it may add, change or delete. */
  maxChangedFiles: number;
  /** Bytes of file content it may add or change, summed over those files. */
  maxChangedBytes: number;
}

/** Why a pull request cannot be brought in as it stands. */
export interface PullRequestRefusal {
  code:
    | "PR_TOO_MANY_COMMITS"
    | "PR_TOO_MANY_FILES"
    | "PR_TOO_LARGE"
    | "PR_UNRELATED_HISTORY"
    | "PR_CONFLICTS"
    | "PR_EMPTY"
    | "SUBMODULES_UNSUPPORTED"
    | "LFS_UNSUPPORTED";
  /** One sentence a maintainer can pass on to the contributor. */
  reason: string;
}

export type LandOutcome =
  | {
      status: "landed";
      /** The branch's tip after the pull request was joined to it. */
      tip: string;
      /** Commits the pull request added that the branch did not have. */
      newCommits: number;
      /** Who wrote those commits. */
      authors: CommitAuthor[];
      changedFiles: number;
      /** True when a merge commit was needed; false for a fast-forward. */
      mergeCommit: boolean;
    }
  /** The branch already contains the pull request's head. */
  | { status: "already-present"; tip: string }
  | { status: "refused"; refusal: PullRequestRefusal };

/** Authors recorded per pull request. The rest are still in the commits. */
export const MAX_RECORDED_AUTHORS = 10;

/**
 * Commits of the workspace branch read to recognise "this commit is already
 * here". Bounds the walk on a full-history clone; a shallow one ends sooner.
 */
const BASE_HISTORY_WINDOW = 1000;

/** A Git LFS pointer file is this small and starts with this line. */
const LFS_POINTER_MAX_BYTES = 1024;
const LFS_POINTER_PREFIX = new TextEncoder().encode("version https://git-lfs.github.com/spec/v1");

const MERGE_AUTHOR = { name: "Stratum", email: "system@usestratum.dev" };

class LimitReached extends Error {
  constructor(readonly refusal: PullRequestRefusal) {
    super(refusal.reason);
  }
}

/**
 * Makes one line of plain text out of a string someone else chose: control
 * characters (newlines above all) become spaces, runs of space collapse.
 */
export function singleLine(text: string, maxLength: number): string {
  return Array.from(text, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code < 0xa0) || code === 0x2028 || code === 0x2029
      ? " "
      : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

const EMAIL = /^[^\s<>@]+@[^\s<>@]+$/;

/**
 * A commit author fit to be stored and written into a `Co-authored-by`
 * trailer, or null. The name and email come straight from a commit object, so
 * they are whatever its writer typed: a newline would let a name add trailers
 * of its own, and `<` or `>` would let it pose as a different address.
 */
export function sanitizeCommitAuthor(name: unknown, email: unknown): CommitAuthor | null {
  if (typeof name !== "string" || typeof email !== "string") return null;
  const cleanEmail = email.trim();
  if (cleanEmail.length > 254 || !EMAIL.test(cleanEmail)) return null;
  const cleanName = singleLine(name.replace(/[<>]/g, ""), 100);
  if (cleanName === "") return null;
  return { name: cleanName, email: cleanEmail };
}

/**
 * `Co-authored-by` trailers for the given authors, one per line. Used when a
 * merge writes a commit of its own instead of keeping the contributor's — a
 * squash — so the people who wrote the code are still named on what lands.
 */
export function coAuthorTrailers(authors: CommitAuthor[]): string[] {
  const seen = new Set<string>();
  const trailers: string[] = [];
  for (const author of authors) {
    const clean = sanitizeCommitAuthor(author.name, author.email);
    if (clean === null) continue;
    const key = clean.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    trailers.push(`Co-authored-by: ${clean.name} <${clean.email}>`);
  }
  return trailers;
}

/**
 * The authors to record after an import: those already recorded, then the new
 * ones, once each by email and no more than {@link MAX_RECORDED_AUTHORS}.
 *
 * A second import of the same pull request reads only the commits that are
 * new, so its authors alone would drop everyone credited by the first.
 */
export function mergeCommitAuthors(
  recorded: CommitAuthor[],
  added: CommitAuthor[],
): CommitAuthor[] {
  const byEmail = new Map<string, CommitAuthor>();
  for (const author of [...recorded, ...added]) {
    if (byEmail.size >= MAX_RECORDED_AUTHORS) break;
    const key = author.email.toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, author);
  }
  return [...byEmail.values()];
}

/** The commits a shallow clone stops at (`.git/shallow`); empty for a full clone. */
async function readShallowBoundary(fs: NodeFS, dir: string): Promise<Set<string>> {
  const path = `${dir.replace(/\/$/, "")}/.git/shallow`;
  const raw = await fromPromise(fs.promises.readFile(path, { encoding: "utf8" }));
  if (!raw.success || typeof raw.data !== "string") return new Set();
  return new Set(
    raw.data
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
}

type NewCommits =
  | { status: "ok"; count: number; authors: CommitAuthor[] }
  | { status: "too-many" }
  | { status: "unrelated" };

/**
 * Walks back from the pull request's head to the branch it targets, counting
 * the commits in between and collecting who wrote them.
 *
 * `unrelated` means the walk ran out of history before it met the branch: the
 * pull request starts from a commit this clone does not have (it is further
 * behind than the history that was fetched) or from no shared commit at all.
 * Either way there is nothing to merge it onto.
 */
async function collectNewCommits(
  fs: NodeFS,
  dir: string,
  head: string,
  branch: string,
  maxCommits: number,
): Promise<NewCommits> {
  const base = new Set<string>();
  const logged = await fromPromise(git.log({ fs, dir, ref: branch, depth: BASE_HISTORY_WINDOW }));
  if (logged.success) for (const entry of logged.data) base.add(entry.oid);
  const shallow = await readShallowBoundary(fs, dir);

  const seen = new Set<string>();
  const authors = new Map<string, CommitAuthor>();
  const queue = [head];
  let reachedBase = false;
  let ranOut = false;
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (base.has(oid)) {
      reachedBase = true;
      continue;
    }
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (seen.size > maxCommits) return { status: "too-many" };

    const read = await fromPromise(git.readCommit({ fs, dir, oid }));
    if (!read.success) {
      ranOut = true;
      continue;
    }
    const author = sanitizeCommitAuthor(
      read.data.commit.author.name,
      read.data.commit.author.email,
    );
    if (author !== null && authors.size < MAX_RECORDED_AUTHORS) {
      const key = author.email.toLowerCase();
      if (!authors.has(key)) authors.set(key, author);
    }
    // A commit on the shallow boundary has parents this clone was not sent.
    if (shallow.has(oid)) {
      ranOut = true;
      continue;
    }
    queue.push(...read.data.commit.parent);
  }
  if (!reachedBase || ranOut) return { status: "unrelated" };
  return { status: "ok", count: seen.size, authors: [...authors.values()] };
}

/** Do these bytes begin with `prefix`? */
function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

/**
 * Counts what differs between two commits' trees, refusing as soon as a limit
 * is passed or a Git LFS pointer turns up among the files the change adds or
 * modifies.
 *
 * Stratum has no LFS server. A pointer file would import as a small text file
 * that names an object nobody can fetch, and the tree that lands would not be
 * the tree the contributor has — so it is refused, like a submodule, instead
 * of brought in broken.
 */
async function measureChange(
  fs: NodeFS,
  dir: string,
  before: string,
  after: string,
  limits: PullRequestLimits,
): Promise<Result<{ changedFiles: number } | { refusal: PullRequestRefusal }, AppError>> {
  let changedFiles = 0;
  let changedBytes = 0;
  const megabytes = (bytes: number) => Math.floor(bytes / (1024 * 1024));
  const walked = await fromPromise(
    git.walk({
      fs,
      dir,
      trees: [git.TREE({ ref: before }), git.TREE({ ref: after })],
      map: async (filepath, entries) => {
        if (filepath === ".") return undefined;
        const [old, next] = entries as [
          (typeof entries)[number] | null,
          (typeof entries)[number] | null,
        ];
        const [oldType, nextType, oldOid, nextOid, oldMode, nextMode] = await Promise.all([
          old?.type(),
          next?.type(),
          old?.oid(),
          next?.oid(),
          old?.mode(),
          next?.mode(),
        ]);
        // Identical on both sides: nothing below it differs either.
        if (oldOid === nextOid && oldType === nextType && oldMode === nextMode) return null;
        // A directory is not a file; its entries are visited in their own right.
        if (nextType === "tree" || (next === null && oldType === "tree")) return undefined;

        changedFiles++;
        if (changedFiles > limits.maxChangedFiles) {
          throw new LimitReached({
            code: "PR_TOO_MANY_FILES",
            reason: `The pull request changes more than ${limits.maxChangedFiles} files, the most that can be brought in`,
          });
        }
        if (next !== null && nextType === "blob") {
          const content = await next.content();
          const size = content?.byteLength ?? 0;
          changedBytes += size;
          if (changedBytes > limits.maxChangedBytes) {
            throw new LimitReached({
              code: "PR_TOO_LARGE",
              reason: `The pull request adds or changes more than ${megabytes(limits.maxChangedBytes)} MB of file content, the most that can be brought in`,
            });
          }
          if (
            content !== undefined &&
            size <= LFS_POINTER_MAX_BYTES &&
            startsWith(content, LFS_POINTER_PREFIX)
          ) {
            throw new LimitReached({
              code: "LFS_UNSUPPORTED",
              reason: `The pull request adds a Git LFS pointer at ${singleLine(filepath, 200)}. Stratum does not support Git LFS; the file has to be committed as ordinary content or left out`,
            });
          }
        }
        return undefined;
      },
    }),
  );
  if (!walked.success) {
    if (walked.error instanceof LimitReached) return ok({ refusal: walked.error.refusal });
    return err(
      new ExternalServiceError("Git", "Failed to compare the pull request's tree", walked.error),
    );
  }
  return ok({ changedFiles });
}

/** Did isomorphic-git decline the merge (a conflict, or a merge it cannot do) rather than fail? */
function isMergeRefusal(error: Error): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "MergeConflictError" || code === "MergeNotSupportedError";
}

/**
 * Joins a fetched pull request to the branch of the clone it was fetched into,
 * or says why it cannot be.
 *
 * In order: count the commits it adds; merge it (a fast-forward when the pull
 * request is up to date with the branch, a merge commit when it is not — the
 * contributor's own commits are kept as they are either way); then check the
 * tree that results for submodules, and what changed for the file, size and
 * Git LFS limits. The branch ref in the clone is moved only by the merge, and
 * the caller pushes only after this returns `landed`, so a refusal at any step
 * leaves the workspace untouched.
 *
 * @param head - The pull request's head commit, already fetched into the clone
 * @param branch - The workspace's branch, checked out in the clone
 * @returns `err` only when the repository could not be read; everything that is
 *   a property of the pull request comes back as `refused`
 */
export async function landPullRequest(
  repo: { fs: NodeFS; dir: string },
  input: { prNumber: number; head: string; branch: string; limits: PullRequestLimits },
  logger: Logger,
): Promise<Result<LandOutcome, AppError>> {
  const { fs, dir } = repo;
  const { head, branch, limits } = input;
  const refused = (refusal: PullRequestRefusal): Result<LandOutcome, AppError> =>
    ok({ status: "refused", refusal });

  const before = await fromPromise(git.resolveRef({ fs, dir, ref: branch }));
  if (!before.success) {
    return err(
      new ExternalServiceError("Git", "Failed to resolve the workspace branch", before.error),
    );
  }
  const previousTip = before.data;

  const commits = await collectNewCommits(fs, dir, head, branch, limits.maxCommits);
  if (commits.status === "too-many") {
    return refused({
      code: "PR_TOO_MANY_COMMITS",
      reason: `The pull request adds more than ${limits.maxCommits} commits to '${branch}', the most that can be brought in`,
    });
  }
  if (commits.status === "unrelated") {
    return refused({
      code: "PR_UNRELATED_HISTORY",
      reason: `The pull request does not start from a recent commit of '${branch}'. It needs to be updated with the current '${branch}' before it can be brought in`,
    });
  }
  if (commits.count === 0) return ok({ status: "already-present", tip: previousTip });

  const merged = await fromPromise(
    git.merge({
      fs,
      dir,
      ours: branch,
      theirs: head,
      author: MERGE_AUTHOR,
      committer: MERGE_AUTHOR,
      message: `Merge GitHub pull request #${input.prNumber} into ${branch}`,
      // Nothing is resolved here: a conflict is the contributor's to fix.
      abortOnConflict: true,
    }),
  );
  if (!merged.success) {
    if (isMergeRefusal(merged.error)) {
      return refused({
        code: "PR_CONFLICTS",
        reason: `The pull request conflicts with '${branch}'. It needs to be updated with the current '${branch}' and the conflicts resolved before it can be brought in`,
      });
    }
    logger.error("Failed to merge pull request into workspace clone", merged.error, {
      prNumber: input.prNumber,
    });
    return err(new ExternalServiceError("Git", "Failed to merge the pull request", merged.error));
  }

  const after = await fromPromise(git.resolveRef({ fs, dir, ref: branch }));
  if (!after.success) {
    return err(new ExternalServiceError("Git", "Failed to resolve the merged tip", after.error));
  }
  const tip = after.data;

  // The whole resulting tree, not only what changed: what lands is this tree.
  const submodules = await scanForSubmoduleContent(fs, tip, logger);
  if (!submodules.success) return err(submodules.error);
  if (submodules.data.gitlinkPaths.length > 0 || submodules.data.hasGitmodules) {
    return refused({
      code: "SUBMODULES_UNSUPPORTED",
      reason:
        "The pull request uses git submodules, which Stratum does not support. The submodule has to be removed before it can be brought in",
    });
  }

  const measured = await measureChange(fs, dir, previousTip, tip, limits);
  if (!measured.success) return err(measured.error);
  if ("refusal" in measured.data) return refused(measured.data.refusal);

  return ok({
    status: "landed",
    tip,
    newCommits: commits.count,
    authors: commits.authors,
    changedFiles: measured.data.changedFiles,
    mergeCommit: merged.data.mergeCommit === true,
  });
}

/** The error a refusal is reported as: the caller's input is fine, the pull request is not. */
export function refusalError(refusal: PullRequestRefusal): AppError {
  return new AppError(refusal.reason, refusal.code, 422);
}
