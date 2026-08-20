import { Hono } from "hono";
import { artifactsRepoNameFromRemote, importFromGitHub, syncFromGitHub } from "../storage/git-ops";
import { writeSnapshotFromRepo } from "../storage/repo-snapshot";
import { listProjects } from "../storage/state";
import { checkForSyncUpdates, getProjectSourceUrl, updateProjectAfterSync } from "../storage/sync";
import { type Env, artifactsRepoName } from "../types";
import { createLogger } from "../utils/logger";

// The former unauthenticated `POST /projects/:name/sync` handler was removed: it
// let any caller repoint a project's githubUrl and trigger a destructive
// re-import with no auth check. The authenticated, namespaced equivalent lives
// in sync-management.ts. This router is kept as an empty mount so the
// co-located syncAllProjects cron helper below keeps its import path.
const app = new Hono<{ Bindings: Env }>();

export { app as syncRouter };

export async function syncAllProjects(
  env: Env,
): Promise<{ synced: number; failed: number; skipped: number }> {
  const logger = createLogger({ operation: "syncAllProjects" });

  const projectsResult = await listProjects(env.STATE, logger);
  if (!projectsResult.success) {
    logger.error("Failed to list projects for sync", projectsResult.error);
    return { synced: 0, failed: 0, skipped: 0 };
  }

  const projects = projectsResult.data;
  let synced = 0;
  let failed = 0;
  let skipped = 0;

  for (const project of projects) {
    if (!project.autoSyncEnabled) continue;

    const sourceUrl = getProjectSourceUrl(project);
    if (!sourceUrl) continue;

    const projectLogger = logger.child({ projectName: project.name, sourceUrl });

    try {
      const checkResult = await checkForSyncUpdates(env.STATE, project, undefined, projectLogger);
      if (!checkResult.success) {
        failed++;
        projectLogger.error("Sync update check failed", checkResult.error);
        continue;
      }
      if (!checkResult.data.hasUpdates) {
        skipped++;
        projectLogger.debug("Project up to date, skipping sync");
        continue;
      }

      projectLogger.info("Syncing project", { commitsBehind: checkResult.data.commitsBehind });
      const branch = project.sourceDefaultBranch || project.githubDefaultBranch || "main";

      // #190: existing projects sync INCREMENTALLY into their Artifacts repo —
      // never delete-and-re-import, which destroyed Stratum-native commits and
      // orphaned workspace forks. Only projects without a recorded Artifacts
      // remote (no repo to preserve) still take the legacy import path.
      let succeeded: boolean;
      let syncedRemote = project.remote;
      let syncError: Error | undefined;
      if (artifactsRepoNameFromRemote(project.remote) !== null) {
        const result = await syncFromGitHub(
          env.ARTIFACTS,
          project.remote,
          sourceUrl,
          projectLogger,
          branch,
        );
        succeeded = result.success;
        if (!result.success) syncError = result.error;
      } else {
        const result = await importFromGitHub(
          env.ARTIFACTS,
          artifactsRepoName(project),
          sourceUrl,
          projectLogger,
          branch,
        );
        succeeded = result.success;
        if (result.success) {
          syncedRemote = result.data.remote;
        } else {
          syncError = result.error;
        }
      }

      if (succeeded) {
        projectLogger.info("Project synced successfully");
        // NOTE: writeSnapshotFromRepo must be called after any new sync trigger added here
        await writeSnapshotFromRepo(
          env.STATE,
          env.ARTIFACTS,
          {
            remote: syncedRemote,
            namespace: project.namespace,
            slug: project.slug,
          },
          projectLogger,
        );
        if (checkResult.data.latestCommit) {
          // The remote only changes on the legacy full-import fallback —
          // incremental sync keeps the existing repo (and thus the remote)
          // stable. Persisting it here is required: otherwise the next cron
          // run still sees the legacy remote and re-runs the destructive
          // full import.
          const updateResult = await updateProjectAfterSync(
            env.STATE,
            { ...project, remote: syncedRemote },
            checkResult.data.latestCommit,
            projectLogger,
          );
          // Count the project as synced only once the metadata write lands:
          // a stale lastSyncedCommit would make the next cron run re-import
          // a repo that is already up to date.
          if (!updateResult.success) {
            failed++;
            projectLogger.error("Failed to record sync metadata", updateResult.error);
            continue;
          }
        }
        synced++;
      } else {
        failed++;
        projectLogger.error("Project sync failed", syncError);
      }
    } catch (error) {
      failed++;
      projectLogger.error(
        "Project sync threw exception",
        error instanceof Error ? error : undefined,
      );
    }
  }

  logger.info("Batch sync completed", { synced, failed, skipped, total: projects.length });
  return { synced, failed, skipped };
}
