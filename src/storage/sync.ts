/**
 * Git sync functionality for keeping imported repositories up to date
 */

import type { ProjectEntry, SyncCheckResult } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { getProjectByPath, setProject } from "./state";
import { detectProvider, getProvider, parseRepoUrl, buildAuthConfig } from "./git-providers";
import type { ProviderAuthConfig } from "./git-providers";

// Sync job tracking in KV (for quick lookup)
const SYNC_STATUS_PREFIX = "sync-status:";

interface SyncStatus {
  namespace: string;
  slug: string;
  lastCheckedAt: string;
  lastSyncedAt?: string;
  lastSyncedCommit?: string;
  lastSyncStatus: "success" | "failed" | "in_progress" | "idle";
  lastSyncError?: string;
  hasUpdates: boolean;
  commitsBehind?: number;
  latestCommit?: string;
  autoSyncEnabled: boolean;
}

/**
 * Get sync status key for KV storage
 */
function syncStatusKey(namespace: string, slug: string): string {
  return `${SYNC_STATUS_PREFIX}${namespace}:${slug}`;
}

/**
 * Parse sync status from KV
 */
function parseSyncStatus(raw: string | null): SyncStatus | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SyncStatus;
  } catch {
    return null;
  }
}

/**
 * Check if a project has sync capabilities (connected to a git provider)
 */
export function hasSyncCapabilities(project: ProjectEntry): boolean {
  return !!(
    project.githubUrl || // Legacy field
    project.sourceUrl // New generic field
  );
}

/**
 * Get the source URL for a project (handles legacy and new fields)
 */
export function getProjectSourceUrl(project: ProjectEntry): string | undefined {
  return project.sourceUrl || project.githubUrl;
}

/**
 * Get the source provider for a project
 */
export function getProjectProvider(project: ProjectEntry): ReturnType<typeof detectProvider> {
  const url = getProjectSourceUrl(project);
  if (!url) return null;

  // Use stored provider if available
  if (project.sourceProvider) {
    return project.sourceProvider;
  }

  // Detect from URL
  return detectProvider(url);
}

/**
 * Check for updates for a project
 * Compares the stored commit SHA with the latest from the remote
 */
export async function checkForSyncUpdates(
  kv: KVNamespace,
  project: ProjectEntry,
  auth: ProviderAuthConfig | undefined,
  logger: Logger,
): Promise<Result<SyncCheckResult, AppError>> {
  const { namespace, slug } = project;
  const sourceUrl = getProjectSourceUrl(project);

  if (!sourceUrl) {
    return err(new AppError("Project has no source URL", "INVALID_STATE", 400));
  }

  const provider = getProjectProvider(project);
  if (!provider) {
    return err(new AppError("Unsupported git provider", "INVALID_STATE", 400));
  }

  const parsed = parseRepoUrl(sourceUrl);
  if (!parsed) {
    return err(new AppError("Invalid source URL", "INVALID_STATE", 400));
  }

  const { owner, repo } = parsed.info;
  const branch = project.sourceDefaultBranch || project.githubDefaultBranch || "main";
  const currentCommit = project.lastSyncedCommit;

  logger.debug("Checking for sync updates", {
    namespace,
    slug,
    provider,
    owner,
    repo,
    branch,
    currentCommit: currentCommit?.slice(0, 7),
  });

  try {
    const providerClient = getProvider(provider);
    const updateResult = await providerClient.checkForUpdates(
      owner,
      repo,
      currentCommit,
      branch,
      auth,
      logger,
    );

    // Update sync status in KV
    const status: SyncStatus = {
      namespace,
      slug,
      lastCheckedAt: new Date().toISOString(),
      lastSyncedAt: project.lastSyncedAt,
      lastSyncedCommit: currentCommit,
      lastSyncStatus: project.lastSyncStatus || "idle",
      lastSyncError: project.lastSyncError,
      hasUpdates: updateResult.hasUpdates,
      commitsBehind: updateResult.commitsBehind,
      latestCommit: updateResult.latestCommit,
      autoSyncEnabled: project.autoSyncEnabled || false,
    };

    await kv.put(syncStatusKey(namespace, slug), JSON.stringify(status));

    logger.info("Sync check completed", {
      namespace,
      slug,
      hasUpdates: updateResult.hasUpdates,
      commitsBehind: updateResult.commitsBehind,
    });

    return ok(updateResult);
  } catch (error) {
    logger.error("Failed to check for updates", error instanceof Error ? error : undefined, {
      namespace,
      slug,
    });
    return err(
      new AppError(
        `Failed to check for updates: ${error instanceof Error ? error.message : "Unknown error"}`,
        "SYNC_ERROR",
        500,
      ),
    );
  }
}

/**
 * Update project after successful sync
 * Updates the stored commit SHA and sync timestamp
 */
export async function updateProjectAfterSync(
  kv: KVNamespace,
  project: ProjectEntry,
  syncedCommit: string,
  logger: Logger,
): Promise<Result<ProjectEntry, AppError>> {
  const { namespace, slug } = project;

  logger.debug("Updating project after sync", {
    namespace,
    slug,
    commit: syncedCommit.slice(0, 7),
  });

  const updatedProject: ProjectEntry = {
    ...project,
    lastSyncedAt: new Date().toISOString(),
    lastSyncedCommit: syncedCommit,
    lastSyncStatus: "success",
    lastSyncError: undefined,
  };

  const result = await setProject(kv, updatedProject, logger);
  if (!result.success) {
    return result;
  }

  // Update sync status in KV
  const statusKey = syncStatusKey(namespace, slug);
  const existingStatus = parseSyncStatus(await kv.get(statusKey));

  const status: SyncStatus = {
    namespace,
    slug,
    lastCheckedAt: new Date().toISOString(),
    lastSyncedAt: updatedProject.lastSyncedAt,
    lastSyncedCommit: syncedCommit,
    lastSyncStatus: "success",
    hasUpdates: false,
    commitsBehind: 0,
    autoSyncEnabled: existingStatus?.autoSyncEnabled || false,
  };

  await kv.put(statusKey, JSON.stringify(status));

  logger.info("Project updated after sync", {
    namespace,
    slug,
    commit: syncedCommit.slice(0, 7),
  });

  return ok(updatedProject);
}

/**
 * Update project with sync error
 * Records the error and updates sync status
 */
export async function updateProjectSyncError(
  kv: KVNamespace,
  project: ProjectEntry,
  errorMessage: string,
  logger: Logger,
): Promise<Result<ProjectEntry, AppError>> {
  const { namespace, slug } = project;

  logger.error("Sync error recorded", undefined, {
    namespace,
    slug,
    error: errorMessage,
  });

  const updatedProject: ProjectEntry = {
    ...project,
    lastSyncStatus: "failed",
    lastSyncError: errorMessage,
  };

  const result = await setProject(kv, updatedProject, logger);
  if (!result.success) {
    return result;
  }

  // Update sync status in KV
  const statusKey = syncStatusKey(namespace, slug);
  const existingStatus = parseSyncStatus(await kv.get(statusKey));

  const status: SyncStatus = {
    namespace,
    slug,
    lastCheckedAt: new Date().toISOString(),
    lastSyncedAt: existingStatus?.lastSyncedAt,
    lastSyncedCommit: existingStatus?.lastSyncedCommit,
    lastSyncStatus: "failed",
    lastSyncError: errorMessage,
    hasUpdates: existingStatus?.hasUpdates || false,
    commitsBehind: existingStatus?.commitsBehind,
    autoSyncEnabled: existingStatus?.autoSyncEnabled || false,
  };

  await kv.put(statusKey, JSON.stringify(status));

  return ok(updatedProject);
}

/**
 * Set sync in progress status
 * Marks the project as currently syncing
 */
export async function setSyncInProgress(
  kv: KVNamespace,
  namespace: string,
  slug: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  logger.debug("Setting sync in progress", { namespace, slug });

  try {
    const statusKey = syncStatusKey(namespace, slug);
    const existingStatus = parseSyncStatus(await kv.get(statusKey));

    const status: SyncStatus = {
      namespace,
      slug,
      lastCheckedAt: new Date().toISOString(),
      lastSyncedAt: existingStatus?.lastSyncedAt,
      lastSyncedCommit: existingStatus?.lastSyncedCommit,
      lastSyncStatus: "in_progress",
      hasUpdates: existingStatus?.hasUpdates || false,
      commitsBehind: existingStatus?.commitsBehind,
      autoSyncEnabled: existingStatus?.autoSyncEnabled || false,
    };

    await kv.put(statusKey, JSON.stringify(status));
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to set sync in progress", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to set sync status", "STORAGE_ERROR", 500));
  }
}

/**
 * Get sync status for a project
 */
export async function getSyncStatus(
  kv: KVNamespace,
  namespace: string,
  slug: string,
  logger: Logger,
): Promise<Result<SyncStatus | null, AppError>> {
  try {
    const statusKey = syncStatusKey(namespace, slug);
    const raw = await kv.get(statusKey);
    const status = parseSyncStatus(raw);
    return ok(status);
  } catch (error) {
    logger.error("Failed to get sync status", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to get sync status", "STORAGE_ERROR", 500));
  }
}

/**
 * Toggle auto-sync for a project
 */
export async function setAutoSyncEnabled(
  kv: KVNamespace,
  namespace: string,
  slug: string,
  enabled: boolean,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    const statusKey = syncStatusKey(namespace, slug);
    const existingStatus = parseSyncStatus(await kv.get(statusKey));

    const status: SyncStatus = {
      namespace,
      slug,
      lastCheckedAt: new Date().toISOString(),
      lastSyncedAt: existingStatus?.lastSyncedAt,
      lastSyncedCommit: existingStatus?.lastSyncedCommit,
      lastSyncStatus: existingStatus?.lastSyncStatus || "idle",
      hasUpdates: existingStatus?.hasUpdates || false,
      commitsBehind: existingStatus?.commitsBehind,
      autoSyncEnabled: enabled,
    };

    await kv.put(statusKey, JSON.stringify(status));

    logger.info("Auto-sync setting updated", { namespace, slug, enabled });
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to set auto-sync", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to set auto-sync", "STORAGE_ERROR", 500));
  }
}

/**
 * List all projects with auto-sync enabled
 * Useful for cron jobs that check for updates
 */
export async function listAutoSyncProjects(
  kv: KVNamespace,
  logger: Logger,
): Promise<Result<Array<{ namespace: string; slug: string }>, AppError>> {
  try {
    const result = await kv.list({ prefix: SYNC_STATUS_PREFIX });
    const projects: Array<{ namespace: string; slug: string }> = [];

    for (const key of result.keys) {
      const raw = await kv.get(key.name);
      const status = parseSyncStatus(raw);
      if (status?.autoSyncEnabled) {
        projects.push({
          namespace: status.namespace,
          slug: status.slug,
        });
      }
    }

    return ok(projects);
  } catch (error) {
    logger.error("Failed to list auto-sync projects", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to list auto-sync projects", "STORAGE_ERROR", 500));
  }
}

// Re-export types
export type { SyncStatus };
