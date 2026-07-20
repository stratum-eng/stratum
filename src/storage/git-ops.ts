import { createPatch } from "diff";
import git from "isomorphic-git";
import type { ArtifactsCreateResult, ArtifactsNamespace, Author, CommitLogEntry } from "../types";
import { AppError, ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { PhaseTimer } from "../utils/phase-timer";
import { type Result, err, fromPromise, ok } from "../utils/result";
import { commitObject } from "./git-objects";
import { MemoryFS } from "./memory-fs";
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

// Node.js-compatible FS interface (returned by MemoryFS.toNodeFS())
export interface NodeFS {
  promises: {
    readFile(path: string, options?: { encoding?: string }): Promise<string | Uint8Array>;
    writeFile(path: string, data: string | Uint8Array): Promise<void>;
    unlink(path: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    rmdir(path: string): Promise<void>;
    stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
    lstat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
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
    git.push({ fs, dir: DIR, http, url: remote, ref: "main", onAuth: makeAuth(token) }),
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

export async function cloneRepo(
  remote: string,
  token: string,
  logger: Logger,
  httpClient: HttpClient = http,
): Promise<Result<{ fs: NodeFS; dir: string }, AppError>> {
  logger.debug("Cloning repository", { remote });

  const fs = new MemoryFS().toNodeFS();
  const cloneResult = await fromPromise(
    git.clone({
      fs,
      http: httpClient,
      dir: DIR,
      url: remote,
      ref: "main",
      singleBranch: true,
      depth: 50,
      onAuth: makeAuth(token),
    }),
  );

  if (!cloneResult.success) {
    logger.error("Failed to clone repository", cloneResult.error, { remote });
    return err(new ExternalServiceError("Git", "Failed to clone repository", cloneResult.error));
  }

  logger.info("Successfully cloned repository", { remote });
  return ok({ fs: fs as unknown as NodeFS, dir: DIR });
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
): Promise<Result<string, AppError>> {
  logger.debug("Committing and pushing changes", {
    remote,
    changeCount: Object.keys(changes).length,
  });

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
    git.push({ fs, dir, http, url: remote, ref: "main", onAuth: makeAuth(token) }),
  );
  if (!pushResult.success) {
    logger.error("Failed to push to remote", pushResult.error, { remote });
    return err(new ExternalServiceError("Git", "Failed to push to remote", pushResult.error));
  }

  logger.info("Successfully committed and pushed changes", { remote, sha: commitResult.data });
  return ok(commitResult.data);
}

/**
 * Merges a workspace into its parent project repo.
 *
 * Attempts a true three-way merge via isomorphic-git's multi-remote fetch.
 * Falls back to a squash merge (copy changed files, single commit) if the
 * merge fails — this covers cases where isomorphic-git can't resolve the
 * merge or the remotes have diverged in a way that produces conflicts.
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
  const timer = options.timer;
  const measure = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
    timer ? timer.measure(name, fn) : fn();

  const cloneResult = await measure("projectCloneMs", () =>
    cloneRepo(projectRemote, projectToken, logger),
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
      git.fetch({
        fs,
        http,
        dir,
        remote: "workspace",
        ref: "main",
        singleBranch: true,
        onAuth: makeAuth(workspaceToken),
      }),
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
    const resolveFetchResult = await fromPromise(git.resolveRef({ fs, dir, ref: "FETCH_HEAD" }));
    if (resolveFetchResult.success) {
      workspaceSha = resolveFetchResult.data;
    } else {
      const resolveRemoteResult = await fromPromise(
        git.resolveRef({ fs, dir, ref: "refs/remotes/workspace/main" }),
      );
      if (!resolveRemoteResult.success) {
        logger.error("Failed to resolve workspace ref", resolveRemoteResult.error, {
          workspaceRemote,
        });
        return err(
          new ExternalServiceError(
            "Git",
            "Failed to resolve workspace ref",
            resolveRemoteResult.error,
          ),
        );
      }
      workspaceSha = resolveRemoteResult.data;
    }
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
    return squashMerge(fs, dir, workspaceSha, projectRemote, projectToken, author, logger);
  }

  const mergeResult = await measure("mergeMs", () =>
    fromPromise(
      git.merge({
        fs,
        dir,
        ours: "main",
        theirs: workspaceSha,
        author,
        message: "Merge workspace into project",
      }),
    ),
  );

  if (!mergeResult.success) {
    const message =
      mergeResult.error instanceof Error ? mergeResult.error.message : String(mergeResult.error);
    logger.error("Merge failed", mergeResult.error, { projectRemote, workspaceRemote, message });
    return err(
      new MergeConflictError(`Merge failed; workspace may be stale or conflicting: ${message}`),
    );
  }

  const pushResult = await measure("pushMs", () =>
    fromPromise(
      git.push({
        fs,
        dir,
        http,
        url: projectRemote,
        ref: "main",
        onAuth: makeAuth(projectToken),
      }),
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

/**
 * Attempt a fast-forward of the project's main to the workspace tip, skipping the
 * project clone and the in-memory 3-way merge that {@link mergeWorkspaceIntoProject}
 * performs. Correctness does not depend on a cached head: the non-force push is
 * accepted by Artifacts only when the project ref is still `expectedParent` (a
 * true fast-forward). Any race or non-descendant tip returns `fastForwarded:
 * false` so the caller falls back to the proven cold merge.
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
  /** SEC-2: if set, refuse to fast-forward unless the workspace tip equals this
   * (the evaluated sha), so a re-committed workspace can't be FF-merged
   * unevaluated. On mismatch the caller cold-merges, which rejects it. */
  expectedWorkspaceSha?: string,
): Promise<Result<FastForwardResult, AppError>> {
  const measure = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
    timer ? timer.measure(name, fn) : fn();

  const cloneResult = await measure("workspaceFetchMs", () =>
    cloneRepo(workspaceRemote, workspaceToken, logger),
  );
  if (!cloneResult.success) return err(cloneResult.error);
  const { fs, dir } = cloneResult.data;

  const tipResult = await fromPromise(git.resolveRef({ fs, dir, ref: "main" }));
  if (!tipResult.success) {
    return err(new ExternalServiceError("Git", "Failed to resolve workspace tip", tipResult.error));
  }
  const workspaceTip = tipResult.data;

  // SEC-2: don't fast-forward a workspace that moved since evaluation. Fall back
  // to cold merge (pinned) which returns STALE_WORKSPACE.
  if (expectedWorkspaceSha !== undefined && workspaceTip !== expectedWorkspaceSha) {
    logger.warn("Workspace tip changed since evaluation; refusing fast-forward", {
      workspaceRemote,
      expected: expectedWorkspaceSha,
      actual: workspaceTip,
    });
    return ok({ fastForwarded: false });
  }

  // A fast-forward is only possible if the workspace tip descends from the
  // project's current head. If not (or history is too shallow to tell), cold-merge.
  const descResult = await fromPromise(
    git.isDescendent({ fs, dir, oid: workspaceTip, ancestor: expectedParent, depth: -1 }),
  );
  if (!descResult.success) {
    // Most commonly: expectedParent is older than the shallow workspace clone, so
    // ancestry can't be proven. Log it — a repo that always lands here silently
    // never fast-forwards and would otherwise look like the FF path "works".
    logger.warn("Could not determine workspace descent; falling back to cold merge", {
      workspaceRemote,
      workspaceTip,
      expectedParent,
    });
    return ok({ fastForwarded: false });
  }
  if (descResult.data !== true) {
    return ok({ fastForwarded: false });
  }

  const pushResult = await measure("pushMs", () =>
    fromPromise(
      git.push({
        fs,
        dir,
        http,
        url: projectRemote,
        ref: "main",
        remoteRef: "main",
        onAuth: makeAuth(projectToken),
      }),
    ),
  );
  if (!pushResult.success) {
    logger.warn("Fast-forward push rejected; caller will cold-merge", { projectRemote });
    return ok({ fastForwarded: false });
  }

  logger.info("Fast-forwarded project to workspace tip", { projectRemote, sha: workspaceTip });
  return ok({ fastForwarded: true, commit: workspaceTip });
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
        git.fetch({
          fs,
          http,
          dir,
          remote: `ws${i}`,
          ref: "main",
          singleBranch: true,
          onAuth: makeAuth(ws.token),
        }),
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
    git.push({ fs, dir, http, url: projectRemote, ref: "main", onAuth: makeAuth(projectToken) }),
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
    git.push({ fs, dir, http, url: projectRemote, ref: "main", onAuth: makeAuth(projectToken) }),
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
 * `[40-byte tipTreeOid][packed tree objects]`. Recomputed on every commit so the
 * merge always sees the LIVE tip (no stale snapshot) without fetching the fork.
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
}

export interface StagedItemResult {
  changeId: string;
  merged: boolean;
  commit?: string;
}

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
): Promise<Result<StagedItemResult[], AppError>> {
  const gitdir = `${dir === "/" ? "" : dir}/.git`;

  // Phase 1 (off the merge critical path): place every item's objects, then build
  // the synthetic commits. The synth SHA-1 (`commitObject`) is async crypto with real
  // per-call overhead — running them sequentially inside the merge loop was the
  // dominant cost; `Promise.all` lets the crypto overlap. (Placement stays sequential:
  // concurrent writes race on MemoryFS object-dir creation.)
  for (const item of items) {
    for (const o of item.staged.objects) await placeLooseObject(fs, gitdir, o.oid, o.bytes);
  }
  const synths = await Promise.all(
    items.map((item) =>
      commitObject({
        tree: item.staged.treeOid,
        parents: [item.baseSha],
        message: `change ${item.changeId}`,
        timestamp: Math.floor(Date.now() / 1000),
      }),
    ),
  );
  for (const synth of synths) await placeLooseObject(fs, gitdir, synth.oid, synth.bytes);

  // Phase 2: serial merge loop (the ref advance must be serialized). Checkpoint/
  // restore around each so a conflict can't dirty the next.
  const results: StagedItemResult[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const synthOid = synths[i]?.oid;
    if (!item || !synthOid) continue;
    const checkpoint = await fromPromise(git.resolveRef({ fs, dir, ref: "main" }));
    if (!checkpoint.success) {
      results.push({ changeId: item.changeId, merged: false });
      continue;
    }
    const attempt = await fromPromise(
      (async () => {
        const merged = await git.merge({
          fs,
          dir,
          ours: "main",
          theirs: synthOid,
          author: SYSTEM_AUTHOR,
          message: `Merge change ${item.changeId}`,
        });
        await git.checkout({ fs, dir, ref: "main" });
        // git.merge omits `oid` when already up to date (the change's tree is already
        // in main) — that's a successful no-op merge, not a conflict. Fall back to the
        // current head so it's reported merged.
        return merged.oid ?? (await git.resolveRef({ fs, dir, ref: "main" }));
      })(),
    );
    if (attempt.success && attempt.data) {
      results.push({ changeId: item.changeId, merged: true, commit: attempt.data });
    } else {
      // Conflict/error: restore main to the checkpoint so the next merge is clean.
      // If restoration itself fails the FS is corrupt — abort the whole batch
      // rather than merge subsequent items against a dirty state.
      const restoreRef = await fromPromise(
        git.writeRef({ fs, dir, ref: "main", value: checkpoint.data, force: true }),
      );
      if (!restoreRef.success) {
        return err(
          new ExternalServiceError("Git", "Failed to restore ref after conflict", restoreRef.error),
        );
      }
      const restoreCheckout = await fromPromise(git.checkout({ fs, dir, ref: "main" }));
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
      git.push({ fs, dir, http, url: projectRemote, ref: "main", onAuth: makeAuth(projectToken) }),
    );
    if (!pushResult.success) {
      return err(new ExternalServiceError("Git", "Batch push failed", pushResult.error));
    }
  }
  return ok(results);
}

async function squashMerge(
  projectFs: NodeFS,
  projectDir: string,
  workspaceSha: string,
  projectRemote: string,
  projectToken: string,
  author: Author,
  logger: Logger,
): Promise<Result<string, AppError>> {
  logger.debug("Performing squash merge", { projectRemote, workspaceSha });

  const workspaceFilesResult = await listFilesAtCommit(projectFs, workspaceSha, logger);
  if (!workspaceFilesResult.success) return err(workspaceFilesResult.error);

  const projectFilesResult = await listFilesAtCommit(projectFs, "main", logger);
  if (!projectFilesResult.success) return err(projectFilesResult.error);

  const workspaceFiles = workspaceFilesResult.data;
  const projectFiles = projectFilesResult.data;
  const workspaceMap = new Map(workspaceFiles);

  const changed = workspaceFiles.filter(([path, hash]) => {
    const projectHash = projectFiles.find(([p]) => p === path)?.[1];
    return projectHash !== hash;
  });
  const deleted = projectFiles.filter(([path]) => !workspaceMap.has(path));

  for (const [path] of changed) {
    const contentResult = await readFileAtCommit(projectFs, workspaceSha, path, logger);
    if (!contentResult.success) return err(contentResult.error);

    try {
      await projectFs.promises.writeFile(`${projectDir}/${path}`, contentResult.data);
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
    try {
      await projectFs.promises.unlink(`${projectDir}/${path}`);
    } catch (error) {
      const appError = error instanceof Error ? error : new Error(String(error));
      logger.error("Failed to unlink file during squash merge", appError, { path, projectRemote });
      return err(new AppError(`Failed to unlink file: ${path}`, "FS_ERROR", 500));
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
      git.resolveRef({ fs: projectFs, dir: projectDir, ref: "main" }),
    );
    if (!resolveResult.success) {
      logger.error("Failed to resolve main ref", resolveResult.error, { projectRemote });
      return err(
        new ExternalServiceError("Git", "Failed to resolve main ref", resolveResult.error),
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
    git.push({
      fs: projectFs,
      dir: projectDir,
      http,
      url: projectRemote,
      ref: "main",
      onAuth: makeAuth(projectToken),
    }),
  );
  if (!pushResult.success) {
    logger.error("Failed to push squash merge", pushResult.error, { projectRemote });
    return err(new ExternalServiceError("Git", "Failed to push squash merge", pushResult.error));
  }

  logger.info("Successfully completed squash merge", { projectRemote, sha: commitResult.data });
  return ok(commitResult.data);
}

const MAX_REPO_FILES = 500;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface ResolveConflictOpts {
  projectRemote: string;
  projectToken: string;
  workspaceRemote: string;
  workspaceToken: string;
  strategy: "accept-project" | "accept-workspace" | "manual";
  manualResolutions?: { file: string; content: string }[];
  conflictingFiles?: string[];
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

    const cloneResult = await cloneRepo(projectRemote, projectToken, logger);
    if (!cloneResult.success) return err(cloneResult.error);
    const { fs, dir } = cloneResult.data;

    // Guard: total file count
    const filesResult = await listFilesAtCommit(fs, "main", logger);
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
    );
    if (!commitResult.success) return mapPushError(commitResult.error);
    return ok({ commitSha: commitResult.data });
  }

  if (strategy === "accept-project") {
    const cloneResult = await cloneRepo(projectRemote, projectToken, logger);
    if (!cloneResult.success) return err(cloneResult.error);
    const { fs, dir } = cloneResult.data;

    // Guard: total file count
    const filesResult = await listFilesAtCommit(fs, "main", logger);
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
      const refResult = await fromPromise(git.resolveRef({ fs, dir, ref: "main" }));
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
    );
    if (!commitResult.success) return mapPushError(commitResult.error);
    return ok({ commitSha: commitResult.data });
  }

  if (strategy === "accept-workspace") {
    const projectClone = await cloneRepo(projectRemote, projectToken, logger);
    if (!projectClone.success) return err(projectClone.error);
    const { fs: projectFs, dir: projectDir } = projectClone.data;

    // Guard: total file count in project
    const filesResult = await listFilesAtCommit(projectFs, "main", logger);
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

    const workspaceClone = await cloneRepo(workspaceRemote, workspaceToken, logger);
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
        git.resolveRef({ fs: projectFs, dir: projectDir, ref: "main" }),
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

async function listFilesAtCommit(
  fs: NodeFS,
  ref: string,
  logger: Logger,
): Promise<Result<[path: string, oid: string][], AppError>> {
  const files: [string, string][] = [];
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
          files.push([filepath, oid]);
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
): Promise<Result<string, AppError>> {
  logger.debug("Reading file from repo", { remote, path });

  const cloneResult = await cloneRepo(remote, token, logger);
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
): Promise<Result<string[], AppError>> {
  logger.debug("Listing files in repo", { remote });

  const cloneResult = await cloneRepo(remote, token, logger);
  if (!cloneResult.success) return err(cloneResult.error);

  const { fs, dir } = cloneResult.data;
  return walkDir(fs, dir, "", logger);
}

/**
 * Read the full working tree (paths → text contents) in a single clone.
 * Used by the post-merge smoke check to populate a sandbox.
 */
export async function readRepoFiles(
  remote: string,
  token: string,
  logger: Logger,
): Promise<Result<Map<string, string>, AppError>> {
  logger.debug("Reading repo files", { remote });

  const cloneResult = await cloneRepo(remote, token, logger);
  if (!cloneResult.success) return err(cloneResult.error);
  const { fs, dir } = cloneResult.data;

  const filesResult = await walkDir(fs, dir, "", logger);
  if (!filesResult.success) return err(filesResult.error);

  const contents = new Map<string, string>();
  for (const path of filesResult.data) {
    try {
      const raw = await fs.promises.readFile(`/${path}`, { encoding: "utf8" });
      contents.set(path, typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch (error) {
      logger.warn("Skipping unreadable file in repo tree", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return ok(contents);
}

/** The first parent of a commit — for a merge commit, the pre-merge HEAD. */
export async function getCommitParent(
  remote: string,
  token: string,
  commitSha: string,
  logger: Logger,
): Promise<Result<string, AppError>> {
  const cloneResult = await cloneRepo(remote, token, logger);
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
): Promise<Result<string, AppError>> {
  logger.info("Reverting repo to commit tree", { remote, targetSha });

  const cloneResult = await cloneRepo(remote, token, logger);
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
    git.writeRef({ fs, dir, ref: "refs/heads/main", value: revertSha, force: true }),
  );
  if (!refResult.success) {
    return err(new ExternalServiceError("Git", "Failed to update ref", refResult.error));
  }

  const pushResult = await fromPromise(
    git.push({ fs, dir, http, url: remote, ref: "main", onAuth: makeAuth(token) }),
  );
  if (!pushResult.success) {
    logger.error("Failed to push revert commit", pushResult.error, { remote });
    return err(new ExternalServiceError("Git", "Failed to push revert commit", pushResult.error));
  }

  logger.info("Revert commit pushed", { remote, revertSha, targetSha });
  return ok(revertSha);
}

async function walkDir(
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
        const stat = await fs.promises.stat(fullPath);
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
): Promise<Result<CommitLogEntry[], AppError>> {
  logger.debug("Getting commit log", { remote, depth });

  const cloneResult = await cloneRepo(remote, token, logger);
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

    const doImport = () =>
      artifacts.import({
        source: { url: githubUrl, branch, depth },
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

/**
 * Builds a git-style unified diff header + POSIX patch for a modified file.
 * `createPatch` computes a real line-level diff with proper @@ hunks.
 */
function fileUnifiedDiff(path: string, oldContent: string, newContent: string): string {
  // createPatch returns: "Index: <path>\n===...\n--- <path>\n+++ <path>\n@@ ... @@\n..."
  // We strip the Index/=== preamble and replace the --- / +++ markers with git-style ones.
  const patch = createPatch(path, oldContent, newContent, "", "");
  const lines = patch.split("\n");
  // Drop the first two lines ("Index: …" and "===…") then fix up --- / +++ paths.
  const body = lines
    .slice(2)
    .map((line) => {
      if (line.startsWith("--- ")) return `--- a/${path}`;
      if (line.startsWith("+++ ")) return `+++ b/${path}`;
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

export async function getDiffBetweenRepos(
  baseRemote: string,
  baseToken: string,
  workspaceRemote: string,
  workspaceToken: string,
  logger: Logger,
): Promise<
  Result<
    { diff: string; workspaceOid: string; workspaceTreeOid: string; workspaceSha: string },
    AppError
  >
> {
  logger.debug("Getting diff between repos", { baseRemote, workspaceRemote });

  const [workspaceCloneResult, baseCloneResult] = await Promise.all([
    cloneRepo(workspaceRemote, workspaceToken, logger),
    cloneRepo(baseRemote, baseToken, logger),
  ]);

  if (!workspaceCloneResult.success) return err(workspaceCloneResult.error);
  if (!baseCloneResult.success) return err(baseCloneResult.error);

  const { fs: workspaceFs, dir: workspaceDir } = workspaceCloneResult.data;
  const { fs: baseFs } = baseCloneResult.data;

  // Resolve the workspace tip + its tree from the SAME clone the diff is computed
  // against, so callers can pin evaluation to this exact revision (#115 selects
  // this commit for the merge; SEC-2 asserts it hasn't moved). Resolving them
  // separately would open a TOCTOU window between the diff and the pin. The tree
  // oid is what lets a merge backend content-address the code it is about to land
  // against what was evaluated, closing the residual race between the pre-merge
  // tip check and the staged-tree read.
  const workspaceOidResult = await fromPromise(
    git.resolveRef({ fs: workspaceFs, dir: workspaceDir, ref: "main" }),
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

  const [workspaceFilesResult, baseFilesResult] = await Promise.all([
    listFilesAtCommit(workspaceFs, "main", logger),
    listFilesAtCommit(baseFs, "main", logger),
  ]);

  if (!workspaceFilesResult.success) return err(workspaceFilesResult.error);
  if (!baseFilesResult.success) return err(baseFilesResult.error);

  const workspaceFiles = workspaceFilesResult.data;
  const baseFiles = baseFilesResult.data;

  const baseContent = new Map<string, string>();
  const workspaceContent = new Map<string, string>();

  await Promise.all([
    ...baseFiles.map(async ([path]) => {
      const contentResult = await readFileAtCommit(baseFs, "main", path, logger);
      if (contentResult.success) {
        baseContent.set(path, contentResult.data);
      }
    }),
    ...workspaceFiles.map(async ([path]) => {
      const contentResult = await readFileAtCommit(workspaceFs, "main", path, logger);
      if (contentResult.success) {
        workspaceContent.set(path, contentResult.data);
      }
    }),
  ]);

  const diff = buildUnifiedDiff(baseContent, workspaceContent);
  logger.info("Successfully generated diff between repos", { baseRemote, workspaceRemote });
  return ok({ diff, workspaceOid, workspaceTreeOid, workspaceSha });
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
