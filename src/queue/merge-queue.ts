import { DurableObject } from "cloudflare:workers";
import { getChange, updateChangeStatus } from "../storage/changes";
import { mergeWorkspaceIntoProject } from "../storage/git-ops";
import { recordProvenance } from "../storage/provenance";
import { getProject, getWorkspace } from "../storage/state";
import type { Env } from "../types";
import { type Logger, createLogger } from "../utils/logger";

const MERGEABLE_STATUSES = new Set(["approved", "accepted", "promoted"]);

/** Plain, RPC-serializable outcome of a merge attempt. */
export interface MergeOutcome {
  success: boolean;
  commit?: string;
  error?: string;
}

// Must extend DurableObject: callers invoke merge() over RPC, which the runtime
// only enables for classes that extend the special base class.
export class MergeQueue extends DurableObject<Env> {
  async merge(changeId: string, logger?: Logger): Promise<MergeOutcome> {
    const log = logger ?? createLogger({ changeId });
    const changeResult = await getChange(this.env.DB, log, changeId);
    if (!changeResult.success) {
      return { success: false, error: changeResult.error.message };
    }

    const change = changeResult.data;
    if (!MERGEABLE_STATUSES.has(change.status)) {
      return { success: false, error: "Change not found or not ready to merge" };
    }

    try {
      const projectResult = await getProject(this.env.STATE, change.project, log);
      if (!projectResult.success) {
        return { success: false, error: projectResult.error.message };
      }
      const project = projectResult.data;

      const workspaceResult = await getWorkspace(this.env.STATE, project.id, change.workspace, log);
      if (!workspaceResult.success) {
        return { success: false, error: workspaceResult.error.message };
      }
      const workspace = workspaceResult.data;

      const commitResult = await mergeWorkspaceIntoProject(
        project.remote,
        project.token,
        workspace.remote,
        workspace.token,
        log,
        { strategy: "merge" },
      );

      if (!commitResult.success) {
        return { success: false, error: commitResult.error.message };
      }
      const commit = commitResult.data;

      const updateResult = await updateChangeStatus(this.env.DB, log, changeId, "merged", {
        ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
        ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
        ...(change.evalReason !== undefined ? { evalReason: change.evalReason } : {}),
        mergedAt: new Date().toISOString(),
      });

      if (!updateResult.success) {
        return { success: false, error: updateResult.error.message };
      }

      await recordProvenance(this.env.DB, log, {
        commitSha: commit,
        project: change.project,
        workspace: change.workspace,
        changeId,
        ...(change.agentId !== undefined ? { agentId: change.agentId } : {}),
        ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
      });

      return { success: true, commit };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, error };
    }
  }
}
