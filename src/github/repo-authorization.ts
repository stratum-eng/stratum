/**
 * Who may act on a GitHub repository through Stratum, and which single
 * project is its canonical target.
 *
 * A project's source URL is set freely by its owner, so naming a repo proves
 * nothing. A project is authorized for `owner/repo` only when its Stratum
 * owner (an agent's owner, for an agent-owned project):
 *
 *   - is linked to the GitHub App installation that covers the repo
 *     (migration 059), or
 *   - is bound to the repo's GitHub owner by the operator, in
 *     `GITHUB_ALLOWED_OWNERS` (formerly `GITHUB_APP_ALLOWED_OWNERS`) as
 *     `githubOwner=org:<orgId>` or `githubOwner=user:<userId>` entries.
 *     Bindings name stable ids, never a namespace: a namespace can be freed by
 *     a rename or a deletion and claimed by someone else, who would then
 *     inherit the binding.
 *
 * The instance PAT (`GITHUB_TOKEN`) is reachable only through the second
 * route. Inbound webhook events and outbound writes (PR promotion, evaluation
 * comments and statuses) also go through the canonical repo link
 * (migration 060): one authorized project per repo, claimed only once
 * authorization has passed.
 */

import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import {
  type GitHubPrincipal,
  isAccountLinkedTo,
  isInstallationLinkedTo,
  projectPrincipal,
} from "../storage/github-installations";
import {
  type GitHubRepoLink,
  type RepoLinkProject,
  claimRepoLink,
  getRepoLink,
  replaceRepoLink,
} from "../storage/github-repo-links";
import { mirrorTargetsRepo } from "../storage/push-mirrors";
import { getProjectByPath, listProjects } from "../storage/state";
import type { Env, ProjectEntry } from "../types";
import type { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export type OwnerBindingsEnv = Pick<Env, "GITHUB_ALLOWED_OWNERS" | "GITHUB_APP_ALLOWED_OWNERS">;
export type RepoAuthorizationEnv = OwnerBindingsEnv & { DB: D1Database };

const GITHUB_LOGIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const STRATUM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** A bound Stratum owner, as `org:<id>` or `user:<id>`. */
export type BoundOwnerKey = `org:${string}` | `user:${string}`;

export interface OwnerBindings {
  /** GitHub owner (lowercase) → Stratum owners (`org:<id>` / `user:<id>`) bound to it. */
  bindings: Map<string, Set<BoundOwnerKey>>;
  /** Entries that bind nothing: no `=`, an `@namespace` side, or a malformed one. Ignored. */
  unbound: string[];
}

/**
 * Parses `githubOwner=org:<orgId>` / `githubOwner=user:<userId>` entries,
 * comma-separated. Anything else is ignored rather than read as "any project":
 * an entry with no Stratum side, and an `@namespace` side, because a
 * namespace is reusable (renames, deletions) while an id is not.
 *
 * @param raw - The setting's value
 * @returns The bindings, and the entries that were ignored
 */
export function parseOwnerBindings(raw: string | undefined): OwnerBindings {
  const bindings = new Map<string, Set<BoundOwnerKey>>();
  const unbound: string[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    const githubOwner = separator < 0 ? "" : trimmed.slice(0, separator).trim().toLowerCase();
    const side = separator < 0 ? "" : trimmed.slice(separator + 1).trim();
    const match = side.match(/^(org|user):(.+)$/);
    const id = match?.[2]?.trim() ?? "";
    if (!GITHUB_LOGIN_PATTERN.test(githubOwner) || !match || !STRATUM_ID_PATTERN.test(id)) {
      unbound.push(trimmed);
      continue;
    }
    const key = `${match[1] as "org" | "user"}:${id}` as BoundOwnerKey;
    const owners = bindings.get(githubOwner) ?? new Set<BoundOwnerKey>();
    owners.add(key);
    bindings.set(githubOwner, owners);
  }
  return { bindings, unbound };
}

const warnedUnboundEntries = new Set<string>();

/**
 * The operator's owner bindings, from `GITHUB_ALLOWED_OWNERS` and the older
 * `GITHUB_APP_ALLOWED_OWNERS` (both are read; entries combine). Each ignored
 * entry is logged once per isolate, naming the form that works.
 *
 * @param env - Environment carrying the settings
 * @param logger - Logger for the one-time warning
 * @returns GitHub owner → bound Stratum owners
 */
export function ownerBindings(
  env: OwnerBindingsEnv,
  logger: Logger,
): Map<string, Set<BoundOwnerKey>> {
  const raw = [env.GITHUB_ALLOWED_OWNERS, env.GITHUB_APP_ALLOWED_OWNERS]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .join(",");
  const { bindings, unbound } = parseOwnerBindings(raw);
  for (const entry of unbound) {
    if (warnedUnboundEntries.has(entry)) continue;
    warnedUnboundEntries.add(entry);
    logger.warn(
      "Ignoring GitHub allowed-owner entry; bind a stable id: githubOwner=org:<orgId> or githubOwner=user:<userId>",
      { entry },
    );
  }
  return bindings;
}

/**
 * The stable owner a principal acts as: an org or user by id, or, for an
 * agent, the id of the user who owns it. Null when an agent's owner cannot be
 * resolved, which every caller treats as "not admitted".
 *
 * @param db - D1 database
 * @param principal - The principal
 * @param logger - Request logger
 * @returns `org:<id>` / `user:<id>`, or null
 */
export async function principalOwnerKey(
  db: D1Database,
  principal: GitHubPrincipal,
  logger: Logger,
): Promise<BoundOwnerKey | null> {
  if (principal.type === "org") return `org:${principal.id}`;
  if (principal.type === "user") return `user:${principal.id}`;
  try {
    const row = await db
      .prepare("SELECT owner_id FROM agents WHERE id = ?")
      .bind(principal.id)
      .first<{ owner_id: string | null }>();
    return typeof row?.owner_id === "string" ? `user:${row.owner_id}` : null;
  } catch (error) {
    logger.error("Failed to resolve agent owner for GitHub authorization", undefined, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Does the operator's owner binding admit `principal` for repos owned by
 * `owner`? The only route to the instance PAT.
 *
 * @param env - Environment with the bindings and DB
 * @param owner - The repo's GitHub owner
 * @param principal - Who the call or event is for
 * @param logger - Request logger
 * @returns Whether a binding names this principal's owner id for this GitHub owner
 */
export async function allowlistAdmits(
  env: RepoAuthorizationEnv,
  owner: string,
  principal: GitHubPrincipal | null,
  logger: Logger,
): Promise<boolean> {
  if (!principal) return false;
  const owners = ownerBindings(env, logger).get(owner.toLowerCase());
  if (!owners || owners.size === 0) return false;
  const key = await principalOwnerKey(env.DB, principal, logger);
  return key !== null && owners.has(key);
}

export type RepoAuthorization =
  | { allowed: true; reason: "allowlisted_owner" | "linked" }
  | { allowed: false; reason: "no_principal" | "not_linked" | "link_check_failed" };

/**
 * How an installation link may vouch for a principal:
 * - a number: the specific installation covering the repo (from GitHub or a
 *   signed event);
 * - `"account"`: any live installation on the repo owner's account, for
 *   re-validating a stored holder where no installation id is at hand;
 * - `null`: links don't count (the PAT path, or an event from a plain repo
 *   webhook), so only the owner binding can admit.
 */
export type InstallationScope = number | "account" | null;

/**
 * Is `principal` authorized for repos owned by `owner`? A failed link lookup
 * is a "no".
 *
 * @param env - Environment with the bindings and DB
 * @param owner - The repo's GitHub owner
 * @param principal - Who the call or event is for
 * @param scope - Which installation link may vouch, if any
 * @param logger - Request logger
 * @returns The decision and why
 */
export async function authorizeForRepo(
  env: RepoAuthorizationEnv,
  owner: string,
  principal: GitHubPrincipal | null,
  scope: InstallationScope,
  logger: Logger,
): Promise<RepoAuthorization> {
  if (!principal) return { allowed: false, reason: "no_principal" };
  if (await allowlistAdmits(env, owner, principal, logger)) {
    return { allowed: true, reason: "allowlisted_owner" };
  }
  if (scope === null) return { allowed: false, reason: "not_linked" };
  const linked =
    scope === "account"
      ? await isAccountLinkedTo(env.DB, owner, principal, logger)
      : await isInstallationLinkedTo(env.DB, scope, principal, logger);
  if (!linked.success) return { allowed: false, reason: "link_check_failed" };
  return linked.data
    ? { allowed: true, reason: "linked" }
    : { allowed: false, reason: "not_linked" };
}

/**
 * Does a project's source URL name `owner/repo`? Dots are allowed in repo
 * names; `.git` and a trailing path are tolerated.
 *
 * @param project - The project
 * @param owner - GitHub owner
 * @param repo - GitHub repo
 * @returns Whether the project points at that repo
 */
export function sourceMatchesRepo(
  project: Pick<ProjectEntry, "sourceUrl" | "githubUrl">,
  owner: string,
  repo: string,
): boolean {
  const sourceUrl = project.sourceUrl || project.githubUrl;
  if (!sourceUrl) return false;
  const match = sourceUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/i);
  if (!match) return false;
  const [, projectOwner, projectRepo] = match;
  return (
    projectOwner?.toLowerCase() === owner.toLowerCase() &&
    projectRepo?.toLowerCase() === repo.toLowerCase()
  );
}

type ProjectLookupEnv = RepoAuthorizationEnv & { STATE: KVNamespace };

/** The linked project, when it still exists at the stored path with the stored id. */
async function linkedProject(
  env: ProjectLookupEnv,
  link: GitHubRepoLink,
  logger: Logger,
): Promise<Result<ProjectEntry | null, AppError>> {
  const found = await getProjectByPath(env.STATE, link.namespace, link.slug, logger);
  if (!found.success) {
    return found.error.code === "NOT_FOUND" ? ok(null) : err(found.error);
  }
  return ok(found.data.id === link.projectId ? found.data : null);
}

/**
 * May the current holder of a repo link keep it? It must still exist, still
 * point at the repo (as its source, or as its push-mirror target), and still be authorized through the owner binding or a
 * link to an installation on the owner's account. Any lookup failure keeps the
 * holder in place: displacing on an error would let a transient fault hand a
 * repo to someone else.
 */
async function holderStillValid(
  env: ProjectLookupEnv,
  link: GitHubRepoLink,
  owner: string,
  repo: string,
  logger: Logger,
): Promise<boolean> {
  const holder = await linkedProject(env, link, logger);
  if (!holder.success) return true;
  if (!holder.data) return false;
  // A project points at a repo by importing from it or by mirroring to it
  // (#417). Without the second, a mirror-only project — one with no source URL
  // at all — would hold its target only until any other project named the same
  // repo as a source, and then lose the right to push to its own mirror.
  if (!sourceMatchesRepo(holder.data, owner, repo)) {
    const mirrors = await mirrorTargetsRepo(env.DB, logger, holder.data.id, owner, repo);
    // Same rule as every other lookup here: a failure keeps the holder.
    if (!mirrors.success) return true;
    if (!mirrors.data) return false;
  }
  const decision = await authorizeForRepo(
    env,
    owner,
    projectPrincipal(holder.data),
    "account",
    logger,
  );
  return decision.allowed || decision.reason === "link_check_failed";
}

/**
 * Makes `project` the canonical target of `owner/repo` if it can be, for an
 * outbound write. The caller has already authorized `project`. Claims a free
 * repo; keeps it if already held; displaces a holder that is gone or no
 * longer authorized; otherwise refuses.
 *
 * @param env - Environment with KV, DB and bindings
 * @param owner - GitHub owner
 * @param repo - GitHub repo
 * @param project - The authorized project
 * @param logger - Request logger
 * @returns Whether `project` is the canonical target after the call
 */
export async function ensureCanonicalProject(
  env: ProjectLookupEnv,
  owner: string,
  repo: string,
  project: RepoLinkProject,
  logger: Logger,
): Promise<Result<boolean, AppError>> {
  const link = await getRepoLink(env.DB, owner, repo, logger);
  if (!link.success) return link;
  if (!link.data) {
    const holder = await claimRepoLink(env.DB, owner, repo, project, logger);
    if (!holder.success) return holder;
    return ok(holder.data === project.id);
  }
  if (link.data.projectId === project.id) return ok(true);
  if (await holderStillValid(env, link.data, owner, repo, logger)) return ok(false);

  const replaced = await replaceRepoLink(env.DB, owner, repo, link.data.projectId, project, logger);
  if (!replaced.success) return replaced;
  if (replaced.data) {
    logger.info("Moved GitHub repo link to a newly authorized project", {
      owner,
      repo,
      from: link.data.projectId,
      to: project.id,
    });
    return ok(true);
  }
  const reread = await getRepoLink(env.DB, owner, repo, logger);
  if (!reread.success) return reread;
  return ok(reread.data?.projectId === project.id);
}

/**
 * The project an inbound webhook event for `owner/repo` belongs to, or null
 * when no authorized project exists. The canonical link is used when its
 * holder is still authorized for this event; otherwise the oldest authorized
 * project whose source URL names the repo claims it. Unauthorized projects
 * never receive events, whatever their source URL says.
 *
 * @param env - Environment with KV, DB and bindings
 * @param owner - GitHub owner from the event
 * @param repo - GitHub repo from the event
 * @param installationId - The event's `installation.id`, when it came through
 *   the GitHub App; absent for a plain repository webhook
 * @param logger - Request logger
 * @returns The project, or null
 */
export async function resolveInboundProject(
  env: ProjectLookupEnv,
  owner: string,
  repo: string,
  installationId: number | undefined,
  logger: Logger,
): Promise<Result<ProjectEntry | null, AppError>> {
  const scope: InstallationScope = installationId ?? null;
  const isAuthorized = async (project: ProjectEntry) =>
    (await authorizeForRepo(env, owner, projectPrincipal(project), scope, logger)).allowed;

  const link = await getRepoLink(env.DB, owner, repo, logger);
  if (!link.success) return link;
  if (link.data) {
    const holder = await linkedProject(env, link.data, logger);
    if (!holder.success) return holder;
    if (
      holder.data &&
      sourceMatchesRepo(holder.data, owner, repo) &&
      (await isAuthorized(holder.data))
    ) {
      return ok(holder.data);
    }
    // Not authorized for THIS event (e.g. a plain repo webhook, where only a
    // binding counts), but still valid at account scope, or its lookup
    // failed: keep it, as ensureCanonicalProject does, and drop the event.
    // A holder is displaced only once it is gone or no longer authorized.
    if (await holderStillValid(env, link.data, owner, repo, logger)) {
      logger.debug("GitHub event not routed: canonical project not authorized for it", {
        owner,
        repo,
        installationId,
      });
      return ok(null);
    }
  }

  const all = await listProjects(env.STATE, logger);
  if (!all.success) return all;
  const candidates = all.data
    .filter(
      (project) => project.id !== link.data?.projectId && sourceMatchesRepo(project, owner, repo),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const candidate of candidates) {
    if (!(await isAuthorized(candidate))) continue;
    if (!link.data) {
      const holder = await claimRepoLink(env.DB, owner, repo, candidate, logger);
      if (!holder.success) return holder;
      if (holder.data === candidate.id) return ok(candidate);
      // Lost a race to a concurrent claim; route to the winner only if it is
      // one of the projects authorized for this event.
      const winner = candidates.find((project) => project.id === holder.data);
      return ok(winner && (await isAuthorized(winner)) ? winner : null);
    }
    const replaced = await replaceRepoLink(
      env.DB,
      owner,
      repo,
      link.data.projectId,
      candidate,
      logger,
    );
    if (!replaced.success) return replaced;
    if (replaced.data) {
      logger.info("Moved GitHub repo link to a newly authorized project", {
        owner,
        repo,
        from: link.data.projectId,
        to: candidate.id,
      });
      return ok(candidate);
    }
    return ok(null);
  }

  logger.debug("No authorized Stratum project for GitHub repo; dropping event", {
    owner,
    repo,
    installationId,
    candidates: candidates.length,
  });
  return ok(null);
}
