import type { ProjectEntry, WorkspaceEntry } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

const PROJECT_PREFIX = "project:";
const WORKSPACE_PREFIX = "workspace:";

function parseEntry<T>(raw: string, key: string, logger: Logger): Result<T, AppError> {
  try {
    const parsed = JSON.parse(raw) as T;
    return ok(parsed);
  } catch (error) {
    logger.error(
      `Failed to parse KV entry for key "${key}"`,
      error instanceof Error ? error : undefined,
    );
    return err(
      new AppError(`Failed to parse KV entry for key "${key}"`, "PARSE_ERROR", 500, { key }),
    );
  }
}

// Helper to generate storage key from namespace and slug
function projectKey(namespace: string, slug: string): string {
  return `${PROJECT_PREFIX}${namespace}:${slug}`;
}

// Legacy key format for backward compatibility during migration
function legacyProjectKey(name: string): string {
  return `${PROJECT_PREFIX}${name}`;
}

function workspaceKey(projectId: string, name: string): string {
  return `${WORKSPACE_PREFIX}${projectId}:${name}`;
}

// Get project by namespace and slug (new namespace-aware API)
export async function getProjectByPath(
  kv: KVNamespace,
  namespace: string,
  slug: string,
  logger: Logger,
): Promise<Result<ProjectEntry, AppError>> {
  const key = projectKey(namespace, slug);
  logger.debug("Fetching project by path", { namespace, slug, key });
  const raw = await kv.get(key);
  if (!raw) {
    return err(
      new AppError(`Project '${namespace}/${slug}' not found`, "NOT_FOUND", 404, {
        resource: "project",
        namespace,
        slug,
      }),
    );
  }
  return parseEntry<ProjectEntry>(raw, key, logger);
}

// Legacy: Get project by name (for backward compatibility during migration)
export async function getProject(
  kv: KVNamespace,
  name: string,
  logger: Logger,
): Promise<Result<ProjectEntry, AppError>> {
  logger.debug("Fetching project (legacy)", { name });
  const raw = await kv.get(legacyProjectKey(name));
  if (!raw) {
    return err(
      new AppError(`Project '${name}' not found`, "NOT_FOUND", 404, { resource: "project", name }),
    );
  }
  return parseEntry<ProjectEntry>(raw, legacyProjectKey(name), logger);
}

// Set project using new namespace-aware key
export async function setProject(
  kv: KVNamespace,
  entry: ProjectEntry,
  logger: Logger,
): Promise<Result<void, AppError>> {
  logger.debug("Setting project", {
    id: entry.id,
    namespace: entry.namespace,
    slug: entry.slug,
    name: entry.name,
  });
  try {
    // Use new namespace:slug key format
    const key = projectKey(entry.namespace, entry.slug);
    await kv.put(key, JSON.stringify(entry));
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to set project", error instanceof Error ? error : undefined, {
      id: entry.id,
      namespace: entry.namespace,
      slug: entry.slug,
    });
    return err(
      new AppError(
        `Failed to set project '${entry.namespace}/${entry.slug}'`,
        "STORAGE_ERROR",
        500,
        { id: entry.id, namespace: entry.namespace, slug: entry.slug },
      ),
    );
  }
}

// Delete project by namespace and slug
export async function deleteProject(
  kv: KVNamespace,
  namespace: string,
  slug: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  logger.debug("Deleting project", { namespace, slug });
  try {
    await kv.delete(projectKey(namespace, slug));
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to delete project", error instanceof Error ? error : undefined, {
      namespace,
      slug,
    });
    return err(
      new AppError(`Failed to delete project '${namespace}/${slug}'`, "STORAGE_ERROR", 500, {
        namespace,
        slug,
      }),
    );
  }
}

// Legacy delete for migration purposes
export async function deleteProjectLegacy(
  kv: KVNamespace,
  name: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  logger.debug("Deleting project (legacy)", { name });
  try {
    await kv.delete(legacyProjectKey(name));
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to delete project (legacy)", error instanceof Error ? error : undefined, {
      name,
    });
    return err(new AppError(`Failed to delete project '${name}'`, "STORAGE_ERROR", 500, { name }));
  }
}

// List all projects (for admin/migration)
export async function listProjects(
  kv: KVNamespace,
  logger: Logger,
): Promise<Result<ProjectEntry[], AppError>> {
  logger.debug("Listing all projects");
  try {
    const result = await kv.list({ prefix: PROJECT_PREFIX });
    const entries = await Promise.all(
      result.keys.map(async ({ name }) => {
        const raw = await kv.get(name);
        if (!raw) return null;
        const parsed = parseEntry<ProjectEntry>(raw, name, logger);
        return parsed.success ? parsed.data : null;
      }),
    );
    return ok(entries.filter((e): e is ProjectEntry => e !== null));
  } catch (error) {
    logger.error("Failed to list projects", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to list projects", "STORAGE_ERROR", 500));
  }
}

// List projects by namespace (for user/org dashboard)
export async function listProjectsByNamespace(
  kv: KVNamespace,
  namespace: string,
  logger: Logger,
): Promise<Result<ProjectEntry[], AppError>> {
  logger.debug("Listing projects by namespace", { namespace });
  try {
    const result = await kv.list({ prefix: `${PROJECT_PREFIX}${namespace}:` });
    const entries = await Promise.all(
      result.keys.map(async ({ name }) => {
        const raw = await kv.get(name);
        if (!raw) return null;
        const parsed = parseEntry<ProjectEntry>(raw, name, logger);
        return parsed.success ? parsed.data : null;
      }),
    );
    return ok(entries.filter((e): e is ProjectEntry => e !== null));
  } catch (error) {
    logger.error(
      "Failed to list projects by namespace",
      error instanceof Error ? error : undefined,
      { namespace },
    );
    return err(new AppError("Failed to list projects", "STORAGE_ERROR", 500, { namespace }));
  }
}

// Check if a project exists in a namespace
export async function projectExists(
  kv: KVNamespace,
  namespace: string,
  slug: string,
  logger: Logger,
): Promise<Result<boolean, AppError>> {
  logger.debug("Checking project existence", { namespace, slug });
  try {
    const result = await getProjectByPath(kv, namespace, slug, logger);
    return ok(result.success);
  } catch {
    return ok(false);
  }
}

// Workspace functions (namespaced by project ID)
export async function getWorkspace(
  kv: KVNamespace,
  projectId: string,
  name: string,
  logger: Logger,
): Promise<Result<WorkspaceEntry, AppError>> {
  logger.debug("Fetching workspace", { projectId, name });
  const raw = await kv.get(workspaceKey(projectId, name));
  if (!raw) {
    return err(
      new AppError(`Workspace '${name}' not found in project '${projectId}'`, "NOT_FOUND", 404, {
        resource: "workspace",
        projectId,
        name,
      }),
    );
  }
  return parseEntry<WorkspaceEntry>(raw, workspaceKey(projectId, name), logger);
}

export async function setWorkspace(
  kv: KVNamespace,
  projectId: string,
  entry: WorkspaceEntry,
  logger: Logger,
): Promise<Result<void, AppError>> {
  logger.debug("Setting workspace", { projectId, name: entry.name });
  try {
    await kv.put(workspaceKey(projectId, entry.name), JSON.stringify(entry));
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to set workspace", error instanceof Error ? error : undefined, {
      projectId,
      name: entry.name,
    });
    return err(
      new AppError(`Failed to set workspace '${entry.name}'`, "STORAGE_ERROR", 500, {
        projectId,
        name: entry.name,
      }),
    );
  }
}

export async function deleteWorkspace(
  kv: KVNamespace,
  projectId: string,
  name: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  logger.debug("Deleting workspace", { projectId, name });
  try {
    await kv.delete(workspaceKey(projectId, name));
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to delete workspace", error instanceof Error ? error : undefined, {
      projectId,
      name,
    });
    return err(
      new AppError(`Failed to delete workspace '${name}'`, "STORAGE_ERROR", 500, {
        projectId,
        name,
      }),
    );
  }
}

export async function listWorkspaces(
  kv: KVNamespace,
  projectId: string,
  logger: Logger,
): Promise<Result<WorkspaceEntry[], AppError>> {
  logger.debug("Listing workspaces", { projectId });
  try {
    const result = await kv.list({ prefix: `${WORKSPACE_PREFIX}${projectId}:` });
    const entries = await Promise.all(
      result.keys.map(async ({ name }) => {
        const raw = await kv.get(name);
        if (!raw) return null;
        const parsed = parseEntry<WorkspaceEntry>(raw, name, logger);
        return parsed.success ? parsed.data : null;
      }),
    );
    return ok(entries.filter((e): e is WorkspaceEntry => e !== null));
  } catch (error) {
    logger.error("Failed to list workspaces", error instanceof Error ? error : undefined, {
      projectId,
    });
    return err(new AppError("Failed to list workspaces", "STORAGE_ERROR", 500, { projectId }));
  }
}
