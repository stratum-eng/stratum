import { DurableObject } from "cloudflare:workers";
import { getChange, updateChangeStatus } from "../storage/changes";
import { blobObject, commitObject, treeObject } from "../storage/git-objects";
import {
  type NodeFS,
  type StagedItemResult,
  type StagedTreeItem,
  batchMergeStagedTrees,
  cloneRepo,
  fastForwardMerge,
  freshRepoToken,
  loadStagedTree,
  mergeWorkspaceIntoProject,
} from "../storage/git-ops";
import { type CommitOutcome, commitPhasesFromSpans, recordCommitMetrics } from "../storage/metrics";
import { putObject } from "../storage/object-store";
import { recordProvenance } from "../storage/provenance";
import { getProject, getWorkspace } from "../storage/state";
import type { Env } from "../types";
import { type Logger, createLogger } from "../utils/logger";
import { PhaseTimer } from "../utils/phase-timer";
import { GroupCommitCoordinator, type ItemOutcome } from "./group-commit";
import type { MergeOutcome } from "./merge-queue";

const MERGEABLE_STATUSES = new Set(["approved", "accepted", "promoted"]);
const HEAD_KEY = "head";

/**
 * Per-repo ref authority (ADR 004, Phase 1). Tracks the project's main `head` and
 * fast-forwards when a change's expected parent still equals it, skipping the
 * project clone + 3-way merge. Every other case falls back to the proven cold
 * merge. The cached head is an optimization only — correctness is anchored by
 * Artifacts' non-force ref check on push (see fastForwardMerge).
 *
 * Objects still live in Artifacts this phase; the R2 object plane + group-commit
 * (the part that crosses the throughput target) is a later pass.
 */
interface BenchAdvance {
  path: string;
  blobOid: string;
}

export class RepoDO extends DurableObject<Env> {
  private coord?: GroupCommitCoordinator<BenchAdvance, void>;
  // Phase 2 bench state: the working tree (path -> blob oid), the current commit,
  // and counters. Real git objects; conflicts resolved server-side, never rejected.
  private readonly benchTree = new Map<string, string>();
  private benchHead?: string;
  private benchBatches = 0;
  private benchLanded = 0;
  private benchConflicts = 0;

  /**
   * Per-repo group-commit coordinator (ADR 004 Phase 2). The durable write folds a
   * batch of ref advances into ONE combined tree + ONE commit + ONE head write —
   * the single serialized cost. Blob writes happen in the (parallel) object plane
   * before submit.
   */
  private coordinator(): GroupCommitCoordinator<BenchAdvance, void> {
    if (!this.coord) {
      this.coord = new GroupCommitCoordinator<BenchAdvance, void>({
        maxBatchSize: 64,
        durableWrite: (batch) => this.landBatch(batch),
      });
    }
    return this.coord;
  }

  /**
   * Fold a batch into one real git commit, resolving same-path conflicts (last
   * wins). Returns one outcome per item; the whole batch lands together here, so
   * every item shares the batch's success (a thrown error rejects all).
   */
  private async landBatch(batch: BenchAdvance[]): Promise<ItemOutcome<void>[]> {
    const bucket = this.env.REPO_OBJECTS;
    if (!bucket) throw new Error("REPO_OBJECTS not bound");
    const log = createLogger({ component: "RepoDO.bench" });

    const seen = new Set<string>();
    for (const adv of batch) {
      // A write to a path already in the tree (or earlier in this same batch) is a
      // concurrent conflict resolved server-side — last-writer-wins, not rejected.
      if (this.benchTree.has(adv.path) || seen.has(adv.path)) this.benchConflicts += 1;
      seen.add(adv.path);
      this.benchTree.set(adv.path, adv.blobOid);
    }

    const entries = Array.from(this.benchTree, ([name, oid]) => ({ mode: "100644", name, oid }));
    const tree = await treeObject(entries);
    const treePut = await putObject(bucket, tree.oid, tree.bytes, log);
    if (!treePut.success) throw new Error(treePut.error.message);

    const commit = await commitObject({
      tree: tree.oid,
      parents: this.benchHead ? [this.benchHead] : [],
      message: `batch ${this.benchBatches + 1} (${batch.length} commits)`,
      timestamp: Math.floor(Date.now() / 1000),
    });
    const commitPut = await putObject(bucket, commit.oid, commit.bytes, log);
    if (!commitPut.success) throw new Error(commitPut.error.message);

    this.benchHead = commit.oid;
    await this.ctx.storage.put("bench_head", commit.oid);
    this.benchBatches += 1;
    this.benchLanded += batch.length;
    return batch.map(() => ({ ok: true, value: undefined }));
  }

  /**
   * Ref-plane entry point (ADR 004 Phase 2): the blob was already written to the
   * R2 object plane by the Worker (parallel, no coordination). The DO only folds
   * the ref advance into the group-commit batch — keeping the single-threaded DO
   * off the object-write path is what lets object writes parallelize.
   */
  async benchAdvance(path: string, blobOid: string): Promise<{ ok: true }> {
    await this.coordinator().submit({ path, blobOid });
    return { ok: true };
  }

  /**
   * Convenience for tests: write the blob then advance. The live path does the
   * blob write in the Worker (see the /bench route) so it does NOT serialize
   * through the DO.
   */
  async benchCommit(path: string, sizeBytes: number): Promise<{ blob: string }> {
    if (!this.env.REPO_OBJECTS) throw new Error("REPO_OBJECTS not bound");
    const log = createLogger({ component: "RepoDO.bench" });
    const content = crypto.getRandomValues(new Uint8Array(Math.max(1, sizeBytes)));
    const blob = await blobObject(content);
    const put = await putObject(this.env.REPO_OBJECTS, blob.oid, blob.bytes, log);
    if (!put.success) throw new Error(put.error.message);
    await this.benchAdvance(path, blob.oid);
    return { blob: blob.oid };
  }

  /** Bench counters for the harness to read after a run. */
  benchStats(): {
    head: string | undefined;
    batches: number;
    landed: number;
    conflictsResolved: number;
    treeSize: number;
  } {
    return {
      head: this.benchHead,
      batches: this.benchBatches,
      landed: this.benchLanded,
      conflictsResolved: this.benchConflicts,
      treeSize: this.benchTree.size,
    };
  }

  // --- Production R2 merge path (ADR 004 Tasks 5/6) ---
  private r2Coord?: GroupCommitCoordinator<StagedTreeItem, StagedItemResult>;
  private projectRemote?: string;
  // Warm project clone reused across batches: removes the per-batch clone so the
  // durable write is just merge+push, which lets concurrent merges coalesce into
  // large batches. Discarded on any push failure (stale head) -> re-clone next batch.
  private warm?: { fs: NodeFS; dir: string };

  /** Group-commit over R2-staged trees: batches concurrent merges, one push/batch. */
  private r2Coordinator(): GroupCommitCoordinator<StagedTreeItem, StagedItemResult> {
    if (!this.r2Coord) {
      this.r2Coord = new GroupCommitCoordinator<StagedTreeItem, StagedItemResult>({
        maxBatchSize: 64,
        // Accumulate staggered merge requests into real batches (the lever for
        // cross-request coalescing under a swarm).
        batchWindowMs: 25,
        durableWrite: async (batch) => {
          const log = createLogger({ component: "RepoDO.r2.batch" });
          if (!this.projectRemote) throw new Error("project remote unknown");
          // Fresh write token per batch (Artifacts tokens are ~1h; never persisted).
          const token = await freshRepoToken(this.env.ARTIFACTS, this.projectRemote, "write", log);
          if (!token.success) throw new Error(token.error.message);
          if (!this.warm) {
            const cloned = await cloneRepo(this.projectRemote, token.data, log);
            if (!cloned.success) throw new Error(cloned.error.message);
            this.warm = { fs: cloned.data.fs, dir: cloned.data.dir };
          }
          const res = await batchMergeStagedTrees(
            this.warm.fs,
            this.warm.dir,
            this.projectRemote,
            token.data,
            batch,
            log,
          );
          if (!res.success) {
            // Push rejected / stale warm head -> drop the warm clone so the next
            // batch re-clones against the true remote head (correctness anchor:
            // Artifacts' non-force push). The batch is rejected; changes re-merge.
            this.warm = undefined;
            throw new Error(res.error.message);
          }
          return res.data.map((r) => ({ ok: true as const, value: r }));
        },
      });
    }
    return this.r2Coord;
  }

  /**
   * Merge a change via the R2 fetch-free path: load the workspace's staged tip
   * tree from R2, group-commit-merge it onto the project head, push once. Returns
   * `{ fallback: true }` when the R2 path can't apply (no staged tree / no base /
   * not bound) so the caller takes the proven cold path.
   */
  async mergeViaR2(changeId: string, logger?: Logger): Promise<MergeOutcome | { fallback: true }> {
    const log = logger ?? createLogger({ changeId, component: "RepoDO.r2" });
    const bucket = this.env.REPO_OBJECTS;
    if (!bucket) return { fallback: true };

    const changeResult = await getChange(this.env.DB, log, changeId);
    if (!changeResult.success) return { success: false, error: changeResult.error.message };
    const change = changeResult.data;
    if (!MERGEABLE_STATUSES.has(change.status)) {
      return { success: false, error: "Change not found or not ready to merge" };
    }
    if (!change.baseSha) return { fallback: true }; // need a base for the synthetic merge

    const projectResult = await getProject(this.env.STATE, change.project, log);
    if (!projectResult.success) return { success: false, error: projectResult.error.message };
    const project = projectResult.data;

    const key = `repos/${project.id}/ws/${change.workspace}`;
    const staged = await loadStagedTree(bucket, key);
    if (!staged) return { fallback: true }; // not staged → cold path

    this.projectRemote = project.remote;
    let result: StagedItemResult;
    try {
      result = await this.r2Coordinator().submit({ changeId, baseSha: change.baseSha, staged });
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!result.merged || !result.commit) {
      return { success: false, error: "Merge conflict: change could not be auto-merged" };
    }

    // Keep the cached head fresh so a later change that falls back to advance()
    // predicts the fast-forward correctly instead of racing on a stale head.
    await this.setHead(result.commit);

    const updateResult = await updateChangeStatus(this.env.DB, log, changeId, "merged", {
      ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
      ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
      ...(change.evalReason !== undefined ? { evalReason: change.evalReason } : {}),
      mergedAt: new Date().toISOString(),
    });
    if (!updateResult.success) return { success: false, error: updateResult.error.message };

    await recordProvenance(this.env.DB, log, {
      commitSha: result.commit,
      project: change.project,
      workspace: change.workspace,
      changeId,
      ...(change.agentId !== undefined ? { agentId: change.agentId } : {}),
      ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
    });

    // GC the staged tree now that it has landed (Task 6).
    await bucket.delete(key).catch(() => {});
    return { success: true, commit: result.commit };
  }

  private async getHead(): Promise<string | undefined> {
    return this.ctx.storage.get<string>(HEAD_KEY);
  }

  private async setHead(oid: string): Promise<void> {
    await this.ctx.storage.put(HEAD_KEY, oid);
  }

  /**
   * Serialize advances per repo: the head read-modify-write must not interleave
   * across concurrent calls, or the cached head can record a value that isn't the
   * latest ref. (Group-commit will replace this coarse serialization later.)
   */
  async advance(changeId: string, logger?: Logger): Promise<MergeOutcome> {
    return this.ctx.blockConcurrencyWhile(() => this.advanceLocked(changeId, logger));
  }

  private async advanceLocked(changeId: string, logger?: Logger): Promise<MergeOutcome> {
    const log = logger ?? createLogger({ changeId, component: "RepoDO" });
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

      const [projectToken, workspaceToken] = await timer.measure("tokenMintMs", () =>
        Promise.all([
          freshRepoToken(this.env.ARTIFACTS, project.remote, "write", log),
          freshRepoToken(this.env.ARTIFACTS, workspace.remote, "read", log),
        ]),
      );
      if (!projectToken.success) return { success: false, error: projectToken.error.message };
      if (!workspaceToken.success) return { success: false, error: workspaceToken.error.message };

      const expectedParent = change.baseSha;
      const head = await this.getHead();

      let commit: string | undefined;
      let outcome: CommitOutcome = "cold_fallback";

      // Fast-forward fast path: only when we believe the project head is still the
      // change's base. A wrong cache cannot corrupt anything — the non-force push
      // inside fastForwardMerge rejects, and we cold-merge below.
      if (expectedParent && head && expectedParent === head) {
        const ff = await fastForwardMerge(
          project.remote,
          projectToken.data,
          workspace.remote,
          workspaceToken.data,
          expectedParent,
          log,
          timer,
        );
        if (ff.success && ff.data.fastForwarded && ff.data.commit) {
          commit = ff.data.commit;
          outcome = "fast_forward";
        }
      }

      // Cold fallback for every non-fast-forward case (race, missing base, push
      // rejection, or any FF error).
      if (!commit) {
        const coldResult = await mergeWorkspaceIntoProject(
          project.remote,
          projectToken.data,
          workspace.remote,
          workspaceToken.data,
          log,
          { strategy: "merge", timer },
        );
        if (!coldResult.success) {
          return { success: false, error: coldResult.error.message };
        }
        commit = coldResult.data;
        outcome = "cold_fallback";
      }

      if (!commit) {
        return { success: false, error: "Merge did not produce a commit" };
      }
      const mergedCommit = commit;

      // Persist the new head before the bookkeeping writes. A crash after this
      // but before the status update leaves the change re-mergeable; a retry sees
      // head !== base, cold-merges, and isomorphic-git treats an already-applied
      // tree as up-to-date (content-addressed, no double apply).
      await timer.measure("refAdvanceMs", () => this.setHead(mergedCommit));

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

      await timer.measure("provenanceMs", () =>
        recordProvenance(this.env.DB, log, {
          commitSha: mergedCommit,
          project: change.project,
          workspace: change.workspace,
          changeId,
          ...(change.agentId !== undefined ? { agentId: change.agentId } : {}),
          ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
        }),
      );

      const metricsResult = await recordCommitMetrics(
        this.env.DB,
        {
          project: change.project,
          changeId,
          outcome,
          phases: commitPhasesFromSpans(timer.toObject()),
          totalMs: Date.now() - startedAt,
        },
        log,
      );
      if (!metricsResult.success) {
        log.warn("Failed to record commit metrics", { changeId });
      }

      return { success: true, commit: mergedCommit };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, error };
    }
  }
}
