import type { ProjectEntry } from "../types";

export function canReadProject(
  project: ProjectEntry,
  userId?: string,
  agentOwnerId?: string,
): boolean {
  // Incomplete imports are only visible to the owner — the repo has no content yet.
  // importCompleted is absent on legacy projects; treat absence as completed.
  if (project.importCompleted === false) {
    return canWriteProject(project, userId, agentOwnerId);
  }
  if (project.visibility === "public") return true;
  return canWriteProject(project, userId, agentOwnerId);
}

/**
 * Returns true when a non-owner should receive a 404 rather than a 403.
 * An incomplete import is invisible to outsiders — leaking its existence
 * (even via a 403) is undesirable.
 */
export function shouldAppearNotFound(
  project: ProjectEntry,
  userId?: string,
  agentOwnerId?: string,
): boolean {
  return project.importCompleted === false && !canWriteProject(project, userId, agentOwnerId);
}

export function canWriteProject(
  project: ProjectEntry,
  userId?: string,
  agentOwnerId?: string,
): boolean {
  if (!project.ownerId) return false;
  return project.ownerId === userId || project.ownerId === agentOwnerId;
}

export function filterReadableProjects(
  projects: ProjectEntry[],
  userId?: string,
  agentOwnerId?: string,
): ProjectEntry[] {
  return projects.filter((project) => canReadProject(project, userId, agentOwnerId));
}
