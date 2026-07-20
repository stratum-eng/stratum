import { DurableObject } from "cloudflare:workers";
import { getChange, markChangeMerged } from "../storage/changes";
import { isTargetDeleting } from "../storage/deletion";
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

    // No-op if the owner is being erased (see MergeQueue.merge for rationale).
    if (await isTargetDeleting(this.env, project, log)) {
      log.info("Skipping R2 merge for deleting owner", { changeId, projectId: project.id });
      return { success: false, error: "Project owner is being deleted" };
    }

    const key = `repos/${project.id}/ws/${change.workspace}`;
    const staged = await loadStagedTree(bucket, key);
    if (!staged) return { fallback: true }; // not staged → cold path

    // SEC-2: content-address the tree we are about to land against what was
    // evaluated. This closes the residual TOCTOU between the route's pre-merge
    // tip check and this staged-tree read: if the workspace was re-committed in
    // that window, the staged tree oid won't match the evaluated tree oid.
    // Legacy changes (pre-migration 026) have no evaluatedTreeOid and skip it.
    if (change.evaluatedTreeOid !== undefined && staged.treeOid !== change.evaluatedTreeOid) {
      return {
        success: false,
        error:
          "Workspace changed since evaluation: staged tree does not match the evaluated revision",
      };
    }

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

    const updateResult = await markChangeMerged(this.env.DB, log, changeId, {
      ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
      ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
      ...(change.evalReason !== undefined ? { evalReason: change.evalReason } : {}),
      mergedAt: new Date().toISOString(),
    });
    if (!updateResult.success) return { success: false, error: updateResult.error.message };
    const { transitioned } = updateResult.data;
    // A concurrent invocation already merged this change (interleaved before our
    // CAS). The winner recorded provenance and GC'd the staged tree; skip both so
    // a single logical merge yields exactly one set of side effects.
    if (!transitioned) return { success: true, commit: result.commit, transitioned: false };

    // The commit is already durable; provenance is bookkeeping — log a failure for
    // observability but don't fail the (successful) merge.
    const provenanceResult = await recordProvenance(this.env.DB, log, {
      commitSha: result.commit,
      project: change.project,
      projectId: change.projectId ?? project.id,
      workspace: change.workspace,
      changeId,
      ...(change.agentId !== undefined ? { agentId: change.agentId } : {}),
      ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
      ...(change.agentModel !== undefined ? { model: change.agentModel } : {}),
      ...(change.agentPromptHash !== undefined ? { promptHash: change.agentPromptHash } : {}),
    });
    if (!provenanceResult.success) {
      log.error("Failed to record provenance after R2 merge", provenanceResult.error);
    }

    // GC the staged tree now that it has landed (Task 6).
    await bucket.delete(key).catch((error) => {
      log.warn("Failed to delete staged tree", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return { success: true, commit: result.commit, transitioned };
  }

  // --- Hot object index (ADR 004): staged tip trees in the DO's local SQLite ---
  // Reading them at merge time is a microsecond-scale local read instead of a
  // ~30ms-per-change R2 GET — the resolve phase was the batch path's dominant cost.
  private stagedTableReady = false;
  private ensureStagedTable(): void {
    if (this.stagedTableReady) return;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS staged_trees (workspace TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL)",
    );
    this.stagedTableReady = true;
  }

  /** Stage (upsert) a workspace's packed tip tree into the DO's local SQLite. */
  async stageTree(workspace: string, value: ArrayBuffer): Promise<void> {
    this.ensureStagedTable();
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO staged_trees (workspace, value, updated_at) VALUES (?, ?, ?)",
      workspace,
      value,
      Date.now(),
    );
  }

  private readStagedTree(workspace: string): Uint8Array | null {
    this.ensureStagedTable();
    const rows = this.ctx.storage.sql
      .exec<{ value: ArrayBuffer }>("SELECT value FROM staged_trees WHERE workspace = ?", workspace)
      .toArray();
    const row = rows[0];
    return row ? new Uint8Array(row.value) : null;
  }

  /**
   * Read many staged trees from the LOCAL SQLite hot index in one RPC — replaces the
   * batch path's N per-change R2 GETs (~30ms each) with a single fast call. The
   * caller does the actual clone+merge+push in the Worker (the merge runs measurably
   * faster there than inside the DO).
   */
  async getStagedTrees(workspaces: string[]): Promise<{ workspace: string; value: Uint8Array }[]> {
    const out: { workspace: string; value: Uint8Array }[] = [];
    for (const ws of workspaces) {
      const value = this.readStagedTree(ws);
      if (value) out.push({ workspace: ws, value });
    }
    return out;
  }

  /** GC staged trees from the hot index after their changes have landed. */
  async gcStagedTrees(workspaces: string[]): Promise<void> {
    if (workspaces.length === 0) return;
    this.ensureStagedTable();
    for (const ws of workspaces) {
      this.ctx.storage.sql.exec("DELETE FROM staged_trees WHERE workspace = ?", ws);
    }
  }

  /**
   * Deletion-cascade RPC: DO storage is only reachable from inside the class,
   * so the project cascade calls this to wipe the ref cache, bench state, and
   * the staged-tree hot index. In-memory state is reset too — a warm instance
   * surviving the purge must not serve stale refs if the name is ever reused.
   */
  async purge(): Promise<void> {
    // Serialize the wipe with any in-flight mergeViaR2/advanceLocked: without the
    // barrier a concurrent merge could re-populate storage or act on state we are
    // mid-reset, leaving a "deleted" repo warm with stale refs.
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.deleteAll();
      this.benchTree.clear();
      this.benchHead = undefined;
      this.benchBatches = 0;
      this.benchLanded = 0;
      this.benchConflicts = 0;
      this.warm = undefined;
      this.projectRemote = undefined;
      this.stagedTableReady = false;
    });
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

      // No-op if the owner is being erased (see MergeQueue.merge for rationale).
      if (await isTargetDeleting(this.env, project, log)) {
        log.info("Skipping advance for deleting owner", { changeId, projectId: project.id });
        return { success: false, error: "Project owner is being deleted" };
      }

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
          change.evaluatedSha,
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
          {
            strategy: "merge",
            timer,
            // SEC-2: pin the merged tip to the evaluated sha on the RepoDO cold
            // fallback too. Legacy changes with no evaluatedSha skip it.
            ...(change.evaluatedSha !== undefined
              ? { expectedWorkspaceSha: change.evaluatedSha }
              : {}),
          },
        );
        if (!coldResult.success) {
          return { success: false, error: coldResult.error.message, code: coldResult.error.code };
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
      // provenance/metrics writes (the winner recorded them) — see mergeViaR2.
      if (!transitioned) {
        return { success: true, commit: mergedCommit, transitioned: false };
      }

      const provenanceResult = await timer.measure("provenanceMs", () =>
        recordProvenance(this.env.DB, log, {
          commitSha: mergedCommit,
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

      const metricsResult = await recordCommitMetrics(
        this.env.DB,
        {
          project: change.project,
          projectId: change.projectId ?? project.id,
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

      return { success: true, commit: mergedCommit, transitioned };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, error };
    }
  }
}
