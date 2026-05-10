import { describe, expect, it } from "vitest";
import { buildFileTree } from "../src/ui/file-tree";

describe("buildFileTree", () => {
  it("returns empty array for empty input", () => {
    expect(buildFileTree([])).toEqual([]);
  });

  it("renders flat root-level files alphabetically", () => {
    const result = buildFileTree(["README.md", "index.ts", "biome.json"]);
    expect(result).toEqual([
      { type: "file", name: "biome.json", path: "biome.json" },
      { type: "file", name: "index.ts", path: "index.ts" },
      { type: "file", name: "README.md", path: "README.md" },
    ]);
  });

  it("sorts directories before files at the same level", () => {
    const result = buildFileTree(["README.md", "src/index.ts", "biome.json"]);
    const first = result[0];
    const second = result[1];
    const third = result[2];
    expect(first?.type).toBe("dir");
    expect(first?.name).toBe("src");
    expect(second?.type).toBe("file");
    expect(third?.type).toBe("file");
  });

  it("nests files under directories correctly", () => {
    const result = buildFileTree(["src/index.ts", "src/utils/helpers.ts"]);
    expect(result).toHaveLength(1);
    const src = result[0];
    expect(src?.type).toBe("dir");
    expect(src?.name).toBe("src");
    if (src?.type === "dir") {
      expect(src.children).toHaveLength(2);
      expect(src.children[0]).toMatchObject({ type: "dir", name: "utils" });
      expect(src.children[1]).toMatchObject({ type: "file", name: "index.ts" });
    }
  });

  it("builds deeply nested paths (4+ levels)", () => {
    const result = buildFileTree(["a/b/c/d/file.ts"]);
    const a = result[0];
    expect(a?.type).toBe("dir");
    expect(a?.name).toBe("a");
    if (a?.type === "dir") {
      const b = a.children[0];
      expect(b).toMatchObject({ type: "dir", name: "b" });
      if (b?.type === "dir") {
        const c = b.children[0];
        expect(c).toMatchObject({ type: "dir", name: "c" });
        if (c?.type === "dir") {
          const d = c.children[0];
          expect(d).toMatchObject({ type: "dir", name: "d" });
          if (d?.type === "dir") {
            expect(d.children[0]).toMatchObject({
              type: "file",
              name: "file.ts",
              path: "a/b/c/d/file.ts",
            });
          }
        }
      }
    }
  });

  it("handles a file and a directory with the same prefix", () => {
    const result = buildFileTree(["foo", "foo/bar.ts"]);
    const file = result.find((n) => n.type === "file" && n.name === "foo");
    const dir = result.find((n) => n.type === "dir" && n.name === "foo");
    expect(file).toBeDefined();
    expect(dir).toBeDefined();
  });

  it("sorts case-insensitively (B.ts after a.ts)", () => {
    const result = buildFileTree(["B.ts", "a.ts"]);
    expect(result[0]?.name).toBe("a.ts");
    expect(result[1]?.name).toBe("B.ts");
  });

  it("sets path on dir node to full relative directory path", () => {
    const result = buildFileTree(["src/utils/helpers.ts"]);
    expect(result[0]).toMatchObject({ type: "dir", name: "src", path: "src" });
    const src = result[0];
    if (src?.type === "dir") {
      expect(src.children[0]).toMatchObject({ type: "dir", name: "utils", path: "src/utils" });
    }
  });

  it("deduplicates directory entries when multiple files share a parent", () => {
    const result = buildFileTree(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(result).toHaveLength(1);
    const src = result[0];
    expect(src?.type).toBe("dir");
    if (src?.type === "dir") {
      expect(src.children).toHaveLength(3);
    }
  });
});
