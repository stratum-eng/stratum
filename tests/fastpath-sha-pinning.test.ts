/**
 * #124: the R2/group-commit fast path must land the EVALUATED commit
 * (change.workspace_head_sha), never the workspace's live tip or the latest
 * staged tree. Exercises the real git logic (isomorphic-git over MemoryFS);
 * only the network legs — `git.clone` (builds a scripted workspace history
 * with deterministic oids) and `git.push` (records what would be pushed) —
 * are stubbed.
 */
import git from "isomorphic-git";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  STALE_STAGED_TREE_REASON,
  batchMergeStagedTrees,
  extractTreeObjects,
  fastForwardMerge,
} from "../src/storage/git-ops";
import { MemoryFS } from "../src/storage/memory-fs";
import { createLogger } from "../src/utils/logger";

const state = vi.hoisted(() => ({
  build: undefined as undefined | ((fs: unknown, dir: string) => Promise<unknown>),
  pushes: [] as { url?: string; ref?: string; remoteRef?: string; oid?: string }[],
  rejectPush: false,
}));

vi.mock("isomorphic-git", async (importActual) => {
  const actual = await importActual<typeof import("isomorphic-git")>();
  const real = actual.default;
  return {
    ...actual,
    default: {
      ...real,
      clone: vi.fn(async (args: { fs: unknown; dir: string }) => {
        if (!state.build) throw new Error("no repo builder configured for git.clone");
        await state.build(args.fs, args.dir);
      }),
      push: vi.fn(
        async (args: {
          fs: never;
          dir: string;
          url?: string;
          ref?: string;
          remoteRef?: string;
        }) => {
          if (state.rejectPush) throw new Error("push rejected (non-fast-forward)");
          const oid = await real.resolveRef({
            fs: args.fs,
            dir: args.dir,
            ref: args.ref ?? "HEAD",
          });
          state.pushes.push({ url: args.url, ref: args.ref, remoteRef: args.remoteRef, oid });
          return { ok: true, error: null, refs: {} };
        },
      ),
    },
  };
});

const logger = createLogger({ component: "test" });
const AUTHOR = { name: "Stratum", email: "system@usestratum.dev" };

type AnyFS = never;

/**
 * Deterministic workspace history: commit 0 = base (expectedParent), commit 1 =
 * the evaluated (pinned) commit, commit 2 = a re-push that moved the tip past
 * the evaluated sha. Fixed author timestamps -> identical oids on every build,
 * so tests can precompute the shas the mocked `git.clone` will produce.
 */
async function buildHistory(fsAny: unknown, dir: string, commits: number): Promise<string[]> {
  const fs = fsAny as AnyFS;
  const oids: string[] = [];
  await git.init({ fs, dir, defaultBranch: "main" });
  const files = ["README.md", "evaluated.txt", "newer.txt"];
  const prefix = dir === "/" ? "" : dir;
  for (let i = 0; i < commits; i++) {
    const path = files[i] ?? `f${i}.txt`;
    await (
      fsAny as { promises: { writeFile(p: string, d: string): Promise<void> } }
    ).promises.writeFile(`${prefix}/${path}`, `content ${i}\n`);
    await git.add({ fs, dir, filepath: path });
    oids.push(
      await git.commit({
        fs,
        dir,
        message: `c${i}`,
        author: { ...AUTHOR, timestamp: 1700000000 + i, timezoneOffset: 0 },
      }),
    );
  }
  return oids;
}

async function precomputeOids(commits: number): Promise<string[]> {
  return buildHistory(new MemoryFS().toNodeFS(), "/pre", commits);
}

describe("fastForwardMerge pinned-sha targeting (#124)", () => {
  beforeEach(() => {
    state.build = undefined;
    state.pushes = [];
    state.rejectPush = false;
  });

  const callFF = (expectedParent: string, pinned?: string) =>
    fastForwardMerge(
      "https://proj.example/repo.git",
      "ptok",
      "https://ws.example/repo.git",
      "wtok",
      expectedParent,
      logger,
      undefined,
      pinned,
    );

  it("no re-push (tip === pinned): fast-forwards main to the tip exactly as before", async () => {
    const [base, evaluated] = await precomputeOids(2);
    state.build = (fs, dir) => buildHistory(fs, dir, 2);

    const result = await callFF(base as string, evaluated);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ fastForwarded: true, commit: evaluated });
    expect(state.pushes).toHaveLength(1);
    expect(state.pushes[0]).toMatchObject({ ref: "main", remoteRef: "main", oid: evaluated });
  });

  it("re-push between eval and merge: pushes the PINNED sha, not the moved tip", async () => {
    const [base, evaluated, newer] = await precomputeOids(3);
    state.build = (fs, dir) => buildHistory(fs, dir, 3);

    const result = await callFF(base as string, evaluated);

    expect(result.success).toBe(true);
    if (!result.success) return;
    // The evaluated commit lands — the unevaluated tip does not.
    expect(result.data.fastForwarded).toBe(true);
    expect(result.data.commit).toBe(evaluated);
    expect(result.data.commit).not.toBe(newer);
    expect(state.pushes).toHaveLength(1);
    expect(state.pushes[0]?.oid).toBe(evaluated);
    expect(state.pushes[0]?.remoteRef).toBe("main");
    expect(state.pushes[0]?.ref).not.toBe("main"); // pinned commit rides a local ref
  });

  it("pinned sha absent from the workspace history: fails closed with a clear error, nothing pushed", async () => {
    const [base] = await precomputeOids(2);
    state.build = (fs, dir) => buildHistory(fs, dir, 2);

    const result = await callFF(base as string, "0123456789abcdef0123456789abcdef01234567");

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("PINNED_SHA_UNREACHABLE");
    expect(result.error.message).toMatch(/no longer present/);
    expect(state.pushes).toHaveLength(0);
  });

  it("pinned sha that does not descend from the expected parent: declines the fast-forward (cold fallback)", async () => {
    const [, evaluated, newer] = await precomputeOids(3);
    state.build = (fs, dir) => buildHistory(fs, dir, 3);

    // expectedParent = the tip itself; the (older) pinned commit cannot be a
    // fast-forward of it.
    const result = await callFF(newer as string, evaluated);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.fastForwarded).toBe(false);
    expect(state.pushes).toHaveLength(0);
  });

  it("declines the fast-forward when descent from the expected parent cannot be proven", async () => {
    const [, evaluated] = await precomputeOids(2);
    state.build = (fs, dir) => buildHistory(fs, dir, 2);

    // expectedParent unknown to the clone (e.g. beyond the shallow history):
    // isDescendent cannot prove ancestry -> cold fallback, nothing pushed.
    const result = await callFF("9999999999999999999999999999999999999999", evaluated);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.fastForwarded).toBe(false);
    expect(state.pushes).toHaveLength(0);
  });

  it("legacy change with no pinned sha: fast-forwards to the live tip (behavior unchanged)", async () => {
    const [base, , newer] = await precomputeOids(3);
    state.build = (fs, dir) => buildHistory(fs, dir, 3);

    const result = await callFF(base as string, undefined);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ fastForwarded: true, commit: newer });
    expect(state.pushes[0]).toMatchObject({ ref: "main", oid: newer });
  });

  it("push rejection still degrades to the cold fallback", async () => {
    const [base, evaluated] = await precomputeOids(2);
    state.build = (fs, dir) => buildHistory(fs, dir, 2);
    state.rejectPush = true;

    const result = await callFF(base as string, evaluated);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.fastForwarded).toBe(false);
  });
});

describe("batchMergeStagedTrees evaluated-tree validation (#124)", () => {
  beforeEach(() => {
    state.build = undefined;
    state.pushes = [];
    state.rejectPush = false;
  });

  /** Project repo (base commit) + a workspace commit whose tree we stage. */
  async function setup() {
    const fsNode = new MemoryFS().toNodeFS();
    const fs = fsNode as AnyFS;
    const dir = "/proj";
    await git.init({ fs, dir, defaultBranch: "main" });
    const write = async (path: string, content: string) => {
      await (
        fsNode as { promises: { writeFile(p: string, d: string): Promise<void> } }
      ).promises.writeFile(`${dir}/${path}`, content);
      await git.add({ fs, dir, filepath: path });
    };
    await write("README.md", "base\n");
    const base = await git.commit({
      fs,
      dir,
      message: "base",
      author: { ...AUTHOR, timestamp: 1700000000, timezoneOffset: 0 },
    });
    // Workspace branch from base: add ws.txt — its tree is what gets staged.
    await git.branch({ fs, dir, ref: "ws", object: base });
    await git.checkout({ fs, dir, ref: "ws" });
    await write("ws.txt", "ws\n");
    const wsTip = await git.commit({
      fs,
      dir,
      message: "ws",
      author: { ...AUTHOR, timestamp: 1700000001, timezoneOffset: 0 },
    });
    await git.checkout({ fs, dir, ref: "main" });
    const wsTreeOid = (await git.readCommit({ fs, dir, oid: wsTip })).commit.tree;
    const objects = await extractTreeObjects(fsNode as never, dir, wsTreeOid);
    return { fsNode, dir, base, wsTreeOid, objects };
  }

  it("a staged tree that mismatches the evaluated tree oid is refused at the merge layer; nothing pushed", async () => {
    const { fsNode, dir, base, wsTreeOid, objects } = await setup();

    const result = await batchMergeStagedTrees(
      fsNode as never,
      dir,
      "https://proj.example/repo.git",
      "ptok",
      [
        {
          changeId: "chg_stale",
          baseSha: base,
          staged: { treeOid: wsTreeOid, objects },
          expectedTreeOid: "b".repeat(40), // evaluated against a different tree
        },
      ],
      logger,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual([
      { changeId: "chg_stale", merged: false, reason: STALE_STAGED_TREE_REASON },
    ]);
    expect(state.pushes).toHaveLength(0);
    // main untouched.
    const files = await git.listFiles({ fs: fsNode as AnyFS, dir, ref: "main" });
    expect(files).toEqual(["README.md"]);
  });

  it("a matching staged tree merges; a stale one in the same batch is refused without dirtying it", async () => {
    const { fsNode, dir, base, wsTreeOid, objects } = await setup();

    const result = await batchMergeStagedTrees(
      fsNode as never,
      dir,
      "https://proj.example/repo.git",
      "ptok",
      [
        {
          changeId: "chg_stale",
          baseSha: base,
          staged: { treeOid: wsTreeOid, objects },
          expectedTreeOid: "b".repeat(40),
        },
        {
          changeId: "chg_ok",
          baseSha: base,
          staged: { treeOid: wsTreeOid, objects },
          expectedTreeOid: wsTreeOid, // matches the evaluated tree
        },
      ],
      logger,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data[0]).toEqual({
      changeId: "chg_stale",
      merged: false,
      reason: STALE_STAGED_TREE_REASON,
    });
    expect(result.data[1]?.merged).toBe(true);
    expect(result.data[1]?.commit).toBeDefined();
    expect(state.pushes).toHaveLength(1);
    // The evaluated content landed on main.
    const files = await git.listFiles({ fs: fsNode as AnyFS, dir, ref: "main" });
    expect(files.sort()).toEqual(["README.md", "ws.txt"]);
  });

  it("items without an expectedTreeOid (legacy) merge exactly as before", async () => {
    const { fsNode, dir, base, wsTreeOid, objects } = await setup();

    const result = await batchMergeStagedTrees(
      fsNode as never,
      dir,
      "https://proj.example/repo.git",
      "ptok",
      [{ changeId: "chg_legacy", baseSha: base, staged: { treeOid: wsTreeOid, objects } }],
      logger,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data[0]?.merged).toBe(true);
    expect(state.pushes).toHaveLength(1);
  });
});
