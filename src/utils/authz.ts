import { type OrgAccessLevel, getOrgAccessLevel } from "../storage/orgs";
import type { ProjectEntry } from "../types";
import { createLogger } from "./logger";

const logger = createLogger({ component: "Authz" });

/** Direct ownership: the project belongs to this user (or this agent's owner). */
function isDirectOwner(project: ProjectEntry, userId?: string, agentOwnerId?: string): boolean {
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
