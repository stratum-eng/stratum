import git from "isomorphic-git";
import { describe, expect, it, vi } from "vitest";
import { blobObject, commitObject, treeObject } from "../src/storage/git-objects";
import { type NodeFS, applySourceUpdate } from "../src/storage/git-ops";
import { MemoryFS } from "../src/storage/memory-fs";
import { type FsLike, placeLooseObject } from "../src/storage/object-loader";
import type { Logger } from "../src/utils/logger";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const DIR = "/repo";
const author = { name: "t", email: "t@x.com", timestamp: 1_700_000_000, timezoneOffset: 0 };

// isomorphic-git accepts its own fs shape, which is structurally wider than
// NodeFS; derive it from the library so the tests stay type-checked.
type GitFS = Parameters<typeof git.init>[0]["fs"];

async function initRepo(): Promise<{ fs: NodeFS; gfs: GitFS }> {
  const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
  const gfs = fs as GitFS;
  await git.init({ fs: gfs, dir: DIR, defaultBranch: "main" });
  return { fs, gfs };
}

async function commitFiles(gfs: GitFS, files: Record<string, string>, message = "c") {
  for (const [path, content] of Object.entries(files)) {
    await (gfs as unknown as NodeFS).promises.writeFile(`${DIR}/${path}`, content);
    await git.add({ fs: gfs, dir: DIR, filepath: path });
  }
  return git.commit({ fs: gfs, dir: DIR, message, author });
}

/** Rewind main to `sha` (simulates the local repo not yet having later commits). */
async function rewindMain(gfs: GitFS, sha: string) {
  await git.writeRef({ fs: gfs, dir: DIR, ref: "refs/heads/main", value: sha, force: true });
  await git.checkout({ fs: gfs, dir: DIR, ref: "main", force: true });
}

describe("applySourceUpdate (real git, in-memory)", () => {
  it("fast-forwards main to the source tip when the source is strictly ahead", async () => {
    const { fs, gfs } = await initRepo();
    const base = await commitFiles(gfs, { "file.txt": "base\n" }, "base");
    const mid = await commitFiles(gfs, { "file.txt": "v2\n" }, "source c2");
    const sourceTip = await commitFiles(gfs, { "extra.txt": "new\n" }, "source c3");
    await rewindMain(gfs, base);

    const result = await applySourceUpdate(fs, DIR, sourceTip, logger);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("fast-forwarded");
    expect(result.data.commit).toBe(sourceTip);
    expect(await git.resolveRef({ fs: gfs, dir: DIR, ref: "main" })).toBe(sourceTip);
    const log = await git.log({ fs: gfs, dir: DIR, depth: -1 });
    expect(log.map((c) => c.oid)).toEqual([sourceTip, mid, base]);
  });

  it("is a no-op when the source tip equals main", async () => {
    const { fs, gfs } = await initRepo();
    const tip = await commitFiles(gfs, { "file.txt": "base\n" }, "base");

    const result = await applySourceUpdate(fs, DIR, tip, logger);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("up-to-date");
    expect(result.data.commit).toBe(tip);
    expect(await git.resolveRef({ fs: gfs, dir: DIR, ref: "main" })).toBe(tip);
  });

  it("is a no-op when main is ahead of the source tip (native commits preserved)", async () => {
    const { fs, gfs } = await initRepo();
    const base = await commitFiles(gfs, { "file.txt": "base\n" }, "base");
    const nativeTip = await commitFiles(gfs, { "native.txt": "stratum\n" }, "native merge");

    const result = await applySourceUpdate(fs, DIR, base, logger);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("up-to-date");
    expect(result.data.commit).toBe(nativeTip);
    // The Stratum-native commit is still the tip — nothing was rewound.
    expect(await git.resolveRef({ fs: gfs, dir: DIR, ref: "main" })).toBe(nativeTip);
  });

  it("merges cleanly-diverged histories, keeping native and source commits", async () => {
    const { fs, gfs } = await initRepo();
    const base = await commitFiles(gfs, { "file.txt": "base\n" }, "base");
    const sourceTip = await commitFiles(gfs, { "source.txt": "from github\n" }, "source");
    await rewindMain(gfs, base);
    const nativeTip = await commitFiles(gfs, { "native.txt": "stratum\n" }, "native");

    const result = await applySourceUpdate(fs, DIR, sourceTip, logger);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("merged");
    const head = await git.resolveRef({ fs: gfs, dir: DIR, ref: "main" });
    expect(result.data.commit).toBe(head);
    const merge = await git.readCommit({ fs: gfs, dir: DIR, oid: head });
    expect(merge.commit.parent.sort()).toEqual([nativeTip, sourceTip].sort());
    const files = await git.listFiles({ fs: gfs, dir: DIR, ref: "main" });
    expect(files.sort()).toEqual(["file.txt", "native.txt", "source.txt"]);
  });

  it("fails with SYNC_DIVERGED on conflicting edits and leaves main untouched", async () => {
    const { fs, gfs } = await initRepo();
    await commitFiles(gfs, { "file.txt": "base\n" }, "base");
    const sourceTip = await commitFiles(gfs, { "file.txt": "github edit\n" }, "source");
    const base = (await git.log({ fs: gfs, dir: DIR, depth: -1 })).at(-1)?.oid ?? "";
    await rewindMain(gfs, base);
    const nativeTip = await commitFiles(gfs, { "file.txt": "native edit\n" }, "native");

    const result = await applySourceUpdate(fs, DIR, sourceTip, logger);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("SYNC_DIVERGED");
    expect(result.error.statusCode).toBe(409);
    expect(result.error.message).toContain("left untouched");
    // Nothing was rewound or deleted.
    expect(await git.resolveRef({ fs: gfs, dir: DIR, ref: "main" })).toBe(nativeTip);
  });

  it("fails with SYNC_DIVERGED for unrelated history (force-push rewrite) without touching main", async () => {
    const { fs, gfs } = await initRepo();
    const nativeTip = await commitFiles(gfs, { "file.txt": "base\n" }, "base");

    // Synthesize an orphan commit with no common ancestor — what the source
    // looks like after a history rewrite / grafted shallow fetch.
    const gitdir = `${DIR}/.git`;
    const blob = await blobObject(new TextEncoder().encode("rewritten\n"));
    const tree = await treeObject([{ mode: "100644", name: "other.txt", oid: blob.oid }]);
    const orphan = await commitObject({
      tree: tree.oid,
      parents: [],
      message: "rewritten root",
      timestamp: 1_700_000_100,
    });
    for (const o of [blob, tree, orphan]) {
      await placeLooseObject(gfs as unknown as FsLike, gitdir, o.oid, o.bytes);
    }

    const result = await applySourceUpdate(fs, DIR, orphan.oid, logger);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("SYNC_DIVERGED");
    expect(await git.resolveRef({ fs: gfs, dir: DIR, ref: "main" })).toBe(nativeTip);
  });
});
