import { getChange, updateChangeStatus } from "../storage/changes";
import { mergeWorkspaceIntoProject } from "../storage/git-ops";
import { recordProvenance } from "../storage/provenance";
import { getProject, getWorkspace } from "../storage/state";
import type { Env } from "../types";
import type { AppError } from "../utils/errors";
import { type Logger, createLogger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

const MERGEABLE_STATUSES = new Set(["approved", "accepted", "promoted"]);

export class MergeQueue {
  env: Env;
  ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async merge(
    changeId: string,
    logger?: Logger,
  ): Promise<Result<{ success: boolean; commit?: string; error?: string }, AppError>> {
    const log = logger ?? createLogger({ changeId });
    const changeResult = await getChange(this.env.DB, log, changeId);
    if (!changeResult.success) {
      return err(changeResult.error);
    }

    const change = changeResult.data;
    if (!MERGEABLE_STATUSES.has(change.status)) {
      return ok({ success: false, error: "Change not found or not ready to merge" });
    }

    try {
      const projectResult = await getProject(this.env.STATE, change.project, log);
      if (!projectResult.success) {
        return err(projectResult.error);
      }
      const project = projectResult.data;

      const workspaceResult = await getWorkspace(this.env.STATE, project.id, change.workspace, log);
      if (!workspaceResult.success) {
        return err(workspaceResult.error);
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
        return err(commitResult.error);
      }
      const commit = commitResult.data;

      const updateResult = await updateChangeStatus(this.env.DB, log, changeId, "merged", {
        ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
        ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
        ...(change.evalReason !== undefined ? { evalReason: change.evalReason } : {}),
        mergedAt: new Date().toISOString(),
      });

      if (!updateResult.success) {
        return err(updateResult.error);
      }

      await recordProvenance(this.env.DB, log, {
        commitSha: commit,
        project: change.project,
        workspace: change.workspace,
        changeId,
        ...(change.agentId !== undefined ? { agentId: change.agentId } : {}),
        ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
      });

      return ok({ success: true, commit });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return ok({ success: false, error });
    }
  }
}
