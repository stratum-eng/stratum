import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { blobObject, commitObject, treeObject } from "../src/storage/git-objects";
import { MemoryFS } from "../src/storage/memory-fs";
import { placeLooseObject } from "../src/storage/object-loader";

const enc = (s: string) => new TextEncoder().encode(s);
const author = { name: "Stratum", email: "system@usestratum.dev" };

// Task 1b gate: prove isomorphic-git git.merge can consume R2-staged objects
// (built by git-objects.ts, placed via the deflate/fanout loader) and 3-way merge.
describe("git.merge over R2-staged objects (Task 1b gate)", () => {
  it("loads staged objects and merges two disjoint changes onto a shared base", async () => {
    const fs = new MemoryFS().toNodeFS() as unknown as Parameters<typeof git.init>[0]["fs"];
    const dir = "/repo";
    const gitdir = `${dir}/.git`;
    await git.init({ fs, dir, defaultBranch: "main" });

    const place = async (...objs: { oid: string; bytes: Uint8Array }[]) => {
      for (const o of objs) await placeLooseObject(fs as never, gitdir, o.oid, o.bytes);
    };

    // Base commit B: { file.txt }
    const baseBlob = await blobObject(enc("base\n"));
    const baseTree = await treeObject([{ mode: "100644", name: "file.txt", oid: baseBlob.oid }]);
    const base = await commitObject({
      tree: baseTree.oid,
      parents: [],
      message: "base",
      timestamp: 1700000000,
    });
    await place(baseBlob, baseTree, base);
    await git.writeRef({ fs, dir, ref: "refs/heads/main", value: base.oid, force: true });
    await git.checkout({ fs, dir, ref: "main" });

    // Change 1 (from B): add a.txt
    const aBlob = await blobObject(enc("a\n"));
    const t1 = await treeObject([
      { mode: "100644", name: "a.txt", oid: aBlob.oid },
      { mode: "100644", name: "file.txt", oid: baseBlob.oid },
    ]);
    const c1 = await commitObject({
      tree: t1.oid,
      parents: [base.oid],
      message: "c1",
      timestamp: 1700000001,
    });
    await place(aBlob, t1, c1);

    // Change 2 (from B): add b.txt
    const bBlob = await blobObject(enc("b\n"));
    const t2 = await treeObject([
      { mode: "100644", name: "b.txt", oid: bBlob.oid },
      { mode: "100644", name: "file.txt", oid: baseBlob.oid },
    ]);
    const c2 = await commitObject({
      tree: t2.oid,
      parents: [base.oid],
      message: "c2",
      timestamp: 1700000002,
    });
    await place(bBlob, t2, c2);

    // isomorphic-git must be able to read a staged object back.
    const readBack = await git.readCommit({ fs, dir, oid: c1.oid });
    expect(readBack.commit.tree).toBe(t1.oid);

    // Merge c1 (fast-forward), then 3-way merge c2 onto it.
    await git.merge({ fs, dir, ours: "main", theirs: c1.oid, author });
    await git.checkout({ fs, dir, ref: "main" });
    const merged = await git.merge({
      fs,
      dir,
      ours: "main",
      theirs: c2.oid,
      author,
      message: "merge c2",
    });
    expect(merged.oid).toBeDefined();
    await git.checkout({ fs, dir, ref: "main" });

    // The merged tree must contain all three files — no data lost.
    const files = await git.listFiles({ fs, dir, ref: "main" });
    expect(files.sort()).toEqual(["a.txt", "b.txt", "file.txt"]);
  });
});
