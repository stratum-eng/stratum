import type { ProjectEntry, WorkspaceEntry } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { listProjects, listWorkspaces, setProject, setWorkspace } from "./state";

/**
 * Project & workspace IDENTITY lives in KV, not D1 (roadmap item #3 migrates it).
 * A repo pack in R2 is keyed by project id and its manifest carries the full
 * ProjectEntry, but dumping the KV identity too gives a self-contained restore of
 * "which projects/workspaces exist" without depending on the repo manifests.
 */
export interface KvIdentityDump {
  projects: Uint8Array;
  workspaces: Uint8Array;
  projectCount: number;
  workspaceCount: number;
  /** True if any project's workspaces could not be listed and were omitted — the
   * dump is not a faithful snapshot of identity. Callers must not treat a partial
   * dump as complete. */
  partial: boolean;
}

export async function exportKvIdentity(
  kv: KVNamespace,
  logger: Logger,
): Promise<Result<KvIdentityDump, AppError>> {
  const projectsResult = await listProjects(kv, logger);
  if (!projectsResult.success) return err(projectsResult.error);
  const projects = projectsResult.data;

  const workspaces: WorkspaceEntry[] = [];
  let partial = false;
  for (const project of projects) {
    const wsResult = await listWorkspaces(kv, project.id, logger);
    if (wsResult.success) workspaces.push(...wsResult.data);
    else {
      partial = true;
      logger.warn("Skipping workspaces for a project during backup", { projectId: project.id });
    }
  }

  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  return ok({
    projects: enc(projects),
    workspaces: enc(workspaces),
    projectCount: projects.length,
    workspaceCount: workspaces.length,
    partial,
  });
}

/** Reload projects then workspaces from their JSON dumps. */
export async function restoreKvIdentity(
  kv: KVNamespace,
  projectsJson: Uint8Array,
  workspacesJson: Uint8Array,
  logger: Logger,
): Promise<Result<{ projects: number; workspaces: number }, AppError>> {
  try {
    const projects = JSON.parse(new TextDecoder().decode(projectsJson)) as ProjectEntry[];
    const workspaces = JSON.parse(new TextDecoder().decode(workspacesJson)) as WorkspaceEntry[];

    for (const project of projects) {
      const res = await setProject(kv, project, logger);
      if (!res.success) return err(res.error);
    }
    for (const ws of workspaces) {
      // WorkspaceEntry.parent is the owning project id (the workspace KV key).
      const res = await setWorkspace(kv, ws.parent, ws, logger);
      if (!res.success) return err(res.error);
    }
    return ok({ projects: projects.length, workspaces: workspaces.length });
  } catch (error) {
    logger.error("Failed to restore KV identity", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to restore KV identity", "STORAGE_ERROR", 500));
  }
}
