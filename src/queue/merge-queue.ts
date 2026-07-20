import { DurableObject } from "cloudflare:workers";
import { getChange, markChangeMerged } from "../storage/changes";
import { isTargetDeleting } from "../storage/deletion";
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
  /** Structured error code (e.g. "STALE_WORKSPACE") so the route can map the
   * failure to the right HTTP status instead of a generic 400. */
  code?: string;
  /** Whether THIS invocation performed the approved→merged transition. `false`
   * means a concurrent merger already merged the change (the git merge here was
   * redundant), so the route must NOT emit a second `change.merged`. Absent on
   * paths that predate the CAS — treated as "did transition" so the event fires. */
  transitioned?: boolean;
}

// Must extend DurableObject: callers invoke merge() over RPC, which the runtime
// only enables for classes that extend the special base class.
export class MergeQueue extends DurableObject<Env> {
  /**
   * Deletion-cascade RPC: DO storage is only reachable from inside the class,
   * so the project cascade calls this to drop any durable state this queue
   * ever wrote for the (now deleted) project.
   */
  async purge(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

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

      // No-op if the owner is being erased: merging would re-create provenance/
      // metrics/change rows the deletion cascade is removing.
      if (await isTargetDeleting(this.env, project, log)) {
        log.info("Skipping merge for deleting owner", { changeId, projectId: project.id });
        return { success: false, error: "Project owner is being deleted" };
      }

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
          // Merge the exact evaluated commit, not the workspace's live tip (#115),
          // AND assert that tip hasn't moved since evaluation (SEC-2). Both pin to
          // the same evaluated revision on the production merge path; legacy
          // changes without these fields fall back to the live tip.
          ...(change.workspaceHeadSha ? { workspaceSha: change.workspaceHeadSha } : {}),
          ...(change.evaluatedSha !== undefined
            ? { expectedWorkspaceSha: change.evaluatedSha }
            : {}),
        },
      );

      if (!commitResult.success) {
        return {
          success: false,
          error: commitResult.error.message,
          code: commitResult.error.code,
        };
      }
      const commit = commitResult.data;

      const updateResult = await timer.measure("d1UpdateMs", () =>
        markChangeMerged(this.env.DB, log, changeId, {
          ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
          ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
          ...(change.evalReason !== undefined ? { evalReason: change.evalReason } : {}),
          mergedAt: new Date().toISOString(),
        }),
      );

      if (!updateResult.success) {
        return { success: false, error: updateResult.error.message };
      }
      const { transitioned } = updateResult.data;
      // Concurrent invocation already merged this change; skip the redundant
      // provenance/metrics writes (the winner recorded them) so one logical merge
      // yields exactly one set of side effects.
      if (!transitioned) return { success: true, commit, transitioned: false };

      const provenanceResult = await timer.measure("provenanceMs", () =>
        recordProvenance(this.env.DB, log, {
          commitSha: commit,
          project: change.project,
          projectId: change.projectId ?? project.id,
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
          projectId: change.projectId ?? project.id,
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

      return { success: true, commit, transitioned };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, error };
    }
  }
}
