import git from "isomorphic-git";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blobObject, commitObject, treeObject } from "../src/storage/git-objects";
import { type NodeFS, squashMerge } from "../src/storage/git-ops";
import { MemoryFS } from "../src/storage/memory-fs";
import { type FsLike, placeLooseObject } from "../src/storage/object-loader";
import type { Logger } from "../src/utils/logger";

const enc = (s: string) => new TextEncoder().encode(s);
const author = { name: "Stratum", email: "system@usestratum.dev" };

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
} as unknown as Logger;

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Encode one git pkt-line (4-hex-digit length prefix covering itself). */
function pkt(payload: string | Uint8Array): Uint8Array {
  const bytes = typeof payload === "string" ? enc(payload) : payload;
  const len = (bytes.length + 4).toString(16).padStart(4, "0");
  return concat(enc(len), bytes);
}

const FLUSH = enc("0000");

/**
 * Minimal git smart-HTTP receive-pack server: advertises `main` at `mainOid`
 * and accepts any push with report-status over side-band-64k. Just enough for
 * isomorphic-git's `git.push` to complete against a stubbed `fetch`.
 */
function stubReceivePackServer(mainOid: string) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/info/refs?service=git-receive-pack")) {
      const body = concat(
        pkt("# service=git-receive-pack\n"),
        FLUSH,
        pkt(`${mainOid} refs/heads/main\0report-status side-band-64k\n`),
        FLUSH,
      );
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/x-git-receive-pack-advertisement" },
      });
    }
    if (url.endsWith("/git-receive-pack")) {
      const report = concat(pkt("unpack ok\n"), pkt("ok refs/heads/main\n"), FLUSH);
      const channel1 = new Uint8Array(1 + report.length);
      // The advertisement above offers side-band-64k, so the client negotiates
      // it and demultiplexes the response. The report has to be wrapped in
      // channel 1 or the client never sees it and the push hangs.
      channel1[0] = 1;
      channel1.set(report, 1);
      const body = concat(pkt(channel1), FLUSH);
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/x-git-receive-pack-result" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("squashMerge preserves file modes and symlinks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carries exec bits, symlink changes, and additions into the squash commit", async () => {
    const raw = new MemoryFS();
    const fs = raw.toNodeFS() as unknown as NodeFS;
    const gitfs = fs as unknown as Parameters<typeof git.init>[0]["fs"];
    const dir = "/";
    const gitdir = "/.git";
    await git.init({ fs: gitfs, dir, defaultBranch: "main" });

    // Base tree: plain file, non-exec script, symlink -> file.txt, and a file
    // the workspace deletes.
    const fileBlob = await blobObject(enc("base\n"));
    const scriptBlob = await blobObject(enc("#!/bin/sh\nexit 0\n"));
    const linkToFile = await blobObject(enc("file.txt"));
    const goneBlob = await blobObject(enc("bye\n"));
    const baseTree = await treeObject([
      { mode: "100644", name: "file.txt", oid: fileBlob.oid },
      { mode: "100644", name: "script.sh", oid: scriptBlob.oid },
      { mode: "120000", name: "link", oid: linkToFile.oid },
      { mode: "100644", name: "gone.txt", oid: goneBlob.oid },
    ]);
    const base = await commitObject({
      tree: baseTree.oid,
      parents: [],
      message: "base",
      timestamp: 1700000000,
    });

    // Workspace tree: script.sh becomes executable (same blob — a mode-only
    // change), the symlink is retargeted, a new symlink appears, gone.txt is
    // deleted, file.txt is untouched.
    const linkToScript = await blobObject(enc("script.sh"));
    const wsTree = await treeObject([
      { mode: "100644", name: "file.txt", oid: fileBlob.oid },
      { mode: "100755", name: "script.sh", oid: scriptBlob.oid },
      { mode: "120000", name: "link", oid: linkToScript.oid },
      { mode: "120000", name: "newlink", oid: linkToFile.oid },
    ]);
    const ws = await commitObject({
      tree: wsTree.oid,
      parents: [base.oid],
      message: "workspace",
      timestamp: 1700000001,
    });

    for (const o of [fileBlob, scriptBlob, linkToFile, goneBlob, baseTree, base]) {
      await placeLooseObject(fs as FsLike, gitdir, o.oid, o.bytes);
    }
    for (const o of [linkToScript, wsTree, ws]) {
      await placeLooseObject(fs as FsLike, gitdir, o.oid, o.bytes);
    }
    await git.writeRef({ fs: gitfs, dir, ref: "refs/heads/main", value: base.oid, force: true });
    await git.checkout({ fs: gitfs, dir, ref: "main" });

    stubReceivePackServer(base.oid);

    const result = await squashMerge(
      fs,
      dir,
      ws.oid,
      "https://example.test/git/project.git",
      "token",
      author,
      logger,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const commit = await git.readCommit({ fs: gitfs, dir, oid: result.data });
    expect(commit.commit.parent).toEqual([base.oid]);
    const tree = await git.readTree({ fs: gitfs, dir, oid: commit.commit.tree });
    const byPath = new Map(tree.tree.map((e) => [e.path, e]));

    // Exec bit carried over even though the blob is unchanged.
    expect(byPath.get("script.sh")?.mode).toBe("100755");
    expect(byPath.get("script.sh")?.oid).toBe(scriptBlob.oid);
    // Retargeted symlink stays a symlink with the new target.
    expect(byPath.get("link")?.mode).toBe("120000");
    expect(byPath.get("link")?.oid).toBe(linkToScript.oid);
    // New symlink created as a symlink.
    expect(byPath.get("newlink")?.mode).toBe("120000");
    expect(byPath.get("newlink")?.oid).toBe(linkToFile.oid);
    // Untouched + deleted files behave as before.
    expect(byPath.get("file.txt")?.mode).toBe("100644");
    expect(byPath.get("gone.txt")).toBeUndefined();
    // The squash tree equals the workspace tree exactly — full fidelity.
    expect(commit.commit.tree).toBe(wsTree.oid);

    // The workdir mirrors the commit.
    const linkTarget = await raw.promises.readlink("/link");
    expect(linkTarget.success && linkTarget.data === "script.sh").toBe(true);
    const scriptStat = await raw.promises.lstat("/script.sh");
    expect(scriptStat.success && scriptStat.data.mode === 0o100755).toBe(true);
  });

  // Both directions of a path-shape change. Unlinking the target path alone
  // cannot fix either: a symlink ANCESTOR redirects the write somewhere else
  // entirely, and MemoryFS's unlink succeeds on a directory without removing
  // its children, so they outlive the directory they belonged to.
  it("replaces a directory with a symlink without leaving its children behind", async () => {
    const raw = new MemoryFS();
    const fs = raw.toNodeFS() as unknown as NodeFS;
    const gitfs = fs as unknown as Parameters<typeof git.init>[0]["fs"];
    const dir = "/";
    const gitdir = "/.git";
    await git.init({ fs: gitfs, dir, defaultBranch: "main" });

    // Base: lib/ is a real directory holding one file.
    const childBlob = await blobObject(enc("child\n"));
    const libTree = await treeObject([{ mode: "100644", name: "a.ts", oid: childBlob.oid }]);
    const baseTree = await treeObject([{ mode: "40000", name: "lib", oid: libTree.oid }]);
    const base = await commitObject({
      tree: baseTree.oid,
      parents: [],
      message: "base",
      timestamp: 1700000000,
    });

    // Workspace: lib is a symlink instead.
    const linkBlob = await blobObject(enc("vendor"));
    const wsTree = await treeObject([{ mode: "120000", name: "lib", oid: linkBlob.oid }]);
    const ws = await commitObject({
      tree: wsTree.oid,
      parents: [base.oid],
      message: "workspace",
      timestamp: 1700000001,
    });

    for (const o of [childBlob, libTree, baseTree, base, linkBlob, wsTree, ws]) {
      await placeLooseObject(fs as FsLike, gitdir, o.oid, o.bytes);
    }
    await git.writeRef({ fs: gitfs, dir, ref: "refs/heads/main", value: base.oid, force: true });
    await git.checkout({ fs: gitfs, dir, ref: "main" });

    stubReceivePackServer(base.oid);
    const result = await squashMerge(
      fs,
      dir,
      ws.oid,
      "https://example.test/git/project.git",
      "token",
      author,
      logger,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const commit = await git.readCommit({ fs: gitfs, dir, oid: result.data });
    expect(commit.commit.tree).toBe(wsTree.oid);
    // The orphaned child must not survive underneath the new symlink.
    const orphan = await raw.promises.readFile("/lib/a.ts");
    expect(orphan.success).toBe(false);
  });

  it("appends the trailers it is given to the squash commit's message", async () => {
    const raw = new MemoryFS();
    const fs = raw.toNodeFS() as unknown as NodeFS;
    const gitfs = fs as unknown as Parameters<typeof git.init>[0]["fs"];
    const dir = "/";
    const gitdir = "/.git";
    await git.init({ fs: gitfs, dir, defaultBranch: "main" });

    const before = await blobObject(enc("before\n"));
    const baseTree = await treeObject([{ mode: "100644", name: "a.txt", oid: before.oid }]);
    const base = await commitObject({
      tree: baseTree.oid,
      parents: [],
      message: "base",
      timestamp: 1700000000,
    });
    const after = await blobObject(enc("after\n"));
    const wsTree = await treeObject([{ mode: "100644", name: "a.txt", oid: after.oid }]);
    const ws = await commitObject({
      tree: wsTree.oid,
      parents: [base.oid],
      message: "workspace",
      timestamp: 1700000001,
    });
    for (const o of [before, baseTree, base, after, wsTree, ws]) {
      await placeLooseObject(fs as FsLike, gitdir, o.oid, o.bytes);
    }
    await git.writeRef({ fs: gitfs, dir, ref: "refs/heads/main", value: base.oid, force: true });
    await git.checkout({ fs: gitfs, dir, ref: "main" });

    stubReceivePackServer(base.oid);
    const result = await squashMerge(
      fs,
      dir,
      ws.oid,
      "https://example.test/git/project.git",
      "token",
      author,
      logger,
      "main",
      ["Co-authored-by: Casey Contributor <casey@example.com>"],
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    // A blank line, then the trailers: the shape git and GitHub read as
    // trailers rather than as more subject.
    const commit = await git.readCommit({ fs: gitfs, dir, oid: result.data });
    expect(commit.commit.message.trimEnd()).toBe(
      "Squash merge workspace (1 file changed)\n\nCo-authored-by: Casey Contributor <casey@example.com>",
    );
  });

  it("writes a file under a path whose old shape was a symlink, not through it", async () => {
    const raw = new MemoryFS();
    const fs = raw.toNodeFS() as unknown as NodeFS;
    const gitfs = fs as unknown as Parameters<typeof git.init>[0]["fs"];
    const dir = "/";
    const gitdir = "/.git";
    await git.init({ fs: gitfs, dir, defaultBranch: "main" });

    // Base: lib is a symlink to the real/ directory.
    const decoyBlob = await blobObject(enc("decoy\n"));
    const realTree = await treeObject([{ mode: "100644", name: "keep.ts", oid: decoyBlob.oid }]);
    const libLink = await blobObject(enc("real"));
    const baseTree = await treeObject([
      { mode: "120000", name: "lib", oid: libLink.oid },
      { mode: "40000", name: "real", oid: realTree.oid },
    ]);
    const base = await commitObject({
      tree: baseTree.oid,
      parents: [],
      message: "base",
      timestamp: 1700000000,
    });

    // Workspace: lib becomes a real directory containing file.ts.
    const fileBlob = await blobObject(enc("content\n"));
    const newLibTree = await treeObject([{ mode: "100644", name: "file.ts", oid: fileBlob.oid }]);
    const wsTree = await treeObject([
      { mode: "40000", name: "lib", oid: newLibTree.oid },
      { mode: "40000", name: "real", oid: realTree.oid },
    ]);
    const ws = await commitObject({
      tree: wsTree.oid,
      parents: [base.oid],
      message: "workspace",
      timestamp: 1700000001,
    });

    for (const o of [
      decoyBlob,
      realTree,
      libLink,
      baseTree,
      base,
      fileBlob,
      newLibTree,
      wsTree,
      ws,
    ]) {
      await placeLooseObject(fs as FsLike, gitdir, o.oid, o.bytes);
    }
    await git.writeRef({ fs: gitfs, dir, ref: "refs/heads/main", value: base.oid, force: true });
    await git.checkout({ fs: gitfs, dir, ref: "main" });

    stubReceivePackServer(base.oid);
    const result = await squashMerge(
      fs,
      dir,
      ws.oid,
      "https://example.test/git/project.git",
      "token",
      author,
      logger,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const commit = await git.readCommit({ fs: gitfs, dir, oid: result.data });
    expect(commit.commit.tree).toBe(wsTree.oid);
    // The write must not have followed the stale link into real/.
    const leaked = await raw.promises.readFile("/real/file.ts");
    expect(leaked.success).toBe(false);
  });

  it("replaces a file ancestor so a nested descendant can be written", async () => {
    const raw = new MemoryFS();
    const fs = raw.toNodeFS() as unknown as NodeFS;
    const gitfs = fs as unknown as Parameters<typeof git.init>[0]["fs"];
    const dir = "/";
    const gitdir = "/.git";
    await git.init({ fs: gitfs, dir, defaultBranch: "main" });

    // Base: `lib` is a plain FILE, not a symlink. It blocks a nested write with
    // ENOTDIR exactly as a symlink would, but readlink cannot detect it.
    const libFileBlob = await blobObject(enc("i am a file\n"));
    const baseTree = await treeObject([{ mode: "100644", name: "lib", oid: libFileBlob.oid }]);
    const base = await commitObject({
      tree: baseTree.oid,
      parents: [],
      message: "base",
      timestamp: 1700000000,
    });

    const nestedBlob = await blobObject(enc("nested\n"));
    const libDirTree = await treeObject([{ mode: "100644", name: "file.ts", oid: nestedBlob.oid }]);
    const wsTree = await treeObject([{ mode: "40000", name: "lib", oid: libDirTree.oid }]);
    const ws = await commitObject({
      tree: wsTree.oid,
      parents: [base.oid],
      message: "workspace",
      timestamp: 1700000001,
    });

    for (const o of [libFileBlob, baseTree, base, nestedBlob, libDirTree, wsTree, ws]) {
      await placeLooseObject(fs as FsLike, gitdir, o.oid, o.bytes);
    }
    await git.writeRef({ fs: gitfs, dir, ref: "refs/heads/main", value: base.oid, force: true });
    await git.checkout({ fs: gitfs, dir, ref: "main" });

    stubReceivePackServer(base.oid);
    const result = await squashMerge(
      fs,
      dir,
      ws.oid,
      "https://example.test/git/project.git",
      "token",
      author,
      logger,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const commit = await git.readCommit({ fs: gitfs, dir, oid: result.data });
    expect(commit.commit.tree).toBe(wsTree.oid);
  });

  it("does not delete through a replacement symlink when removing an obsolete path", async () => {
    const raw = new MemoryFS();
    const fs = raw.toNodeFS() as unknown as NodeFS;
    const gitfs = fs as unknown as Parameters<typeof git.init>[0]["fs"];
    const dir = "/";
    const gitdir = "/.git";
    await git.init({ fs: gitfs, dir, defaultBranch: "main" });

    // Base: lib/ is a directory holding old.ts. The target dir already contains
    // a file of the SAME NAME, which is what an unlink through the replacement
    // symlink would destroy.
    const oldBlob = await blobObject(enc("old\n"));
    const victimBlob = await blobObject(enc("do not delete\n"));
    const libTree = await treeObject([{ mode: "100644", name: "old.ts", oid: oldBlob.oid }]);
    const vendorTree = await treeObject([{ mode: "100644", name: "old.ts", oid: victimBlob.oid }]);
    const baseTree = await treeObject([
      { mode: "40000", name: "lib", oid: libTree.oid },
      { mode: "40000", name: "vendor", oid: vendorTree.oid },
    ]);
    const base = await commitObject({
      tree: baseTree.oid,
      parents: [],
      message: "base",
      timestamp: 1700000000,
    });

    // Workspace: lib becomes a symlink to vendor; lib/old.ts is gone.
    const linkBlob = await blobObject(enc("vendor"));
    const wsTree = await treeObject([
      { mode: "120000", name: "lib", oid: linkBlob.oid },
      { mode: "40000", name: "vendor", oid: vendorTree.oid },
    ]);
    const ws = await commitObject({
      tree: wsTree.oid,
      parents: [base.oid],
      message: "workspace",
      timestamp: 1700000001,
    });

    for (const o of [
      oldBlob,
      victimBlob,
      libTree,
      vendorTree,
      baseTree,
      base,
      linkBlob,
      wsTree,
      ws,
    ]) {
      await placeLooseObject(fs as FsLike, gitdir, o.oid, o.bytes);
    }
    await git.writeRef({ fs: gitfs, dir, ref: "refs/heads/main", value: base.oid, force: true });
    await git.checkout({ fs: gitfs, dir, ref: "main" });

    stubReceivePackServer(base.oid);
    const result = await squashMerge(
      fs,
      dir,
      ws.oid,
      "https://example.test/git/project.git",
      "token",
      author,
      logger,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const commit = await git.readCommit({ fs: gitfs, dir, oid: result.data });
    expect(commit.commit.tree).toBe(wsTree.oid);
    // The same-named file inside the link's target must survive untouched.
    const victim = await raw.promises.readFile("/vendor/old.ts", "utf8");
    expect(victim.success && victim.data === "do not delete\n").toBe(true);
  });

  // squashMerge takes the NodeFS interface, and node's readdir FOLLOWS a
  // directory symlink where MemoryFS's reports ENOTDIR. This wrapper gives the
  // node semantics so the subtree walk is exercised the way it would behave on
  // a real filesystem: without the lstat gate, removeSubtree recurses into the
  // link's target and deletes files that were never part of the merge.
  function withNativeReaddir(raw: MemoryFS, fs: NodeFS): NodeFS {
    // Resolve symlinks along `count` leading components, node-style. readdir
    // follows the whole path including a trailing link; unlink resolves the
    // ancestors but removes the link itself rather than its target.
    const resolve = async (path: string, keepLast: boolean): Promise<string> => {
      const parts = path.split("/").filter(Boolean);
      const limit = keepLast ? parts.length - 1 : parts.length;
      let cur = "";
      for (let i = 0; i < parts.length; i++) {
        const next = `${cur}/${parts[i]}`;
        if (i >= limit) {
          cur = next;
          continue;
        }
        const link = await raw.readlink(next);
        cur = link.success ? `${cur}/${link.data}` : next;
      }
      return cur || "/";
    };
    return {
      promises: {
        ...fs.promises,
        readdir: async (path: string) => fs.promises.readdir(await resolve(path, false)),
        unlink: async (path: string) => fs.promises.unlink(await resolve(path, true)),
      },
    } as NodeFS;
  }

  it("does not empty a symlink's target when replacing a directory", async () => {
    const raw = new MemoryFS();
    const base = raw.toNodeFS() as unknown as NodeFS;
    const fs = withNativeReaddir(raw, base);
    const gitfs = base as unknown as Parameters<typeof git.init>[0]["fs"];
    const dir = "/";
    const gitdir = "/.git";
    await git.init({ fs: gitfs, dir, defaultBranch: "main" });

    // Base: `lib` is a symlink to vendor/, and vendor/ holds a file that must
    // survive. The workspace turns `lib` into a real directory.
    const keepBlob = await blobObject(enc("must survive\n"));
    const vendorTree = await treeObject([{ mode: "100644", name: "keep.ts", oid: keepBlob.oid }]);
    const linkBlob = await blobObject(enc("vendor"));
    const baseTree = await treeObject([
      { mode: "120000", name: "lib", oid: linkBlob.oid },
      { mode: "40000", name: "vendor", oid: vendorTree.oid },
    ]);
    const baseCommit = await commitObject({
      tree: baseTree.oid,
      parents: [],
      message: "base",
      timestamp: 1700000000,
    });

    // `lib` itself becomes a regular file, so clearConflictingPathShape calls
    // removeSubtree directly ON the symlink -- the only path where a following
    // readdir would descend into vendor/.
    const newBlob = await blobObject(enc("now a file\n"));
    const wsTree = await treeObject([
      { mode: "100644", name: "lib", oid: newBlob.oid },
      { mode: "40000", name: "vendor", oid: vendorTree.oid },
    ]);
    const ws = await commitObject({
      tree: wsTree.oid,
      parents: [baseCommit.oid],
      message: "workspace",
      timestamp: 1700000001,
    });

    for (const o of [keepBlob, vendorTree, linkBlob, baseTree, baseCommit, newBlob, wsTree, ws]) {
      await placeLooseObject(base as FsLike, gitdir, o.oid, o.bytes);
    }
    await git.writeRef({
      fs: gitfs,
      dir,
      ref: "refs/heads/main",
      value: baseCommit.oid,
      force: true,
    });
    await git.checkout({ fs: gitfs, dir, ref: "main" });

    stubReceivePackServer(baseCommit.oid);
    const result = await squashMerge(
      fs,
      dir,
      ws.oid,
      "https://example.test/git/project.git",
      "token",
      author,
      logger,
    );
    expect(result.success).toBe(true);
    // The link target's contents must be untouched.
    const survivor = await raw.readFile("/vendor/keep.ts", "utf8");
    expect(survivor.success && survivor.data === "must survive\n").toBe(true);
  });

  it("returns the current head untouched when nothing changed", async () => {
    const raw = new MemoryFS();
    const fs = raw.toNodeFS() as unknown as NodeFS;
    const gitfs = fs as unknown as Parameters<typeof git.init>[0]["fs"];
    const dir = "/";
    const gitdir = "/.git";
    await git.init({ fs: gitfs, dir, defaultBranch: "main" });

    const fileBlob = await blobObject(enc("same\n"));
    const tree = await treeObject([{ mode: "100644", name: "file.txt", oid: fileBlob.oid }]);
    const base = await commitObject({
      tree: tree.oid,
      parents: [],
      message: "base",
      timestamp: 1700000000,
    });
    const ws = await commitObject({
      tree: tree.oid,
      parents: [base.oid],
      message: "no-op",
      timestamp: 1700000001,
    });
    for (const o of [fileBlob, tree, base, ws]) {
      await placeLooseObject(fs as FsLike, gitdir, o.oid, o.bytes);
    }
    await git.writeRef({ fs: gitfs, dir, ref: "refs/heads/main", value: base.oid, force: true });
    await git.checkout({ fs: gitfs, dir, ref: "main" });

    const fetchSpy = stubReceivePackServer(base.oid);

    const result = await squashMerge(
      fs,
      dir,
      ws.oid,
      "https://example.test/git/project.git",
      "token",
      author,
      logger,
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(base.oid);
    // No changes -> no push.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed on a gitlink (submodule) entry instead of silently dropping it", async () => {
    const raw = new MemoryFS();
    const fs = raw.toNodeFS() as unknown as NodeFS;
    const gitfs = fs as unknown as Parameters<typeof git.init>[0]["fs"];
    const dir = "/";
    const gitdir = "/.git";
    await git.init({ fs: gitfs, dir, defaultBranch: "main" });

    const fileBlob = await blobObject(enc("base\n"));
    const baseTree = await treeObject([{ mode: "100644", name: "file.txt", oid: fileBlob.oid }]);
    const base = await commitObject({
      tree: baseTree.oid,
      parents: [],
      message: "base",
      timestamp: 1700000000,
    });
    // A gitlink (submodule reference): mode 160000, oid is the submodule's
    // commit — never read as a blob, so it doesn't need to exist as an object.
    // It lives inside a real `vendor` subtree because a tree entry name cannot
    // contain a slash; a flat "vendor/lib" entry is a tree git cannot produce,
    // so the walker would not be exercised the way it is in practice.
    const vendorTree = await treeObject([{ mode: "160000", name: "lib", oid: "a".repeat(40) }]);
    const wsTree = await treeObject([
      { mode: "100644", name: "file.txt", oid: fileBlob.oid },
      { mode: "40000", name: "vendor", oid: vendorTree.oid },
    ]);
    const ws = await commitObject({
      tree: wsTree.oid,
      parents: [base.oid],
      message: "add submodule",
      timestamp: 1700000001,
    });
    for (const o of [fileBlob, baseTree, base, vendorTree, wsTree, ws]) {
      await placeLooseObject(fs as FsLike, gitdir, o.oid, o.bytes);
    }
    await git.writeRef({ fs: gitfs, dir, ref: "refs/heads/main", value: base.oid, force: true });
    await git.checkout({ fs: gitfs, dir, ref: "main" });

    const fetchSpy = stubReceivePackServer(base.oid);

    const result = await squashMerge(
      fs,
      dir,
      ws.oid,
      "https://example.test/git/project.git",
      "token",
      author,
      logger,
    );
    expect(result.success).toBe(false);
    // Fails before ever pushing — the unsupported gitlink is never silently merged.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
