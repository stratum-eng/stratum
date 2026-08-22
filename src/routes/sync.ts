import { Hono } from "hono";
import { importFromGitHub } from "../storage/git-ops";
import { writeSnapshotFromRepo } from "../storage/repo-snapshot";
import { listProjects } from "../storage/state";
import { checkForSyncUpdates, getProjectSourceUrl, updateProjectAfterSync } from "../storage/sync";
import { type Env, artifactsRepoName, projectDefaultBranch } from "../types";
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
      const result = await importFromGitHub(
        env.ARTIFACTS,
        artifactsRepoName(project),
        sourceUrl,
        projectLogger,
        projectDefaultBranch(project),
      );
      if (result.success) {
        projectLogger.info("Project synced successfully");
        // NOTE: writeSnapshotFromRepo must be called after any new sync trigger added here
        await writeSnapshotFromRepo(
          env.STATE,
          env.ARTIFACTS,
          {
            remote: result.data.remote,
            namespace: project.namespace,
            slug: project.slug,
            defaultBranch: projectDefaultBranch(project),
          },
          projectLogger,
        );
        if (checkResult.data.latestCommit) {
          const updateResult = await updateProjectAfterSync(
            env.STATE,
            project,
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
        projectLogger.error("Project sync failed", result.error);
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
