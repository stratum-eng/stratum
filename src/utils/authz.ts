import { orgBlockedBySecondFactor } from "../services/org-second-factor";
import { type OrgAccessLevel, getOrgAccessLevel } from "../storage/orgs";
import type {
  BoundCredentialBinding,
  CredentialBinding,
  ProjectEntry,
  WorkspaceEntry,
} from "../types";
import { createLogger } from "./logger";
import { forbidden } from "./response";

const logger = createLogger({ component: "Authz" });

/*
 * Credential binding (#323).
 *
 * Every helper in this module that answers "may this caller touch this
 * project?" takes the caller's {@link CredentialBinding} as a REQUIRED
 * positional argument, ahead of the optional principal ids. That ordering is
 * load-bearing: the old signature was `(db, project, userId?, agentOwnerId?)`,
 * so a call site nobody updated passes a `string | undefined` where a binding
 * is expected and fails to COMPILE. A defaulted or trailing optional parameter
 * would have turned each missed call site into a silent bypass instead — the
 * exact failure a reviewer cannot see in a diff.
 *
 * A binding only narrows. It is checked before, and in addition to, the
 * principal's own access, so a bound token never reaches more than its owner
 * could, and out-of-binding projects are refused even when public: the token's
 * holder was handed "this project", not "this project plus the public web".
 * Anonymous access to a public project is a different request (no credential)
 * and is unaffected.
 */

/** The binding of every credential that is not a bound scoped token. */
export const UNBOUND: CredentialBinding = Object.freeze({ kind: "unbound" });

/**
 * The slice of a Hono context {@link credentialBindingFrom} reads. Route
 * helpers that accept a narrowed context intersect this into it, so a helper
 * that authorizes cannot be handed a context that has no binding to give.
 */
export type BindingContext = {
  get: (key: "credentialBinding") => CredentialBinding | undefined;
};

/**
 * The binding the request authenticated with. `authMiddleware` publishes it
 * for scoped tokens; every other credential kind (session, agent, OAuth grant,
 * legacy key, anonymous) is {@link UNBOUND}.
 */
export function credentialBindingFrom(c: BindingContext): CredentialBinding {
  return c.get("credentialBinding") ?? UNBOUND;
}

/** Narrows to a binding that actually restricts something. */
export function isBound(binding: CredentialBinding): binding is BoundCredentialBinding {
  return binding.kind !== "unbound";
}

/**
 * Whether the binding admits this project at all, before any question of the
 * principal's own access. An org binding covers projects OWNED by that org —
 * read from the project as it is now, so a project transferred out of the org
 * leaves the binding with it.
 */
export function bindingCoversProject(binding: CredentialBinding, project: ProjectEntry): boolean {
  switch (binding.kind) {
    case "unbound":
      return true;
    case "project":
      return project.id === binding.projectId;
    case "org":
      return project.ownerType === "org" && project.ownerId === binding.orgId;
  }
}

/**
 * The response for a caller an authz helper just refused, on a route that
 * answers non-writers with `403`.
 *
 * A `403` confirms the project exists, which a stranger may learn on those
 * routes but a bound token must not: its holder was handed one project or org,
 * and a `403`/`404` split would let it enumerate the rest of the account's
 * private projects. So outside the binding the route answers with `hidden` —
 * whatever it gives for a target that does not exist — and only inside the
 * binding is the refusal a `403`. Every "Project access denied" in the routes
 * goes through here so the rule has one home.
 */
export function refuseProjectAccess(
  binding: CredentialBinding,
  project: ProjectEntry,
  hidden: () => Response,
): Response {
  if (!bindingCoversProject(binding, project)) return hidden();
  return forbidden("Project access denied");
}

/**
 * Whether the binding admits creating a project owned by `owner`. A project
 * binding never does — it names one EXISTING project — and an org binding only
 * inside its own org.
 */
export function bindingAllowsCreateIn(
  binding: CredentialBinding,
  owner: { type: "user" | "org"; id: string },
): boolean {
  switch (binding.kind) {
    case "unbound":
      return true;
    case "project":
      return false;
    case "org":
      return owner.type === "org" && owner.id === binding.orgId;
  }
}

/** Direct ownership: the project belongs to this user (or this agent's owner),
 * and the caller's binding admits it. */
export function isDirectOwner(
  project: ProjectEntry,
  binding: CredentialBinding,
  userId?: string,
  agentOwnerId?: string,
): boolean {
  if (!bindingCoversProject(binding, project)) return false;
  return ownsDirectly(project, userId, agentOwnerId);
}

function ownsDirectly(project: ProjectEntry, userId?: string, agentOwnerId?: string): boolean {
  if (!project.ownerId) return false;
  return project.ownerId === userId || project.ownerId === agentOwnerId;
}

/**
 * The caller's access to an org's projects, after the org's own "require a
 * second factor" policy (#256): a session that has not passed the factor the
 * org requires gets none of the access the org granted. Only this org's
 * resources are affected — see `orgBlockedBySecondFactor`.
 */
async function orgAccessLevel(
  db: D1Database,
  orgId: string,
  actor: string,
  record = true,
): Promise<OrgAccessLevel> {
  if (orgBlockedBySecondFactor(orgId, record)) return "none";
  return getOrgAccessLevel(db, logger, orgId, actor);
}

function levelAllowsWrite(level: OrgAccessLevel): boolean {
  return level === "write" || level === "admin";
}

/**
 * Whether the caller may read the project. Org-owned projects grant read to
 * every org member; agents inherit their owning user's access.
 */
export async function canReadProject(
  db: D1Database,
  project: ProjectEntry,
  binding: CredentialBinding,
  userId?: string,
  agentOwnerId?: string,
): Promise<boolean> {
  if (!bindingCoversProject(binding, project)) return false;
  // Incomplete imports are only visible to writers — the repo has no content yet.
  // importCompleted is absent on legacy projects; treat absence as completed.
  if (project.importCompleted === false) {
    return canWriteProject(db, project, binding, userId, agentOwnerId);
  }
  if (project.visibility === "public") return true;
  if (ownsDirectly(project, userId, agentOwnerId)) return true;

  if (project.ownerType === "org") {
    const actor = userId ?? agentOwnerId;
    if (!actor) return false;
    return (await orgAccessLevel(db, project.ownerId, actor)) !== "none";
  }
  return false;
}

/**
 * Whether the caller may write to the project. For org-owned projects, write
 * requires org owner/admin role or membership in a team with write/admin
 * permissions.
 */
export async function canWriteProject(
  db: D1Database,
  project: ProjectEntry,
  binding: CredentialBinding,
  userId?: string,
  agentOwnerId?: string,
): Promise<boolean> {
  if (!bindingCoversProject(binding, project)) return false;
  if (ownsDirectly(project, userId, agentOwnerId)) return true;

  if (project.ownerType === "org") {
    const actor = userId ?? agentOwnerId;
    if (!actor) return false;
    return levelAllowsWrite(await orgAccessLevel(db, project.ownerId, actor));
  }
  return false;
}

/**
 * Whether the caller is an administrator of the project: its direct owner, or —
 * for an org-owned project — an org owner/admin. This is a strictly stronger
 * relation than {@link canWriteProject}: a plain org *writer* is NOT an admin.
 * Used by workspace write-authz to grant an admin override over any workspace.
 */
export async function isProjectAdmin(
  db: D1Database,
  project: ProjectEntry,
  binding: CredentialBinding,
  userId?: string,
  agentOwnerId?: string,
): Promise<boolean> {
  if (!bindingCoversProject(binding, project)) return false;
  if (ownsDirectly(project, userId, agentOwnerId)) return true;

  if (project.ownerType === "org") {
    const actor = userId ?? agentOwnerId;
    if (!actor) return false;
    return (await orgAccessLevel(db, project.ownerId, actor)) === "admin";
  }
  return false;
}

/**
 * Whether the caller may write (push/commit/delete) to a specific workspace.
 *
 * A workspace is a per-principal fork: the creator owns it, so a plain
 * project-writer who did NOT create it must not be able to clobber someone
 * else's in-flight work. Write is therefore granted to the creating principal
 * (an agent shares its owner's identity via `createdByUserId`) OR to a project
 * admin (a deliberate override for owners/org-admins to manage any fork).
 *
 * Legacy workspaces predate `createdByUserId`; with no recorded creator we fail
 * closed — only project admins may write — rather than fall back to the broad
 * project-writer set. Callers are expected to have already confirmed
 * `canWriteProject` for the surface; this narrows within the project.
 */
export async function canWriteWorkspace(
  db: D1Database,
  project: ProjectEntry,
  workspace: WorkspaceEntry,
  binding: CredentialBinding,
  userId?: string,
  agentOwnerId?: string,
): Promise<boolean> {
  if (!bindingCoversProject(binding, project)) return false;
  const effectiveUser = userId ?? agentOwnerId;
  if (workspace.createdByUserId !== undefined) {
    if (effectiveUser !== undefined && workspace.createdByUserId === effectiveUser) return true;
    // Not the creator, but an admin may still override.
    return isProjectAdmin(db, project, binding, userId, agentOwnerId);
  }
  // Legacy (no recorded creator) OR admin-override path: admins only.
  return isProjectAdmin(db, project, binding, userId, agentOwnerId);
}

/**
 * Filter a project list down to what the caller may read. Org access is
 * resolved once per distinct org, not once per project.
 */
export async function filterReadableProjects(
  db: D1Database,
  allProjects: ProjectEntry[],
  binding: CredentialBinding,
  userId?: string,
  agentOwnerId?: string,
): Promise<ProjectEntry[]> {
  const projects = allProjects.filter((project) => bindingCoversProject(binding, project));
  const actor = userId ?? agentOwnerId;
  const orgLevels = new Map<string, OrgAccessLevel>();

  const orgIds = new Set(projects.filter((p) => p.ownerType === "org").map((p) => p.ownerId));
  if (actor) {
    for (const orgId of orgIds) {
      orgLevels.set(orgId, await orgAccessLevel(db, orgId, actor, false));
    }
  }
  const orgLevel = (orgId: string): OrgAccessLevel => orgLevels.get(orgId) ?? "none";

  return projects.filter((project) => {
    if (project.importCompleted === false) {
      // Same write-only rule as canReadProject for incomplete imports.
      if (ownsDirectly(project, userId, agentOwnerId)) return true;
      return project.ownerType === "org" && levelAllowsWrite(orgLevel(project.ownerId));
    }
    if (project.visibility === "public") return true;
    if (ownsDirectly(project, userId, agentOwnerId)) return true;
    if (project.ownerType === "org") return orgLevel(project.ownerId) !== "none";
    return false;
  });
}

/**
 * Filter a project list down to the ones that belong to the caller: projects
 * they directly own, plus org-owned projects they're a member of. Unlike
 * {@link filterReadableProjects}, this deliberately EXCLUDES other people's
 * public projects — it answers "what's mine?", not "what can I see?". This is
 * what the personal dashboard wants, so a user's home shows their own work
 * rather than the whole instance's public firehose. Returns an empty list for
 * an unauthenticated caller (no actor to own anything).
 */
export async function filterMemberProjects(
  db: D1Database,
  allProjects: ProjectEntry[],
  binding: CredentialBinding,
  userId?: string,
  agentOwnerId?: string,
): Promise<ProjectEntry[]> {
  const actor = userId ?? agentOwnerId;
  if (!actor) return [];
  const projects = allProjects.filter((project) => bindingCoversProject(binding, project));

  const orgLevels = new Map<string, OrgAccessLevel>();
  const orgIds = new Set(projects.filter((p) => p.ownerType === "org").map((p) => p.ownerId));
  for (const orgId of orgIds) {
    orgLevels.set(orgId, await orgAccessLevel(db, orgId, actor, false));
  }
  const orgLevel = (orgId: string): OrgAccessLevel => orgLevels.get(orgId) ?? "none";

  return projects.filter((project) => {
    if (project.importCompleted === false) {
      if (ownsDirectly(project, userId, agentOwnerId)) return true;
      return project.ownerType === "org" && levelAllowsWrite(orgLevel(project.ownerId));
    }
    if (ownsDirectly(project, userId, agentOwnerId)) return true;
    if (project.ownerType === "org") return orgLevel(project.ownerId) !== "none";
    return false;
  });
}
