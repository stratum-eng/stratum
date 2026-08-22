import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/storage/changes", () => ({
  getChange: vi.fn(),
  updateChangeStatus: vi.fn(async () => ({ success: true, data: undefined })),
  markChangeMerged: vi.fn(async () => ({ success: true, data: { transitioned: true } })),
  mergeTransitionOpts: (
    change: { evalScore?: number; evalPassed?: boolean; evalReason?: string },
    mergedAt: string,
  ) => ({
    ...(change?.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
    ...(change?.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
    ...(change?.evalReason !== undefined ? { evalReason: change.evalReason } : {}),
    mergedAt,
  }),
}));
vi.mock("../src/storage/state", () => ({
  getProject: vi.fn(),
  getWorkspace: vi.fn(),
}));
vi.mock("../src/storage/git-ops", () => ({
  freshRepoToken: vi.fn(async () => ({ success: true, data: "tok" })),
  fastForwardMerge: vi.fn(),
  mergeWorkspaceIntoProject: vi.fn(),
  cloneRepo: vi.fn(async () => ({ success: true, data: { fs: {}, dir: "/" } })),
  batchMergeStagedTrees: vi.fn(),
  loadStagedTree: vi.fn(async () => null),
  // Real key layout (pure helpers) so key-construction assertions are meaningful.
  stagedTreeKey: (projectId: string, workspace: string) => `repos/${projectId}/ws/${workspace}`,
  stagedTreeShaKey: (projectId: string, workspace: string, sha: string) =>
    `repos/${projectId}/ws/${workspace}/sha/${sha}`,
}));
vi.mock("../src/storage/provenance", () => ({
  recordProvenance: vi.fn(async () => ({ success: true, data: undefined })),
}));
vi.mock("../src/storage/metrics", () => ({
  recordCommitMetrics: vi.fn(async () => ({ success: true, data: undefined })),
  commitPhasesFromSpans: (spans: Record<string, number>) => spans,
}));

import { RepoDO } from "../src/queue/repo-do";
import { getChange, markChangeMerged } from "../src/storage/changes";
import {
  batchMergeStagedTrees,
  fastForwardMerge,
  loadStagedTree,
  mergeWorkspaceIntoProject,
} from "../src/storage/git-ops";
import { recordCommitMetrics } from "../src/storage/metrics";
import { recordProvenance } from "../src/storage/provenance";
import { getProject, getWorkspace } from "../src/storage/state";
import type { Env } from "../src/types";

const env = { DB: {}, STATE: {}, ARTIFACTS: {} } as unknown as Env;

function makeCtx(): { ctx: DurableObjectState; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  // Minimal in-memory stand-in for the DO's SQLite — pattern-matches the exact
  // statements RepoDO's hot index issues.
  const rows = new Map<string, ArrayBuffer>();
  const sql = {
    exec: (query: string, ...args: unknown[]) => {
      if (query.startsWith("INSERT OR REPLACE INTO staged_trees")) {
        rows.set(args[0] as string, args[1] as ArrayBuffer);
      } else if (query.startsWith("SELECT value FROM staged_trees")) {
        const value = rows.get(args[0] as string);
        return { toArray: () => (value ? [{ value }] : []) };
      } else if (query.startsWith("DELETE FROM staged_trees")) {
        rows.delete(args[0] as string);
      }
      return { toArray: () => [] };
    },
  };
  const ctx = {
    storage: {
      get: async (k: string) => store.get(k),
      put: async (k: string, v: unknown) => {
        store.set(k, v);
      },
      sql,
    },
    blockConcurrencyWhile: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  } as unknown as DurableObjectState;
  return { ctx, store };
}

function setChange(baseSha?: string, extra: Record<string, unknown> = {}) {
  vi.mocked(getChange).mockResolvedValue({
    success: true,
    data: {
      id: "chg_1",
      project: "acme/web",
      workspace: "ws_1",
      status: "approved",
      baseSha,
      ...extra,
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal Change stub
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  setChange("base1");
  vi.mocked(getProject).mockResolvedValue({
    success: true,
    data: { id: "proj_1", remote: "https://artifacts/acme-web.git" },
    // biome-ignore lint/suspicious/noExplicitAny: minimal Project stub
  } as any);
  vi.mocked(getWorkspace).mockResolvedValue({
    success: true,
    data: { remote: "https://artifacts/acme-web-ws1.git" },
    // biome-ignore lint/suspicious/noExplicitAny: minimal Workspace stub
  } as any);
  vi.mocked(mergeWorkspaceIntoProject).mockResolvedValue({ success: true, data: "merge-commit" });
  vi.mocked(fastForwardMerge).mockResolvedValue({
    success: true,
    data: { fastForwarded: true, commit: "ws-tip" },
  });
});

describe("RepoDO.advance fast-forward path", () => {
  it("fast-forwards when expectedParent === head, persists the new head, skips cold merge", async () => {
    const { ctx, store } = makeCtx();
    store.set("head", "base1");
    const repo = new RepoDO(ctx, env);
    const result = await repo.advance("chg_1");

    expect(result).toEqual({ success: true, commit: "ws-tip", transitioned: true });
    expect(fastForwardMerge).toHaveBeenCalledTimes(1);
    expect(mergeWorkspaceIntoProject).not.toHaveBeenCalled();
    expect(store.get("head")).toBe("ws-tip");
    expect(vi.mocked(recordCommitMetrics).mock.calls[0]?.[1].outcome).toBe("fast_forward");
  });
});

describe("RepoDO.advance cold fallback", () => {
  it("cold-merges when there is no known head (first merge after cold start)", async () => {
    const { ctx, store } = makeCtx();
    const repo = new RepoDO(ctx, env);
    const result = await repo.advance("chg_1");

    expect(result).toEqual({ success: true, commit: "merge-commit", transitioned: true });
    expect(fastForwardMerge).not.toHaveBeenCalled();
    expect(mergeWorkspaceIntoProject).toHaveBeenCalledTimes(1);
    expect(store.get("head")).toBe("merge-commit");
    expect(vi.mocked(recordCommitMetrics).mock.calls[0]?.[1].outcome).toBe("cold_fallback");
  });

  it("cold-merges on a raced head (expectedParent !== head), no lost update", async () => {
    const { ctx } = makeCtx();
    (await ctx.storage.put("head", "someone-else-advanced")) as unknown;
    const repo = new RepoDO(ctx, env);
    const result = await repo.advance("chg_1");
    expect(result.success).toBe(true);
    expect(fastForwardMerge).not.toHaveBeenCalled();
    expect(mergeWorkspaceIntoProject).toHaveBeenCalledTimes(1);
  });

  it("reports transitioned:false and skips provenance/metrics when a concurrent merge already won", async () => {
    vi.mocked(markChangeMerged).mockResolvedValueOnce({
      success: true,
      data: { transitioned: false },
    });
    const { ctx, store } = makeCtx();
    store.set("head", "base1"); // fast-forward path produces a commit
    const repo = new RepoDO(ctx, env);

    const result = await repo.advance("chg_1");

    expect(result).toMatchObject({ success: true, transitioned: false });
    expect(recordProvenance).not.toHaveBeenCalled();
    expect(recordCommitMetrics).not.toHaveBeenCalled();
  });

  it("cold-merges when the change has no baseSha", async () => {
    setChange(undefined);
    const { ctx, store } = makeCtx();
    store.set("head", "base1");
    const repo = new RepoDO(ctx, env);
    await repo.advance("chg_1");
    expect(fastForwardMerge).not.toHaveBeenCalled();
    expect(mergeWorkspaceIntoProject).toHaveBeenCalledTimes(1);
  });

  it("cold-merges when the fast-forward push is rejected (race)", async () => {
    vi.mocked(fastForwardMerge).mockResolvedValue({
      success: true,
      data: { fastForwarded: false },
    });
    const { ctx, store } = makeCtx();
    store.set("head", "base1");
    const repo = new RepoDO(ctx, env);
    const result = await repo.advance("chg_1");
    expect(result).toEqual({ success: true, commit: "merge-commit", transitioned: true });
    expect(fastForwardMerge).toHaveBeenCalledTimes(1);
    expect(mergeWorkspaceIntoProject).toHaveBeenCalledTimes(1);
  });

  it("benchCommit writes real git objects (blob, tree, commit) and advances head", async () => {
    const { ctx, store } = makeCtx();
    const puts: string[] = [];
    const bucket = {
      put: async (key: string) => {
        puts.push(key);
      },
    };
    const repo = new RepoDO(ctx, { ...env, REPO_OBJECTS: bucket } as unknown as Env);
    const { blob } = await repo.benchCommit("a.txt", 64);
    expect(blob).toMatch(/^[0-9a-f]{40}$/); // real git SHA-1 oid
    // one batch -> blob + tree + commit objects written, all under objects/<oid>.
    expect(puts).toHaveLength(3);
    expect(puts.every((k) => k.startsWith("objects/"))).toBe(true);
    const head = store.get("bench_head") as string;
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    const stats = repo.benchStats();
    expect(stats.landed).toBe(1);
    expect(stats.treeSize).toBe(1);
    expect(stats.head).toBe(head);
  });

  it("benchCommit resolves same-path conflicts server-side instead of rejecting", async () => {
    const { ctx } = makeCtx();
    const bucket = { put: async () => {} };
    const repo = new RepoDO(ctx, { ...env, REPO_OBJECTS: bucket } as unknown as Env);
    // Two writes to the same path; both land, second is a resolved conflict.
    await repo.benchCommit("shared.txt", 32);
    await repo.benchCommit("shared.txt", 32);
    const stats = repo.benchStats();
    expect(stats.landed).toBe(2);
    expect(stats.treeSize).toBe(1);
    expect(stats.conflictsResolved).toBeGreaterThanOrEqual(1);
  });

  it("rejects a change that is not in a mergeable state", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      // biome-ignore lint/suspicious/noExplicitAny: minimal Change stub
      data: { id: "chg_1", project: "acme/web", workspace: "ws_1", status: "merged" } as any,
    });
    const { ctx } = makeCtx();
    const repo = new RepoDO(ctx, env);
    const result = await repo.advance("chg_1");
    expect(result.success).toBe(false);
  });
});

describe("RepoDO hot index (staged trees in local SQLite)", () => {
  const bytes = (arr: number[]) => new Uint8Array(arr).buffer;

  it("stageTree -> getStagedTrees round-trips the packed bytes", async () => {
    const { ctx } = makeCtx();
    const repo = new RepoDO(ctx, env);
    await repo.stageTree("ws_1", bytes([1, 2, 3, 4]));

    const out = await repo.getStagedTrees(["ws_1", "ws_missing"]);
    expect(out).toHaveLength(1);
    expect(out[0]?.workspace).toBe("ws_1");
    expect([...(out[0]?.value ?? [])]).toEqual([1, 2, 3, 4]);
  });

  it("stageTree upserts — the latest tip wins", async () => {
    const { ctx } = makeCtx();
    const repo = new RepoDO(ctx, env);
    await repo.stageTree("ws_1", bytes([1]));
    await repo.stageTree("ws_1", bytes([9, 9]));

    const out = await repo.getStagedTrees(["ws_1"]);
    expect([...(out[0]?.value ?? [])]).toEqual([9, 9]);
  });

  it("getStagedTrees returns only present workspaces (missing are skipped)", async () => {
    const { ctx } = makeCtx();
    const repo = new RepoDO(ctx, env);
    await repo.stageTree("a", bytes([1]));
    const out = await repo.getStagedTrees(["a", "b", "c"]);
    expect(out.map((o) => o.workspace)).toEqual(["a"]);
  });

  it("gcStagedTrees removes only the landed workspaces", async () => {
    const { ctx } = makeCtx();
    const repo = new RepoDO(ctx, env);
    await repo.stageTree("a", bytes([1]));
    await repo.stageTree("b", bytes([2]));
    await repo.gcStagedTrees(["a"]);

    const out = await repo.getStagedTrees(["a", "b"]);
    expect(out.map((o) => o.workspace)).toEqual(["b"]);
  });

  it("gcStagedTrees on an empty list is a no-op", async () => {
    const { ctx } = makeCtx();
    const repo = new RepoDO(ctx, env);
    await repo.stageTree("a", bytes([1]));
    await repo.gcStagedTrees([]);
    expect(await repo.getStagedTrees(["a"])).toHaveLength(1);
  });
});

// #124: the fast paths must land the EVALUATED commit (change.workspace_head_sha),
// not the workspace's live tip / latest staged tree.
describe("RepoDO.advance sha pinning (#124)", () => {
  it("threads the pinned workspace_head_sha into fastForwardMerge and lands it", async () => {
    setChange("base1", { workspaceHeadSha: "pinned-sha", evaluatedSha: "pinned-sha" });
    vi.mocked(fastForwardMerge).mockResolvedValue({
      success: true,
      data: { fastForwarded: true, commit: "pinned-sha" },
    });
    const { ctx, store } = makeCtx();
    store.set("head", "base1");
    const repo = new RepoDO(ctx, env);

    const result = await repo.advance("chg_1");

    expect(result).toEqual({ success: true, commit: "pinned-sha", transitioned: true });
    expect(vi.mocked(fastForwardMerge).mock.calls[0]?.[7]).toBe("pinned-sha");
    expect(mergeWorkspaceIntoProject).not.toHaveBeenCalled();
    expect(store.get("head")).toBe("pinned-sha");
  });

  it("falls back to evaluatedSha as the pin when workspaceHeadSha is absent", async () => {
    setChange("base1", { evaluatedSha: "eval-sha" });
    const { ctx, store } = makeCtx();
    store.set("head", "base1");
    const repo = new RepoDO(ctx, env);
    await repo.advance("chg_1");
    expect(vi.mocked(fastForwardMerge).mock.calls[0]?.[7]).toBe("eval-sha");
  });

  it("legacy change (no pinned fields): fast-forward runs unpinned (live tip)", async () => {
    setChange("base1");
    const { ctx, store } = makeCtx();
    store.set("head", "base1");
    const repo = new RepoDO(ctx, env);
    const result = await repo.advance("chg_1");
    expect(result.success).toBe(true);
    expect(vi.mocked(fastForwardMerge).mock.calls[0]?.[7]).toBeUndefined();
  });

  it("fails closed (nothing merged, no cold retry) when the pinned sha is gone from the workspace", async () => {
    setChange("base1", { workspaceHeadSha: "pinned-sha", evaluatedSha: "pinned-sha" });
    vi.mocked(fastForwardMerge).mockResolvedValue({
      success: false,
      error: {
        message: "Evaluated workspace commit is no longer present in the workspace history",
        code: "PINNED_SHA_UNREACHABLE",
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal AppError stub
    } as any);
    const { ctx, store } = makeCtx();
    store.set("head", "base1");
    const repo = new RepoDO(ctx, env);

    const result = await repo.advance("chg_1");

    expect(result.success).toBe(false);
    expect(result.code).toBe("PINNED_SHA_UNREACHABLE");
    expect(result.error).toMatch(/no longer present/);
    expect(mergeWorkspaceIntoProject).not.toHaveBeenCalled();
    expect(markChangeMerged).not.toHaveBeenCalled();
    expect(store.get("head")).toBe("base1"); // head not advanced
  });

  it("still cold-merges on any other fast-forward error", async () => {
    setChange("base1", { workspaceHeadSha: "pinned-sha", evaluatedSha: "pinned-sha" });
    vi.mocked(fastForwardMerge).mockResolvedValue({
      success: false,
      error: { message: "network sad", code: "EXTERNAL_SERVICE_ERROR" },
      // biome-ignore lint/suspicious/noExplicitAny: minimal AppError stub
    } as any);
    const { ctx, store } = makeCtx();
    store.set("head", "base1");
    const repo = new RepoDO(ctx, env);
    const result = await repo.advance("chg_1");
    expect(result).toEqual({ success: true, commit: "merge-commit", transitioned: true });
    expect(mergeWorkspaceIntoProject).toHaveBeenCalledTimes(1);
  });

  it("pins the cold fallback the same way the cold route/queue paths do", async () => {
    setChange("base1", { workspaceHeadSha: "pinned-sha", evaluatedSha: "pinned-sha" });
    vi.mocked(fastForwardMerge).mockResolvedValue({
      success: true,
      data: { fastForwarded: false },
    });
    const { ctx, store } = makeCtx();
    store.set("head", "base1");
    const repo = new RepoDO(ctx, env);

    const result = await repo.advance("chg_1");

    expect(result.success).toBe(true);
    const opts = vi.mocked(mergeWorkspaceIntoProject).mock.calls[0]?.[5];
    expect(opts?.workspaceSha).toBe("pinned-sha");
    expect(opts?.expectedWorkspaceSha).toBe("pinned-sha");
  });
});

describe("RepoDO.mergeViaR2 sha-keyed staged trees (#124)", () => {
  const EVAL_TREE = "e".repeat(40);
  const NEWER_TREE = "f".repeat(40);
  const LATEST_KEY = "repos/proj_1/ws/ws_1";
  const SHA_KEY = "repos/proj_1/ws/ws_1/sha/pinned-sha";

  let deleted: string[];
  let bucket: { delete: ReturnType<typeof vi.fn> };
  let r2env: Env;

  beforeEach(() => {
    deleted = [];
    bucket = {
      delete: vi.fn(async (k: string) => {
        deleted.push(k);
      }),
    };
    r2env = { ...env, REPO_OBJECTS: bucket } as unknown as Env;
    setChange("base1", {
      workspaceHeadSha: "pinned-sha",
      evaluatedSha: "pinned-sha",
      evaluatedTreeOid: EVAL_TREE,
    });
    vi.mocked(batchMergeStagedTrees).mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: mirrors the mocked signature
      async (_fs: any, _dir: any, _remote: any, _tok: any, items: any[]) => ({
        success: true,
        data: items.map((it) => ({ changeId: it.changeId, merged: true, commit: "r2-commit" })),
      }),
    );
  });

  it("re-push between eval and merge: consumes the sha-keyed (evaluated) tree, not the newer latest tree", async () => {
    vi.mocked(loadStagedTree).mockImplementation(async (_bucket, key: string) =>
      key === SHA_KEY ? { treeOid: EVAL_TREE, objects: [] } : { treeOid: NEWER_TREE, objects: [] },
    );
    const { ctx, store } = makeCtx();
    const repo = new RepoDO(ctx, r2env);

    const result = await repo.mergeViaR2("chg_1");

    expect(result).toEqual({ success: true, commit: "r2-commit", transitioned: true });
    // The sha-keyed copy was preferred and its (evaluated) tree was merged.
    expect(vi.mocked(loadStagedTree).mock.calls[0]?.[1]).toBe(SHA_KEY);
    const items = vi.mocked(batchMergeStagedTrees).mock.calls[0]?.[4] as {
      staged: { treeOid: string };
      expectedTreeOid?: string;
    }[];
    expect(items[0]?.staged.treeOid).toBe(EVAL_TREE);
    expect(items[0]?.expectedTreeOid).toBe(EVAL_TREE);
    // Head cache advanced; both staged-tree copies GC'd.
    expect(store.get("head")).toBe("r2-commit");
    expect(deleted.sort()).toEqual([LATEST_KEY, SHA_KEY].sort());
  });

  it("sha key missing and latest tree is NOT the evaluated content: falls back (nothing merged via R2)", async () => {
    vi.mocked(loadStagedTree).mockImplementation(async (_bucket, key: string) =>
      key === SHA_KEY ? null : { treeOid: NEWER_TREE, objects: [] },
    );
    const { ctx } = makeCtx();
    const repo = new RepoDO(ctx, r2env);

    const result = await repo.mergeViaR2("chg_1");

    expect(result).toEqual({ fallback: true });
    expect(batchMergeStagedTrees).not.toHaveBeenCalled();
    expect(markChangeMerged).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });

  it("sha key missing but latest tree IS the evaluated content: merges it", async () => {
    vi.mocked(loadStagedTree).mockImplementation(async (_bucket, key: string) =>
      key === SHA_KEY ? null : { treeOid: EVAL_TREE, objects: [] },
    );
    const { ctx } = makeCtx();
    const repo = new RepoDO(ctx, r2env);
    const result = await repo.mergeViaR2("chg_1");
    expect(result).toMatchObject({ success: true, commit: "r2-commit" });
  });

  it("sha-keyed tree that mismatches the evaluated tree oid: clear failure, nothing merged", async () => {
    vi.mocked(loadStagedTree).mockImplementation(async (_bucket, key: string) =>
      key === SHA_KEY ? { treeOid: NEWER_TREE, objects: [] } : null,
    );
    const { ctx, store } = makeCtx();
    const repo = new RepoDO(ctx, r2env);

    const result = await repo.mergeViaR2("chg_1");

    expect(result).toMatchObject({ success: false });
    expect((result as { error?: string }).error).toMatch(/does not match the evaluated revision/);
    expect(batchMergeStagedTrees).not.toHaveBeenCalled();
    expect(markChangeMerged).not.toHaveBeenCalled();
    expect(store.get("head")).toBeUndefined();
    expect(deleted).toEqual([]);
  });

  it("no staged tree anywhere: falls back to the git-based path", async () => {
    vi.mocked(loadStagedTree).mockResolvedValue(null);
    const { ctx } = makeCtx();
    const repo = new RepoDO(ctx, r2env);
    const result = await repo.mergeViaR2("chg_1");
    expect(result).toEqual({ fallback: true });
  });

  it("legacy change (no pinned fields): reads only the latest key, normal flow unchanged", async () => {
    setChange("base1");
    vi.mocked(loadStagedTree).mockResolvedValue({ treeOid: NEWER_TREE, objects: [] });
    const { ctx } = makeCtx();
    const repo = new RepoDO(ctx, r2env);

    const result = await repo.mergeViaR2("chg_1");

    expect(result).toMatchObject({ success: true, commit: "r2-commit" });
    expect(loadStagedTree).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadStagedTree).mock.calls[0]?.[1]).toBe(LATEST_KEY);
    // No sha key to GC — only the latest key.
    expect(deleted).toEqual([LATEST_KEY]);
  });

  it("surfaces the batch validation reason when the merge layer rejects a stale tree", async () => {
    vi.mocked(loadStagedTree).mockImplementation(async (_bucket, key: string) =>
      key === SHA_KEY ? { treeOid: EVAL_TREE, objects: [] } : null,
    );
    vi.mocked(batchMergeStagedTrees).mockResolvedValue({
      success: true,
      data: [
        {
          changeId: "chg_1",
          merged: false,
          reason: "Workspace changed since evaluation: staged tree does not match",
        },
      ],
    });
    const { ctx } = makeCtx();
    const repo = new RepoDO(ctx, r2env);

    const result = await repo.mergeViaR2("chg_1");

    expect(result).toMatchObject({ success: false });
    expect((result as { error?: string }).error).toMatch(/staged tree does not match/);
    expect(markChangeMerged).not.toHaveBeenCalled();
  });

  it("a failed batch (e.g. push rejected) surfaces the error and merges nothing", async () => {
    vi.mocked(loadStagedTree).mockImplementation(async (_bucket, key: string) =>
      key === SHA_KEY ? { treeOid: EVAL_TREE, objects: [] } : null,
    );
    vi.mocked(batchMergeStagedTrees).mockResolvedValue({
      success: false,
      error: { message: "Batch push failed" },
      // biome-ignore lint/suspicious/noExplicitAny: minimal error stub
    } as any);
    const { ctx } = makeCtx();
    const repo = new RepoDO(ctx, r2env);

    const result = await repo.mergeViaR2("chg_1");

    expect(result).toMatchObject({ success: false, error: "Batch push failed" });
    expect(markChangeMerged).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });

  it("falls back when the change has no baseSha (no synthetic-merge parent)", async () => {
    setChange(undefined, { workspaceHeadSha: "pinned-sha", evaluatedTreeOid: EVAL_TREE });
    const { ctx } = makeCtx();
    const repo = new RepoDO(ctx, r2env);
    expect(await repo.mergeViaR2("chg_1")).toEqual({ fallback: true });
    expect(loadStagedTree).not.toHaveBeenCalled();
  });

  it("falls back when REPO_OBJECTS is not bound", async () => {
    const { ctx } = makeCtx();
    const repo = new RepoDO(ctx, env); // env without REPO_OBJECTS
    expect(await repo.mergeViaR2("chg_1")).toEqual({ fallback: true });
  });
});
