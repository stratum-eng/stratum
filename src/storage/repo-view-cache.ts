import type { KVNamespace } from "@cloudflare/workers-types";
import type { Logger } from "../utils/logger";
import type { RepoView } from "./git-ops";

/**
 * A cache of the repo overview page, keyed by branch and validated by head sha.
 *
 * Separate from the `repo_snapshot:` entry on purpose. That snapshot is written
 * only at import/sync time and is also what `resolveProjectHead` trusts as the
 * project's HEAD for merge freshness checks — so it must never be refreshed from
 * a page view. This cache answers only "what does this exact commit look like",
 * which never changes. A reader always compares the stored sha to the branch's
 * live tip first, so a push or merge turns the entry into a miss and it can
 * never serve a stale view.
 */

const CACHE_VERSION = 1;
const TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Entries bigger than this are not cached. KV accepts up to 25 MiB per value,
 * but a file list that big is a huge monorepo whose page should not read (and
 * parse) megabytes of JSON on every view. Those repos fall back to cloning.
 */
export const REPO_VIEW_CACHE_MAX_BYTES = 5 * 1024 * 1024;

type CachedRepoView = { v: typeof CACHE_VERSION } & RepoView & { files: string[] };

function repoViewKey(namespace: string, slug: string, branch: string): string {
  return `repo_view:v${CACHE_VERSION}:${encodeURIComponent(namespace)}:${encodeURIComponent(slug)}:${encodeURIComponent(branch)}`;
}

/**
 * The cached view of `branch`, if it was taken at `headSha`.
 *
 * Returns null on a miss, a stale entry, or any KV/parse failure — the caller
 * then reads the repository, so a broken cache costs a clone, never the page.
 */
export async function readRepoViewCache(
  kv: KVNamespace,
  project: { namespace: string; slug: string },
  branch: string,
  headSha: string,
  logger: Logger,
): Promise<(RepoView & { files: string[] }) | null> {
  let raw: string | null;
  try {
    raw = await kv.get(repoViewKey(project.namespace, project.slug, branch));
  } catch (error) {
    logger.warn("KV error reading repo view cache", {
      branch,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn("Corrupt repo view cache entry", { branch });
    return null;
  }
  if (!isCachedRepoView(parsed) || parsed.headSha !== headSha) return null;
  return {
    headSha: parsed.headSha,
    files: parsed.files,
    commits: parsed.commits,
    readme: parsed.readme,
    // Only complete views are ever written.
    complete: true,
  };
}

/**
 * Stores `view` as the cached overview of `branch`.
 *
 * Best-effort: an incomplete view (a failed walk, log, or README read) is not
 * cached — the failure is transient, and caching it would pin a partial page to
 * the commit — nor is one over {@link REPO_VIEW_CACHE_MAX_BYTES}. Never throws.
 */
export async function writeRepoViewCache(
  kv: KVNamespace,
  project: { namespace: string; slug: string },
  branch: string,
  view: RepoView,
  logger: Logger,
): Promise<void> {
  if (!view.complete || view.files === null) return;
  const entry: CachedRepoView = { v: CACHE_VERSION, ...view, files: view.files };
  const body = JSON.stringify(entry);
  const bytes = new TextEncoder().encode(body).byteLength;
  if (bytes > REPO_VIEW_CACHE_MAX_BYTES) {
    logger.warn("Repo view too large to cache", { branch, bytes });
    return;
  }
  try {
    await kv.put(repoViewKey(project.namespace, project.slug, branch), body, {
      expirationTtl: TTL_SECONDS,
    });
  } catch (error) {
    logger.warn("KV error writing repo view cache", {
      branch,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isCachedRepoView(value: unknown): value is CachedRepoView {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.v === CACHE_VERSION &&
    typeof entry.headSha === "string" &&
    Array.isArray(entry.files) &&
    Array.isArray(entry.commits) &&
    (entry.readme === null || typeof entry.readme === "string")
  );
}
