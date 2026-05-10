import { Hono } from "hono";
import { importFromGitHub } from "../storage/git-ops";
import { writeSnapshotFromRepo } from "../storage/repo-snapshot";
import { getProject, listProjects, setProject } from "../storage/state";
import type { Env, ProjectEntry } from "../types";
import { createLogger } from "../utils/logger";
import { badRequest, notFound, ok } from "../utils/response";
import { isValidGitHubUrl } from "../utils/validation";

const app = new Hono<{ Bindings: Env }>();

app.post("/projects/:name/sync", async (c) => {
  const { name } = c.req.param();
  const logger = createLogger({
    path: c.req.path,
    projectName: name,
  });

  const projectResult = await getProject(c.env.STATE, name, logger);
  if (!projectResult.success) {
    logger.warn("Project not found for sync", { name });
    return notFound("Project", name);
  }
  const project = projectResult.data;

  const body = await c.req.json<{ githubUrl?: unknown }>().catch(() => ({}));

  let githubUrl = project.githubUrl;

  if ("githubUrl" in body) {
    if (!isValidGitHubUrl(body.githubUrl)) {
      logger.warn("Invalid GitHub URL provided", { githubUrl: body.githubUrl });
      return badRequest("githubUrl must be a valid github.com repository URL");
    }
    githubUrl = body.githubUrl;
    const updated: ProjectEntry = { ...project, githubUrl };
    const setResult = await setProject(c.env.STATE, updated, logger);
    if (!setResult.success) {
      logger.error("Failed to update project with GitHub URL", setResult.error, {
        name,
        githubUrl,
      });
      return c.json({ error: "Failed to update project" }, 500);
    }
  }

  if (!githubUrl) {
    logger.warn("No GitHub URL set for project", { name });
    return badRequest("no githubUrl set for this project — provide one in the request body");
  }

  logger.info("Starting GitHub import", { name, githubUrl });
  const importResult = await importFromGitHub(c.env.ARTIFACTS, name, githubUrl, logger);

  if (!importResult.success) {
    logger.error("GitHub import failed", importResult.error, { name, githubUrl });
    return c.json({ error: "Failed to import from GitHub" }, 500);
  }

  logger.info("GitHub import completed", { name, githubUrl, remote: importResult.data.remote });
  return ok({ synced: true, project: name, source: githubUrl });
});

export { app as syncRouter };

export async function syncAllProjects(env: Env): Promise<{ synced: number; failed: number }> {
  const logger = createLogger({ operation: "syncAllProjects" });

  const projectsResult = await listProjects(env.STATE, logger);
  if (!projectsResult.success) {
    logger.error("Failed to list projects for sync", projectsResult.error);
    return { synced: 0, failed: 0 };
  }

  const projects = projectsResult.data;
  let synced = 0;
  let failed = 0;

  for (const project of projects) {
    if (!project.githubUrl) continue;

    const projectLogger = logger.child({ projectName: project.name, githubUrl: project.githubUrl });

    try {
      projectLogger.info("Syncing project");
      const result = await importFromGitHub(
        env.ARTIFACTS,
        project.name,
        project.githubUrl,
        projectLogger,
      );
      if (result.success) {
        synced++;
        projectLogger.info("Project synced successfully");
        // NOTE: writeSnapshotFromRepo must be called after any new sync trigger added here
        await writeSnapshotFromRepo(
          env.STATE,
          {
            remote: result.data.remote,
            token: result.data.token,
            namespace: project.namespace,
            slug: project.slug,
          },
          projectLogger,
        );
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

  logger.info("Batch sync completed", { synced, failed, total: projects.length });
  return { synced, failed };
}
