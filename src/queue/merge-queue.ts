import { DurableObject } from "cloudflare:workers";
import { getChange, updateChangeStatus } from "../storage/changes";
import { freshRepoToken, mergeWorkspaceIntoProject } from "../storage/git-ops";
import { commitPhasesFromSpans, recordCommitMetrics } from "../storage/metrics";
import { recordProvenance } from "../storage/provenance";
import { getProject, getWorkspace } from "../storage/state";
import type { Env } from "../types";
import { type Logger, createLogger } from "../utils/logger";
import { PhaseTimer } from "../utils/phase-timer";

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
    const timer = new PhaseTimer();
    const startedAt = Date.now();
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

      // Merge clones the workspace fork (read) and pushes to the project (write).
      // Mint both tokens fresh: no token is persisted.
      const [projectToken, workspaceToken] = await timer.measure("tokenMintMs", () =>
        Promise.all([
          freshRepoToken(this.env.ARTIFACTS, project.remote, "write", log),
          freshRepoToken(this.env.ARTIFACTS, workspace.remote, "read", log),
        ]),
      );
      if (!projectToken.success) return { success: false, error: projectToken.error.message };
      if (!workspaceToken.success) return { success: false, error: workspaceToken.error.message };

      const commitResult = await mergeWorkspaceIntoProject(
        project.remote,
        projectToken.data,
        workspace.remote,
        workspaceToken.data,
        log,
        {
          strategy: "merge",
          timer,
          // SEC-2: pin the merged tip to the evaluated sha (this is the production
          // merge path). Legacy changes with no evaluatedSha skip it.
          ...(change.evaluatedSha !== undefined
            ? { expectedWorkspaceSha: change.evaluatedSha }
            : {}),
        },
      );

      if (!commitResult.success) {
        return { success: false, error: commitResult.error.message };
      }
      const commit = commitResult.data;

      const updateResult = await timer.measure("d1UpdateMs", () =>
        updateChangeStatus(this.env.DB, log, changeId, "merged", {
          ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
          ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
          ...(change.evalReason !== undefined ? { evalReason: change.evalReason } : {}),
          mergedAt: new Date().toISOString(),
        }),
      );

      if (!updateResult.success) {
        return { success: false, error: updateResult.error.message };
      }

      const provenanceResult = await timer.measure("provenanceMs", () =>
        recordProvenance(this.env.DB, log, {
          commitSha: commit,
          project: change.project,
          workspace: change.workspace,
          changeId,
          ...(change.agentId !== undefined ? { agentId: change.agentId } : {}),
          ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
          ...(change.agentModel !== undefined ? { model: change.agentModel } : {}),
          ...(change.agentPromptHash !== undefined ? { promptHash: change.agentPromptHash } : {}),
        }),
      );
      if (!provenanceResult.success) {
        log.error("Failed to record provenance after merge", provenanceResult.error);
      }

      // The classic MergeQueue always runs the full cold merge path.
      const metricsResult = await recordCommitMetrics(
        this.env.DB,
        {
          project: change.project,
          changeId,
          outcome: "cold_fallback",
          phases: commitPhasesFromSpans(timer.toObject()),
          totalMs: Date.now() - startedAt,
        },
        log,
      );
      if (!metricsResult.success) {
        log.warn("Failed to record commit metrics", { changeId });
      }

      return { success: true, commit };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, error };
    }
  }
}
