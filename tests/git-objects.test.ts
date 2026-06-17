import { describe, expect, it } from "vitest";
import { blobObject, commitObject, hashObject, treeObject } from "../src/storage/git-objects";

describe("git-objects (real git SHA-1 oids)", () => {
  it("computes git's canonical empty-blob oid", async () => {
    const { oid } = await blobObject(new Uint8Array(0));
    expect(oid).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("computes git's canonical oid for blob 'hello\\n'", async () => {
    // `printf 'hello\n' | git hash-object --stdin` => ce013625030ba8dba906f756967f9e9ca394464a
    const { oid } = await blobObject(new TextEncoder().encode("hello\n"));
    expect(oid).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("is content-addressed and stable", async () => {
    const a = await blobObject(new TextEncoder().encode("x"));
    const b = await blobObject(new TextEncoder().encode("x"));
    const c = await blobObject(new TextEncoder().encode("y"));
    expect(a.oid).toBe(b.oid);
    expect(a.oid).not.toBe(c.oid);
  });

  it("encodes a tree whose oid is sorted-order independent of input order", async () => {
    const blob = await blobObject(new TextEncoder().encode("data"));
    const t1 = await treeObject([
      { mode: "100644", name: "a.txt", oid: blob.oid },
      { mode: "100644", name: "b.txt", oid: blob.oid },
    ]);
    const t2 = await treeObject([
      { mode: "100644", name: "b.txt", oid: blob.oid },
      { mode: "100644", name: "a.txt", oid: blob.oid },
    ]);
    expect(t1.oid).toBe(t2.oid);
    expect(t1.oid).toMatch(/^[0-9a-f]{40}$/);
  });

  it("builds a commit object referencing tree + parent deterministically", async () => {
    const tree = await treeObject([]);
    const c1 = await commitObject({
      tree: tree.oid,
      parents: [],
      message: "init",
      timestamp: 1700000000,
    });
    const c2 = await commitObject({
      tree: tree.oid,
      parents: [],
      message: "init",
      timestamp: 1700000000,
    });
    expect(c1.oid).toBe(c2.oid); // deterministic given fixed timestamp
    expect(c1.oid).toMatch(/^[0-9a-f]{40}$/);
    const withParent = await commitObject({
      tree: tree.oid,
      parents: [c1.oid],
      message: "init",
      timestamp: 1700000000,
    });
    expect(withParent.oid).not.toBe(c1.oid);
  });

  it("hashObject prefixes the loose-object header", async () => {
    const { bytes } = await hashObject("blob", new TextEncoder().encode("hi"));
    expect(new TextDecoder().decode(bytes.slice(0, 7))).toBe("blob 2\0");
  });

  it("rejects a malformed entry oid instead of silently corrupting the tree", () => {
    expect(() => treeObject([{ mode: "100644", name: "f", oid: "not-a-valid-oid" }])).toThrow(
      /invalid git oid/i,
    );
  });
});
