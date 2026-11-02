import type { KVNamespace } from "@cloudflare/workers-types";
import type { Logger } from "../utils/logger";
import type { RepoView } from "./git-ops";

/**
 * A cache of the repo overview page, keyed by branch and stamped with the
 * commit it was read at.
 *
 * Separate from the `repo_snapshot:` entry on purpose. That snapshot is written
 * only at import/sync time and is also what `resolveProjectHead` trusts as the
 * project's HEAD for merge freshness checks — so it must never be refreshed from
 * a page view. This cache only answers "what did this branch look like at
 * `headSha`", which is safe to show while a newer read is in flight.
 *
 * Readers serve it stale-while-revalidate: an entry whose `headSha` is not the
 * branch's live tip is still rendered (flagged as behind) while one background
 * read, gated by {@link claimRepoViewRefresh}, replaces it. Only a branch with
 * no entry at all makes a viewer wait for a clone.
 */

const CACHE_VERSION = 1;
const TTL_SECONDS = 7 * 24 * 60 * 60;
/**
 * How long one background refresh holds the branch's refresh claim. KV's floor
 * for `expirationTtl` is 60s, and a clone of a large repo can take most of that,
 * so this is also roughly the longest a refresh may run before another viewer
 * is allowed to start a second one.
 */
const REFRESH_CLAIM_TTL_SECONDS = 60;

/**
 * Entries bigger than this are not cached. KV accepts up to 25 MiB per value,
 * but a file list that big is a huge monorepo whose page should not read (and
 * parse) megabytes of JSON on every view. Those repos fall back to cloning.
 */
export const REPO_VIEW_CACHE_MAX_BYTES = 5 * 1024 * 1024;

type CachedRepoView = { v: typeof CACHE_VERSION } & RepoView & { files: string[] };

function keySuffix(namespace: string, slug: string, branch: string): string {
  return `${encodeURIComponent(namespace)}:${encodeURIComponent(slug)}:${encodeURIComponent(branch)}`;
}

function repoViewKey(namespace: string, slug: string, branch: string): string {
  return `repo_view:v${CACHE_VERSION}:${keySuffix(namespace, slug, branch)}`;
}

function refreshClaimKey(namespace: string, slug: string, branch: string): string {
  return `repo_view_refresh:${keySuffix(namespace, slug, branch)}`;
}

/**
 * The last cached view of `branch`, whatever commit it was taken at.
 *
 * The caller compares the returned `headSha` with the branch's live tip to tell
 * a current entry from one that is behind. Returns null on a miss or any
 * KV/parse failure — the caller then reads the repository, so a broken cache
 * costs a clone, never the page.
 */
export async function readRepoViewCache(
  kv: KVNamespace,
  project: { namespace: string; slug: string },
  branch: string,
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
  if (!isCachedRepoView(parsed)) return null;
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

/**
 * Refresh claims this isolate has handed out, per KV binding: key → expiry (ms).
 *
 * KV has no compare-and-swap, so concurrent requests that all read "no claim"
 * before any of them writes one would each win. Concurrent requests usually
 * share an isolate, and this map is checked and set synchronously, so it closes
 * that race locally; the KV claim covers other isolates and locations. Keyed by
 * binding so separate environments (and tests) never share claims. Losing it on
 * isolate eviction only means an extra clone.
 */
const localClaims = new WeakMap<KVNamespace, Map<string, number>>();

function claimLocally(kv: KVNamespace, key: string): boolean {
  const now = Date.now();
  let claims = localClaims.get(kv);
  if (!claims) {
    claims = new Map();
    localClaims.set(kv, claims);
  }
  const expiresAt = claims.get(key);
  if (expiresAt !== undefined && expiresAt > now) return false;
  for (const [claimed, expiry] of claims) if (expiry <= now) claims.delete(claimed);
  claims.set(key, now + REFRESH_CLAIM_TTL_SECONDS * 1000);
  return true;
}

/**
 * Claims the right to refresh `branch`'s cached view for the next
 * {@link REFRESH_CLAIM_TTL_SECONDS}, so a burst of viewers of a page that is
 * behind starts one background clone rather than one each.
 *
 * Best-effort: KV is eventually consistent, so viewers in different locations
 * can both win; that costs a duplicate clone, never a wrong page. A KV failure
 * answers false — skipping a refresh only leaves the page behind until the next
 * view after the claim lapses.
 */
export async function claimRepoViewRefresh(
  kv: KVNamespace,
  project: { namespace: string; slug: string },
  branch: string,
  logger: Logger,
): Promise<boolean> {
  const key = refreshClaimKey(project.namespace, project.slug, branch);
  if (!claimLocally(kv, key)) return false;
  try {
    if ((await kv.get(key)) !== null) return false;
    await kv.put(key, "1", { expirationTtl: REFRESH_CLAIM_TTL_SECONDS });
    return true;
  } catch (error) {
    logger.warn("KV error claiming repo view refresh", {
      branch,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
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
