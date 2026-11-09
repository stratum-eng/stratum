/**
 * Read-only repository access through the Artifacts binding's native read API
 * (`log`, `readTree`, `readBlob`), instead of cloning with isomorphic-git.
 *
 * A clone downloads a packfile and unpacks it in JavaScript inside the Worker;
 * the repo overview of a modest repository cost 8–45s of wall time that way.
 * The native API resolves refs, trees and blobs on the Artifacts side, so a view
 * is one `log` call, one `readTree` per directory, and one `readBlob` for the
 * README — no packfile ever reaches the Worker.
 *
 * The API is part of the Artifacts open beta (2026-10-01), so every reader here
 * reports failure as a Result and the caller falls back to cloning: a missing or
 * misbehaving method degrades to the old, slow path, never to a broken page.
 */
import type { KVNamespace } from "@cloudflare/workers-types";
import type {
  ArtifactsNamespace,
  ArtifactsRepo,
  ArtifactsTreeEntry,
  CommitLogEntry,
} from "../types";
import { AppError, ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import {
  type RepoView,
  type TagDetailCache,
  type TagObjectDetails,
  artifactsRepoNameFromRemote,
  getCommitLog,
  listFilesInRepo,
  loadRepoView,
  readFileFromRepo,
} from "./git-ops";

/**
 * Most `readTree` calls one view may make. Each is a binding round trip (and a
 * billed Artifacts operation), so a repository with more directories than this
 * is read by cloning instead — one packfile beats thousands of calls.
 */
export const MAX_TREE_READS = 500;

/** `readTree` calls kept in flight at once while walking a tree. */
const TREE_READ_CONCURRENCY = 16;

/** Error code for a tree with more directories than {@link MAX_TREE_READS}. */
export const TREE_TOO_LARGE = "ARTIFACTS_TREE_TOO_LARGE";

/**
 * Releases an RPC stub. `Symbol.dispose` is looked up at runtime because this
 * repo's `lib` (ES2022) does not type it; a runtime without it has nothing to
 * release.
 */
function disposeStub(stub: unknown): void {
  const dispose = (Symbol as unknown as { dispose?: symbol }).dispose;
  if (dispose === undefined || typeof stub !== "object" || stub === null) return;
  const release = (stub as Record<symbol, unknown>)[dispose];
  if (typeof release !== "function") return;
  try {
    release.call(stub);
  } catch {
    // Disposal is a courtesy to the runtime; failing it must not fail the read.
  }
}

/**
 * Runs `use` against the Artifacts repo behind `remote`, then disposes the stub.
 * Any throw — including a method the runtime does not support — becomes an
 * error Result.
 */
export async function withArtifactsRepo<T>(
  artifacts: ArtifactsNamespace,
  remote: string,
  logger: Logger,
  use: (repo: ArtifactsRepo) => Promise<T>,
): Promise<Result<T, AppError>> {
  let repo: ArtifactsRepo | undefined;
  try {
    const name = artifactsRepoNameFromRemote(remote);
    if (!name) {
      return err(
        new ExternalServiceError("Artifacts", `Could not derive repo name from remote: ${remote}`),
      );
    }
    repo = await artifacts.get(name);
    const handle = repo;
    // The name is only the last path segment of the remote, and the binding is
    // bound to one namespace: a remote from another namespace would resolve to
    // a same-named repo here and serve its contents. Confirm the repo is the
    // one the remote names, alongside the read so it adds no latency.
    const [data, info] = await Promise.all([use(handle), handle.info()]);
    if (normalizeRemote(info.remote) !== normalizeRemote(remote)) {
      throw new RemoteMismatchError(`binding resolved ${name} to ${info.remote}, not ${remote}`);
    }
    return ok(data);
  } catch (error) {
    logger.warn("Artifacts native read failed", {
      remote,
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof TreeTooLargeError) {
      return err(new AppError("Tree too large for a native read", TREE_TOO_LARGE, 502));
    }
    return err(
      new ExternalServiceError(
        "Artifacts",
        "Native repository read failed",
        error instanceof Error ? error : undefined,
      ),
    );
  } finally {
    disposeStub(repo);
  }
}

class RemoteMismatchError extends Error {}

/** Compares remotes the way a Git client would treat them as the same repo. */
function normalizeRemote(remote: string): string {
  return remote
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

class TreeTooLargeError extends Error {
  readonly code = TREE_TOO_LARGE;
}

/**
 * Full file listings of Git trees, keyed by tree hash.
 *
 * A tree's hash covers everything beneath it, so a listing stored under it is
 * correct forever. That is what makes a walk incremental: after a push only the
 * trees on the changed paths have new hashes; every other directory is one
 * cache read instead of a `readTree` per directory under it.
 */
export type TreeListingCache = {
  /** The listing stored for `hash`, or null on a miss or any failure. */
  get(hash: string): Promise<string[] | null>;
  /** Best-effort store; never throws. */
  put(hash: string, files: string[]): Promise<void>;
};

const TREE_LISTING_VERSION = 1;
const TREE_LISTING_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Listings bigger than this are not stored; the subtree is re-walked instead. */
export const TREE_LISTING_MAX_BYTES = 1024 * 1024;

/**
 * A {@link TreeListingCache} in KV, scoped to `scope` (the project id). Scoped
 * rather than shared across repositories even though equal hashes mean equal
 * content: it keeps one project's cached paths from ever being read on another
 * project's behalf, at the cost of not sharing entries between forks.
 */
export function kvTreeListingCache(
  kv: KVNamespace,
  scope: string,
  logger: Logger,
): TreeListingCache {
  const key = (hash: string) =>
    `tree_files:v${TREE_LISTING_VERSION}:${encodeURIComponent(scope)}:${hash}`;
  return {
    async get(hash) {
      try {
        const raw = await kv.get(key(hash));
        if (raw === null) return null;
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) && parsed.every((p) => typeof p === "string")
          ? (parsed as string[])
          : null;
      } catch (error) {
        logger.warn("Tree listing cache read failed", {
          hash,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    async put(hash, files) {
      const body = JSON.stringify(files);
      if (body.length > TREE_LISTING_MAX_BYTES) return;
      try {
        await kv.put(key(hash), body, { expirationTtl: TREE_LISTING_TTL_SECONDS });
      } catch (error) {
        logger.warn("Tree listing cache write failed", {
          hash,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

const TAG_DETAILS_VERSION = 1;
const TAG_DETAILS_TTL_SECONDS = 30 * 24 * 60 * 60;
/** A tag message longer than this is not stored; that tag is read by cloning. */
const TAG_DETAILS_MAX_BYTES = 64 * 1024;

function parseTagDetails(raw: string): TagObjectDetails | null {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { message, tagger, timestamp } = parsed as Record<string, unknown>;
  if (message !== undefined && typeof message !== "string") return null;
  if (tagger !== undefined && typeof tagger !== "string") return null;
  if (timestamp !== undefined && typeof timestamp !== "number") return null;
  return {
    ...(message !== undefined ? { message } : {}),
    ...(tagger !== undefined ? { tagger } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}

/**
 * A {@link TagDetailCache} in KV, scoped to `scope` (the project id) for the
 * same reason as {@link kvTreeListingCache}: one project's tag messages are
 * never read on another project's behalf.
 */
export function kvTagDetailCache(kv: KVNamespace, scope: string, logger: Logger): TagDetailCache {
  const key = (oid: string) =>
    `tag_details:v${TAG_DETAILS_VERSION}:${encodeURIComponent(scope)}:${oid}`;
  return {
    async get(oid) {
      try {
        const raw = await kv.get(key(oid));
        return raw === null ? null : parseTagDetails(raw);
      } catch (error) {
        logger.warn("Tag detail cache read failed", {
          oid,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    async put(oid, details) {
      const body = JSON.stringify(details);
      if (body.length > TAG_DETAILS_MAX_BYTES) return;
      try {
        await kv.put(key(oid), body, { expirationTtl: TAG_DETAILS_TTL_SECONDS });
      } catch (error) {
        logger.warn("Tag detail cache write failed", {
          oid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

/** Runs at most `limit` of the given tasks at once. */
function concurrencyLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    while (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/**
 * Every file path under the tree `rootHash`, matching what a clone's checkout
 * walk yields: blobs, executables and symlinks are leaves, directories are
 * recursed, and submodules (`gitlink`) are skipped — a clone checks them out as
 * empty directories, which contribute no paths.
 *
 * Each directory is first looked up in `cache`; only a miss costs a `readTree`
 * (at most {@link TREE_READ_CONCURRENCY} in flight, {@link MAX_TREE_READS} in
 * total), and its listing is then queued for storing in `writes`. Order is not
 * significant: the file tree sorts its nodes.
 */
async function listTreeFiles(
  repo: ArtifactsRepo,
  rootHash: string,
  cache: TreeListingCache | undefined,
  writes: Promise<void>[],
): Promise<string[]> {
  const limit = concurrencyLimiter(TREE_READ_CONCURRENCY);
  let treeReads = 0;

  const listTree = async (hash: string): Promise<string[]> => {
    const cached = cache ? await cache.get(hash) : null;
    if (cached) return cached;

    treeReads++;
    if (treeReads > MAX_TREE_READS) throw new TreeTooLargeError("tree has too many directories");
    const entries = await limit(() => repo.readTree(hash));
    // A tree its parent names but the store lacks is a corrupt read, not an
    // empty directory: fail so the caller falls back instead of caching a
    // listing with a hole in it.
    if (!entries) throw new Error(`tree ${hash} is missing`);

    const files: string[] = [];
    const subdirs: ArtifactsTreeEntry[] = [];
    for (const entry of entries) {
      if (entry.type === "tree") subdirs.push(entry);
      else if (entry.type !== "gitlink") files.push(entry.name);
    }
    const nested = await Promise.all(
      subdirs.map(async (dir) => (await listTree(dir.hash)).map((path) => `${dir.name}/${path}`)),
    );
    const listing = files.concat(...nested);
    if (cache) writes.push(cache.put(hash, listing));
    return listing;
  };

  return listTree(rootHash);
}

/** Options for {@link readRepoViewNative}. */
export type NativeReadOptions = {
  /** Makes the tree walk incremental; see {@link TreeListingCache}. */
  treeCache?: TreeListingCache;
  /** Defers cache writes past the response; without it they are awaited. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** How many commits of history to return. */
  commitDepth?: number;
};

const README_PATH = "README.md";

/**
 * Reads the repo overview (file list, recent commits, README) for `branch` via
 * the native read API. Same shape and semantics as the clone-based
 * `loadRepoView`, so the two are interchangeable.
 *
 * A branch with no commits (an empty repository, or a ref that does not
 * resolve) is an error, as it is for the clone path. A tree
 * past {@link MAX_TREE_READS} uncached directories is an error with code
 * {@link TREE_TOO_LARGE}, so the caller clones instead.
 */
export async function readRepoViewNative(
  artifacts: ArtifactsNamespace,
  remote: string,
  logger: Logger,
  branch = "main",
  options: NativeReadOptions = {},
): Promise<Result<RepoView, AppError>> {
  const writes: Promise<void>[] = [];
  const result = await withArtifactsRepo(artifacts, remote, logger, async (repo) => {
    const log = await repo.log({ ref: branch, limit: options.commitDepth ?? 20 });
    const head = log[0];
    // No commits: an empty repository or a branch that does not resolve. The
    // clone path fails here, and the page relies on that — a failed read shows
    // Sync Now, an empty listing does not — so fail too and let the caller fall
    // back to it rather than inventing an empty view.
    if (!head) throw new Error(`no commits on ${branch}`);

    const commits: CommitLogEntry[] = log.map((c) => ({
      sha: c.hash,
      message: c.message.trim(),
      author: `${c.author.name} <${c.author.email}>`,
      timestamp: c.authoredAt,
    }));

    // The README's exact name is only known once the walk lists the root, so
    // fetch the usual spelling alongside the walk instead of after it. A
    // failure here is held, not thrown: it must not abort the walk, and only
    // matters if the repo turns out to have that file.
    const speculativeReadme = repo
      .readFile({ ref: head.hash, path: README_PATH })
      .then((blob) => (blob ? blob.text() : null))
      .catch((error: unknown) => {
        // `readFile` resolves null for a missing file, so a rejection is an
        // unexpected failure — worth a log line, as the clone path gives it.
        logger.warn("Failed to read README for native repo view", {
          remote,
          path: README_PATH,
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      });
    const files = await listTreeFiles(repo, head.treeHash, options.treeCache, writes);

    const readmePath = files.find((f) => !f.includes("/") && f.toLowerCase() === "readme.md");
    let readme: string | null = null;
    if (readmePath === README_PATH) {
      readme = (await speculativeReadme) ?? null;
    } else if (readmePath) {
      const blob = await repo.readFile({ ref: head.hash, path: readmePath });
      readme = blob ? await blob.text() : null;
    }
    // An existing README that did not read is a transient failure, so the view
    // must not be cached — same rule as the clone path.
    const complete = !readmePath || readme !== null;

    const view: RepoView = { headSha: head.hash, files, commits, readme, complete };
    return view;
  });

  if (writes.length > 0) {
    const stored = Promise.all(writes);
    if (options.waitUntil) options.waitUntil(stored);
    else await stored;
  }
  if (!result.success) return result;
  logger.info("Loaded repo view natively", {
    remote,
    branch,
    fileCount: result.data.files?.length ?? 0,
    commitCount: result.data.commits.length,
  });
  return result;
}

/**
 * The repo overview for `branch`: natively when the read API can serve it,
 * otherwise by cloning (`loadRepoView`). The clone covers a runtime or
 * namespace where the beta read API fails, and a tree too large to walk by
 * calls; `readToken` is only used on that path.
 */
export async function loadRepoViewPreferNative(
  artifacts: ArtifactsNamespace,
  remote: string,
  readToken: string,
  logger: Logger,
  branch = "main",
  options: NativeReadOptions = {},
): Promise<Result<RepoView, AppError>> {
  const native = await readRepoViewNative(artifacts, remote, logger, branch, options);
  if (native.success) return native;
  logger.warn("Falling back to a clone for the repo view", {
    remote,
    branch,
    code: native.error.code,
  });
  return loadRepoView(remote, readToken, logger, branch);
}

/**
 * `path`'s text at `branch`, natively, falling back to `readFileFromRepo`'s
 * clone. Keeps its contract: a path that does not resolve to a file is an
 * error with code `FS_ERROR`, which callers read as "not found".
 */
export async function readFileFromRepoPreferNative(
  artifacts: ArtifactsNamespace,
  remote: string,
  token: string,
  path: string,
  logger: Logger,
  branch = "main",
): Promise<Result<string, AppError>> {
  const native = await withArtifactsRepo(artifacts, remote, logger, async (repo) => {
    const blob = await repo.readFile({ ref: branch, path });
    return blob === null ? null : blob.text();
  });
  if (native.success) {
    if (native.data === null) {
      return err(new AppError(`Failed to read file: ${path}`, "FS_ERROR", 404));
    }
    return ok(native.data);
  }
  logger.warn("Falling back to a clone to read a file", { remote, path, branch });
  return readFileFromRepo(remote, token, path, logger, branch);
}

/**
 * The most history a native log read returns. The clone path it replaces
 * fetched at most this many commits (its shallow clone depth), so a larger
 * request never returned more; the native API would allow up to 1000.
 */
export const MAX_NATIVE_LOG_DEPTH = 50;

/** The last `depth` commits of `branch`, natively, falling back to `getCommitLog`'s clone. */
export async function getCommitLogPreferNative(
  artifacts: ArtifactsNamespace,
  remote: string,
  token: string,
  logger: Logger,
  depth = 20,
  branch = "main",
): Promise<Result<CommitLogEntry[], AppError>> {
  const native = await withArtifactsRepo(artifacts, remote, logger, async (repo) => {
    const log = await repo.log({ ref: branch, limit: Math.min(depth, MAX_NATIVE_LOG_DEPTH) });
    return log.map((c) => ({
      sha: c.hash,
      message: c.message.trim(),
      author: `${c.author.name} <${c.author.email}>`,
      timestamp: c.authoredAt,
    }));
  });
  // An empty log means the ref did not resolve (or the repo is empty). The clone
  // path reports that as an error, which some callers rely on, so let it.
  if (native.success && native.data.length > 0) return native;
  if (!native.success)
    logger.warn("Falling back to a clone for the commit log", { remote, branch });
  return getCommitLog(remote, token, logger, depth, branch);
}

/** Every file path at `branch`, natively, falling back to `listFilesInRepo`'s clone. */
export async function listFilesInRepoPreferNative(
  artifacts: ArtifactsNamespace,
  remote: string,
  token: string,
  logger: Logger,
  branch = "main",
  options: Pick<NativeReadOptions, "treeCache" | "waitUntil"> = {},
): Promise<Result<string[], AppError>> {
  const writes: Promise<void>[] = [];
  const native = await withArtifactsRepo(artifacts, remote, logger, async (repo) => {
    const [head] = await repo.log({ ref: branch, limit: 1 });
    if (!head) return null;
    return listTreeFiles(repo, head.treeHash, options.treeCache, writes);
  });
  if (writes.length > 0) {
    const stored = Promise.all(writes);
    if (options.waitUntil) options.waitUntil(stored);
    else await stored;
  }
  if (native.success && native.data !== null) return ok(native.data);
  if (!native.success) logger.warn("Falling back to a clone to list files", { remote, branch });
  return listFilesInRepo(remote, token, logger, branch);
}
