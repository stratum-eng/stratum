import { type OrgAccessLevel, getOrgAccessLevel } from "../storage/orgs";
import type { ProjectEntry, WorkspaceEntry } from "../types";
import { createLogger } from "./logger";

const logger = createLogger({ component: "Authz" });

/** Direct ownership: the project belongs to this user (or this agent's owner). */
export function isDirectOwner(
  project: ProjectEntry,
  userId?: string,
  agentOwnerId?: string,
): boolean {
  if (!project.ownerId) return false;
  return project.ownerId === userId || project.ownerId === agentOwnerId;
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
  userId?: string,
  agentOwnerId?: string,
): Promise<boolean> {
  // Incomplete imports are only visible to writers — the repo has no content yet.
  // importCompleted is absent on legacy projects; treat absence as completed.
  if (project.importCompleted === false) {
    return canWriteProject(db, project, userId, agentOwnerId);
  }
  if (project.visibility === "public") return true;
  if (isDirectOwner(project, userId, agentOwnerId)) return true;

  if (project.ownerType === "org") {
    const actor = userId ?? agentOwnerId;
    if (!actor) return false;
    return (await getOrgAccessLevel(db, logger, project.ownerId, actor)) !== "none";
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
  userId?: string,
  agentOwnerId?: string,
): Promise<boolean> {
  if (isDirectOwner(project, userId, agentOwnerId)) return true;

  if (project.ownerType === "org") {
    const actor = userId ?? agentOwnerId;
    if (!actor) return false;
    return levelAllowsWrite(await getOrgAccessLevel(db, logger, project.ownerId, actor));
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
  userId?: string,
  agentOwnerId?: string,
): Promise<boolean> {
  if (isDirectOwner(project, userId, agentOwnerId)) return true;

  if (project.ownerType === "org") {
    const actor = userId ?? agentOwnerId;
    if (!actor) return false;
    return (await getOrgAccessLevel(db, logger, project.ownerId, actor)) === "admin";
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
  userId?: string,
  agentOwnerId?: string,
): Promise<boolean> {
  const effectiveUser = userId ?? agentOwnerId;
  if (workspace.createdByUserId !== undefined) {
    if (effectiveUser !== undefined && workspace.createdByUserId === effectiveUser) return true;
    // Not the creator, but an admin may still override.
    return isProjectAdmin(db, project, userId, agentOwnerId);
  }
  // Legacy (no recorded creator) OR admin-override path: admins only.
  return isProjectAdmin(db, project, userId, agentOwnerId);
}

/**
 * Filter a project list down to what the caller may read. Org access is
 * resolved once per distinct org, not once per project.
 */
export async function filterReadableProjects(
  db: D1Database,
  projects: ProjectEntry[],
  userId?: string,
  agentOwnerId?: string,
): Promise<ProjectEntry[]> {
  const actor = userId ?? agentOwnerId;
  const orgLevels = new Map<string, OrgAccessLevel>();

  const orgIds = new Set(projects.filter((p) => p.ownerType === "org").map((p) => p.ownerId));
  if (actor) {
    for (const orgId of orgIds) {
      orgLevels.set(orgId, await getOrgAccessLevel(db, logger, orgId, actor));
    }
  }
  const orgLevel = (orgId: string): OrgAccessLevel => orgLevels.get(orgId) ?? "none";

  return projects.filter((project) => {
    if (project.importCompleted === false) {
      // Same write-only rule as canReadProject for incomplete imports.
      if (isDirectOwner(project, userId, agentOwnerId)) return true;
      return project.ownerType === "org" && levelAllowsWrite(orgLevel(project.ownerId));
    }
    if (project.visibility === "public") return true;
    if (isDirectOwner(project, userId, agentOwnerId)) return true;
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
  projects: ProjectEntry[],
  userId?: string,
  agentOwnerId?: string,
): Promise<ProjectEntry[]> {
  const actor = userId ?? agentOwnerId;
  if (!actor) return [];

  const orgLevels = new Map<string, OrgAccessLevel>();
  const orgIds = new Set(projects.filter((p) => p.ownerType === "org").map((p) => p.ownerId));
  for (const orgId of orgIds) {
    orgLevels.set(orgId, await getOrgAccessLevel(db, logger, orgId, actor));
  }
  const orgLevel = (orgId: string): OrgAccessLevel => orgLevels.get(orgId) ?? "none";

  return projects.filter((project) => {
    if (project.importCompleted === false) {
      if (isDirectOwner(project, userId, agentOwnerId)) return true;
      return project.ownerType === "org" && levelAllowsWrite(orgLevel(project.ownerId));
    }
    if (isDirectOwner(project, userId, agentOwnerId)) return true;
    if (project.ownerType === "org") return orgLevel(project.ownerId) !== "none";
    return false;
  });
}
