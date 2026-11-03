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
 *     `githubOwner=@stratumNamespace` entries.
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
import { getProjectByPath, listProjects } from "../storage/state";
import type { Env, ProjectEntry } from "../types";
import type { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export type OwnerBindingsEnv = Pick<Env, "GITHUB_ALLOWED_OWNERS" | "GITHUB_APP_ALLOWED_OWNERS">;
export type RepoAuthorizationEnv = OwnerBindingsEnv & { DB: D1Database };

const GITHUB_LOGIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const STRATUM_NAMESPACE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;

export interface OwnerBindings {
  /** GitHub owner (lowercase) → Stratum namespaces (lowercase, no `@`) it is bound to. */
  bindings: Map<string, Set<string>>;
  /** Entries that bind nothing (no `=`, or a malformed side). Ignored. */
  unbound: string[];
}

/**
 * Parses `githubOwner=@stratumNamespace` entries, comma-separated. An entry
 * without a Stratum side is ignored rather than read as "any project": the
 * whole point of the binding is that naming a repo in a source URL is not
 * enough.
 *
 * @param raw - The setting's value
 * @returns The bindings, and the entries that were ignored
 */
export function parseOwnerBindings(raw: string | undefined): OwnerBindings {
  const bindings = new Map<string, Set<string>>();
  const unbound: string[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) {
      unbound.push(trimmed);
      continue;
    }
    const githubOwner = trimmed.slice(0, separator).trim().toLowerCase();
    const namespace = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^@/, "")
      .toLowerCase();
    if (!GITHUB_LOGIN_PATTERN.test(githubOwner) || !STRATUM_NAMESPACE_PATTERN.test(namespace)) {
      unbound.push(trimmed);
      continue;
    }
    const namespaces = bindings.get(githubOwner) ?? new Set<string>();
    namespaces.add(namespace);
    bindings.set(githubOwner, namespaces);
  }
  return { bindings, unbound };
}

const warnedUnboundEntries = new Set<string>();

/**
 * The operator's owner bindings, from `GITHUB_ALLOWED_OWNERS` and the older
 * `GITHUB_APP_ALLOWED_OWNERS` (both are read; entries combine). Each ignored
 * entry is logged once per isolate, loudly enough to find, because an entry
 * that used to admit every project now admits none.
 *
 * @param env - Environment carrying the settings
 * @param logger - Logger for the one-time warning
 * @returns GitHub owner → bound Stratum namespaces
 */
export function ownerBindings(env: OwnerBindingsEnv, logger: Logger): Map<string, Set<string>> {
  const raw = [env.GITHUB_ALLOWED_OWNERS, env.GITHUB_APP_ALLOWED_OWNERS]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .join(",");
  const { bindings, unbound } = parseOwnerBindings(raw);
  for (const entry of unbound) {
    if (warnedUnboundEntries.has(entry)) continue;
    warnedUnboundEntries.add(entry);
    logger.warn(
      "Ignoring GitHub allowed-owner entry without a Stratum owner; use githubOwner=@namespace",
      { entry },
    );
  }
  return bindings;
}

/**
 * The Stratum namespace a principal acts as: a user's username, an org's
 * slug, or an agent's owner's username. Null when it cannot be resolved,
 * which every caller treats as "not admitted".
 *
 * @param db - D1 database
 * @param principal - The principal
 * @param logger - Request logger
 * @returns The namespace, lowercase and without `@`, or null
 */
export async function principalNamespace(
  db: D1Database,
  principal: GitHubPrincipal,
  logger: Logger,
): Promise<string | null> {
  const query =
    principal.type === "org"
      ? "SELECT slug AS ns FROM orgs WHERE id = ?"
      : principal.type === "agent"
        ? "SELECT u.username AS ns FROM agents a JOIN users u ON u.id = a.owner_id WHERE a.id = ?"
        : "SELECT username AS ns FROM users WHERE id = ?";
  try {
    const row = await db.prepare(query).bind(principal.id).first<{ ns: string | null }>();
    return typeof row?.ns === "string" ? row.ns.toLowerCase() : null;
  } catch (error) {
    logger.error("Failed to resolve principal namespace", undefined, {
      principalType: principal.type,
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
 * @returns Whether a binding names this principal's namespace for this owner
 */
export async function allowlistAdmits(
  env: RepoAuthorizationEnv,
  owner: string,
  principal: GitHubPrincipal | null,
  logger: Logger,
): Promise<boolean> {
  if (!principal) return false;
  const namespaces = ownerBindings(env, logger).get(owner.toLowerCase());
  if (!namespaces || namespaces.size === 0) return false;
  const namespace = await principalNamespace(env.DB, principal, logger);
  return namespace !== null && namespaces.has(namespace);
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
 * point at the repo, and still be authorized through the owner binding or a
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
  if (!holder.data || !sourceMatchesRepo(holder.data, owner, repo)) return false;
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
