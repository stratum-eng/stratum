import { createPatch } from "diff";
import git, { Errors as GitErrors } from "isomorphic-git";
import type { ArtifactsCreateResult, ArtifactsNamespace, Author, CommitLogEntry } from "../types";
import { AppError, ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { PhaseTimer } from "../utils/phase-timer";
import { type Result, err, fromPromise, ok } from "../utils/result";
import { isTraversalPath, isValidRefName } from "../utils/validation";
import { commitObject } from "./git-objects";
import { MODE_SYMLINK, MemoryFS } from "./memory-fs";
import { packObjects, placeLooseObject, unpackObjects } from "./object-loader";

// Custom HTTP client for Cloudflare Workers
// isomorphic-git/http/web expects browser APIs that don't exist in Workers.
// Built via a factory so an instrumented variant can isolate the true network
// leg (the single `await fetch`) from body-buffering and pack processing.
export function createHttpClient(opts: { onNetworkMs?: (ms: number) => void } = {}) {
  return {
    async request({
      url,
      method = "GET",
      headers = {},
      body: requestBody,
    }: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: AsyncIterableIterator<Uint8Array>;
    }) {
      // Buffer the full body before sending — Cloudflare Workers doesn't support
      // half-duplex streaming on outbound fetch(), so a ReadableStream body may be
      // silently dropped, causing the git server to return an empty response.
      let body: Uint8Array | undefined;
      if (requestBody) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of requestBody) {
          chunks.push(chunk);
        }
        const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
        body = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
      }

      const fetchStart = Date.now();
      const response = await fetch(url, {
        method,
        headers,
        body,
      });
      opts.onNetworkMs?.(Date.now() - fetchStart);

      const resHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        resHeaders[key] = value;
      });

      // Stream response body instead of materializing to avoid high memory usage
      async function* bodyGenerator(): AsyncIterableIterator<Uint8Array> {
        if (!response.body) return;
        const reader = response.body.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            yield value;
          }
        } finally {
          reader.releaseLock();
        }
      }

      return {
        url: response.url,
        method,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: resHeaders,
        body: bodyGenerator(),
      };
    },
  };
}

type HttpClient = ReturnType<typeof createHttpClient>;

// Default (uninstrumented) client used by every non-benchmarked path.
const http = createHttpClient();

const DIR = "/";

/**
 * Races `promise` against a timer, rejecting with an error naming `what` and
 * `timeoutMs` if the timer wins (#332). isomorphic-git's clone/fetch calls
 * have no cancellation support of their own — the `signal` option in its
 * types is documented as "reserved for future use" as of the pinned 1.37.x —
 * so this is the only bound available on a stalling remote. It stops this
 * file WAITING on the call, not the call itself: the underlying request keeps
 * running in the background until it settles or the Worker's execution ends,
 * since there is no way to actually abort it. Still worth doing — without
 * this, a stalling remote holds the calling request open indefinitely, with
 * no bound at all.
 *
 * Always clears its timer, so a `promise` that settles well within `timeoutMs`
 * never leaks a pending `setTimeout` past the call.
 */
/**
 * Thrown by {@link withTimeout} when its timer wins the race. Distinguishable
 * via `instanceof` from the underlying operation's own failures, because the
 * two mean different things: `withTimeout` never actually cancels the
 * underlying call (see its own doc comment), so a `TimeoutError` means "we
 * gave up waiting — the real operation may still be running and could still
 * land," not "this definitely did not happen." That distinction matters to
 * any caller that would otherwise take a destructive action on the strength
 * of a failure (e.g. backup restore's rollback — see `pushMain`/`pushTags`).
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new TimeoutError(`${what} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Default budget for {@link cloneRepo}'s own `git.clone` call. Sized for the
 * common case — a synchronous request path (browse, diff, merge, sandbox
 * eval) waiting on a shallow clone of a Stratum-native or GitHub remote — not
 * for `fullHistory: true` callers on a large repo, which should pass a larger
 * explicit `timeoutMs` (see the backup caller in `src/backup/repo-snapshot.ts`).
 */
const CLONE_TIMEOUT_MS = 30_000;

/** Default budget for one tag's fetch, and for the `git.getRemoteInfo` call
 * that enumerates tag names before it, inside {@link cloneRepo}'s
 * `includeTags` loop — used whenever the caller didn't pass `opts.timeoutMs`
 * (which governs the main clone AND every network call in this loop — see
 * its doc comment). Smaller than {@link CLONE_TIMEOUT_MS} deliberately: a
 * stalling remote fails the FIRST such call and aborts the whole clone, so
 * the realistic worst case is one timeout, not one per tag (up to
 * {@link MAX_TAGS}). */
const TAG_FETCH_TIMEOUT_MS = 15_000;

/** Budget for a workspace fetch or push inside the merge request path
 * (`mergeWorkspaceIntoProject`, `fastForwardMerge`, `batchMergeWorkspaces`,
 * `mergeStagedCommits`, `batchMergeStagedTrees`, `squashMerge`,
 * `revertToCommit`) — synchronous and user-facing, so kept tight. */
const MERGE_FETCH_TIMEOUT_MS = 30_000;

/** Budget for one deepening round in {@link readRepoFiles}'s pinned-commit
 * read (#246). Small deliberately: each round fetches a bounded increment
 * against the remote just cloned from moments earlier, and up to 4 rounds
 * can run in a single synchronous evaluation request (see
 * `PINNED_COMMIT_MAX_FETCH_DEPTH`'s own latency accounting). */
const DEEPEN_FETCH_TIMEOUT_MS = 15_000;

/** Budget for each of {@link syncFromGitHub}'s three fetches (the initial
 * source fetch and its two deepening callbacks). Larger than the
 * request-path budgets above: sync runs as a background/scheduled job, where
 * added latency is cheap — the same tradeoff `SYNC_MAX_FETCH_DEPTH`'s own
 * rationale already makes for that function. */
const SYNC_FETCH_TIMEOUT_MS = 60_000;

/** Budget for a `git.push` call on a synchronous, user-facing request path
 * OUTSIDE the merge family (`pushBranchToRemote` — GitHub PR promotion,
 * `initAndPush`, `commitAndPush`) — the merge/squash-merge/revert push sites
 * use the separate-but-equal {@link MERGE_FETCH_TIMEOUT_MS} instead, kept
 * distinct so each family can be retuned independently even though both
 * start at the same 30s value (#332's push/getRemoteInfo follow-up, caught
 * by review after the initial clone/fetch pass). */
const PUSH_TIMEOUT_MS = 30_000;

/** Budget for a `git.push` call inside {@link pushMain}/{@link pushTags} —
 * used exclusively by backup restore (`src/backup/repo-restore.ts`), an
 * infrequent, admin/cron-triggered operation, so kept generous like backup's
 * own 300s clone override rather than the request-path default. */
const RESTORE_TIMEOUT_MS = 300_000;

// Node.js-compatible FS interface (returned by MemoryFS.toNodeFS())
export interface NodeFS {
  promises: {
    readFile(path: string, options?: { encoding?: string }): Promise<string | Uint8Array>;
    writeFile(path: string, data: string | Uint8Array, options?: { mode?: number }): Promise<void>;
    unlink(path: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    rmdir(path: string): Promise<void>;
    stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
    lstat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
    readlink(path: string): Promise<string>;
    symlink(target: string, path: string): Promise<void>;
  };
}

const SYSTEM_AUTHOR: Author = { name: "Stratum", email: "system@usestratum.dev" };

export type MergeStrategy = "merge" | "squash";

export interface MergeWorkspaceOptions {
  author?: Author;
  strategy?: MergeStrategy;
  /** Optional Phase 0 instrumentation; populates per-phase spans when present. */
  timer?: PhaseTimer;
  /** SEC-2: if set, the fetched workspace tip must equal this (the sha that was
   * evaluated). Aborts the merge with STALE_WORKSPACE otherwise, closing the
   * window between the route's pre-merge check and this fetch. Defense-in-depth
   * alongside `workspaceSha`. */
  expectedWorkspaceSha?: string;
  /**
   * The exact workspace commit to merge (the sha the change was evaluated
   * against, #115). When set, the merge uses this commit instead of the
   * workspace's live `main` tip — closing the TOCTOU where a re-push between
   * evaluation and merge would otherwise land unevaluated content. Omit to merge
   * the live tip (legacy behavior). The sha must be reachable in the fetched
   * workspace history, else the merge fails closed.
   */
  workspaceSha?: string;
  /**
   * Default branch of the project repo AND its workspace fork (Artifacts forks
   * copy the parent's default branch under the same name). Defaults to "main";
   * pass projectDefaultBranch(project) for imported repos whose default is
   * master/trunk/….
   */
  branch?: string;
}

/**
 * Matches an isomorphic-git error class by `instanceof` as well as by its
 * static `code`, so a duplicated module instance (dual ESM/CJS load) still
 * classifies correctly.
 */
function matchesGitError(
  error: unknown,
  errorClass: { code: string } & (new (...args: never[]) => unknown),
): boolean {
  return (
    error instanceof errorClass ||
    (error instanceof Error && (error as { code?: unknown }).code === errorClass.code)
  );
}

/**
 * isomorphic-git reports a genuine content conflict as its own
 * `MergeConflictError`, carrying the conflicting paths in `data.filepaths`.
 */
function isGitMergeConflict(
  error: unknown,
): error is InstanceType<typeof GitErrors.MergeConflictError> {
  return matchesGitError(error, GitErrors.MergeConflictError);
}

export class MergeConflictError extends AppError {
  readonly conflictingFiles: string[];
  constructor(message: string, conflictingFiles: string[] = []) {
    super(message, "MERGE_CONFLICT", 409);
    this.name = "MergeConflictError";
    this.conflictingFiles = conflictingFiles;
  }
}

/**
 * Artifacts tokens are formatted as `<secret>?expires=<timestamp>`.
 * Only the secret portion is used for HTTP Basic auth.
 */
export function extractTokenSecret(token: string): string {
  return token.split("?expires=")[0] ?? token;
}

function makeAuth(token: string) {
  const secret = extractTokenSecret(token);
  return () => ({ username: "x", password: secret });
}

/**
 * Parse the Artifacts repo name out of a clone remote URL.
 * Remotes look like `https://<account>.artifacts.cloudflare.net/git/<namespace>/<repoName>.git`.
 * The trailing `<repoName>` is the name `ARTIFACTS.get()` expects. Returns null if the
 * URL doesn't match (e.g. a non-Artifacts remote).
 *
 * The hostname is constrained to `*.artifacts.cloudflare.net` over HTTPS: `freshRepoToken`
 * mints a real Artifacts credential from the returned name and uses it to auth against the
 * remote, so a non-Artifacts remote slipping through here could exfiltrate that token.
 */
export function artifactsRepoNameFromRemote(remote: string): string | null {
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (!url.hostname.endsWith(".artifacts.cloudflare.net")) return null;

  const match = url.pathname.match(/^\/git\/[^/]+\/([^/]+?)(?:\.git)?\/?$/);
  return match?.[1] ?? null;
}

/**
 * Mint a fresh, short-lived Artifacts token for a repo just before a git operation.
 *
 * Artifacts tokens carry an embedded `?expires=` timestamp, so a token is only good for
 * about an hour after it's minted. Rather than persist one and watch it go stale (which
 * yields `403 Invalid or expired token`), every git operation mints its own token scoped
 * to what it needs (`read` for clone/fetch, `write` for push). The repo identity is
 * derived from the remote URL.
 */
export async function freshRepoToken(
  artifacts: ArtifactsNamespace,
  remote: string,
  scope: "read" | "write",
  logger: Logger,
): Promise<Result<string, AppError>> {
  const name = artifactsRepoNameFromRemote(remote);
  if (!name) {
    logger.error("Could not derive Artifacts repo name from remote", undefined, { remote });
    return err(
      new ExternalServiceError("Artifacts", `Could not derive repo name from remote: ${remote}`),
    );
  }
  const minted = await fromPromise(
    (async () => {
      const repo = await artifacts.get(name);
      return repo.createToken(scope, 3600);
    })(),
  );
  if (!minted.success) {
    logger.error(
      "Failed to mint Artifacts token",
      minted.error instanceof Error ? minted.error : undefined,
      { remote, name, scope },
    );
    return err(
      new ExternalServiceError("Artifacts", "Failed to mint repository token", minted.error),
    );
  }
  return ok(minted.data.plaintext);
}

/**
 * Publishes the local default branch to a remote repository.
 *
 * `force` is opt-in because it overwrites the remote's default branch outright
 * — the project's canonical branch — so defaulting it on would discard any
 * commits pushed by someone else since this clone was taken. Backup restore is
 * the caller that does pass it, to publish a reconstructed repo over an
 * existing one; `pushTags` mirrors the same opt-in for the same reason.
 *
 * @param opts - Controls whether the existing remote branch may be overwritten, and which branch to push (default `main`, since imported repos keep their source branch name).
 * @returns No value on success, or an application error if the push fails.
 */
export async function pushMain(
  remote: string,
  token: string,
  fs: NodeFS,
  dir: string,
  logger: Logger,
  opts?: { force?: boolean; branch?: string },
): Promise<Result<void, AppError>> {
  const branch = opts?.branch ?? "main";
  const res = await fromPromise(
    withTimeout(
      git.push({
        fs,
        dir,
        http,
        url: remote,
        ref: branch,
        remoteRef: branch,
        onAuth: makeAuth(token),
        force: opts?.force ?? false,
      }),
      RESTORE_TIMEOUT_MS,
      "pushMain: git.push",
    ),
  );
  if (!res.success) {
    logger.error("Failed to push main during restore", res.error, { remote });
    // A timeout is not a confirmed rejection — withTimeout never actually
    // cancels the underlying push, so it may still land after this returns.
    // Coded distinctly (not ExternalServiceError) so callers like
    // restoreProjectRepo's rollback can tell "definitely failed, safe to
    // clean up" apart from "unknown, don't destroy anything on this signal."
    if (res.error instanceof TimeoutError) {
      return err(
        new AppError(
          `Push during restore timed out: ${res.error.message}. The push may still be in progress and could still land — do not assume it failed.`,
          "PUSH_TIMEOUT",
          504,
          { remote },
        ),
      );
    }
    return err(new ExternalServiceError("Git", "Failed to push during restore", res.error));
  }
  return ok(undefined);
}

/**
 * Pushes local `refs/tags/*` to an Artifacts remote.
 *
 * Runs after `pushMain` during backup restore so a restored repo carries its
 * tags; `force` mirrors the same restore-over-existing opt-in `pushMain` uses,
 * for the same reason.
 *
 * @param tagNames - The tag names to push.
 * @param opts - Controls whether existing remote tags may be replaced.
 * @returns An empty result on success, or an error describing the first failed tag push.
 */
export async function pushTags(
  remote: string,
  token: string,
  fs: NodeFS,
  dir: string,
  tagNames: string[],
  logger: Logger,
  opts?: { force?: boolean },
): Promise<Result<void, AppError>> {
  // Tags are pushed one ref at a time, so a mid-list failure leaves earlier tags
  // on the remote. Report exactly which ones landed: a forced restore over an
  // existing repo is not rolled back, and an operator (or a retry, which is
  // idempotent for already-pushed tags) needs to know how far it got.
  const pushedTags: string[] = [];
  for (const [index, name] of tagNames.entries()) {
    const ref = `refs/tags/${name}`;
    const res = await fromPromise(
      withTimeout(
        git.push({
          fs,
          dir,
          http,
          url: remote,
          ref,
          remoteRef: ref,
          onAuth: makeAuth(token),
          force: opts?.force ?? false,
        }),
        RESTORE_TIMEOUT_MS,
        `pushTags: git.push ${ref}`,
      ),
    );
    if (!res.success) {
      logger.error("Failed to push tag during restore", res.error, {
        remote,
        ref,
        failedTag: name,
        pushedTags,
        unpushedTags: tagNames.slice(index + 1),
      });
      // Same distinction pushMain makes: a timeout on tag N doesn't mean tag
      // N (or anything after it) definitely didn't land, and it says nothing
      // about the tags already confirmed pushed — a caller must not treat
      // this the same as a confirmed rejection when deciding what to do with
      // that already-landed state (see restoreProjectRepo's rollback).
      if (res.error instanceof TimeoutError) {
        return err(
          new AppError(
            `Push of tag ${name} during restore timed out: ${res.error.message}. ${pushedTags.length}/${tagNames.length} tags were confirmed pushed before this; the timed-out tag may still land — do not assume it failed.`,
            "PUSH_TIMEOUT",
            504,
            { remote, failedTag: name, pushedTags: [...pushedTags] },
          ),
        );
      }
      return err(
        new ExternalServiceError(
          "Git",
          `Failed to push tag ${name} during restore (${pushedTags.length}/${tagNames.length} tags pushed before the failure)`,
          res.error,
        ),
      );
    }
    pushedTags.push(name);
  }
  return ok(undefined);
}

/**
 * Pushes local `refs/heads/*` to an **Artifacts** remote.
 *
 * Distinct from {@link pushBranchToRemote}, which exists for GitHub and
 * authenticates as `x-access-token` with the token verbatim. Artifacts tokens
 * are `<secret>?expires=<timestamp>` and every Artifacts push strips the suffix
 * (see {@link extractTokenSecret}); handing one to the GitHub helper sends the
 * whole string as the password and the remote refuses it. Restore is the only
 * caller, and it pushes to Artifacts, so it needs this one.
 *
 * Reports partial progress exactly as {@link pushTags} does, and for the same
 * reason: refs go one at a time and a forced restore is not rolled back.
 *
 * @param branchNames - Branch names (without the `refs/heads/` prefix) to push.
 * @param opts - Whether an existing remote ref may be replaced.
 */
export async function pushBranches(
  remote: string,
  token: string,
  fs: NodeFS,
  dir: string,
  branchNames: string[],
  logger: Logger,
  opts?: { force?: boolean },
): Promise<Result<void, AppError>> {
  const pushedBranches: string[] = [];
  for (const [index, name] of branchNames.entries()) {
    const ref = `refs/heads/${name}`;
    const res = await fromPromise(
      git.push({
        fs,
        dir,
        http,
        url: remote,
        ref,
        remoteRef: ref,
        onAuth: makeAuth(token),
        force: opts?.force ?? false,
      }),
    );
    if (!res.success) {
      logger.error("Failed to push branch during restore", res.error, {
        remote,
        ref,
        failedBranch: name,
        pushedBranches,
        unpushedBranches: branchNames.slice(index + 1),
      });
      return err(
        new ExternalServiceError(
          "Git",
          `Failed to push branch ${name} during restore (${pushedBranches.length}/${branchNames.length} branches pushed before the failure)`,
          res.error,
        ),
      );
    }
    pushedBranches.push(name);
  }
  return ok(undefined);
}

/**
 * Pushes a local branch to a branch on an external remote — e.g. GitHub's
 * `stratum/<changeId>` ref before a PR is opened (#189).
 *
 * `localRef` is the branch inside `dir` to push and defaults to `main`. It must
 * match the ref the caller cloned: a `singleBranch` clone of a `develop`- or
 * `master`-default repo contains only that branch, and asking git.push for a
 * `main` that is not there fails locally, before any network call.
 *
 * Auth is HTTP basic with the token as the password; GitHub accepts any
 * username alongside a token. `force` defaults to false because `remoteRef` is
 * caller-supplied and could name a branch this app does not own — a defaulted
 * force-push there would destroy someone else's work. Pass `force: true`
 * explicitly, and only when overwriting a ref Stratum owns (re-promotion).
 *
 * @param opts - Remote URL, target branch, authentication token, the local branch to push, and optional force-push setting.
 * @returns A successful result when the push completes, or an application error when it fails.
 */
export async function pushBranchToRemote(
  fs: NodeFS,
  dir: string,
  opts: { url: string; remoteRef: string; token: string; force?: boolean; localRef?: string },
  logger: Logger,
): Promise<Result<void, AppError>> {
  const res = await fromPromise(
    withTimeout(
      git.push({
        fs,
        dir,
        http,
        url: opts.url,
        ref: opts.localRef ?? "main",
        remoteRef: opts.remoteRef,
        onAuth: () => ({ username: "x-access-token", password: opts.token }),
        force: opts.force ?? false,
      }),
      PUSH_TIMEOUT_MS,
      "pushBranchToRemote: git.push",
    ),
  );
  if (!res.success) {
    const cause = res.error instanceof Error ? res.error.message : String(res.error);
    logger.error("Failed to push branch to remote", res.error, {
      url: opts.url,
      remoteRef: opts.remoteRef,
      localRef: opts.localRef ?? "main",
    });
    return err(new ExternalServiceError("Git", `Failed to push branch: ${cause}`, res.error));
  }
  return ok(undefined);
}

/**
 * Resolves the tip commit of `ref` in an already-cloned repository.
 *
 * Distinct from {@link getCommitLog}, which clones fresh: this reads the `fs`/`dir`
 * of a clone the caller already has open, so it costs no extra network round trip.
 * Promotion (#243) uses this to confirm the workspace clone it is about to
 * force-push to GitHub is still the revision recorded as `change.evaluatedSha` —
 * the clone is a live read of the workspace, which can have advanced since
 * evaluation ran.
 *
 * `ref` is required and deliberately not defaulted to `"main"`. Callers hand
 * this a clone they made themselves, and those clones are routinely
 * `singleBranch` on a project-configured default branch — a `main` default
 * would resolve a ref that does not exist in such a clone and fail a valid
 * promotion, which is exactly the bug a silent default hid here before. The
 * caller already knows which ref it cloned; making it say so keeps the two
 * from drifting apart again.
 *
 * @param ref - The ref to resolve, which must exist in this clone — normally
 * the same ref the caller passed to {@link cloneRepo}.
 */
export async function resolveLocalTip(
  fs: NodeFS,
  dir: string,
  ref: string,
): Promise<Result<string, AppError>> {
  const tipResult = await fromPromise(git.resolveRef({ fs, dir, ref }));
  if (!tipResult.success) {
    return err(new ExternalServiceError("Git", "Failed to resolve local tip", tipResult.error));
  }
  return ok(tipResult.data);
}

/**
 * Initializes a repository with the supplied files, commits them, and pushes the commit to `main`.
 *
 * Only valid against a remote with no history: this builds the root commit, so
 * running it on a populated repository would orphan whatever is already there.
 *
 * @param remote - The remote repository URL
 * @param token - The authentication token for the remote repository
 * @param files - Files to add to the initial commit, keyed by path
 * @param message - The commit message
 * @param author - The commit author
 * @returns The SHA of the pushed commit
 */
export async function initAndPush(
  remote: string,
  token: string,
  files: Record<string, string>,
  message: string,
  logger: Logger,
  author: Author = SYSTEM_AUTHOR,
): Promise<Result<string, AppError>> {
  logger.debug("Initializing git repository", { remote, fileCount: Object.keys(files).length });

  const rawFs = new MemoryFS();
  const fs = rawFs.toNodeFS();

  const initResult = await fromPromise(git.init({ fs, dir: DIR, defaultBranch: "main" }));
  if (!initResult.success) {
    const cause =
      initResult.error instanceof Error ? initResult.error.message : String(initResult.error);
    logger.error("Failed to initialize git repository", initResult.error, { remote, cause });
    return err(
      new ExternalServiceError(
        "Git",
        `Failed to initialize repository: ${cause}`,
        initResult.error,
      ),
    );
  }

  for (const [path, content] of Object.entries(files)) {
    // Use raw fs for writeFile since we need Result handling
    const writeResult = await rawFs.promises.writeFile(`/${path}`, content);
    if (!writeResult.success) {
      logger.error("Failed to write file to memory FS", writeResult.error, { path, remote });
      return err(writeResult.error);
    }
    const addResult = await fromPromise(git.add({ fs, dir: DIR, filepath: path }));
    if (!addResult.success) {
      logger.error("Failed to stage file", addResult.error, { path, remote });
      return err(new ExternalServiceError("Git", `Failed to stage file: ${path}`, addResult.error));
    }
  }

  const commitResult = await fromPromise(git.commit({ fs, dir: DIR, message, author }));
  if (!commitResult.success) {
    logger.error("Failed to commit", commitResult.error, { remote, message });
    return err(new ExternalServiceError("Git", "Failed to commit", commitResult.error));
  }

  const pushResult = await fromPromise(
    withTimeout(
      git.push({ fs, dir: DIR, http, url: remote, ref: "main", onAuth: makeAuth(token) }),
      PUSH_TIMEOUT_MS,
      "initAndPush: git.push",
    ),
  );
  if (!pushResult.success) {
    const cause =
      pushResult.error instanceof Error ? pushResult.error.message : String(pushResult.error);
    logger.error("Failed to push to remote", pushResult.error, { remote, cause });
    return err(
      new ExternalServiceError("Git", `Failed to push to remote: ${cause}`, pushResult.error),
    );
  }

  logger.info("Successfully initialized and pushed repository", { remote, sha: commitResult.data });
  return ok(commitResult.data);
}

/**
 * Hard cap on how many tags a single `includeTags` clone will fetch. Each tag
 * costs its own fetch round trip (see below), so an unbounded remote tag count
 * would turn one clone into an unbounded number of requests. Truncation is
 * never silent: it is reported on the clone result (`tagsTruncated`,
 * `totalTagCount`) so `listRepoTags` and its callers can surface it (#241).
 *
 * Sized against the Workers subrequest budget, not picked round: one
 * isomorphic-git fetch is TWO subrequests (a GET of
 * `/info/refs?service=git-upload-pack`, then a POST to `/git-upload-pack`), so
 * the loop below costs `2 * MAX_TAGS` on top of the clone's own pair and the
 * `getRemoteInfo` handshake. At 500 that is ~1003 — on the nose of the
 * ~1000-subrequest cap this codebase budgets against elsewhere (see the note in
 * `src/storage/state.ts`), which would kill the request outright instead of
 * degrading. 200 keeps the tag walk near 400 and leaves the rest of the request
 * room to breathe; repos above it degrade visibly through `truncated`.
 */
export const MAX_TAGS = 200;

/**
 * Clones the `main` branch of a repository into an in-memory filesystem.
 *
 * The whole tree lands in worker memory, which is what makes the depth choice
 * a real tradeoff rather than a preference — see the `fullHistory` branch at
 * the `depth` option for why backup needs full history and merges do not.
 *
 * @param remote - The repository URL to clone
 * @param token - The authentication token for the repository
 * @param opts - Clone options
 * @param opts.fullHistory - Whether to clone the complete reachable history; otherwise, clone the most recent 50 commits
 * @param opts.ref - The branch to clone; defaults to `main`, but imported repos keep their source branch name (master/trunk/…)
 * @param opts.includeTags - Whether to follow the clone with a per-tag fetch of `refs/tags/*`; a `singleBranch` clone never brings tags. Capped at {@link MAX_TAGS}; see the result's `tagsTruncated`/`totalTagCount`.
 * @returns The cloned filesystem and its working directory (plus tag-fetch truncation info when `includeTags` was set), or an application error
 */
/**
 * Commits fetched for a shallow clone when the caller does not ask for more.
 *
 * Shared with {@link SYNC_FETCH_DEPTH} rather than written twice: the sync path
 * clones the project and fetches the source, and its deepening loop assumes
 * both started at the same window. Two independently-written 50s would agree
 * today and drift the first time either was tuned, with the only symptom a
 * spurious SYNC_DIVERGED.
 */
const DEFAULT_SHALLOW_DEPTH = 50;

/** The shape `getRemoteInfo` nests advertised refs into: each `/`-separated
 * path segment of the ref becomes a nested key, with the oid (or symref
 * target) only at the leaf. See {@link flattenRefTree}. */
type RemoteRefTree = { [segment: string]: string | RemoteRefTree };

/**
 * `getRemoteInfo` builds an object TREE out of the flat ref list it gets from
 * the remote, splitting every ref on "/" and nesting a level per segment (see
 * isomorphic-git's `getRemoteInfo`) — so `refs/tags/release/1.0` lands at
 * `refs.tags.release["1.0"]`, not `refs.tags["release/1.0"]`. A plain
 * `Object.keys(refs.tags)` therefore only recovers the first path segment of
 * any hierarchical tag name (yielding a nested object where an oid was
 * expected). This walks the tree back down, rejoining segments with "/", to
 * recover the true `name -> oid` pairs regardless of nesting depth.
 */
function flattenRefTree(node: RemoteRefTree | undefined, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (!node) return out;
  for (const [segment, value] of Object.entries(node)) {
    const name = prefix ? `${prefix}/${segment}` : segment;
    if (typeof value === "string") {
      out[name] = value;
    } else {
      Object.assign(out, flattenRefTree(value, name));
    }
  }
  return out;
}

export async function cloneRepo(
  remote: string,
  token: string,
  logger: Logger,
  opts: {
    fullHistory?: boolean;
    ref?: string;
    includeTags?: boolean;
    depth?: number;
    /** Overrides {@link CLONE_TIMEOUT_MS} for the main clone AND
     * {@link TAG_FETCH_TIMEOUT_MS} for each tag fetch when `includeTags` is
     * set — pass a larger value for a `fullHistory: true` clone of a repo
     * expected to be large (#332). Applies per-operation, not as an
     * aggregate budget across the whole call: a caller with `includeTags`
     * set is saying "any single network operation this clone makes may take
     * this long", the same statement the main clone already makes one of. */
    timeoutMs?: number;
  } = {},
  httpClient: HttpClient = http,
): Promise<
  Result<{ fs: NodeFS; dir: string; tagsTruncated?: boolean; totalTagCount?: number }, AppError>
> {
  logger.debug("Cloning repository", { remote, fullHistory: opts.fullHistory ?? false });

  const fs = new MemoryFS().toNodeFS();
  const cloneResult = await fromPromise(
    withTimeout(
      git.clone({
        fs,
        http: httpClient,
        dir: DIR,
        url: remote,
        // The repo's default branch: "main" for Stratum-native repos, but imported
        // repos keep their source branch name (master/trunk/…) — see
        // projectDefaultBranch in ../types.
        ref: opts.ref ?? "main",
        singleBranch: true,
        // Merges only need recent history (fast shallow clone). Backup needs the FULL
        // reachable history so the resulting pack is reachability-closed and restores
        // to the true tip — a 50-commit shallow clone silently drops older ancestors,
        // producing a snapshot that can't be restored past commit 50.
        //
        // `depth` is overridable because a caller that deepens afterwards has to
        // start both sides at the SAME window. `syncFromGitHub` fetches the source
        // at its own `depth`; if this clone stayed pinned at 50 while that was
        // larger, the project side would sit shallower than the retry loop's
        // starting window believes, and a merge base the source already has could
        // be reported as SYNC_DIVERGED without the project ever being deepened.
        ...(opts.fullHistory ? {} : { depth: opts.depth ?? DEFAULT_SHALLOW_DEPTH }),
        onAuth: makeAuth(token),
      }),
      opts.timeoutMs ?? CLONE_TIMEOUT_MS,
      "cloneRepo: git.clone",
    ),
  );

  if (!cloneResult.success) {
    logger.error("Failed to clone repository", cloneResult.error, { remote });
    return err(new ExternalServiceError("Git", "Failed to clone repository", cloneResult.error));
  }

  // isomorphic-git's singleBranch clone requests ONLY the branch tip — tag refs
  // are neither advertised locally nor are their objects fetched. Callers that
  // need tags (tags listing, backup) opt in to a follow-up tags-only fetch:
  // `getRemoteInfo` enumerates `refs/tags/*` cheaply (a ref/oid handshake, no
  // object data), then each tag is fetched INDIVIDUALLY with `singleBranch:
  // true` — isomorphic-git's singleBranch fetch requests only the one resolved
  // oid (`wants = [oid]`), so this pulls each tag's own object graph and
  // nothing else. A combined `singleBranch: false, tags: true` fetch (the old
  // approach) instead requests every branch tip the remote advertises, which
  // for a project with large branches unrelated to any tag pulls substantially
  // more than the feature needs (#241). depth/unresolvable degradation is
  // unchanged: each per-tag fetch keeps the same shallow window, and a tag
  // whose target lies outside it still degrades via `collectRepoTags` rather
  // than failing the clone.
  let tagsTruncated = false;
  let totalTagCount = 0;
  if (opts.includeTags) {
    const remoteInfoResult = await fromPromise(
      withTimeout(
        git.getRemoteInfo({ http: httpClient, url: remote, onAuth: makeAuth(token) }),
        opts.timeoutMs ?? TAG_FETCH_TIMEOUT_MS,
        "cloneRepo: git.getRemoteInfo",
      ),
    );
    if (!remoteInfoResult.success) {
      logger.error("Failed to enumerate remote tags", remoteInfoResult.error, { remote });
      return err(
        new ExternalServiceError("Git", "Failed to enumerate remote tags", remoteInfoResult.error),
      );
    }

    // getRemoteInfo nests advertised refs into an object tree keyed by path
    // segment (`refs.tags.<name>`, or several levels deep for a hierarchical
    // tag name like `release/1.0` — see `flattenRefTree`); it also advertises
    // each annotated tag's peeled commit under a `<name>^{}` key alongside the
    // tag object itself — that suffix marks a peeled target, not a real tag
    // name, so it's filtered out (we peel annotated tags ourselves in
    // `collectRepoTags`).
    const remoteTagsTree = (remoteInfoResult.data.refs as { tags?: RemoteRefTree } | undefined)
      ?.tags;
    const tagNames = Object.keys(flattenRefTree(remoteTagsTree)).filter(
      (name) => !name.endsWith("^{}"),
    );

    totalTagCount = tagNames.length;
    tagsTruncated = totalTagCount > MAX_TAGS;
    // Sort ascending for stable, readable fetch order; when truncating, keep
    // the highest-sorting names (tail of the ascending sort) rather than the
    // lowest, since a release listing wants v9.x over v1.x when only one can
    // fit. This is lexicographic, not chronological, ordering — "v10" sorts
    // below "v9" — so it's a best-effort signal from names alone, not a
    // guarantee of "newest".
    const sortedTagNames = tagNames.sort();
    const tagNamesToFetch = tagsTruncated ? sortedTagNames.slice(-MAX_TAGS) : sortedTagNames;
    if (tagsTruncated) {
      logger.warn("Remote tag count exceeds MAX_TAGS; truncating tags fetch", {
        remote,
        totalTagCount,
        fetchedTagCount: tagNamesToFetch.length,
        maxTags: MAX_TAGS,
      });
    }

    for (const name of tagNamesToFetch) {
      const tagFetch = await fromPromise(
        withTimeout(
          git.fetch({
            fs,
            http: httpClient,
            dir: DIR,
            url: remote,
            singleBranch: true,
            remoteRef: `refs/tags/${name}`,
            tags: true,
            ...(opts.fullHistory ? {} : { depth: 50 }),
            onAuth: makeAuth(token),
          }),
          // A caller's timeoutMs override (e.g. backup's 300s) is a
          // statement about how long ANY single network operation in this
          // clone may take, not just the main one — a full-history clone
          // with `includeTags: true` also drops each tag fetch's own depth
          // limit above, so leaving this on the smaller default would have
          // let a large/old-tagged repo's backup keep failing via a
          // 15s-capped tag fetch despite the override existing precisely to
          // give this clone more room (#332).
          opts.timeoutMs ?? TAG_FETCH_TIMEOUT_MS,
          `cloneRepo: git.fetch tag ${name}`,
        ),
      );
      if (!tagFetch.success) {
        logger.error("Failed to fetch tag", tagFetch.error, { remote, tag: name });
        return err(new ExternalServiceError("Git", `Failed to fetch tag: ${name}`, tagFetch.error));
      }
    }
  }

  logger.info("Successfully cloned repository", { remote });
  return ok({
    fs: fs as unknown as NodeFS,
    dir: DIR,
    ...(opts.includeTags ? { tagsTruncated, totalTagCount } : {}),
  });
}

export async function commitAndPush(
  fs: NodeFS,
  dir: string,
  remote: string,
  token: string,
  changes: Record<string, string>,
  message: string,
  logger: Logger,
  author: Author = SYSTEM_AUTHOR,
  branch = "main",
): Promise<Result<string, AppError>> {
  logger.debug("Committing and pushing changes", {
    remote,
    changeCount: Object.keys(changes).length,
  });

  // S7 (#130): the change map can come straight from a request body, and each
  // key is joined onto the clone dir below. Mirror resolveConflict's guards at
  // this choke point so EVERY caller gets them: no `../`/absolute traversal
  // out of the repo tree, and a per-file size cap (the MemoryFS lives in a
  // ~128MB isolate).
  for (const [path, content] of Object.entries(changes)) {
    if (isTraversalPath(path)) {
      return err(
        new AppError(
          `Invalid file path: ${path} — path traversal is not allowed`,
          "INVALID_INPUT",
          422,
        ),
      );
    }
    if (new TextEncoder().encode(content).length > MAX_FILE_BYTES) {
      return err(new AppError(`File ${path} exceeds maximum size of 10 MB`, "INVALID_INPUT", 422));
    }
  }

  const base = dir.endsWith("/") ? dir : `${dir}/`;
  for (const [path, content] of Object.entries(changes)) {
    try {
      await fs.promises.writeFile(`${base}${path}`, content);
    } catch (error) {
      const appError = error instanceof Error ? error : new Error(String(error));
      logger.error("Failed to write file to memory FS", appError, { path, remote });
      return err(new AppError(`Failed to write file: ${path}`, "FS_ERROR", 500));
    }

    const addResult = await fromPromise(git.add({ fs, dir, filepath: path }));
    if (!addResult.success) {
      logger.error("Failed to stage file", addResult.error, { path, remote });
      return err(new ExternalServiceError("Git", `Failed to stage file: ${path}`, addResult.error));
    }
  }

  const commitResult = await fromPromise(git.commit({ fs, dir, message, author }));
  if (!commitResult.success) {
    logger.error("Failed to commit", commitResult.error, { remote, message });
    return err(new ExternalServiceError("Git", "Failed to commit", commitResult.error));
  }

  const pushResult = await fromPromise(
    withTimeout(
      git.push({ fs, dir, http, url: remote, ref: branch, onAuth: makeAuth(token) }),
      PUSH_TIMEOUT_MS,
      "commitAndPush: git.push",
    ),
  );
  if (!pushResult.success) {
    logger.error("Failed to push to remote", pushResult.error, { remote });
    return err(new ExternalServiceError("Git", "Failed to push to remote", pushResult.error));
  }

  logger.info("Successfully committed and pushed changes", { remote, sha: commitResult.data });
  return ok(commitResult.data);
}

/**
 * Resolve the tip commit of a ref that was just fetched: prefer `FETCH_HEAD`
 * (set by the fetch that just ran), falling back to the fetched remote's
 * tracking ref for backends that don't populate `FETCH_HEAD`.
 */
async function resolveFetchedTip(
  fs: NodeFS,
  dir: string,
  remoteTrackingRef: string,
  logger: Logger,
  errorMessage: string,
  logContext: Record<string, unknown>,
): Promise<Result<string, AppError>> {
  const fetchHeadResult = await fromPromise(git.resolveRef({ fs, dir, ref: "FETCH_HEAD" }));
  if (fetchHeadResult.success) return ok(fetchHeadResult.data);

  const remoteRefResult = await fromPromise(git.resolveRef({ fs, dir, ref: remoteTrackingRef }));
  if (!remoteRefResult.success) {
    logger.error(errorMessage, remoteRefResult.error, logContext);
    return err(new ExternalServiceError("Git", errorMessage, remoteRefResult.error));
  }
  return ok(remoteRefResult.data);
}

/**
 * Merges a workspace into its parent project repo.
 *
 * Performs a true three-way merge via isomorphic-git's multi-remote fetch. A
 * squash merge happens only when the caller asks for one
 * (`options.strategy === "squash"`).
 *
 * It does **not** fall back to a squash on conflict, and has not for some time.
 * The old fallback swallowed real conflicts: it copied the workspace's files
 * over the project's, which silently discarded any project commit made after
 * the workspace forked. A conflict now returns `MergeConflictError` with the
 * conflicting paths, which the route turns into `409 MERGE_CONFLICT` carrying a
 * `conflictId` for out-of-band resolution.
 *
 * This comment is called out because its earlier wording outlived the change
 * and propagated: the README, the getting-started guide and the roadmap all
 * described the squash fallback as current behaviour long after it was gone.
 */
export async function mergeWorkspaceIntoProject(
  projectRemote: string,
  projectToken: string,
  workspaceRemote: string,
  workspaceToken: string,
  logger: Logger,
  options: MergeWorkspaceOptions = {},
): Promise<Result<string, AppError>> {
  logger.debug("Merging workspace into project", {
    projectRemote,
    workspaceRemote,
    strategy: options.strategy,
  });

  const author = options.author ?? SYSTEM_AUTHOR;
  const branch = options.branch ?? "main";
  const timer = options.timer;
  const measure = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
    timer ? timer.measure(name, fn) : fn();

  const cloneResult = await measure("projectCloneMs", () =>
    cloneRepo(projectRemote, projectToken, logger, { ref: branch }),
  );
  if (!cloneResult.success) return err(cloneResult.error);
  const { fs, dir } = cloneResult.data;

  const addRemoteResult = await fromPromise(
    git.addRemote({ fs, dir, remote: "workspace", url: workspaceRemote }),
  );
  if (!addRemoteResult.success) {
    logger.error("Failed to add workspace remote", addRemoteResult.error, {
      projectRemote,
      workspaceRemote,
    });
    return err(
      new ExternalServiceError("Git", "Failed to add workspace remote", addRemoteResult.error),
    );
  }

  const fetchResult = await measure("workspaceFetchMs", () =>
    fromPromise(
      withTimeout(
        git.fetch({
          fs,
          http,
          dir,
          remote: "workspace",
          ref: branch,
          singleBranch: true,
          onAuth: makeAuth(workspaceToken),
        }),
        MERGE_FETCH_TIMEOUT_MS,
        "mergeWorkspaceIntoProject: git.fetch workspace",
      ),
    ),
  );
  if (!fetchResult.success) {
    logger.error("Failed to fetch workspace", fetchResult.error, { workspaceRemote });
    return err(new ExternalServiceError("Git", "Failed to fetch workspace", fetchResult.error));
  }

  let workspaceSha: string;
  if (options.workspaceSha) {
    // Pin to the evaluated commit. It must be reachable in the just-fetched
    // history; if a re-push rewound past it, readCommit throws and we fail
    // closed rather than merge a different (unevaluated) tip.
    const pinnedResult = await fromPromise(git.readCommit({ fs, dir, oid: options.workspaceSha }));
    if (!pinnedResult.success) {
      logger.error("Pinned workspace sha not reachable in workspace", pinnedResult.error, {
        workspaceRemote,
        workspaceSha: options.workspaceSha,
      });
      return err(
        new ExternalServiceError(
          "Git",
          "Evaluated workspace commit is no longer present in the workspace",
          pinnedResult.error,
        ),
      );
    }
    workspaceSha = options.workspaceSha;
  } else {
    const tipResult = await resolveFetchedTip(
      fs,
      dir,
      `refs/remotes/workspace/${branch}`,
      logger,
      "Failed to resolve workspace ref",
      { workspaceRemote },
    );
    if (!tipResult.success) return err(tipResult.error);
    workspaceSha = tipResult.data;
  }

  // SEC-2: content is content-addressed on the staged paths; the cold path merges
  // the freshly-fetched tip, so verify it is exactly the sha that was evaluated
  // before merging. Closes the TOCTOU between the route's pre-merge tip check and
  // this fetch.
  if (options.expectedWorkspaceSha !== undefined && workspaceSha !== options.expectedWorkspaceSha) {
    logger.warn("Workspace tip changed since evaluation; aborting cold merge", {
      workspaceRemote,
      expected: options.expectedWorkspaceSha,
      actual: workspaceSha,
    });
    return err(
      new AppError(
        "Workspace changed since evaluation: tip does not match the evaluated revision",
        "STALE_WORKSPACE",
        409,
      ),
    );
  }

  if (options.strategy === "squash") {
    return squashMerge(fs, dir, workspaceSha, projectRemote, projectToken, author, logger, branch);
  }

  const mergeResult = await measure("mergeMs", () =>
    fromPromise(
      git.merge({
        fs,
        dir,
        ours: branch,
        theirs: workspaceSha,
        author,
        message: "Merge workspace into project",
        // isomorphic-git defaults to true, which throws the file-list-less
        // MergeNotSupportedError for any conflict its diff3 algorithm can't
        // auto-resolve. false lets it write conflict markers instead and throw
        // MergeConflictError with the real filepaths — safe here since `dir` is
        // a fresh, throwaway MemoryFS clone discarded after this call returns.
        abortOnConflict: false,
      }),
    ),
  );

  if (!mergeResult.success) {
    const message =
      mergeResult.error instanceof Error ? mergeResult.error.message : String(mergeResult.error);
    logger.error("Merge failed", mergeResult.error, { projectRemote, workspaceRemote, message });
    if (isGitMergeConflict(mergeResult.error)) {
      const filepaths = Array.isArray(mergeResult.error.data?.filepaths)
        ? mergeResult.error.data.filepaths
        : [];
      return err(
        new MergeConflictError(
          `Merge failed; workspace may be stale or conflicting: ${message}`,
          filepaths,
        ),
      );
    }
    // isomorphic-git throws MergeNotSupportedError for conflict shapes it can't
    // auto-resolve (e.g. add/add) and for histories with no single merge base —
    // still content conflicts the caller must resolve, just with no file list.
    if (matchesGitError(mergeResult.error, GitErrors.MergeNotSupportedError)) {
      return err(
        new MergeConflictError(`Merge failed; workspace may be stale or conflicting: ${message}`),
      );
    }
    // Anything else (network, auth, corrupt objects) is an operational failure —
    // surface it as such rather than telling the client to resolve conflicts.
    return err(
      new ExternalServiceError(
        "Git",
        `Merge failed: ${message}`,
        mergeResult.error instanceof Error ? mergeResult.error : undefined,
      ),
    );
  }

  const pushResult = await measure("pushMs", () =>
    fromPromise(
      withTimeout(
        git.push({
          fs,
          dir,
          http,
          url: projectRemote,
          ref: branch,
          onAuth: makeAuth(projectToken),
        }),
        MERGE_FETCH_TIMEOUT_MS,
        "mergeWorkspaceIntoProject: git.push",
      ),
    ),
  );
  if (!pushResult.success) {
    logger.error("Failed to push merge result", pushResult.error, { projectRemote });
    return err(new ExternalServiceError("Git", "Failed to push merge result", pushResult.error));
  }

  if (!mergeResult.data.oid) {
    logger.error("Merge produced no commit OID", undefined, { projectRemote, workspaceRemote });
    return err(new ExternalServiceError("Git", "Merge produced no commit OID"));
  }

  logger.info("Successfully merged workspace into project", {
    projectRemote,
    workspaceRemote,
    sha: mergeResult.data.oid,
  });
  return ok(mergeResult.data.oid);
}

export interface FastForwardResult {
  /** false => a fast-forward was not possible; caller should cold-merge. */
  fastForwarded: boolean;
  commit?: string;
}

/** Local ref used to push a pinned (non-tip) workspace commit to the project. */
const PINNED_MERGE_REF = "refs/heads/stratum-pinned-merge";

/**
 * Attempt a fast-forward of the project's main to the pinned workspace commit
 * (the evaluated sha, #124) — or the workspace tip for legacy unpinned changes —
 * skipping the project clone and the in-memory 3-way merge that
 * {@link mergeWorkspaceIntoProject} performs. Correctness does not depend on a
 * cached head: the non-force push is accepted by Artifacts only when the project
 * ref is still `expectedParent` (a true fast-forward). Any race or non-descendant
 * target returns `fastForwarded: false` so the caller falls back to the proven
 * cold merge.
 *
 * Note: this still fetches the workspace fork (its objects live in a separate
 * Artifacts repo); what it removes is the project clone (`depth:50`) + `git.merge`.
 */
export async function fastForwardMerge(
  projectRemote: string,
  projectToken: string,
  workspaceRemote: string,
  workspaceToken: string,
  expectedParent: string,
  logger: Logger,
  timer?: PhaseTimer,
  /** #124: the evaluated workspace commit (`change.workspace_head_sha`). When
   * set, the fast-forward TARGETS this sha: if the live tip moved past it
   * (re-push between evaluation and merge), the PINNED sha is pushed — not the
   * unevaluated tip. If the pinned sha is no longer present in the fetched
   * workspace history (force-push rewound it), the merge fails closed with
   * `PINNED_SHA_UNREACHABLE`. Omit for legacy live-tip behavior (changes that
   * predate migration 024). */
  pinnedWorkspaceSha?: string,
  /** Default branch shared by the project repo and its workspace fork. */
  branch = "main",
): Promise<Result<FastForwardResult, AppError>> {
  const measure = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
    timer ? timer.measure(name, fn) : fn();

  const cloneResult = await measure("workspaceFetchMs", () =>
    cloneRepo(workspaceRemote, workspaceToken, logger, { ref: branch }),
  );
  if (!cloneResult.success) return err(cloneResult.error);
  const { fs, dir } = cloneResult.data;

  const tipResult = await fromPromise(git.resolveRef({ fs, dir, ref: branch }));
  if (!tipResult.success) {
    return err(new ExternalServiceError("Git", "Failed to resolve workspace tip", tipResult.error));
  }
  const workspaceTip = tipResult.data;

  // The commit this merge will land. Defaults to the live tip (legacy changes
  // with no pinned sha); a pinned change always lands its EVALUATED commit.
  let target = workspaceTip;
  if (pinnedWorkspaceSha !== undefined && pinnedWorkspaceSha !== workspaceTip) {
    // Re-push between evaluation and merge. The merge gate is only sound if the
    // commit that lands is the one that was evaluated (#123/#124), so merge the
    // pinned sha — after proving it still exists in the fetched history.
    const pinnedResult = await fromPromise(git.readCommit({ fs, dir, oid: pinnedWorkspaceSha }));
    if (!pinnedResult.success) {
      logger.error("Pinned workspace sha not reachable in workspace; failing closed", undefined, {
        workspaceRemote,
        pinnedWorkspaceSha,
        workspaceTip,
      });
      return err(
        new AppError(
          "Evaluated workspace commit is no longer present in the workspace history; re-evaluate the change before merging",
          "PINNED_SHA_UNREACHABLE",
          409,
        ),
      );
    }
    logger.warn("Workspace tip moved since evaluation; fast-forwarding to the pinned sha", {
      workspaceRemote,
      pinned: pinnedWorkspaceSha,
      tip: workspaceTip,
    });
    target = pinnedWorkspaceSha;
  }

  // A fast-forward is only possible if the merge target descends from the
  // project's current head. If not (or history is too shallow to tell), cold-merge.
  const descResult = await fromPromise(
    git.isDescendent({ fs, dir, oid: target, ancestor: expectedParent, depth: -1 }),
  );
  if (!descResult.success) {
    // Most commonly: expectedParent is older than the shallow workspace clone, so
    // ancestry can't be proven. Log it — a repo that always lands here silently
    // never fast-forwards and would otherwise look like the FF path "works".
    logger.warn("Could not determine workspace descent; falling back to cold merge", {
      workspaceRemote,
      target,
      expectedParent,
    });
    return ok({ fastForwarded: false });
  }
  if (descResult.data !== true) {
    return ok({ fastForwarded: false });
  }

  // Push the target. The common case (target === tip) pushes the clone's `main`
  // exactly as before; a pinned non-tip target is pushed via a local ref written
  // at the pinned commit — O(1) extra work, no additional network round trips.
  let pushRef = branch;
  if (target !== workspaceTip) {
    const writeRefResult = await fromPromise(
      git.writeRef({ fs, dir, ref: PINNED_MERGE_REF, value: target, force: true }),
    );
    if (!writeRefResult.success) {
      return err(
        new ExternalServiceError("Git", "Failed to write pinned merge ref", writeRefResult.error),
      );
    }
    pushRef = PINNED_MERGE_REF;
  }

  const pushResult = await measure("pushMs", () =>
    fromPromise(
      withTimeout(
        git.push({
          fs,
          dir,
          http,
          url: projectRemote,
          ref: pushRef,
          remoteRef: branch,
          onAuth: makeAuth(projectToken),
        }),
        MERGE_FETCH_TIMEOUT_MS,
        "fastForwardMerge: git.push",
      ),
    ),
  );
  if (!pushResult.success) {
    logger.warn("Fast-forward push rejected; caller will cold-merge", { projectRemote });
    return ok({ fastForwarded: false });
  }

  logger.info("Fast-forwarded project to evaluated workspace commit", {
    projectRemote,
    sha: target,
  });
  return ok({ fastForwarded: true, commit: target });
}

export interface BatchWorkspace {
  changeId: string;
  remote: string;
  token: string;
}

export interface BatchMergeTimings {
  cloneMs: number;
  fetchMs: number;
  mergeMs: number;
  pushMs: number;
  totalMs: number;
}

export interface BatchMergeResult {
  commit: string;
  landed: string[];
  conflicted: string[];
  timings: BatchMergeTimings;
}

/**
 * Real-flow throughput spike (ADR 004 Task 1 gate): clone the project ONCE, fetch
 * N workspace tips CONCURRENTLY (overlapping I/O — the read-side question), then
 * sequentially 3-way merge each onto main, then ONE push. Measures whether the
 * read side parallelizes and what the batched real-flow commits/sec actually is.
 *
 * Distinct-file (non-conflicting) workspaces merge cleanly; a conflicting one is
 * recorded and skipped (checkpoint/restore of the dirty FS is Task 3 — not needed
 * for the non-conflicting throughput measurement).
 */
export async function batchMergeWorkspaces(
  projectRemote: string,
  projectToken: string,
  workspaces: BatchWorkspace[],
  logger: Logger,
): Promise<Result<BatchMergeResult, AppError>> {
  const startedAt = Date.now();
  const cloneStart = Date.now();
  const cloneResult = await cloneRepo(projectRemote, projectToken, logger);
  if (!cloneResult.success) return err(cloneResult.error);
  const { fs, dir } = cloneResult.data;
  const cloneMs = Date.now() - cloneStart;

  // Register each workspace as its own remote, then fetch them all concurrently.
  for (let i = 0; i < workspaces.length; i++) {
    const addResult = await fromPromise(
      git.addRemote({ fs, dir, remote: `ws${i}`, url: workspaces[i]?.remote ?? "" }),
    );
    if (!addResult.success) {
      return err(
        new ExternalServiceError("Git", "Failed to add workspace remote", addResult.error),
      );
    }
  }

  const fetchStart = Date.now();
  const fetched = await Promise.all(
    workspaces.map((ws, i) =>
      fromPromise(
        withTimeout(
          git.fetch({
            fs,
            http,
            dir,
            remote: `ws${i}`,
            ref: "main",
            singleBranch: true,
            onAuth: makeAuth(ws.token),
          }),
          MERGE_FETCH_TIMEOUT_MS,
          `batchMergeWorkspaces: git.fetch ws${i}`,
        ),
      ),
    ),
  );
  const fetchMs = Date.now() - fetchStart;
  for (const f of fetched) {
    if (!f.success) {
      return err(new ExternalServiceError("Git", "Concurrent workspace fetch failed", f.error));
    }
  }

  const landed: string[] = [];
  const conflicted: string[] = [];
  const mergeStart = Date.now();
  for (let i = 0; i < workspaces.length; i++) {
    const ws = workspaces[i];
    if (!ws) continue;
    const tipResult = await fromPromise(
      git.resolveRef({ fs, dir, ref: `refs/remotes/ws${i}/main` }),
    );
    if (!tipResult.success) {
      conflicted.push(ws.changeId);
      continue;
    }
    const mergeResult = await fromPromise(
      git.merge({
        fs,
        dir,
        ours: "main",
        theirs: tipResult.data,
        author: SYSTEM_AUTHOR,
        message: `Merge change ${ws.changeId}`,
      }),
    );
    if (mergeResult.success) {
      landed.push(ws.changeId);
    } else {
      conflicted.push(ws.changeId);
    }
  }
  const mergeMs = Date.now() - mergeStart;

  const headResult = await fromPromise(git.resolveRef({ fs, dir, ref: "main" }));
  if (!headResult.success) {
    return err(
      new ExternalServiceError("Git", "Failed to resolve head after merges", headResult.error),
    );
  }

  const pushStart = Date.now();
  const pushResult = await fromPromise(
    withTimeout(
      git.push({ fs, dir, http, url: projectRemote, ref: "main", onAuth: makeAuth(projectToken) }),
      MERGE_FETCH_TIMEOUT_MS,
      "batchMergeWorkspaces: git.push",
    ),
  );
  const pushMs = Date.now() - pushStart;
  if (!pushResult.success) {
    return err(new ExternalServiceError("Git", "Batch push failed", pushResult.error));
  }

  return ok({
    commit: headResult.data,
    landed,
    conflicted,
    timings: { cloneMs, fetchMs, mergeMs, pushMs, totalMs: Date.now() - startedAt },
  });
}

/**
 * Collect every object reachable from a tree (the tree, its subtrees, and the
 * blobs) as loose-object ("wrapped") bytes — the inverse of placeLooseObject, used
 * to stage a workspace's tip tree to R2 so the merge needs no fork fetch. Returns
 * `[{oid, bytes}]` where bytes are `<type> <len>\0<content>` (oid = git SHA-1).
 */
export async function extractTreeObjects(
  fs: NodeFS,
  dir: string,
  treeOid: string,
): Promise<{ oid: string; bytes: Uint8Array }[]> {
  const out: { oid: string; bytes: Uint8Array }[] = [];
  const seen = new Set<string>();

  const wrapped = async (oid: string): Promise<Uint8Array> => {
    const r = await git.readObject({ fs, dir, oid, format: "wrapped" });
    return r.object as Uint8Array;
  };

  const visit = async (oid: string): Promise<void> => {
    if (seen.has(oid)) return;
    seen.add(oid);
    out.push({ oid, bytes: await wrapped(oid) });
    const tree = await git.readTree({ fs, dir, oid });
    for (const entry of tree.tree) {
      if (entry.type === "tree") {
        await visit(entry.oid);
      } else if (entry.type === "blob" && !seen.has(entry.oid)) {
        seen.add(entry.oid);
        out.push({ oid: entry.oid, bytes: await wrapped(entry.oid) });
      }
    }
  };

  await visit(treeOid);
  return out;
}

export interface StagedMergeResult {
  commit: string;
  landed: string[];
  conflicted: string[];
  timings: { cloneMs: number; loadMs: number; mergeMs: number; pushMs: number; totalMs: number };
}

/**
 * Real-flow R2 path (ADR 004 Task 1c): clone the project ONCE, let `loadStaged`
 * place the batch's staged objects into the warm FS (the caller reads them from
 * R2 — the read side that avoids the connection-capped fork fetch), then
 * sequentially 3-way merge each staged commit onto main, then ONE push. Measures
 * whether the R2-fed real flow clears the throughput target.
 */
export async function mergeStagedCommits(
  projectRemote: string,
  projectToken: string,
  commitOids: string[],
  loadStaged: (fs: NodeFS, gitdir: string) => Promise<void>,
  logger: Logger,
): Promise<Result<StagedMergeResult, AppError>> {
  const startedAt = Date.now();
  const cloneStart = Date.now();
  const cloneResult = await cloneRepo(projectRemote, projectToken, logger);
  if (!cloneResult.success) return err(cloneResult.error);
  const { fs, dir } = cloneResult.data;
  const cloneMs = Date.now() - cloneStart;

  const loadStart = Date.now();
  const loaded = await fromPromise(loadStaged(fs, `${dir === "/" ? "" : dir}/.git`));
  if (!loaded.success) {
    return err(new ExternalServiceError("Git", "Failed to load staged objects", loaded.error));
  }
  const loadMs = Date.now() - loadStart;

  const landed: string[] = [];
  const conflicted: string[] = [];
  const mergeStart = Date.now();
  for (const oid of commitOids) {
    const merged = await fromPromise(
      git.merge({
        fs,
        dir,
        ours: "main",
        theirs: oid,
        author: SYSTEM_AUTHOR,
        message: `merge ${oid.slice(0, 7)}`,
      }),
    );
    if (!merged.success) {
      conflicted.push(oid);
      continue;
    }
    const checkout = await fromPromise(git.checkout({ fs, dir, ref: "main" }));
    if (!checkout.success) {
      return err(
        new ExternalServiceError("Git", "Failed to checkout main after merge", checkout.error),
      );
    }
    landed.push(oid);
  }
  const mergeMs = Date.now() - mergeStart;

  const headResult = await fromPromise(git.resolveRef({ fs, dir, ref: "main" }));
  if (!headResult.success) {
    return err(new ExternalServiceError("Git", "Failed to resolve head", headResult.error));
  }
  const pushStart = Date.now();
  const pushResult = await fromPromise(
    withTimeout(
      git.push({ fs, dir, http, url: projectRemote, ref: "main", onAuth: makeAuth(projectToken) }),
      MERGE_FETCH_TIMEOUT_MS,
      "mergeStagedCommits: git.push",
    ),
  );
  const pushMs = Date.now() - pushStart;
  if (!pushResult.success) {
    return err(new ExternalServiceError("Git", "Staged batch push failed", pushResult.error));
  }

  return ok({
    commit: headResult.data,
    landed,
    conflicted,
    timings: { cloneMs, loadMs, mergeMs, pushMs, totalMs: Date.now() - startedAt },
  });
}

const TREE_OID_HEX_LEN = 40;

/**
 * Stage a workspace's tip TREE to R2 (ADR 004 Task 3): one value =
 * `[40-byte tipTreeOid][packed tree objects]`. Recomputed on every commit. The
 * caller stores it under both the latest-tip key (overwritten per commit) and a
 * sha-keyed copy (`<key>/sha/<commitSha>`, #124) so the merge can consume the
 * tree of the EVALUATED commit even if the workspace was re-pushed since.
 */
export async function stageWorkspaceTree(
  bucket: R2Bucket,
  key: string,
  fs: NodeFS,
  dir: string,
  commitSha: string,
  logger: Logger,
): Promise<Result<{ treeOid: string; objectCount: number; value: Uint8Array }, AppError>> {
  const commit = await fromPromise(git.readCommit({ fs, dir, oid: commitSha }));
  if (!commit.success) {
    return err(new ExternalServiceError("Git", "Failed to read commit for staging", commit.error));
  }
  const treeOid = commit.data.commit.tree;
  const extracted = await fromPromise(extractTreeObjects(fs, dir, treeOid));
  if (!extracted.success) {
    return err(new ExternalServiceError("Git", "Failed to extract tree objects", extracted.error));
  }
  const objects = extracted.data;
  const pack = packObjects(objects);
  const header = new TextEncoder().encode(treeOid);
  const value = new Uint8Array(header.length + pack.length);
  value.set(header);
  value.set(pack, header.length);
  const put = await fromPromise(bucket.put(key, value));
  if (!put.success) {
    logger.error(
      "Failed to stage workspace tree",
      put.error instanceof Error ? put.error : undefined,
    );
    return err(new AppError("Failed to stage workspace tree", "STORAGE_ERROR", 500));
  }
  return ok({ treeOid, objectCount: objects.length, value });
}

export interface StagedTree {
  treeOid: string;
  objects: { oid: string; bytes: Uint8Array }[];
}

/** Parse the `[40-byte tipTreeOid][packed objects]` staged-tree value. */
export function parseStagedTree(value: Uint8Array): StagedTree {
  // Fail fast at the parser boundary on a truncated/corrupt payload (40-byte oid
  // header + at least the 4-byte pack count) rather than deeper in object unpacking.
  if (value.byteLength < TREE_OID_HEX_LEN + 4) {
    throw new Error("Invalid staged tree: truncated header");
  }
  const treeOid = new TextDecoder().decode(value.subarray(0, TREE_OID_HEX_LEN));
  if (!/^[0-9a-f]{40}$/i.test(treeOid)) {
    throw new Error("Invalid staged tree: malformed tree oid");
  }
  const objects = unpackObjects(value.subarray(TREE_OID_HEX_LEN));
  return { treeOid, objects };
}

/** R2 key of the latest-tip staged tree for a workspace (overwritten per commit). */
export function stagedTreeKey(projectId: string, workspace: string): string {
  return `repos/${projectId}/ws/${workspace}`;
}

/** #124: sha-keyed staged-tree copy — immutable per workspace commit, so the
 * merge can read the EVALUATED commit's tree after a re-push overwrote the
 * latest-tip key. */
export function stagedTreeShaKey(projectId: string, workspace: string, sha: string): string {
  return `${stagedTreeKey(projectId, workspace)}/sha/${sha}`;
}

/** Load a workspace's staged tip tree from R2 (see stageWorkspaceTree). */
export async function loadStagedTree(bucket: R2Bucket, key: string): Promise<StagedTree | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  return parseStagedTree(new Uint8Array(await obj.arrayBuffer()));
}

export interface StagedTreeItem {
  changeId: string;
  baseSha: string;
  staged: StagedTree;
  /** #124: tree oid the change was evaluated against. When set, the synthetic
   * commit is only built and merged if the staged tree matches — validating at
   * the merge layer that what lands is exactly the evaluated content. */
  expectedTreeOid?: string;
}

export interface StagedItemResult {
  changeId: string;
  merged: boolean;
  commit?: string;
  /** Why the item did not merge (validation failure vs plain conflict). */
  reason?: string;
}

/** Reason reported when a staged tree fails the evaluated-tree validation. */
export const STALE_STAGED_TREE_REASON =
  "Workspace changed since evaluation: staged tree does not match the evaluated revision";

/**
 * Group-commit batch over R2-staged workspace trees (ADR 004 Task 5): operates on
 * a caller-provided WARM fs/dir (clone reused across batches), placing each item's
 * staged objects, synthesizing a commit
 * `{tree: tipTree, parent: baseSha}`, and 3-way `git.merge` it onto the head —
 * checkpoint/restore the FS around each so a conflict can't dirty the next — then
 * ONE push. Per-item result (merged | conflicted); a clone/push failure throws
 * (the coordinator rejects the whole batch).
 */
export async function batchMergeStagedTrees(
  fs: NodeFS,
  dir: string,
  projectRemote: string,
  projectToken: string,
  items: StagedTreeItem[],
  _logger: Logger,
  branch = "main",
): Promise<Result<StagedItemResult[], AppError>> {
  const gitdir = `${dir === "/" ? "" : dir}/.git`;

  // #124 validation (O(1) per item — a string compare): a staged tree that does
  // not match the tree the change was evaluated against must not be synthesized
  // into a commit, let alone merged. Sha-keyed staging makes this a corruption
  // guard rather than a common path.
  const eligible = items.map(
    (item) => item.expectedTreeOid === undefined || item.staged.treeOid === item.expectedTreeOid,
  );

  // Phase 1 (off the merge critical path): place every item's objects, then build
  // the synthetic commits. The synth SHA-1 (`commitObject`) is async crypto with real
  // per-call overhead — running them sequentially inside the merge loop was the
  // dominant cost; `Promise.all` lets the crypto overlap. (Placement stays sequential:
  // concurrent writes race on MemoryFS object-dir creation.)
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || !eligible[i]) continue;
    for (const o of item.staged.objects) await placeLooseObject(fs, gitdir, o.oid, o.bytes);
  }
  const synths = await Promise.all(
    items.map((item, i) =>
      eligible[i]
        ? commitObject({
            tree: item.staged.treeOid,
            parents: [item.baseSha],
            message: `change ${item.changeId}`,
            timestamp: Math.floor(Date.now() / 1000),
          })
        : Promise.resolve(null),
    ),
  );
  for (const synth of synths) {
    if (synth) await placeLooseObject(fs, gitdir, synth.oid, synth.bytes);
  }

  // Phase 2: serial merge loop (the ref advance must be serialized). Checkpoint/
  // restore around each so a conflict can't dirty the next.
  const results: StagedItemResult[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    if (!eligible[i]) {
      results.push({ changeId: item.changeId, merged: false, reason: STALE_STAGED_TREE_REASON });
      continue;
    }
    const synthOid = synths[i]?.oid;
    if (!synthOid) continue;
    const checkpoint = await fromPromise(git.resolveRef({ fs, dir, ref: branch }));
    if (!checkpoint.success) {
      results.push({ changeId: item.changeId, merged: false });
      continue;
    }
    const attempt = await fromPromise(
      (async () => {
        const merged = await git.merge({
          fs,
          dir,
          ours: branch,
          theirs: synthOid,
          author: SYSTEM_AUTHOR,
          message: `Merge change ${item.changeId}`,
        });
        await git.checkout({ fs, dir, ref: branch });
        // git.merge omits `oid` when already up to date (the change's tree is already
        // in the default branch) — that's a successful no-op merge, not a conflict.
        // Fall back to the current head so it's reported merged.
        return merged.oid ?? (await git.resolveRef({ fs, dir, ref: branch }));
      })(),
    );
    if (attempt.success && attempt.data) {
      results.push({ changeId: item.changeId, merged: true, commit: attempt.data });
    } else {
      // Conflict/error: restore main to the checkpoint so the next merge is clean.
      // If restoration itself fails the FS is corrupt — abort the whole batch
      // rather than merge subsequent items against a dirty state.
      const restoreRef = await fromPromise(
        git.writeRef({ fs, dir, ref: branch, value: checkpoint.data, force: true }),
      );
      if (!restoreRef.success) {
        return err(
          new ExternalServiceError("Git", "Failed to restore ref after conflict", restoreRef.error),
        );
      }
      const restoreCheckout = await fromPromise(git.checkout({ fs, dir, ref: branch }));
      if (!restoreCheckout.success) {
        return err(
          new ExternalServiceError(
            "Git",
            "Failed to checkout after conflict restore",
            restoreCheckout.error,
          ),
        );
      }
      results.push({ changeId: item.changeId, merged: false });
    }
  }

  if (results.some((r) => r.merged)) {
    const pushResult = await fromPromise(
      withTimeout(
        git.push({
          fs,
          dir,
          http,
          url: projectRemote,
          ref: branch,
          onAuth: makeAuth(projectToken),
        }),
        MERGE_FETCH_TIMEOUT_MS,
        "batchMergeStagedTrees: git.push",
      ),
    );
    if (!pushResult.success) {
      return err(new ExternalServiceError("Git", "Batch push failed", pushResult.error));
    }
  }
  return ok(results);
}

/**
 * Removes a real directory subtree, leaf-first.
 *
 * The `lstat` gate is load-bearing, not a fast path. `MemoryFS.readdir` happens
 * to report ENOTDIR for a symlink, but node's own `readdir` FOLLOWS a directory
 * symlink — and `squashMerge` takes the `NodeFS` interface, not `MemoryFS`.
 * Recursing on `readdir` alone would therefore walk into a link's target and
 * delete files that were never part of this merge. Checking the entry first and
 * descending only into real directories leaves any symlink for the caller to
 * unlink, whichever implementation is behind the interface.
 */
async function removeSubtree(fs: NodeFS, full: string): Promise<void> {
  let stat: { isDirectory(): boolean };
  try {
    stat = await fs.promises.lstat(full);
  } catch {
    return; // absent
  }
  if (!stat.isDirectory()) return; // file or symlink: the caller's unlink handles it

  let entries: string[];
  try {
    entries = await fs.promises.readdir(full);
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = `${full}/${entry}`;
    await removeSubtree(fs, child);
    await fs.promises.unlink(child).catch(() => {});
  }
  await fs.promises.rmdir(full).catch(() => {});
}

/**
 * Clears anything whose *path shape* conflicts with what is about to be written.
 *
 * Two transitions corrupt the worktree if the old shape is left in place, and
 * neither is caught by unlinking the target path alone:
 *
 * - A symlink at an ANCESTOR silently redirects the write. With `lib` a symlink
 *   to `real/`, writing `lib/file.ts` lands at `real/file.ts` — verified
 *   against MemoryFS, which resolves the link during the write. The merge then
 *   reports success having written to the wrong path.
 * - Replacing a directory with a symlink leaves the directory's children behind.
 *   MemoryFS's `unlink` succeeds on a directory without removing descendants, so
 *   `lib/a.ts` stays readable *through* the new `lib` symlink.
 *
 * Ancestors are probed with `lstat` and removed unless they are directories.
 * The `NodeFS` shape has no `isSymbolicLink()`, but it does not need one here:
 * a plain file blocks a descendant write exactly as a symlink redirects it, so
 * "not a directory" is the whole test. `readlink` would be the narrower probe
 * and misses the file case entirely -- it throws EINVAL there.
 */
async function clearConflictingPathShape(
  fs: NodeFS,
  projectDir: string,
  path: string,
): Promise<void> {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const ancestor = `${projectDir}/${parts.slice(0, i).join("/")}`;
    let stat: { isDirectory(): boolean };
    try {
      stat = await fs.promises.lstat(ancestor);
    } catch {
      continue; // absent: the write creates it
    }
    // Anything that is not a directory blocks a descendant write. `lstat`
    // catches files and symlinks alike and does not follow links; probing with
    // `readlink` would miss a plain file, which fails the write with ENOTDIR
    // just as surely as a symlink redirects it.
    if (stat.isDirectory()) continue;
    await fs.promises.unlink(ancestor).catch(() => {});
  }
  await removeSubtree(fs, `${projectDir}/${path}`);
}

/** Exported for tests (the workdir copy must preserve file modes and symlinks). */
export async function squashMerge(
  projectFs: NodeFS,
  projectDir: string,
  workspaceSha: string,
  projectRemote: string,
  projectToken: string,
  author: Author,
  logger: Logger,
  branch = "main",
): Promise<Result<string, AppError>> {
  logger.debug("Performing squash merge", { projectRemote, workspaceSha });

  const workspaceFilesResult = await listFilesAtCommit(projectFs, workspaceSha, logger);
  if (!workspaceFilesResult.success) return err(workspaceFilesResult.error);

  const projectFilesResult = await listFilesAtCommit(projectFs, branch, logger);
  if (!projectFilesResult.success) return err(projectFilesResult.error);

  const workspaceFiles = workspaceFilesResult.data;
  const projectFiles = projectFilesResult.data;
  const workspaceMap = new Map(workspaceFiles.map(([path, oid]) => [path, oid]));
  const projectMap = new Map(projectFiles.map(([path, oid, mode]) => [path, { oid, mode }]));

  // Compare oid AND mode so a mode-only change (chmod +x, file<->symlink) is
  // carried over — the blob oid alone is identical in that case.
  const changed = workspaceFiles.filter(([path, hash, mode]) => {
    const projectEntry = projectMap.get(path);
    return projectEntry?.oid !== hash || projectEntry?.mode !== mode;
  });
  const deleted = projectFiles.filter(([path]) => !workspaceMap.has(path));
  // Every directory the workspace tree needs. A project path that is now one of
  // these is not really deleted -- its *shape* changed. `lib` as a symlink in
  // the project and `lib/file.ts` in the workspace makes `lib` look deleted,
  // but writing the file recreates `lib` as a real directory, and unlinking it
  // afterwards would either fail with EISDIR or destroy what was just written.
  const workspaceDirs = new Set<string>();
  for (const [path] of workspaceFiles) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) workspaceDirs.add(parts.slice(0, i).join("/"));
  }

  for (const [path, , mode] of changed) {
    const blobResult = await fromPromise(
      git.readBlob({ fs: projectFs, dir: DIR, oid: workspaceSha, filepath: path }),
    );
    if (!blobResult.success) {
      logger.error("Failed to read file at commit", blobResult.error, { workspaceSha, path });
      return err(
        new ExternalServiceError(
          "Git",
          `Failed to read file: ${path} at commit: ${workspaceSha}`,
          blobResult.error,
        ),
      );
    }
    const blob = blobResult.data.blob;

    const fullPath = `${projectDir}/${path}`;
    try {
      // Drop whatever is at the path first so file<->symlink transitions and
      // stale exec bits can't leak through the overwrite. The shape clear has
      // to come first: unlinking `fullPath` cannot fix a symlink ancestor that
      // would redirect the write, nor a directory whose children outlive it.
      await clearConflictingPathShape(projectFs, projectDir, path);
      await projectFs.promises.unlink(fullPath).catch(() => {});
      if (mode === MODE_SYMLINK) {
        await projectFs.promises.symlink(new TextDecoder().decode(blob), fullPath);
      } else {
        await projectFs.promises.writeFile(fullPath, blob, { mode });
      }
    } catch (error) {
      const appError = error instanceof Error ? error : new Error(String(error));
      logger.error("Failed to write file during squash merge", appError, { path, projectRemote });
      return err(new AppError(`Failed to write file: ${path}`, "FS_ERROR", 500));
    }

    const addResult = await fromPromise(
      git.add({ fs: projectFs, dir: projectDir, filepath: path }),
    );
    if (!addResult.success) {
      logger.error("Failed to stage file during squash merge", addResult.error, {
        path,
        projectRemote,
      });
      return err(new ExternalServiceError("Git", `Failed to stage file: ${path}`, addResult.error));
    }
  }

  for (const [path] of deleted) {
    // The worktree removal is conditional; the index removal below never is.
    // Whatever happened on disk, the entry has to leave the index or the squash
    // tree keeps a path the workspace does not have.
    //
    // Skip the unlink when the path -- or any ancestor of it -- is something
    // the workspace now owns, because the entry no longer means what the
    // project tree said it meant.
    //
    // Defensive rather than a fix for a reproducible bug: `MemoryFS.unlink`
    // resolves paths literally and does not follow a symlink ancestor, so with
    // `lib` replaced by a link, removing `lib/old.ts` returns ENOENT and leaves
    // the link target alone (verified). `squashMerge` takes the `NodeFS`
    // interface though, and node's own `fs` *does* traverse -- there the same
    // unlink would delete a same-named file inside the target that was never
    // part of this merge. The guard costs nothing and removes that dependency
    // on which implementation is behind the interface.
    const supersededByWorkspace =
      workspaceDirs.has(path) ||
      path
        .split("/")
        .slice(0, -1)
        .some((_, i, all) => workspaceMap.has(all.slice(0, i + 1).join("/")));
    if (!supersededByWorkspace) {
      try {
        await projectFs.promises.unlink(`${projectDir}/${path}`);
      } catch (error) {
        // Already gone is the desired end state, not a failure:
        // `clearConflictingPathShape` above may have removed this path while
        // making room for a changed one.
        if (!(error instanceof AppError && error.code === "ENOENT")) {
          const appError = error instanceof Error ? error : new Error(String(error));
          logger.error("Failed to unlink file during squash merge", appError, {
            path,
            projectRemote,
          });
          return err(new AppError(`Failed to unlink file: ${path}`, "FS_ERROR", 500));
        }
      }
    }

    const removeResult = await fromPromise(
      git.remove({ fs: projectFs, dir: projectDir, filepath: path }),
    );
    if (!removeResult.success) {
      logger.error("Failed to remove file during squash merge", removeResult.error, {
        path,
        projectRemote,
      });
      return err(
        new ExternalServiceError("Git", `Failed to remove file: ${path}`, removeResult.error),
      );
    }
  }

  const changeCount = changed.length + deleted.length;
  if (changeCount === 0) {
    const resolveResult = await fromPromise(
      git.resolveRef({ fs: projectFs, dir: projectDir, ref: branch }),
    );
    if (!resolveResult.success) {
      logger.error("Failed to resolve default-branch ref", resolveResult.error, { projectRemote });
      return err(
        new ExternalServiceError(
          "Git",
          "Failed to resolve default-branch ref",
          resolveResult.error,
        ),
      );
    }
    return ok(resolveResult.data);
  }

  const commitResult = await fromPromise(
    git.commit({
      fs: projectFs,
      dir: projectDir,
      message: `Squash merge workspace (${changeCount} file${changeCount === 1 ? "" : "s"} changed)`,
      author,
    }),
  );
  if (!commitResult.success) {
    logger.error("Failed to commit squash merge", commitResult.error, { projectRemote });
    return err(
      new ExternalServiceError("Git", "Failed to commit squash merge", commitResult.error),
    );
  }

  const pushResult = await fromPromise(
    withTimeout(
      git.push({
        fs: projectFs,
        dir: projectDir,
        http,
        url: projectRemote,
        ref: branch,
        onAuth: makeAuth(projectToken),
      }),
      MERGE_FETCH_TIMEOUT_MS,
      "squashMerge: git.push",
    ),
  );
  if (!pushResult.success) {
    logger.error("Failed to push squash merge", pushResult.error, { projectRemote });
    return err(new ExternalServiceError("Git", "Failed to push squash merge", pushResult.error));
  }

  logger.info("Successfully completed squash merge", { projectRemote, sha: commitResult.data });
  return ok(commitResult.data);
}

const MAX_REPO_FILES = 500;
/** Per-file ceiling for a commit. Exported so the workspace route enforces the
 * SAME number this choke point does, instead of a copy that can drift. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface ResolveConflictOpts {
  projectRemote: string;
  projectToken: string;
  workspaceRemote: string;
  workspaceToken: string;
  strategy: "accept-project" | "accept-workspace" | "manual";
  manualResolutions?: { file: string; content: string }[];
  conflictingFiles?: string[];
  /** Default branch shared by the project repo and its workspace fork ("main" if omitted). */
  branch?: string;
}

/**
 * Resolve a merge conflict by applying a strategy and producing a new commit.
 * Returns { commitSha } on success, or a structured error — never throws.
 */
export async function resolveConflict(
  opts: ResolveConflictOpts,
  logger: Logger,
): Promise<Result<{ commitSha: string }, AppError>> {
  const { projectRemote, projectToken, workspaceRemote, workspaceToken, strategy } = opts;
  const branch = opts.branch ?? "main";

  logger.info("Resolving conflict", { strategy, projectRemote });

  if (strategy === "manual") {
    const resolutions = opts.manualResolutions ?? [];
    if (resolutions.length === 0) {
      return err(
        new AppError("manual strategy requires at least one resolution", "INVALID_INPUT", 400),
      );
    }

    // Validate paths — no ../ traversal
    for (const { file } of resolutions) {
      if (file.includes("../") || file.startsWith("/")) {
        return err(
          new AppError(
            `Invalid file path: ${file} — path traversal is not allowed`,
            "INVALID_INPUT",
            422,
          ),
        );
      }
    }

    // Validate content sizes
    for (const { file, content } of resolutions) {
      if (new TextEncoder().encode(content).length > MAX_FILE_BYTES) {
        return err(
          new AppError(`File ${file} exceeds maximum size of 10 MB`, "INVALID_INPUT", 422),
        );
      }
    }

    const cloneResult = await cloneRepo(projectRemote, projectToken, logger, {
      ref: branch,
    });
    if (!cloneResult.success) return err(cloneResult.error);
    const { fs, dir } = cloneResult.data;

    // Guard: total file count
    const filesResult = await listFilesAtCommit(fs, branch, logger);
    if (!filesResult.success) return err(filesResult.error);
    if (filesResult.data.length > MAX_REPO_FILES) {
      return err(
        new AppError(
          `Repository has ${filesResult.data.length} files (max ${MAX_REPO_FILES})`,
          "INVALID_INPUT",
          422,
        ),
      );
    }

    const fileMap: Record<string, string> = {};
    for (const { file, content } of resolutions) {
      fileMap[file] = content;
    }

    const commitResult = await commitAndPush(
      fs,
      dir,
      projectRemote,
      projectToken,
      fileMap,
      "Resolved merge conflict manually",
      logger,
      SYSTEM_AUTHOR,
      branch,
    );
    if (!commitResult.success) return mapPushError(commitResult.error);
    return ok({ commitSha: commitResult.data });
  }

  if (strategy === "accept-project") {
    const cloneResult = await cloneRepo(projectRemote, projectToken, logger, {
      ref: branch,
    });
    if (!cloneResult.success) return err(cloneResult.error);
    const { fs, dir } = cloneResult.data;

    // Guard: total file count
    const filesResult = await listFilesAtCommit(fs, branch, logger);
    if (!filesResult.success) return err(filesResult.error);
    if (filesResult.data.length > MAX_REPO_FILES) {
      return err(
        new AppError(
          `Repository has ${filesResult.data.length} files (max ${MAX_REPO_FILES})`,
          "INVALID_INPUT",
          422,
        ),
      );
    }

    // Re-stage conflicting files at their current (project) versions to produce a resolution commit
    const conflicting = opts.conflictingFiles ?? [];
    const fileMap: Record<string, string> = {};
    for (const filePath of conflicting) {
      try {
        const content = await fs.promises.readFile(
          dir === "/" ? `/${filePath}` : `${dir}/${filePath}`,
          { encoding: "utf8" },
        );
        fileMap[filePath] =
          typeof content === "string" ? content : new TextDecoder().decode(content);
      } catch {
        // File may not exist on project side; skip
      }
    }

    if (Object.keys(fileMap).length === 0) {
      // No conflicting files to re-stage — resolve HEAD as the "commit"
      const refResult = await fromPromise(git.resolveRef({ fs, dir, ref: branch }));
      if (!refResult.success) return err(new AppError("Failed to resolve HEAD", "GIT_ERROR", 500));
      return ok({ commitSha: refResult.data });
    }

    const commitResult = await commitAndPush(
      fs,
      dir,
      projectRemote,
      projectToken,
      fileMap,
      "Resolved merge conflict: accepted project changes",
      logger,
      SYSTEM_AUTHOR,
      branch,
    );
    if (!commitResult.success) return mapPushError(commitResult.error);
    return ok({ commitSha: commitResult.data });
  }

  if (strategy === "accept-workspace") {
    const projectClone = await cloneRepo(projectRemote, projectToken, logger, {
      ref: branch,
    });
    if (!projectClone.success) return err(projectClone.error);
    const { fs: projectFs, dir: projectDir } = projectClone.data;

    // Guard: total file count in project
    const filesResult = await listFilesAtCommit(projectFs, branch, logger);
    if (!filesResult.success) return err(filesResult.error);
    if (filesResult.data.length > MAX_REPO_FILES) {
      return err(
        new AppError(
          `Repository has ${filesResult.data.length} files (max ${MAX_REPO_FILES})`,
          "INVALID_INPUT",
          422,
        ),
      );
    }

    const workspaceClone = await cloneRepo(workspaceRemote, workspaceToken, logger, {
      ref: branch,
    });
    if (!workspaceClone.success) return err(workspaceClone.error);
    const { fs: wsFs, dir: wsDir } = workspaceClone.data;

    const conflicting = opts.conflictingFiles ?? [];
    const filesToApply = conflicting.length > 0 ? conflicting : filesResult.data.map(([p]) => p);

    const fileMap: Record<string, string> = {};
    for (const filePath of filesToApply) {
      try {
        const content = await wsFs.promises.readFile(
          wsDir === "/" ? `/${filePath}` : `${wsDir}/${filePath}`,
          { encoding: "utf8" },
        );
        fileMap[filePath] =
          typeof content === "string" ? content : new TextDecoder().decode(content);
      } catch {
        // File doesn't exist in workspace; skip
      }
    }

    if (Object.keys(fileMap).length === 0) {
      const refResult = await fromPromise(
        git.resolveRef({ fs: projectFs, dir: projectDir, ref: branch }),
      );
      if (!refResult.success) return err(new AppError("Failed to resolve HEAD", "GIT_ERROR", 500));
      return ok({ commitSha: refResult.data });
    }

    const commitResult = await commitAndPush(
      projectFs,
      projectDir,
      projectRemote,
      projectToken,
      fileMap,
      "Resolved merge conflict: accepted workspace changes",
      logger,
      SYSTEM_AUTHOR,
      branch,
    );
    if (!commitResult.success) return mapPushError(commitResult.error);
    return ok({ commitSha: commitResult.data });
  }

  return err(new AppError(`Unknown strategy: ${strategy}`, "INVALID_INPUT", 400));
}

function mapPushError(error: AppError): Result<never, AppError> {
  const msg = error.message.toLowerCase();
  if (
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden")
  ) {
    return err(new AppError("GitHub token expired or insufficient permissions", "AUTH_ERROR", 401));
  }
  return err(error);
}

export interface SubmoduleContentReport {
  /** Paths of gitlink (mode 160000 / walk type "commit") tree entries found. */
  gitlinkPaths: string[];
  /** Whether a `.gitmodules` file exists at the repo root. */
  hasGitmodules: boolean;
}

/**
 * Scans commit `ref`'s full tree for submodule-related content Stratum does
 * not support (#258): gitlink entries (the tree-level marker for a submodule
 * pointer) and a `.gitmodules` file (the config git uses to declare them).
 *
 * This walks the TREE OBJECT, not a checked-out working copy. That matters:
 * isomorphic-git's checkout silently ignores a gitlink entry -- it writes
 * nothing to the working tree and raises nothing (see the `mkdir-index`/
 * `commit-tree` cases in its checkout implementation, and MemoryFS's
 * `MODE_GITLINK` override, which only fires for an index write that never
 * happens on checkout). A consumer that walked the checked-out filesystem
 * instead would see an ordinary-looking tree with the submodule quietly
 * missing -- exactly the silent corruption #258 forbids. Reading the tree
 * object directly is the only way to reliably detect a gitlink.
 *
 * Called at every point repo content enters Stratum -- GitHub import, and
 * change creation for both a gated push and the REST API (both go through
 * {@link getDiffBetweenRepos}) -- so an unsupported repo is rejected up front
 * with a clear, structured error instead of partially importing or reaching a
 * server-side merge.
 */
export async function scanForSubmoduleContent(
  fs: NodeFS,
  ref: string,
  logger: Logger,
): Promise<Result<SubmoduleContentReport, AppError>> {
  const gitlinkPaths: string[] = [];
  let hasGitmodules = false;
  const walkResult = await fromPromise(
    git.walk({
      fs,
      dir: DIR,
      trees: [git.TREE({ ref })],
      map: async (filepath, [entry]) => {
        if (!entry) return;
        const type = await entry.type();
        if (type === "commit") {
          gitlinkPaths.push(filepath);
        } else if (type === "blob" && filepath === ".gitmodules") {
          hasGitmodules = true;
        }
      },
    }),
  );
  if (!walkResult.success) {
    logger.error("Failed to scan tree for submodule content", walkResult.error, { ref });
    return err(
      new ExternalServiceError("Git", `Failed to scan tree at commit: ${ref}`, walkResult.error),
    );
  }
  return ok({ gitlinkPaths, hasGitmodules });
}

/** Builds the standard fail-closed error for submodule content found by
 * {@link scanForSubmoduleContent} (#258). */
export function submoduleUnsupportedError(report: SubmoduleContentReport): AppError {
  const found: string[] = [];
  if (report.gitlinkPaths.length > 0) {
    const shown = report.gitlinkPaths.slice(0, 5);
    const rest = report.gitlinkPaths.length - shown.length;
    found.push(
      `gitlink entr${report.gitlinkPaths.length === 1 ? "y" : "ies"} at ${shown.join(", ")}${
        rest > 0 ? `, and ${rest} more` : ""
      }`,
    );
  }
  if (report.hasGitmodules) found.push(".gitmodules");
  return new AppError(
    `Repository uses git submodules (found ${found.join(" and ")}), which Stratum does not support yet. Remove submodules and retry.`,
    "SUBMODULES_UNSUPPORTED",
    422,
    { gitlinkPaths: report.gitlinkPaths, hasGitmodules: report.hasGitmodules },
  );
}

async function listFilesAtCommit(
  fs: NodeFS,
  ref: string,
  logger: Logger,
): Promise<Result<[path: string, oid: string, mode: number][], AppError>> {
  const files: [string, string, number][] = [];
  const walkResult = await fromPromise(
    git.walk({
      fs,
      dir: DIR,
      trees: [git.TREE({ ref })],
      map: async (filepath, [entry]) => {
        if (!entry) return;
        const type = await entry.type();
        if (type === "blob") {
          const oid = await entry.oid();
          const mode = await entry.mode();
          files.push([filepath, oid, mode]);
        } else if (type === "commit") {
          // Gitlink (submodule reference) — MemoryFS has no checked-out submodule
          // behind it (see MemoryStats.mode), so silently omitting it here would
          // let squashMerge's diff miss an added/changed/removed submodule
          // pointer. Fail closed instead of losing it.
          throw new Error(`Gitlink (submodule) entry at "${filepath}" is not supported`);
        }
      },
    }),
  );

  if (!walkResult.success) {
    logger.error("Failed to walk files at commit", walkResult.error, { ref });
    return err(
      new ExternalServiceError("Git", `Failed to list files at commit: ${ref}`, walkResult.error),
    );
  }

  return ok(files);
}

async function readFileAtCommit(
  fs: NodeFS,
  ref: string,
  path: string,
  logger: Logger,
): Promise<Result<string, AppError>> {
  const readResult = await fromPromise(git.readBlob({ fs, dir: DIR, oid: ref, filepath: path }));
  if (!readResult.success) {
    logger.error("Failed to read file at commit", readResult.error, { ref, path });
    return err(
      new ExternalServiceError(
        "Git",
        `Failed to read file: ${path} at commit: ${ref}`,
        readResult.error,
      ),
    );
  }

  return ok(new TextDecoder().decode(readResult.data.blob));
}

export async function readFileFromRepo(
  remote: string,
  token: string,
  path: string,
  logger: Logger,
  branch = "main",
): Promise<Result<string, AppError>> {
  logger.debug("Reading file from repo", { remote, path });

  const cloneResult = await cloneRepo(remote, token, logger, { ref: branch });
  if (!cloneResult.success) return err(cloneResult.error);

  const { fs } = cloneResult.data;

  try {
    const content = await fs.promises.readFile(`/${path}`, { encoding: "utf8" });
    logger.info("Successfully read file from repo", { remote, path });
    return ok(typeof content === "string" ? content : new TextDecoder().decode(content));
  } catch (error) {
    logger.error("Failed to read file from repo", error instanceof Error ? error : undefined, {
      remote,
      path,
    });
    return err(new AppError(`Failed to read file: ${path}`, "FS_ERROR", 500));
  }
}

export async function listFilesInRepo(
  remote: string,
  token: string,
  logger: Logger,
  branch = "main",
): Promise<Result<string[], AppError>> {
  logger.debug("Listing files in repo", { remote });

  const cloneResult = await cloneRepo(remote, token, logger, { ref: branch });
  if (!cloneResult.success) return err(cloneResult.error);

  const { fs, dir } = cloneResult.data;
  return walkDir(fs, dir, "", logger);
}

/**
 * Read the full working tree (paths → raw bytes) in a single clone. Used by
 * the post-merge smoke check and the sandbox evaluator to populate a sandbox.
 * When `ref` (a commit sha) is given, the tree of that commit is read instead
 * of the clone's HEAD, so callers can pin the exact evaluated commit.
 *
 * The pinned path clones shallow like the unpinned path, then grows the fetch
 * window only as far as needed to reach `ref` — bounded by
 * {@link PINNED_COMMIT_MAX_FETCH_DEPTH} — rather than cloning full history
 * (#246: a repo with a large or deliberately inflated history could otherwise
 * exhaust the Worker isolate before a single commit tree was even read). A
 * ref still not reachable within the bound is an error, never a silent
 * fall-through to evaluating something else.
 *
 * Bytes are returned as-is (no UTF-8 decoding): a repo tree can contain
 * binary files (images, fonts, `.wasm`, compiled fixtures), and `TextDecoder`
 * is lossy for anything that isn't valid UTF-8. Callers decode to text only
 * where text is genuinely needed.
 */
export async function readRepoFiles(
  remote: string,
  token: string,
  logger: Logger,
  ref?: string,
  branch = "main",
): Promise<Result<Map<string, Uint8Array>, AppError>> {
  logger.debug("Reading repo files", { remote, ref });

  const cloneResult = await cloneRepo(remote, token, logger, { ref: branch });
  if (!cloneResult.success) return err(cloneResult.error);
  const { fs, dir } = cloneResult.data;

  if (ref !== undefined) {
    const deepen: DeepenFetch = async (increment) => {
      const result = await fromPromise(
        withTimeout(
          git.fetch({
            fs,
            http,
            dir,
            remote: "origin",
            ref: branch,
            singleBranch: true,
            depth: increment,
            relative: true,
            onAuth: makeAuth(token),
          }),
          DEEPEN_FETCH_TIMEOUT_MS,
          "readRepoFiles: git.fetch deepen",
        ),
      );
      if (!result.success) {
        logger.error(
          "Failed to deepen repository history while searching for a pinned commit",
          result.error,
          { remote, ref },
        );
        return err(
          new ExternalServiceError("Git", "Failed to deepen repository history", result.error),
        );
      }
      return ok(undefined);
    };

    return readTreeAtCommitWithDeepening(
      fs,
      dir,
      ref,
      branch,
      DEFAULT_SHALLOW_DEPTH,
      PINNED_COMMIT_MAX_FETCH_DEPTH,
      deepen,
      logger,
    );
  }

  const filesResult = await walkDir(fs, dir, "", logger);
  if (!filesResult.success) return err(filesResult.error);

  const contents = new Map<string, Uint8Array>();
  for (const path of filesResult.data) {
    try {
      // No `encoding` option: MemoryFS's readFile returns the raw bytes
      // unmodified when no encoding is requested.
      const raw = await fs.promises.readFile(`/${path}`);
      contents.set(path, typeof raw === "string" ? new TextEncoder().encode(raw) : raw);
    } catch (error) {
      logger.warn("Skipping unreadable file in repo tree", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return ok(contents);
}

/**
 * Aggregate cap on the bytes {@link readTreeAtCommit} will materialize
 * across one commit's entire tree (#333). `MAX_FILE_BYTES` (10 MB) already
 * bounds any single blob, but that alone doesn't bound the TREE: a commit
 * with many merely-large files (or a churny history among callers that read
 * more than one commit) can still sum to far more than the sandbox
 * evaluator's downstream base64 write boundary (`materializeTree`) can
 * safely hold in the Worker's ~128 MB isolate alongside everything else the
 * request needs. #246 bounded HISTORY depth for this same read path; this
 * bounds tree SIZE — an independent dimension of the same memory-exhaustion
 * concern, since even a single commit at depth 1 can carry an oversized tree.
 *
 * Sized the same as `MAX_GIT_BODY_BYTES` (`src/routes/git-http.ts`) — this
 * codebase's existing precedent for how much raw git content is reasonable
 * to buffer in memory for one operation.
 *
 * Checked DURING the read, as each blob lands, not after the whole tree is
 * already in memory — a check applied only once everything is already
 * materialized would be too late to bound anything, the same reasoning #246
 * already applied to the clone step itself.
 */
const MAX_TREE_READ_BYTES = 50 * 1024 * 1024;

/** Every file (path → raw bytes) in the tree of one commit. Exported for tests. */
export async function readTreeAtCommit(
  fs: NodeFS,
  dir: string,
  commitSha: string,
  logger: Logger,
  /** Overrides {@link MAX_TREE_READ_BYTES} — a parameter (rather than a bare
   * reference to the constant) purely so tests can drive the boundary with a
   * small tree instead of allocating tens of MB of fixture data. */
  maxTotalBytes: number = MAX_TREE_READ_BYTES,
): Promise<Result<Map<string, Uint8Array>, AppError>> {
  const listResult = await fromPromise(git.listFiles({ fs, dir, ref: commitSha }));
  if (!listResult.success) {
    logger.error("Failed to list files at commit", listResult.error, { commitSha });
    return err(
      new ExternalServiceError(
        "Git",
        `Failed to read tree at commit ${commitSha}`,
        listResult.error,
      ),
    );
  }

  const contents = new Map<string, Uint8Array>();
  let totalBytes = 0;
  for (const path of listResult.data) {
    const blobResult = await fromPromise(git.readBlob({ fs, dir, oid: commitSha, filepath: path }));
    if (!blobResult.success) {
      // A pinned commit's tree is expected to be complete; an unreadable blob
      // means object corruption, not a benign gap. Fail closed rather than
      // handing a caller (e.g. the sandbox evaluator) a silently partial tree.
      logger.error("Unreadable file in commit tree", blobResult.error, { path, commitSha });
      return err(
        new ExternalServiceError(
          "Git",
          `Failed to read tree at commit ${commitSha}: unreadable object at ${path}`,
          blobResult.error,
        ),
      );
    }

    totalBytes += blobResult.data.blob.length;
    if (totalBytes > maxTotalBytes) {
      logger.error("Commit tree exceeds the max materializable size", undefined, {
        commitSha,
        path,
        totalBytes,
        maxTotalBytes,
      });
      return err(
        new ExternalServiceError(
          "Git",
          `Commit ${commitSha}'s tree exceeds the ${maxTotalBytes}-byte materialization cap ` +
            `(stopped at ${path})`,
        ),
      );
    }
    contents.set(path, blobResult.data.blob);
  }
  return ok(contents);
}

/** The first parent of a commit — for a merge commit, the pre-merge HEAD. */
export async function getCommitParent(
  remote: string,
  token: string,
  commitSha: string,
  logger: Logger,
  branch = "main",
): Promise<Result<string, AppError>> {
  const cloneResult = await cloneRepo(remote, token, logger, { ref: branch });
  if (!cloneResult.success) return err(cloneResult.error);
  const { fs, dir } = cloneResult.data;

  const readResult = await fromPromise(git.readCommit({ fs, dir, oid: commitSha }));
  if (!readResult.success) {
    logger.error("Failed to read commit", readResult.error, { commitSha });
    return err(new ExternalServiceError("Git", "Failed to read commit", readResult.error));
  }
  const parent = readResult.data.commit.parent[0];
  if (!parent) {
    return err(new AppError(`Commit ${commitSha} has no parent`, "GIT_ERROR", 500));
  }
  return ok(parent);
}

/**
 * Revert the repository to the tree of `targetSha` by writing a new commit
 * on top of the current HEAD (history is preserved; nothing is force-pushed).
 * Returns the revert commit sha.
 */
export async function revertToCommit(
  remote: string,
  token: string,
  targetSha: string,
  message: string,
  logger: Logger,
  branch = "main",
): Promise<Result<string, AppError>> {
  logger.info("Reverting repo to commit tree", { remote, targetSha });

  const cloneResult = await cloneRepo(remote, token, logger, { ref: branch });
  if (!cloneResult.success) return err(cloneResult.error);
  const { fs, dir } = cloneResult.data;

  const headResult = await fromPromise(git.resolveRef({ fs, dir, ref: "HEAD" }));
  if (!headResult.success) {
    return err(new ExternalServiceError("Git", "Failed to resolve HEAD", headResult.error));
  }

  const targetResult = await fromPromise(git.readCommit({ fs, dir, oid: targetSha }));
  if (!targetResult.success) {
    logger.error("Failed to read revert target", targetResult.error, { targetSha });
    return err(new ExternalServiceError("Git", "Failed to read revert target", targetResult.error));
  }

  const now = Math.floor(Date.now() / 1000);
  const signature = {
    name: SYSTEM_AUTHOR.name,
    email: SYSTEM_AUTHOR.email,
    timestamp: now,
    timezoneOffset: 0,
  };
  const writeResult = await fromPromise(
    git.writeCommit({
      fs,
      dir,
      commit: {
        message,
        tree: targetResult.data.commit.tree,
        parent: [headResult.data],
        author: signature,
        committer: signature,
      },
    }),
  );
  if (!writeResult.success) {
    logger.error("Failed to write revert commit", writeResult.error, { targetSha });
    return err(new ExternalServiceError("Git", "Failed to write revert commit", writeResult.error));
  }
  const revertSha = writeResult.data;

  const refResult = await fromPromise(
    git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: revertSha, force: true }),
  );
  if (!refResult.success) {
    return err(new ExternalServiceError("Git", "Failed to update ref", refResult.error));
  }

  const pushResult = await fromPromise(
    withTimeout(
      git.push({ fs, dir, http, url: remote, ref: branch, onAuth: makeAuth(token) }),
      MERGE_FETCH_TIMEOUT_MS,
      "revertToCommit: git.push",
    ),
  );
  if (!pushResult.success) {
    logger.error("Failed to push revert commit", pushResult.error, { remote });
    return err(new ExternalServiceError("Git", "Failed to push revert commit", pushResult.error));
  }

  logger.info("Revert commit pushed", { remote, revertSha, targetSha });
  return ok(revertSha);
}

/** Exported for tests (mirrors real symlink-as-leaf traversal, no local copy). */
export async function walkDir(
  fs: NodeFS,
  base: string,
  prefix: string,
  logger: Logger,
): Promise<Result<string[], AppError>> {
  const dirPath = base === "/" ? "/" : base;

  try {
    const entries = await fs.promises.readdir(dirPath);
    const files: string[] = [];

    for (const entry of entries) {
      if (entry === ".git") continue;
      const fullPath = base === "/" ? `/${entry}` : `${base}/${entry}`;

      try {
        // lstat: a symlink is a leaf entry (its own tree object), never recursed
        // into — and a dangling link must not fail the whole walk via ENOENT.
        const stat = await fs.promises.lstat(fullPath);
        if (stat.isDirectory()) {
          const subFilesResult = await walkDir(fs, fullPath, `${prefix}${entry}/`, logger);
          if (!subFilesResult.success) return err(subFilesResult.error);
          files.push(...subFilesResult.data);
        } else {
          files.push(`${prefix}${entry}`);
        }
      } catch (error) {
        logger.error("Failed to stat file", error instanceof Error ? error : undefined, {
          fullPath,
        });
        return err(new AppError(`Failed to stat file: ${fullPath}`, "FS_ERROR", 500));
      }
    }

    return ok(files);
  } catch (error) {
    logger.error("Failed to read directory", error instanceof Error ? error : undefined, {
      dirPath,
    });
    return err(new AppError(`Failed to read directory: ${dirPath}`, "FS_ERROR", 500));
  }
}

export async function getCommitLog(
  remote: string,
  token: string,
  logger: Logger,
  depth = 20,
  branch = "main",
): Promise<Result<CommitLogEntry[], AppError>> {
  logger.debug("Getting commit log", { remote, depth });

  const cloneResult = await cloneRepo(remote, token, logger, { ref: branch });
  if (!cloneResult.success) return err(cloneResult.error);

  const { fs, dir } = cloneResult.data;
  const logResult = await fromPromise(git.log({ fs, dir, depth }));
  if (!logResult.success) {
    logger.error("Failed to get commit log", logResult.error, { remote });
    return err(new ExternalServiceError("Git", "Failed to get commit log", logResult.error));
  }

  const commits = logResult.data.map((c) => ({
    sha: c.oid,
    message: c.commit.message.trim(),
    author: `${c.commit.author.name} <${c.commit.author.email}>`,
    timestamp: c.commit.author.timestamp,
  }));

  logger.info("Successfully retrieved commit log", { remote, commitCount: commits.length });
  return ok(commits);
}

export async function importFromGitHub(
  artifacts: ArtifactsNamespace,
  name: string,
  githubUrl: string,
  logger: Logger,
  branch = "main",
  depth = 10,
  timeoutMs = 120000, // 2 minute default timeout
): Promise<Result<ArtifactsCreateResult, AppError>> {
  logger.debug("Importing from GitHub", { name, githubUrl, branch, depth, timeoutMs });

  // Create timeout handle outside try so finally can access it
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    // Create a timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Import operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    // depth <= 0 means "full history": omit depth from the import request so the
    // Artifacts backend clones without a shallow cutoff.
    const doImport = () =>
      artifacts.import({
        source: { url: githubUrl, branch, ...(depth > 0 ? { depth } : {}) },
        target: { name },
      });

    type ImportResult = Awaited<ReturnType<typeof doImport>>;

    // Artifacts is eventually consistent — on "already exists" delete and retry with
    // exponential backoff; extracted into a local function so the return type is always known.
    const doImportWithRetry = async (): Promise<ImportResult> => {
      try {
        return await Promise.race([doImport(), timeoutPromise]);
      } catch (firstError) {
        const msg = firstError instanceof Error ? firstError.message : String(firstError);
        if (!msg.includes("already exists")) throw firstError;

        logger.warn("Artifacts repo already exists, deleting and retrying", { name });
        const deleted = await artifacts.delete(name);
        logger.info("Artifacts delete result before retry", { name, deleted });

        const retryDelays = [3000, 5000, 8000];
        let lastError: unknown = firstError;
        for (let i = 0; i < retryDelays.length; i++) {
          await new Promise((r) => setTimeout(r, retryDelays[i]));
          try {
            return await Promise.race([doImport(), timeoutPromise]);
          } catch (retryError) {
            lastError = retryError;
            const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
            if (!retryMsg.includes("already exists")) throw retryError;
            logger.warn("Artifacts delete not yet consistent, retrying", { name, attempt: i + 1 });
          }
        }
        throw lastError;
      }
    };

    const result = await doImportWithRetry();

    logger.info("Successfully imported from GitHub", {
      name,
      githubUrl,
      branch,
      remote: result.remote,
    });
    return ok(result);
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new ExternalServiceError(
            "Artifacts",
            error instanceof Error ? error.message : "Import failed",
            error instanceof Error ? error : undefined,
          );
    logger.error("Failed to import from GitHub", appError, { name, githubUrl, branch });
    return err(appError);
  } finally {
    // Always clear the timeout to prevent memory leaks
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

/** Depth for the source fetch during an incremental sync — matches the shallow
 * depth {@link cloneRepo} uses for the local clone it fetches into. */
const SYNC_FETCH_DEPTH = DEFAULT_SHALLOW_DEPTH;

/**
 * Cap on the total fetch window {@link syncFromGitHub} will grow to while
 * retrying a merge that failed only because a shallow clone hid the common
 * ancestor. Each retry round doubles the current window (SYNC_FETCH_DEPTH ->
 * 100 -> 200 -> 400 -> capped here) via `git.fetch`'s `relative: true` option,
 * which extends the shallow boundary from wherever it currently sits rather
 * than re-fetching from the tip. 500 is a deliberate bound: large enough to
 * reach a merge base past a few weeks of active commits on either side, small
 * enough that a genuinely diverged repo can't drive unbounded clone work on
 * every scheduled sync.
 */
const SYNC_MAX_FETCH_DEPTH = 500;

/**
 * Whether commits `ours` and `theirs` in `dir` have no single common ancestor
 * `git.merge` can use as a merge base. isomorphic-git throws the same
 * `MergeNotSupportedError` both for this AND for conflict shapes its diff3
 * algorithm can't auto-resolve — the two are indistinguishable from the error
 * alone, so this recomputes the merge base directly to tell them apart. The
 * caller uses the result to decide whether deepening the shallow history could
 * plausibly fix the failure, versus a hard content conflict that more history
 * can't resolve.
 */
async function isMissingMergeBase(
  fs: NodeFS,
  dir: string,
  ours: string,
  theirs: string,
): Promise<boolean> {
  const oursOid = await fromPromise(git.resolveRef({ fs, dir, ref: ours }));
  if (!oursOid.success) return false;
  const bases = await fromPromise(git.findMergeBase({ fs, dir, oids: [oursOid.data, theirs] }));
  // A read failure here isn't proof either way; treat conservatively as "not a
  // missing-base case" rather than risk looping on an unrelated error.
  if (!bases.success) return false;
  return bases.data.length !== 1;
}

/**
 * Whether ANY commit reachable from `ref` sits on a shallow-fetch boundary
 * (recorded in `.git/shallow`) rather than being a true root — i.e. whether
 * fetching more depth for `ref` could reveal additional ancestors. A ref whose
 * full reachable history is already present locally cannot be deepened any
 * further, so retrying its fetch would just repeat the same result.
 *
 * Deliberately not "is the OLDEST reachable commit a boundary": `.git/shallow`
 * can hold several boundary oids, and a merge commit can reach a truncated
 * line and a fully-present older line at once. Judging by the oldest commit
 * alone would then see the complete root, call the ref non-shallow, and stop
 * {@link applySourceUpdateWithDeepening} while history was still fetchable.
 */
async function isRefShallow(fs: NodeFS, dir: string, ref: string): Promise<boolean> {
  const gitdir = `${dir === "/" ? "" : dir}/.git`;
  const shallowFile = await fromPromise(
    fs.promises.readFile(`${gitdir}/shallow`, { encoding: "utf8" }),
  );
  if (!shallowFile.success) return false;
  const boundary = new Set(
    String(shallowFile.data)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  if (boundary.size === 0) return false;
  // No `depth`: the documented way to ask for an unbounded walk. Passing a
  // sentinel like -1 only works by accident — isomorphic-git stops on
  // `commits.length === depth`, a strict equality a growing count never
  // satisfies for a negative number. If that check ever became `>=`, the walk
  // would end on its first iteration and every ref would look non-shallow.
  const log = await fromPromise(git.log({ fs, dir, ref }));
  if (!log.success) return false;
  // Every reachable commit, not just the oldest one. `.git/shallow` legitimately
  // holds several boundary oids, and a merge commit can reach both a shallow
  // boundary AND an older complete root; the globally oldest commit is then the
  // root, which would hide a ref that genuinely still has history to fetch.
  return log.data.some((commit) => boundary.has(commit.oid));
}

export interface SourceSyncResult {
  /** "up-to-date": main already contains the source tip (no-op, nothing pushed);
   * "fast-forwarded": main advanced to the source tip; "merged": source commits
   * and Stratum-native commits were joined by a merge commit. */
  status: "up-to-date" | "fast-forwarded" | "merged";
  /** The resulting tip of `main`. */
  commit: string;
}

/**
 * Apply an already-fetched source tip onto the local `main` branch.
 *
 * Fast-forwards when main is an ancestor of the source tip, no-ops when the
 * source tip is already reachable from main (Stratum-native commits ahead), and
 * otherwise attempts a true three-way merge so native history is PRESERVED
 * alongside new source commits. If neither is possible — a force-pushed source,
 * conflicting edits, or shallow/grafted history hiding the common ancestor —
 * this fails with `SYNC_DIVERGED` and leaves `main` untouched. It never falls
 * back to any destructive re-import (#190).
 *
 * `SYNC_DIVERGED` is reserved for actual divergence. An operational merge
 * failure (corrupt objects, IO) surfaces as `ExternalServiceError` instead, so
 * the caller is not told to reconcile history that is in fact fine.
 */
export async function applySourceUpdate(
  fs: NodeFS,
  dir: string,
  sourceTip: string,
  logger: Logger,
  author: Author = SYSTEM_AUTHOR,
  branch = "main",
): Promise<Result<SourceSyncResult, AppError>> {
  const mergeResult = await fromPromise(
    git.merge({
      fs,
      dir,
      ours: branch,
      theirs: sourceTip,
      author,
      message: `Sync source commit ${sourceTip.slice(0, 7)} into ${branch}`,
    }),
  );
  if (!mergeResult.success) {
    const cause = mergeResult.error.message;
    logger.error("Source update could not be applied", mergeResult.error, { sourceTip, cause });
    // Only a real content divergence earns SYNC_DIVERGED: isomorphic-git throws
    // MergeConflictError for conflicting edits and MergeNotSupportedError for
    // conflict shapes it can't auto-resolve or histories with no common
    // ancestor. Anything else — corrupt objects, IO, OOM — is operational, and
    // reporting it as "your history diverged" sends the caller to debug the
    // wrong thing. Same split `mergeWorkspaceIntoProject` already applies.
    //
    // `MergeNotSupportedError` alone doesn't say WHICH of those it is, so
    // `missingMergeBase` is derived independently (via `isMissingMergeBase`)
    // and carried on the error's context — `syncFromGitHub` uses it to decide
    // whether deepening the shallow window is worth retrying, versus a hard
    // conflict that more history can't fix.
    if (isGitMergeConflict(mergeResult.error)) {
      return err(
        new AppError(
          `Sync aborted: source history has diverged from the project repository and cannot be applied automatically (${cause}). The existing repository and its workspaces were left untouched.`,
          "SYNC_DIVERGED",
          409,
          { missingMergeBase: false },
        ),
      );
    }
    if (matchesGitError(mergeResult.error, GitErrors.MergeNotSupportedError)) {
      const missingMergeBase = await isMissingMergeBase(fs, dir, branch, sourceTip);
      return err(
        new AppError(
          `Sync aborted: source history has diverged from the project repository and cannot be applied automatically (${cause}). The existing repository and its workspaces were left untouched.`,
          "SYNC_DIVERGED",
          409,
          { missingMergeBase },
        ),
      );
    }
    return err(
      new ExternalServiceError(
        "Git",
        `Failed to apply source update: ${cause}`,
        mergeResult.error instanceof Error ? mergeResult.error : undefined,
      ),
    );
  }

  // git.merge omits `oid` in some no-op cases; fall back to the current head.
  let commit = mergeResult.data.oid;
  if (!commit) {
    const headResult = await fromPromise(git.resolveRef({ fs, dir, ref: branch }));
    if (!headResult.success) {
      return err(
        new ExternalServiceError("Git", `Failed to resolve ${branch} after sync`, headResult.error),
      );
    }
    commit = headResult.data;
  }

  const status: SourceSyncResult["status"] = mergeResult.data.alreadyMerged
    ? "up-to-date"
    : mergeResult.data.fastForward
      ? "fast-forwarded"
      : "merged";
  return ok({ status, commit });
}

/** A deepen callback fetches `depth` MORE commits (relative to the current
 * shallow boundary) for one side of a sync. Returns void on success so the
 * caller re-reads history off the shared `fs`/`dir` rather than a return
 * value. */
export type DeepenFetch = (depth: number) => Promise<Result<void, AppError>>;

/**
 * Apply `sourceTip` onto `main` in `fs`/`dir`, retrying with a progressively
 * deepened fetch window when `applySourceUpdate` reports a missing-merge-base
 * failure (never for a genuine conflict — more history can't fix that, see
 * {@link isMissingMergeBase}). Each retry round doubles the window from
 * `startDepth`, deepening whichever side(s) {@link isRefShallow} confirms are
 * still shallow via `deepenProject`/`deepenSource`, up to `maxDepth`.
 * `SYNC_DIVERGED` is returned once a real conflict surfaces, once the cap is
 * reached, or once neither side has any more local history to reveal.
 *
 * Kept independent of the network specifics (the caller supplies the fetch
 * callbacks) so the retry/doubling/cap logic is testable against a real,
 * already-populated in-memory repo — see {@link syncFromGitHub} for the
 * production wiring (`git.fetch` with `relative: true`).
 */
export async function applySourceUpdateWithDeepening(
  fs: NodeFS,
  dir: string,
  sourceTip: string,
  sourceRef: string,
  startDepth: number,
  maxDepth: number,
  deepen: { project: DeepenFetch; source: DeepenFetch },
  logger: Logger,
  branch = "main",
): Promise<Result<SourceSyncResult, AppError>> {
  let applyResult = await applySourceUpdate(fs, dir, sourceTip, logger, SYSTEM_AUTHOR, branch);
  // Floored at 1 because the window only ever advances by doubling: a
  // `startDepth` of 0 would make `nextWindow` equal `window`, so `increment`
  // would be 0, every round would deepen by nothing, the refs would stay
  // shallow (so the both-sides-complete `break` never fires), and
  // `window < maxDepth` would hold forever. A negative one diverges instead of
  // converging. Both are unreachable from `syncFromGitHub`'s SYNC_FETCH_DEPTH
  // default, but this function is exported and takes the depth from its caller,
  // so termination should not rest on the caller passing something sane.
  let window = Math.max(1, startDepth);

  while (
    !applyResult.success &&
    applyResult.error.code === "SYNC_DIVERGED" &&
    applyResult.error.context?.missingMergeBase === true &&
    window < maxDepth
  ) {
    const nextWindow = Math.min(window * 2, maxDepth);
    const increment = nextWindow - window;

    const [projectShallow, sourceShallow] = await Promise.all([
      isRefShallow(fs, dir, branch),
      isRefShallow(fs, dir, sourceRef),
    ]);
    if (!projectShallow && !sourceShallow) {
      // Neither side has more history to give — the merge base genuinely
      // isn't there, no matter how much further we'd retry.
      break;
    }

    logger.warn("Merge base not found within the shallow window — deepening and retrying", {
      sourceRef,
      window,
      nextWindow,
      projectShallow,
      sourceShallow,
    });

    if (projectShallow) {
      const deepened = await deepen.project(increment);
      if (!deepened.success) return err(deepened.error);
    }
    if (sourceShallow) {
      const deepened = await deepen.source(increment);
      if (!deepened.success) return err(deepened.error);
    }

    window = nextWindow;
    applyResult = await applySourceUpdate(fs, dir, sourceTip, logger, SYSTEM_AUTHOR, branch);
  }

  return applyResult;
}

/**
 * Cap on the fetch window {@link readTreeAtCommitWithDeepening} will grow to
 * while searching for a pinned commit that a shallow clone's initial window
 * missed (#246). Set independently of {@link SYNC_MAX_FETCH_DEPTH} even
 * though the value happens to match: that constant's rationale is a
 * background/scheduled sync, where extra latency is cheap. This one bounds a
 * pinned-commit tree read that runs synchronously inside a merge-gating
 * evaluation request — worst case here is 4 doubling rounds (50 -> 100 -> 200
 * -> 400 -> 500), i.e. 4 extra `git.fetch` calls against the remote just
 * cloned from moments earlier, which is small next to the sandbox
 * evaluator's own 60-180s install/test budget that follows this step. The
 * realistic production case (the pinned sha is the branch tip fetched
 * milliseconds earlier in the same request) needs zero deepening rounds.
 */
const PINNED_COMMIT_MAX_FETCH_DEPTH = 500;

/**
 * Reads the tree at `commitSha`, growing the shallow fetch window
 * (doubling, like {@link applySourceUpdateWithDeepening}) only as far as
 * needed to make the commit resolvable — never an unbounded full-history
 * clone (#246).
 *
 * Gates the retry loop strictly on whether `commitSha` RESOLVES
 * (`git.listFiles`, the same first step `readTreeAtCommit` takes) — never on
 * `readTreeAtCommit`'s overall result. This keeps "do we have enough
 * history" independent of "is the tree readable": a corrupted or dangling
 * blob inside an already-resolved commit fails immediately via the delegated
 * `readTreeAtCommit` call below, rather than being misread as "needs more
 * history" and churning through deepen rounds that could never fix it.
 *
 * Network specifics are injected via `deepen` (same shape as
 * {@link applySourceUpdateWithDeepening}'s `DeepenFetch`), so the retry/cap
 * logic is testable against a real in-memory repo without a network mock —
 * see {@link readRepoFiles} for the production wiring.
 */
export async function readTreeAtCommitWithDeepening(
  fs: NodeFS,
  dir: string,
  commitSha: string,
  branch: string,
  startDepth: number,
  maxDepth: number,
  deepen: DeepenFetch,
  logger: Logger,
): Promise<Result<Map<string, Uint8Array>, AppError>> {
  let resolved = await fromPromise(git.listFiles({ fs, dir, ref: commitSha }));
  // Same floor as applySourceUpdateWithDeepening, and for the same reason: a
  // `startDepth` of 0 would make the first `increment` 0, so the window would
  // never advance and a genuinely-shallow ref would loop until `maxDepth`
  // without ever fetching anything.
  let window = Math.max(1, startDepth);

  while (!resolved.success) {
    const stillShallow = await isRefShallow(fs, dir, branch);
    if (!stillShallow) {
      // Full local history for `branch` is already present and the commit
      // still didn't resolve — it's not reachable from this branch at all.
      // More fetching can't change that; let readTreeAtCommit produce its
      // normal, specific error below.
      break;
    }
    if (window >= maxDepth) {
      logger.error("Pinned commit not found within the max fetch-depth bound", resolved.error, {
        commitSha,
        maxDepth,
      });
      return err(
        new ExternalServiceError(
          "Git",
          `Pinned commit ${commitSha} was not found within the ${maxDepth}-commit history bound`,
          resolved.error,
        ),
      );
    }

    const nextWindow = Math.min(window * 2, maxDepth);
    const increment = nextWindow - window;
    logger.warn("Pinned commit not found within the shallow window — deepening and retrying", {
      commitSha,
      window,
      nextWindow,
    });

    const deepened = await deepen(increment);
    if (!deepened.success) return err(deepened.error);

    window = nextWindow;
    resolved = await fromPromise(git.listFiles({ fs, dir, ref: commitSha }));
  }

  return readTreeAtCommit(fs, dir, commitSha, logger);
}

/**
 * Incremental sync of an EXISTING Artifacts project repo from its source git
 * URL — the non-destructive replacement for re-running the GitHub import (#190).
 *
 * Clones the project's Artifacts repo (shallow), fetches `branch` from the
 * public source URL into it, fast-forwards or merges it onto `main` via
 * {@link applySourceUpdate}, and pushes the result back. The repo is NEVER
 * deleted or recreated: workspace forks keep their ancestry and the project's
 * remote stays stable. Diverged history fails with `SYNC_DIVERGED`; auth or
 * network failures propagate as external-service errors.
 *
 * A shallow clone can hide the common ancestor, making isomorphic-git report a
 * merge it cannot compute — which, from `MergeNotSupportedError` alone, is
 * indistinguishable from real divergence. `applySourceUpdate` disambiguates the
 * two independently (`git.findMergeBase`, see `isMissingMergeBase`); when it's
 * a missing merge base — not a genuine conflict — the fetch window is deepened
 * via `git.fetch`'s `relative: true`, extending whichever side(s) are actually
 * shallow (`isRefShallow`) from their current boundary rather than re-fetching
 * from the tip, and the merge is retried. Each round doubles the window up to
 * {@link SYNC_MAX_FETCH_DEPTH}; `SYNC_DIVERGED` is only returned once a real
 * conflict surfaces or the cap is reached with no merge base in sight. That
 * bound is deliberate: without it, a genuinely diverged repo could drive
 * unbounded fetch work on every scheduled sync.
 */
export async function syncFromGitHub(
  artifacts: ArtifactsNamespace,
  remote: string,
  sourceUrl: string,
  logger: Logger,
  branch = "main",
  depth = SYNC_FETCH_DEPTH,
  maxDepth = SYNC_MAX_FETCH_DEPTH,
): Promise<Result<SourceSyncResult, AppError>> {
  // Normalised once, here, rather than at each use. `depth` reaches three
  // places: this clone, the source fetch, and the deepening loop's starting
  // window. The first two are forwarded by isomorphic-git into the upload-pack
  // `deepen <n>` line, and a server is entitled to reject `deepen 0` or a
  // negative — a protocol error from the remote, raised before the retry
  // helper's own floor could ever apply. Flooring at the entry point keeps all
  // three consistent and keeps a caller from turning a sync into a
  // wire-level failure.
  const startDepth = Math.max(1, depth);
  logger.debug("Incrementally syncing from source", {
    remote,
    sourceUrl,
    branch,
    depth: startDepth,
  });

  // One write-scoped token covers the clone, every deepening fetch of the
  // Artifacts side, and the push-back.
  const tokenResult = await freshRepoToken(artifacts, remote, "write", logger);
  if (!tokenResult.success) return err(tokenResult.error);
  const token = tokenResult.data;

  // Same depth as the source fetch below: the retry loop's starting window
  // assumes both sides begin equally shallow.
  const cloneResult = await cloneRepo(remote, token, logger, {
    ref: branch,
    fullHistory: false,
    depth: startDepth,
  });
  if (!cloneResult.success) return err(cloneResult.error);
  const { fs, dir } = cloneResult.data;

  const addRemoteResult = await fromPromise(
    git.addRemote({ fs, dir, remote: "source", url: sourceUrl }),
  );
  if (!addRemoteResult.success) {
    logger.error("Failed to add source remote", addRemoteResult.error, { sourceUrl });
    return err(
      new ExternalServiceError("Git", "Failed to add source remote", addRemoteResult.error),
    );
  }

  const fetchResult = await fromPromise(
    withTimeout(
      git.fetch({
        fs,
        http,
        dir,
        remote: "source",
        ref: branch,
        singleBranch: true,
        depth: startDepth,
      }),
      SYNC_FETCH_TIMEOUT_MS,
      "syncFromGitHub: git.fetch source",
    ),
  );
  if (!fetchResult.success) {
    const cause = fetchResult.error.message;
    logger.error("Failed to fetch source branch", fetchResult.error, { sourceUrl, branch });
    return err(
      new ExternalServiceError(
        "Git",
        `Failed to fetch ${branch} from source: ${cause}`,
        fetchResult.error,
      ),
    );
  }

  const tipResult = await resolveFetchedTip(
    fs,
    dir,
    `refs/remotes/source/${branch}`,
    logger,
    "Failed to resolve fetched source ref",
    { sourceUrl, branch },
  );
  if (!tipResult.success) return err(tipResult.error);
  const sourceTip = tipResult.data;

  /**
   * Deepens the PROJECT side (the Artifacts clone at `origin`) by `increment`
   * commits. Exists as a closure so {@link applySourceUpdateWithDeepening} can
   * own the retry/doubling policy without knowing anything about this repo's
   * remotes, auth, or transport. Re-fetches the already-added remote with
   * `relative: true`, which extends the shallow boundary from wherever it
   * currently sits instead of re-fetching from the tip; only invoked when
   * {@link isRefShallow} confirms this side actually has more history to reveal.
   */
  const deepenProject: DeepenFetch = async (increment) => {
    const result = await fromPromise(
      withTimeout(
        git.fetch({
          fs,
          http,
          dir,
          remote: "origin",
          // Follows the project's real default branch, not a hardcoded "main":
          // the clone and push around it already do, and asking origin to deepen
          // a ref the repo does not have would fail on any imported project whose
          // default is master/trunk.
          ref: branch,
          singleBranch: true,
          depth: increment,
          relative: true,
          onAuth: makeAuth(token),
        }),
        SYNC_FETCH_TIMEOUT_MS,
        "syncFromGitHub: git.fetch deepenProject",
      ),
    );
    if (!result.success) {
      logger.error("Failed to deepen Artifacts clone history", result.error, { remote, increment });
      return err(
        new ExternalServiceError("Git", "Failed to deepen Artifacts clone history", result.error),
      );
    }
    return ok(undefined);
  };
  /**
   * Deepens the SOURCE side (the upstream public repo at `source`) by
   * `increment` commits. Separate from {@link deepenProject} because the two
   * remotes differ in the ways that matter here: the source is anonymous (no
   * `onAuth`) and its failures must name the source URL, not the Artifacts
   * remote, so an operator reading the log can tell which fetch gave out.
   */
  const deepenSource: DeepenFetch = async (increment) => {
    const result = await fromPromise(
      withTimeout(
        git.fetch({
          fs,
          http,
          dir,
          remote: "source",
          ref: branch,
          singleBranch: true,
          depth: increment,
          relative: true,
        }),
        SYNC_FETCH_TIMEOUT_MS,
        "syncFromGitHub: git.fetch deepenSource",
      ),
    );
    if (!result.success) {
      logger.error("Failed to deepen source history", result.error, {
        sourceUrl,
        branch,
        increment,
      });
      return err(
        new ExternalServiceError(
          "Git",
          `Failed to deepen ${branch} history from source`,
          result.error,
        ),
      );
    }
    return ok(undefined);
  };

  const applyResult = await applySourceUpdateWithDeepening(
    fs,
    dir,
    sourceTip,
    `refs/remotes/source/${branch}`,
    startDepth,
    maxDepth,
    { project: deepenProject, source: deepenSource },
    logger,
    branch,
  );

  if (!applyResult.success) {
    if (applyResult.error.code === "SYNC_DIVERGED") {
      logger.error("Sync diverged: no merge base within the fetch window", applyResult.error, {
        remote,
        sourceUrl,
        maxDepth,
      });
    }
    return err(applyResult.error);
  }
  const applied = applyResult.data;

  if (applied.status === "up-to-date") {
    logger.info("Project already up to date with source", {
      remote,
      sourceUrl,
      commit: applied.commit,
    });
    return ok(applied);
  }

  // Non-force push: a concurrent native merge racing this sync is rejected by
  // the remote instead of being overwritten; the sync can simply be retried.
  const pushResult = await fromPromise(
    withTimeout(
      git.push({
        fs,
        dir,
        http,
        url: remote,
        ref: branch,
        remoteRef: branch,
        onAuth: makeAuth(token),
      }),
      SYNC_FETCH_TIMEOUT_MS,
      "syncFromGitHub: git.push",
    ),
  );
  if (!pushResult.success) {
    logger.error("Failed to push synced history", pushResult.error, { remote });
    return err(new ExternalServiceError("Git", "Failed to push synced history", pushResult.error));
  }

  logger.info("Incremental sync complete", {
    remote,
    sourceUrl,
    status: applied.status,
    commit: applied.commit,
  });
  return ok(applied);
}

/**
 * Builds a git-style unified diff header + POSIX patch for a modified file.
 * `createPatch` computes a real line-level diff with proper @@ hunks.
 */
function fileUnifiedDiff(path: string, oldContent: string, newContent: string): string {
  // createPatch returns: "Index: <path>\n===...\n--- <path>\n+++ <path>\n@@ ... @@\n..."
  // We strip the Index/=== preamble and replace the --- / +++ markers with git-style ones.
  const patch = createPatch(path, oldContent, newContent, "", "");
  const lines = patch.split("\n");
  // Drop the first two lines ("Index: …" and "===…"). The next two are the
  // --- / +++ header pair; rewrite those *by position*, never by prefix. A
  // deleted line whose text starts with "-- " (a SQL or Lua comment) arrives as
  // "--- …" and an added line starting with "++ " as "+++ …", so a prefix test
  // rewrites file content into a bogus header.
  const body = lines
    .slice(2)
    .map((line, index) => {
      if (index === 0 && line.startsWith("--- ")) return `--- a/${path}`;
      if (index === 1 && line.startsWith("+++ ")) return `+++ b/${path}`;
      return line;
    })
    .join("\n");
  return `diff --git a/${path} b/${path}\n${body}`;
}

function newFileDiff(path: string, content: string): string {
  const lines = content.split("\n");
  const lineCount = lines.length;
  const body = lines.map((l) => `+${l}`).join("\n");
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lineCount} @@\n${body}\n`;
}

function deletedFileDiff(path: string, content: string): string {
  const lines = content.split("\n");
  const lineCount = lines.length;
  const body = lines.map((l) => `-${l}`).join("\n");
  return `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1,${lineCount} +0,0 @@\n${body}\n`;
}

/**
 * Produce the change-gate's view of a workspace fork: the unified diff against
 * its base project plus the exact workspace revision that diff was computed
 * from.
 *
 * Both sides are cloned at the SAME `branch` -- an imported project keeps its
 * source branch name (master/trunk/...), and its fork inherits it -- so a caller
 * that passes the project's real default branch gets a diff of like against
 * like. Every ref this function reads (the submodule scan, the tip resolution,
 * the file listing) must use that same `branch`, or the work silently happens
 * against a ref that does not exist on a non-`main` project.
 *
 * The returned tip and tree oids come from this one clone so a caller can pin
 * evaluation to precisely the revision that was diffed, instead of re-resolving
 * later and racing a concurrent push.
 */
export async function getDiffBetweenRepos(
  baseRemote: string,
  baseToken: string,
  workspaceRemote: string,
  workspaceToken: string,
  logger: Logger,
  /** Default branch shared by the base repo and its workspace fork ("main" if omitted). */
  branch = "main",
): Promise<
  Result<
    {
      diff: string;
      workspaceOid: string;
      workspaceTreeOid: string;
      workspaceSha: string;
      /** The base commit the diff was computed against, resolved from the same
       * clone that produced it. Callers forward this to evaluators so a
       * receiver can reproduce the exact tree the diff applies to (#274);
       * re-resolving the project head separately would name a commit the diff
       * may not have been built from. */
      baseOid: string;
    },
    AppError
  >
> {
  logger.debug("Getting diff between repos", { baseRemote, workspaceRemote });

  const [workspaceCloneResult, baseCloneResult] = await Promise.all([
    cloneRepo(workspaceRemote, workspaceToken, logger, { ref: branch }),
    cloneRepo(baseRemote, baseToken, logger, { ref: branch }),
  ]);

  if (!workspaceCloneResult.success) return err(workspaceCloneResult.error);
  if (!baseCloneResult.success) return err(baseCloneResult.error);

  const { fs: workspaceFs, dir: workspaceDir } = workspaceCloneResult.data;
  const { fs: baseFs } = baseCloneResult.data;

  // Fail closed on submodule content (#258) before doing any further work: the
  // base project is already vetted (import and every prior push go through this
  // same gate), so only the incoming workspace tree needs the check. Scanning
  // here -- ahead of the full file listing/content read below -- rejects with a
  // clear, structured error instead of leaving a change record stuck on an
  // opaque diff failure.
  const submoduleScan = await scanForSubmoduleContent(workspaceFs, branch, logger);
  if (!submoduleScan.success) return err(submoduleScan.error);
  if (submoduleScan.data.gitlinkPaths.length > 0 || submoduleScan.data.hasGitmodules) {
    logger.warn("Rejecting change: workspace contains unsupported submodule content", {
      workspaceRemote,
      gitlinkPaths: submoduleScan.data.gitlinkPaths,
      hasGitmodules: submoduleScan.data.hasGitmodules,
    });
    return err(submoduleUnsupportedError(submoduleScan.data));
  }

  // Resolve the workspace tip + its tree from the SAME clone the diff is computed
  // against, so callers can pin evaluation to this exact revision (#115 selects
  // this commit for the merge; SEC-2 asserts it hasn't moved). Resolving them
  // separately would open a TOCTOU window between the diff and the pin. The tree
  // oid is what lets a merge backend content-address the code it is about to land
  // against what was evaluated, closing the residual race between the pre-merge
  // tip check and the staged-tree read.
  const workspaceOidResult = await fromPromise(
    git.resolveRef({ fs: workspaceFs, dir: workspaceDir, ref: branch }),
  );
  if (!workspaceOidResult.success) {
    return err(new AppError("Failed to resolve workspace tip for diff", "GIT_ERROR", 500));
  }
  const workspaceOid = workspaceOidResult.data;
  // Same revision, exposed under both names for the two gate mechanisms.
  const workspaceSha = workspaceOid;
  const workspaceCommitResult = await fromPromise(
    git.readCommit({ fs: workspaceFs, dir: workspaceDir, oid: workspaceOid }),
  );
  if (!workspaceCommitResult.success) {
    return err(new AppError("Failed to read workspace tip commit for diff", "GIT_ERROR", 500));
  }
  const workspaceTreeOid = workspaceCommitResult.data.commit.tree;

  // Resolve the base tip too: readFileAtCommit feeds git.readBlob, whose `oid`
  // parameter does NOT resolve ref names (a ref string fails with NotFoundError,
  // silently dropping the file from the diff) — so both sides read at their
  // resolved tip commit, pinned to the same clone the file listing came from.
  const baseOidResult = await fromPromise(git.resolveRef({ fs: baseFs, dir: DIR, ref: branch }));
  if (!baseOidResult.success) {
    return err(new AppError("Failed to resolve base tip for diff", "GIT_ERROR", 500));
  }
  const baseOid = baseOidResult.data;

  const [workspaceFilesResult, baseFilesResult] = await Promise.all([
    listFilesAtCommit(workspaceFs, branch, logger),
    listFilesAtCommit(baseFs, branch, logger),
  ]);

  if (!workspaceFilesResult.success) return err(workspaceFilesResult.error);
  if (!baseFilesResult.success) return err(baseFilesResult.error);

  const workspaceFiles = workspaceFilesResult.data;
  const baseFiles = baseFilesResult.data;

  const baseContent = new Map<string, string>();
  const workspaceContent = new Map<string, string>();

  await Promise.all([
    ...baseFiles.map(async ([path]) => {
      const contentResult = await readFileAtCommit(baseFs, baseOid, path, logger);
      if (contentResult.success) {
        baseContent.set(path, contentResult.data);
      }
    }),
    ...workspaceFiles.map(async ([path]) => {
      const contentResult = await readFileAtCommit(workspaceFs, workspaceOid, path, logger);
      if (contentResult.success) {
        workspaceContent.set(path, contentResult.data);
      }
    }),
  ]);

  const diff = buildUnifiedDiff(baseContent, workspaceContent);
  logger.info("Successfully generated diff between repos", { baseRemote, workspaceRemote });
  return ok({ diff, workspaceOid, workspaceTreeOid, workspaceSha, baseOid });
}

export function buildUnifiedDiff(
  baseFiles: Map<string, string>,
  workspaceFiles: Map<string, string>,
): string {
  const diffParts: string[] = [];
  const paths = new Set([...baseFiles.keys(), ...workspaceFiles.keys()]);

  for (const path of [...paths].sort()) {
    const oldContent = baseFiles.get(path);
    const newContent = workspaceFiles.get(path);
    if (oldContent === newContent) continue;

    if (oldContent === undefined && newContent !== undefined) {
      diffParts.push(newFileDiff(path, newContent));
    } else if (newContent === undefined && oldContent !== undefined) {
      diffParts.push(deletedFileDiff(path, oldContent));
    } else if (oldContent !== undefined && newContent !== undefined) {
      diffParts.push(fileUnifiedDiff(path, oldContent, newContent));
    }
  }

  return diffParts.join("\n");
}

/**
 * Build a unified diff of what a manual conflict resolution would change
 * relative to the project's current default-branch tip, without pushing
 * anything. This lets the resolution's content be run through the same
 * evaluator pipeline a normal Change goes through (buildEvaluators +
 * runEvaluation in ../services/change-flow) BEFORE resolveConflict commits it.
 *
 * Only reads the resolution's own file paths from project HEAD, not the whole
 * tree — every other path is untouched by a manual resolution and would
 * appear nowhere in the diff, so there is nothing worth spending a full-repo
 * read on. A resolution path absent from HEAD reads as a new-file addition.
 *
 * Returns the resolved base commit sha alongside the diff so callers can
 * record what revision the evaluation ran against (provenance) — the same
 * role `evaluatedSha` plays for a Change.
 */
export async function buildManualResolutionDiff(
  projectRemote: string,
  projectToken: string,
  resolutions: Array<{ file: string; content: string }>,
  branch: string,
  logger: Logger,
): Promise<Result<{ diff: string; baseSha: string }, AppError>> {
  const cloneResult = await cloneRepo(projectRemote, projectToken, logger, { ref: branch });
  if (!cloneResult.success) return err(cloneResult.error);
  const { fs, dir } = cloneResult.data;

  const baseOidResult = await fromPromise(git.resolveRef({ fs, dir, ref: branch }));
  if (!baseOidResult.success) {
    return err(
      new AppError("Failed to resolve project HEAD for resolution diff", "GIT_ERROR", 500),
    );
  }
  const baseOid = baseOidResult.data;

  const baseContent = new Map<string, string>();
  const resolvedContent = new Map<string, string>();
  for (const { file, content } of resolutions) {
    const readResult = await readFileAtCommit(fs, baseOid, file, logger);
    // A read failure (most commonly: the file doesn't exist on HEAD yet) is
    // treated as "no base content" so buildUnifiedDiff renders it as an
    // addition, matching getDiffBetweenRepos' handling of the same case.
    if (readResult.success) baseContent.set(file, readResult.data);
    resolvedContent.set(file, content);
  }

  return ok({ diff: buildUnifiedDiff(baseContent, resolvedContent), baseSha: baseOid });
}

/** A tag as listed from a cloned repo (see `collectRepoTags`). */
export interface RepoTagEntry {
  /** Tag name without the refs/tags/ prefix. */
  name: string;
  /** What refs/tags/<name> points at: the tag object for annotated tags, the
   * target itself for lightweight ones. */
  oid: string;
  /** The peeled target (normally a commit sha), or null when it could not be
   * determined (the tag object itself is missing locally). */
  targetSha: string | null;
  annotated: boolean;
  /** Annotated-tag message (first tag object in a peel chain). */
  message?: string;
  /** Annotated-tag tagger as "Name <email>". */
  tagger?: string;
  /** Annotated-tag tagger timestamp (epoch seconds). */
  timestamp?: number;
  /** True when the tag's target object is not present locally — e.g. it points
   * outside the shallow fetch window. The tag is still listed (degraded), never
   * an error. */
  unresolvable: boolean;
}

/**
 * List every refs/tags/* in an already-cloned repo, dereferencing annotated tags
 * to their target commit. Per-tag object reads are individually guarded: a tag
 * whose object (or target) is missing locally — a shallow clone can drop a
 * target outside the depth window — is returned with `unresolvable: true`
 * rather than failing the whole listing.
 */
export async function collectRepoTags(
  fs: NodeFS,
  dir: string,
  logger?: Logger,
): Promise<RepoTagEntry[]> {
  const names = await git.listTags({ fs, dir });
  const entries: RepoTagEntry[] = [];
  for (const name of [...names].sort()) {
    let oid: string;
    try {
      oid = await git.resolveRef({ fs, dir, ref: `refs/tags/${name}` });
    } catch (error) {
      // Ref file unreadable — nothing meaningful to show for this tag. Logged so
      // a corrupt ref store is distinguishable from a repo that simply has none.
      logger?.warn("Skipping tag with unresolvable ref", {
        tag: name,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const entry: RepoTagEntry = {
      name,
      oid,
      targetSha: null,
      annotated: false,
      unresolvable: false,
    };
    // Peel annotated tags (a chain, in the degenerate tag-of-tag case) down to
    // the target object. `current` lives outside the try so a missing TARGET
    // still yields the intended sha from the tag object we did read.
    let current = oid;
    try {
      // Peel until a non-tag target or a repeated oid (cycle) is hit — a
      // visited-oid set rather than a fixed hop cap so a valid, unusually long
      // tag-of-tag chain still resolves instead of being marked unresolvable.
      const visited = new Set<string>();
      let hop = 0;
      while (entry.targetSha === null) {
        if (visited.has(current)) break;
        visited.add(current);
        const obj = await git.readObject({ fs, dir, oid: current });
        if (obj.type === "tag") {
          const tag = obj.object as {
            object: string;
            message?: string;
            tagger?: { name: string; email: string; timestamp: number };
          };
          entry.annotated = true;
          if (hop === 0) {
            if (typeof tag.message === "string") entry.message = tag.message.trim();
            if (tag.tagger) {
              entry.tagger = `${tag.tagger.name} <${tag.tagger.email}>`;
              entry.timestamp = tag.tagger.timestamp;
            }
          }
          current = tag.object;
          hop++;
        } else {
          entry.targetSha = current;
        }
      }
      // A peel chain that never terminated (cycle) is unresolvable too.
      if (entry.targetSha === null) entry.unresolvable = true;
    } catch (error) {
      // The object at `current` is missing locally. If we peeled at least one
      // tag object, `current` names the intended target — record it, degraded.
      // Expected for a target outside the shallow window; logged at debug so a
      // corrupt object store is still traceable.
      logger?.debug("Tag target not present locally; listing it as unresolvable", {
        tag: name,
        oid: current,
        error: error instanceof Error ? error.message : String(error),
      });
      entry.targetSha = current === oid ? null : current;
      entry.unresolvable = true;
    }
    entries.push(entry);
  }
  return entries;
}

/** Result of {@link listRepoTags}. */
export interface ListRepoTagsResult {
  /** The tags actually listed — capped at {@link MAX_TAGS} when the remote
   * advertises more (see `truncated`). */
  tags: RepoTagEntry[];
  /** True when the remote advertised more than {@link MAX_TAGS} tags and the
   * fetch was capped — reported explicitly, never silent, so callers/UI can
   * show it rather than presenting a quietly-partial list as complete. */
  truncated: boolean;
  /** Total tags the remote advertised, independent of how many were fetched.
   * Equal to `tags.length` unless `truncated` is true. */
  totalTagCount: number;
}

/**
 * Lists the tags in a repository, including entries whose targets cannot be
 * resolved from the cloned history.
 *
 * The clone is shallow but fetches tag refs, so a tag whose target lies outside
 * the shallow window is reported with `unresolvable: true` rather than raising:
 * a tag pointing into unfetched history is expected here, not a failure, and
 * erroring would make the whole listing unavailable because of one old tag.
 * See `collectRepoTags`.
 *
 * The underlying fetch is tags-only (per-tag `singleBranch` fetches, never a
 * whole-branches pull) and capped at {@link MAX_TAGS}; a remote with more tags
 * than that comes back with `truncated: true` rather than silently dropping
 * the excess. See the `cloneRepo` `includeTags` option.
 *
 * @param remote - The repository's remote URL
 * @param token - The authentication token for the remote
 * @returns The repository's tag entries, plus truncation info
 */
export async function listRepoTags(
  remote: string,
  token: string,
  logger: Logger,
  httpClient: HttpClient = http,
): Promise<Result<ListRepoTagsResult, AppError>> {
  logger.debug("Listing repo tags", { remote });

  const cloneResult = await cloneRepo(remote, token, logger, { includeTags: true }, httpClient);
  if (!cloneResult.success) return err(cloneResult.error);

  const collected = await fromPromise(
    collectRepoTags(cloneResult.data.fs, cloneResult.data.dir, logger),
  );
  if (!collected.success) {
    logger.error("Failed to collect repo tags", collected.error, { remote });
    return err(new ExternalServiceError("Git", "Failed to list tags", collected.error));
  }

  const truncated = cloneResult.data.tagsTruncated ?? false;
  const totalTagCount = cloneResult.data.totalTagCount ?? collected.data.length;
  if (truncated) {
    logger.warn("Tag listing truncated at MAX_TAGS", {
      remote,
      totalTagCount,
      returnedTagCount: collected.data.length,
    });
  }

  logger.info("Successfully listed repo tags", {
    remote,
    tagCount: collected.data.length,
    truncated,
  });
  return ok({ tags: collected.data, truncated, totalTagCount });
}

/**
 * Hard cap on how many branches a listing returns.
 *
 * Unlike {@link MAX_TAGS} this is not a subrequest budget: branch listing reads
 * the ref advertisement and nothing else (see {@link listRepoBranches}), so a
 * repo with ten thousand branches costs the same two subrequests as one with
 * three. The cap bounds the RESPONSE — the JSON body, the `<select>` the UI
 * renders from it, and the manifest a backup records — rather than the request
 * count. Truncation is reported, never silent.
 */
export const MAX_BRANCHES = 200;

/** One entry in a branch listing: the branch name and the commit it points at.
 *
 * There is deliberately no `unresolvable` flag, unlike {@link RepoTagEntry}. A
 * tag can be unresolvable because it peels to a target outside a shallow
 * clone's window; a branch tip read from the ref advertisement IS the oid the
 * remote holds, so the state cannot arise. */
export interface RepoBranchEntry {
  name: string;
  oid: string;
}

/** Result of {@link listRepoBranches}. */
export interface ListRepoBranchesResult {
  /** The branches listed, ascending by name, capped at {@link MAX_BRANCHES}. */
  branches: RepoBranchEntry[];
  /** True when the remote advertised more than {@link MAX_BRANCHES} branches
   * and the listing was capped — reported so callers show it rather than
   * presenting a quietly-partial list as complete. */
  truncated: boolean;
  /** Total branches the remote advertised, independent of how many are listed. */
  totalBranchCount: number;
}

/** Branch and tag names a remote currently advertises, from one handshake. */
interface AdvertisedRefs {
  branches: Record<string, string>;
  /** Tag name -> the oid `refs/tags/<name>` points at. For an annotated tag
   * that is the TAG OBJECT, not the commit — see {@link AdvertisedRefs.peeledTags}. */
  tags: Record<string, string>;
  /** Tag name -> the commit an annotated tag peels to, from the remote's own
   * `<name>^{}` advertisement. Absent for a lightweight tag, whose `tags` entry
   * is already the commit. */
  peeledTags: Record<string, string>;
}

/**
 * Reads a remote's advertised `refs/heads/*` and `refs/tags/*` in a single
 * handshake — two subrequests, no object data, nothing written to memory.
 *
 * This is the whole read path for branches. Listing them by CLONING, the way
 * tags are listed, does not work: isomorphic-git translates fetched head refs
 * through the remote's refspec into `refs/remotes/origin/*`, so a clone's
 * `refs/heads/` holds exactly one branch — the one it checked out — no matter
 * how many were fetched. The advertisement already carries every branch name
 * and its tip oid, which is all a listing needs.
 */
async function readAdvertisedRefs(
  remote: string,
  token: string,
  logger: Logger,
  httpClient: HttpClient = http,
): Promise<Result<AdvertisedRefs, AppError>> {
  const infoResult = await fromPromise(
    git.getRemoteInfo({ http: httpClient, url: remote, onAuth: makeAuth(token) }),
  );
  if (!infoResult.success) {
    logger.error("Failed to read remote ref advertisement", infoResult.error, { remote });
    return err(new ExternalServiceError("Git", "Failed to read remote refs", infoResult.error));
  }

  const refs = infoResult.data.refs as { heads?: RemoteRefTree; tags?: RemoteRefTree } | undefined;
  // `<name>^{}` is the remote advertising an annotated tag's PEELED commit
  // alongside the tag object itself. It is not a ref name, so it never enters
  // `tags` — but it is exactly what a branch must point at when someone
  // branches from an annotated tag, so it is kept separately rather than
  // discarded.
  const tags: Record<string, string> = {};
  const peeledTags: Record<string, string> = {};
  for (const [name, oid] of Object.entries(flattenRefTree(refs?.tags))) {
    if (name.endsWith("^{}")) {
      peeledTags[name.slice(0, -3)] = oid;
    } else {
      tags[name] = oid;
    }
  }
  return ok({ branches: flattenRefTree(refs?.heads), tags, peeledTags });
}

/**
 * Whether `name` may be used as a branch name on a project repo.
 *
 * Git's own ref rules ({@link isValidRefName}) plus one Stratum restriction:
 * `HEAD` is refused. Git would accept `refs/heads/HEAD`, but it collides with
 * the symbolic ref every client resolves to find the default branch, and a
 * repository carrying it misbehaves in ways that are not this product's to
 * explain. Tags keep accepting it — a backup holding one must stay restorable.
 */
export function isValidBranchName(name: unknown): name is string {
  return isValidRefName(name) && name !== "HEAD";
}

/**
 * Lists a repository's branches, newest advertisement, no clone.
 *
 * @param defaultBranch - The project's resolved default branch. Used only to
 * decide what survives truncation: it is always retained, because a listing
 * that dropped the one branch every other operation resolves would be worse
 * than useless. The rest are taken in ascending name order — unlike tags there
 * is no version ordering to exploit, so any stable rule is arbitrary and this
 * one is at least predictable.
 */
export async function listRepoBranches(
  remote: string,
  token: string,
  logger: Logger,
  defaultBranch: string,
  httpClient: HttpClient = http,
): Promise<Result<ListRepoBranchesResult, AppError>> {
  logger.debug("Listing repo branches", { remote });

  const advertised = await readAdvertisedRefs(remote, token, logger, httpClient);
  if (!advertised.success) return err(advertised.error);

  const entries = Object.entries(advertised.data.branches)
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const totalBranchCount = entries.length;
  const truncated = totalBranchCount > MAX_BRANCHES;
  let branches = entries;
  if (truncated) {
    const isDefault = (entry: RepoBranchEntry): boolean => entry.name === defaultBranch;
    const defaultEntry = entries.find(isDefault);
    const rest = entries.filter((entry) => !isDefault(entry));
    branches = defaultEntry
      ? [defaultEntry, ...rest.slice(0, MAX_BRANCHES - 1)].sort((a, b) =>
          a.name.localeCompare(b.name),
        )
      : rest.slice(0, MAX_BRANCHES);
    logger.warn("Remote branch count exceeds MAX_BRANCHES; truncating listing", {
      remote,
      totalBranchCount,
      returnedBranchCount: branches.length,
      maxBranches: MAX_BRANCHES,
    });
  }

  logger.info("Successfully listed repo branches", {
    remote,
    branchCount: branches.length,
    truncated,
  });
  return ok({ branches, truncated, totalBranchCount });
}

/** How a requested `?ref=` failed to resolve to exactly one branch. */
export type RefResolutionFailure =
  | { kind: "invalid"; name: string }
  | { kind: "not-found"; name: string }
  | { kind: "ambiguous"; name: string };

/**
 * Resolves a caller-supplied ref to a branch that exists on the remote.
 *
 * Ambiguity is REJECTED, not resolved. `cloneRepo` hands `ref` to `git.clone`,
 * which walks isomorphic-git's `refpaths` — and that list checks
 * `refs/tags/<ref>` BEFORE `refs/heads/<ref>`. A repo holding both
 * `refs/tags/v1` and `refs/heads/v1` would pass a branch-name check and then
 * clone the TAG, serving one tree under a URL that names the other. The same
 * advertisement already carries both namespaces, so the collision is detectable
 * for free and is reported rather than silently picked.
 */
export async function resolveBranchRef(
  remote: string,
  token: string,
  logger: Logger,
  name: string,
  httpClient: HttpClient = http,
): Promise<Result<RepoBranchEntry, RefResolutionFailure | AppError>> {
  if (!isValidBranchName(name)) return err({ kind: "invalid", name } as const);

  const advertised = await readAdvertisedRefs(remote, token, logger, httpClient);
  if (!advertised.success) return err(advertised.error);

  const oid = advertised.data.branches[name];
  if (oid === undefined) return err({ kind: "not-found", name } as const);
  if (advertised.data.tags[name] !== undefined) {
    logger.warn("Refusing an ambiguous ref that names both a branch and a tag", { remote, name });
    return err({ kind: "ambiguous", name } as const);
  }
  return ok({ name, oid });
}

/** Why {@link createBranchRef} or {@link deleteBranchRef} refused. */
export type BranchWriteFailure =
  | { kind: "invalid-name"; name: string }
  | { kind: "exists"; name: string }
  | { kind: "conflicts-with"; name: string; existing: string }
  | { kind: "not-found"; name: string }
  | { kind: "default-branch"; name: string }
  | { kind: "no-default-branch"; name: string }
  | { kind: "bad-start-point"; startPoint: string };

/**
 * Creates `refs/heads/<name>` on a project remote, pointing at an object the
 * repository ALREADY holds.
 *
 * That restriction is the security property, not a convenience: a branch push
 * here goes straight to the Artifacts remote with a minted write token and
 * never passes through `src/routes/git-http.ts`, so the change gate cannot
 * vet it. Because the ref can only ever be aimed at an existing object, there
 * is nothing for it to smuggle in — no unevaluated content enters, and the
 * gate's guarantee is untouched. Enforcement is this function; there is no
 * second line of defence behind it.
 *
 * It is also what keeps backup whole. Every reachable start point — the default
 * tip, another branch's tip (inductively), a tag's tip, or a commit in the
 * default branch's history — is already inside the object set `walkRepoObjects`
 * packs, so a created branch never needs objects the snapshot does not have.
 *
 * The existence pre-check is load-bearing and cannot be replaced by the push:
 * a non-forced `git.push` does NOT reject an existing branch when the new oid
 * is a descendant of its tip — it fast-forwards it, and reports success. The
 * push is only the backstop for a branch created between the check and the
 * write.
 *
 * @param opts.startPoint - A branch name or a full 40-hex commit sha. Omitted
 * means the default branch's tip. A TAG NAME is refused — see
 * `resolveStartPoint` for why (a tag can point at a blob, its peel is not
 * advertised by receive-pack, and it may sit outside both the default branch's
 * history and a backup's capped tag fetch). A short sha is refused too: it
 * would have to be resolved against history this function has not fetched, and
 * guessing is exactly what the invariant above forbids.
 */
export async function createBranchRef(
  remote: string,
  token: string,
  logger: Logger,
  opts: { name: string; startPoint?: string; defaultBranch: string },
  httpClient: HttpClient = http,
): Promise<Result<RepoBranchEntry, BranchWriteFailure | AppError>> {
  const { name, startPoint, defaultBranch } = opts;
  if (!isValidBranchName(name)) return err({ kind: "invalid-name", name } as const);

  const advertised = await readAdvertisedRefs(remote, token, logger, httpClient);
  if (!advertised.success) return err(advertised.error);
  if (advertised.data.branches[name] !== undefined) {
    return err({ kind: "exists", name } as const);
  }
  // Refs are files in a directory tree, so `feature` and `feature/x` cannot
  // both exist — one would have to be a file and a directory at once. The
  // remote refuses the second, and isomorphic-git surfaces that as a
  // `GitPushError` the caller would see as an opaque 502. The advertisement
  // already in hand answers it for free, and with the name that collides.
  const collision = Object.keys(advertised.data.branches).find(
    (existing) => existing.startsWith(`${name}/`) || name.startsWith(`${existing}/`),
  );
  if (collision !== undefined) {
    return err({ kind: "conflicts-with", name, existing: collision } as const);
  }

  const resolved = await resolveStartPoint(
    remote,
    token,
    logger,
    { startPoint, defaultBranch, advertised: advertised.data },
    httpClient,
  );
  if (!resolved.success) return err(resolved.error);
  const { oid, fs, dir } = resolved.data;

  const ref = `refs/heads/${name}`;
  const written = await fromPromise(git.writeRef({ fs, dir, ref, value: oid, force: true }));
  if (!written.success) {
    logger.error("Failed to write local branch ref", written.error, { remote, name });
    return err(new ExternalServiceError("Git", "Failed to write branch ref", written.error));
  }

  const pushed = await fromPromise(
    git.push({
      fs,
      dir,
      http: httpClient,
      url: remote,
      ref,
      remoteRef: ref,
      // Never forced. The branch did not exist a moment ago; if it does now,
      // another writer won the race and must not be overwritten.
      force: false,
      onAuth: makeAuth(token),
    }),
  );
  if (!pushed.success) {
    // A rejection means the remote refused the ref update — the branch was
    // created between the pre-check above and this push, and a non-forced push
    // will not clobber it. Anything else (network, auth, a broken remote) is
    // NOT a conflict, and reporting it as one would tell a caller to pick a
    // different name for a problem a different name cannot fix.
    // Two different rejections mean the same thing to a caller. isomorphic-git
    // throws `PushRejectedError` from its own pre-flight check, and
    // `GitPushError` when the REMOTE answers `ng <ref>` — matching only the
    // first reports a refused ref update as a 502.
    if (
      matchesGitError(pushed.error, GitErrors.PushRejectedError) ||
      matchesGitError(pushed.error, GitErrors.GitPushError)
    ) {
      logger.warn("Remote refused the branch ref update", { remote, name });
      return err({ kind: "exists", name } as const);
    }
    logger.error("Failed to push new branch", pushed.error, { remote, name, oid });
    return err(new ExternalServiceError("Git", "Failed to create branch", pushed.error));
  }

  logger.info("Created branch", { remote, name, oid });
  return ok({ name, oid });
}

/**
 * Resolves a create request's start point to an oid already in the repository,
 * and hands back the clone the push must be made from.
 *
 * The clone comes back with the oid rather than being made separately, and the
 * depth is not incidental. `git.push` sends a ref update alone when the target
 * oid is one the remote already advertises; when it is not — a historical
 * commit — it walks the local object graph from that oid down to something the
 * remote knows, and that walk fails if the commit sits outside the clone's
 * window. Verifying a sha against full history and then pushing from a
 * SHALLOW clone would therefore pass every check and fail at the push, on
 * exactly the old commits this option exists to branch from.
 *
 * So: a start point named in the advertisement is already a remote-known tip
 * and needs no objects, which a shallow clone satisfies. A raw sha needs full
 * history, and is verified in the same clone it will be pushed from.
 *
 * KNOWN NARROWNESS, deliberate: `cloneRepo` is `singleBranch`, so `fullHistory`
 * means the complete history OF THE DEFAULT BRANCH. A raw sha reachable only
 * from some other branch is therefore reported `bad-start-point` even though
 * the repository holds it. That direction is the safe one — the check fails
 * closed, never admitting an object the repo lacks — and no path here can
 * currently produce such a commit: every branch this API creates points at the
 * default tip, another branch's tip, or a sha already in default history, so
 * branch tips stay reachable from the default branch by induction, and both
 * import and restore write a single branch's history. Widening the fetch to
 * every advertised branch would multiply the clone (the whole tree lands in
 * worker memory) against a ~1000-subrequest budget, to validate one sha. If a
 * path ever does introduce divergent branch history — a force-push gate, or a
 * default-branch switch — this becomes reachable and wants revisiting.
 */
async function resolveStartPoint(
  remote: string,
  token: string,
  logger: Logger,
  ctx: { startPoint?: string; defaultBranch: string; advertised: AdvertisedRefs },
  httpClient: HttpClient,
): Promise<Result<{ oid: string; fs: NodeFS; dir: string }, BranchWriteFailure | AppError>> {
  const { startPoint, defaultBranch, advertised } = ctx;

  // Nothing can be branched from a repository whose own default branch the
  // remote does not advertise — an empty repo, or a project whose recorded
  // `sourceDefaultBranch` has drifted from reality. Answered here, before any
  // clone, so the caller gets a named refusal instead of the 502 a clone of a
  // ref that isn't there would produce.
  const defaultTip = advertised.branches[defaultBranch];
  if (defaultTip === undefined) {
    return err({ kind: "no-default-branch", name: defaultBranch } as const);
  }

  // A branch tip, and only a branch tip. Tags are deliberately NOT accepted as
  // start points:
  //
  //  - A tag can point at a blob or a tree (git.git's own `junio-gpg-pub`
  //    does), and `refs/heads/x` at a blob is a branch no client can check out.
  //  - An annotated tag's peeled commit is advertised by upload-pack but NOT by
  //    receive-pack, so `git.push` cannot tell the remote already has it and
  //    walks the local object graph instead — which fails whenever that commit
  //    lies outside the shallow window.
  //  - The tag itself may sit outside the default branch's history, and may not
  //    even be in a backup: the tag fetch is capped at MAX_TAGS. A branch
  //    created there would vanish on restore.
  //
  // A full sha covers the real use (branch from an old commit) with none of
  // this, because it is verified against history that is actually present.
  const advertisedOid = startPoint === undefined ? defaultTip : advertised.branches[startPoint];

  if (advertisedOid !== undefined) {
    // Cheap path: the oid is a ref tip receive-pack advertises, so the push
    // sends a ref update and no objects, and a shallow clone is enough.
    const clone = await cloneRepo(remote, token, logger, { ref: defaultBranch }, httpClient);
    if (!clone.success) return err(clone.error);
    return ok({ oid: advertisedOid, fs: clone.data.fs, dir: clone.data.dir });
  }

  if (startPoint === undefined || !/^[0-9a-f]{40}$/.test(startPoint)) {
    return err({ kind: "bad-start-point", startPoint: startPoint ?? defaultBranch } as const);
  }

  const clone = await cloneRepo(
    remote,
    token,
    logger,
    { ref: defaultBranch, fullHistory: true },
    httpClient,
  );
  if (!clone.success) return err(clone.error);
  const object = await fromPromise(
    git.readObject({ fs: clone.data.fs, dir: clone.data.dir, oid: startPoint }),
  );
  if (!object.success || object.data.type !== "commit") {
    logger.warn("Rejecting a start point that is not a commit in this repository", {
      remote,
      startPoint,
    });
    return err({ kind: "bad-start-point", startPoint } as const);
  }
  return ok({ oid: startPoint, fs: clone.data.fs, dir: clone.data.dir });
}

/**
 * Deletes `refs/heads/<name>` from a project remote.
 *
 * The local `writeRef` before the push is required, not defensive: `git.push`
 * calls `GitRefManager.expand` on the LOCAL ref before it looks at `delete`,
 * and throws `NotFoundError` when that ref is absent. A clone of the default
 * branch has no ref for the branch being deleted, so one is written at the oid
 * the remote advertised. The oid is not sent — a delete pushes zeros — it only
 * has to make the local ref resolvable.
 */
export async function deleteBranchRef(
  remote: string,
  token: string,
  logger: Logger,
  opts: { name: string; defaultBranch: string },
  httpClient: HttpClient = http,
): Promise<Result<void, BranchWriteFailure | AppError>> {
  const { name, defaultBranch } = opts;
  if (!isValidBranchName(name)) return err({ kind: "invalid-name", name } as const);
  // Refused before the advertisement so the answer does not depend on a network
  // call: every internal op resolves this ref, and deleting it would break
  // browse, merge, sync and backup at once.
  if (name === defaultBranch) return err({ kind: "default-branch", name } as const);

  const advertised = await readAdvertisedRefs(remote, token, logger, httpClient);
  if (!advertised.success) return err(advertised.error);
  const oid = advertised.data.branches[name];
  if (oid === undefined) return err({ kind: "not-found", name } as const);

  // A delete needs no default-branch content — only a local ref for `_push`'s
  // `expand` to resolve — so it clones the branch BEING DELETED rather than the
  // default. That keeps a project whose recorded default branch has drifted
  // from the remote able to clean up its branches instead of getting a 502 on
  // a clone of a ref that is not there.
  const clone = await cloneRepo(remote, token, logger, { ref: name }, httpClient);
  if (!clone.success) return err(clone.error);
  const { fs, dir } = clone.data;

  const ref = `refs/heads/${name}`;
  const written = await fromPromise(git.writeRef({ fs, dir, ref, value: oid, force: true }));
  if (!written.success) {
    logger.error("Failed to write local branch ref before delete", written.error, { remote, name });
    return err(new ExternalServiceError("Git", "Failed to prepare branch delete", written.error));
  }

  const pushed = await fromPromise(
    git.push({
      fs,
      dir,
      http: httpClient,
      url: remote,
      ref,
      remoteRef: ref,
      delete: true,
      onAuth: makeAuth(token),
    }),
  );
  if (!pushed.success) {
    logger.error("Failed to delete branch", pushed.error, { remote, name });
    return err(new ExternalServiceError("Git", "Failed to delete branch", pushed.error));
  }

  logger.info("Deleted branch", { remote, name, oid });
  return ok(undefined);
}
