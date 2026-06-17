import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { commitObject } from "../src/storage/git-objects";
import { extractTreeObjects, parseStagedTree } from "../src/storage/git-ops";
import { MemoryFS } from "../src/storage/memory-fs";
import { packObjects, placeLooseObject, unpackObjects } from "../src/storage/object-loader";

const author = { name: "Stratum", email: "system@usestratum.dev" };

describe("parseStagedTree validation", () => {
  const valid = (() => {
    const v = new Uint8Array(40 + packObjects([]).length);
    v.set(new TextEncoder().encode("a".repeat(40)));
    v.set(packObjects([]), 40);
    return v;
  })();

  it("parses a well-formed staged-tree value", () => {
    const out = parseStagedTree(valid);
    expect(out.treeOid).toBe("a".repeat(40));
    expect(out.objects).toEqual([]);
  });

  it("fails fast on a truncated header", () => {
    expect(() => parseStagedTree(new Uint8Array(10))).toThrow(/truncated header/i);
  });

  it("fails fast on a malformed tree oid", () => {
    const bad = new Uint8Array(valid);
    bad.set(new TextEncoder().encode("ZZ"), 0); // non-hex oid bytes
    expect(() => parseStagedTree(bad)).toThrow(/malformed tree oid/i);
  });
});

// Task 3+5 core: extract a workspace tip TREE's objects, round-trip through the
// R2 pack format, then merge it onto a divergent project head via a SYNTHETIC
// commit (tree = tip tree, parent = base). Proves the squash-style 3-way merge
// the production R2 path uses, end to end, without Artifacts.
describe("R2 staged-tree synthetic-commit merge (Task 3+5)", () => {
  it("merges a workspace tip tree onto a divergent head with the correct 3-way result", async () => {
    const fs = new MemoryFS().toNodeFS() as unknown as Parameters<typeof git.init>[0]["fs"];
    const dir = "/proj";
    const gitdir = `${dir}/.git`;
    await git.init({ fs, dir, defaultBranch: "main" });

    const write = async (path: string, content: string) => {
      await (
        fs as never as { promises: { writeFile(p: string, d: string): Promise<void> } }
      ).promises.writeFile(`${dir}/${path}`, content);
      await git.add({ fs, dir, filepath: path });
    };

    // base: README
    await write("README.md", "base\n");
    const base = await git.commit({ fs, dir, message: "base", author });

    // project head diverges: base + a.txt
    await write("a.txt", "a\n");
    await git.commit({ fs, dir, message: "add a", author }); // main = head

    // workspace tip diverges from base: base + b.txt
    await git.branch({ fs, dir, ref: "ws", object: base });
    await git.checkout({ fs, dir, ref: "ws" });
    await write("b.txt", "b\n");
    const wsTip = await git.commit({ fs, dir, message: "add b", author });
    await git.checkout({ fs, dir, ref: "main" });

    const wsTreeOid = (await git.readCommit({ fs, dir, oid: wsTip })).commit.tree;

    // Extract the tip tree's objects and round-trip through the R2 pack format.
    const extracted = await extractTreeObjects(fs as never, dir, wsTreeOid);
    expect(extracted.length).toBeGreaterThanOrEqual(3); // tree + README + b.txt
    const roundTripped = unpackObjects(packObjects(extracted));

    // Simulate the merge authority: place the staged objects, synthesize a commit
    // (tree = tip tree, parent = base), and 3-way merge it onto the project head.
    for (const o of roundTripped) await placeLooseObject(fs as never, gitdir, o.oid, o.bytes);
    const synth = await commitObject({
      tree: wsTreeOid,
      parents: [base],
      message: "synthetic ws commit",
      timestamp: 1700000000,
    });
    await placeLooseObject(fs as never, gitdir, synth.oid, synth.bytes);

    const merged = await git.merge({ fs, dir, ours: "main", theirs: synth.oid, author });
    expect(merged.oid).toBeDefined();
    await git.checkout({ fs, dir, ref: "main" });

    const files = await git.listFiles({ fs, dir, ref: "main" });
    expect(files.sort()).toEqual(["README.md", "a.txt", "b.txt"]);
  });
});
