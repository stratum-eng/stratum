import git from "isomorphic-git";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotRepo, walkRepoObjects } from "../src/backup/repo-snapshot";
import {
  MAX_TAGS,
  type NodeFS,
  TAG_DETAIL_READ_TIMEOUT_MS,
  TAG_DETAIL_STORE_TIMEOUT_MS,
  type TagDetails,
  cloneRepo,
  collectRepoTags,
  listRepoTags,
  pushTags,
} from "../src/storage/git-ops";
import { MemoryFS } from "../src/storage/memory-fs";
import { placeLooseObject } from "../src/storage/object-loader";
import type { Env, ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";

// Partial isomorphic-git mock: `clone`, `fetch`, `getRemoteInfo`, and `push`
// are the only network-coupled calls the code under test makes; everything
// else (init, commit, tag, readObject, …) stays real so the tests exercise
// genuine git object stores in MemoryFS.
const { mockClone, mockFetch, mockGetRemoteInfo, mockPush, listTagsOverride } = vi.hoisted(() => ({
  mockClone: vi.fn(),
  mockFetch: vi.fn(),
  mockGetRemoteInfo: vi.fn(),
  mockPush: vi.fn(),
  // When set, replaces git.listTags for a single test (reset in beforeEach).
  listTagsOverride: { fn: null as null | ((args: unknown) => Promise<string[]>) },
}));

vi.mock("isomorphic-git", async (importActual) => {
  const actual = await importActual<typeof import("isomorphic-git")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      clone: (args: unknown) => mockClone(args),
      fetch: (args: unknown) => mockFetch(args),
      getRemoteInfo: (args: unknown) => mockGetRemoteInfo(args),
      push: (args: unknown) => mockPush(args),
      listTags: (args: unknown) =>
        listTagsOverride.fn
          ? listTagsOverride.fn(args)
          : actual.default.listTags(args as Parameters<typeof actual.default.listTags>[0]),
    },
  };
});

/** Shape a `getRemoteInfo` mock resolution for a set of tag names, mirroring
 * the real nesting getRemoteInfo builds: each ref is split on "/" and nested
 * a level per segment, so a hierarchical tag name (e.g. "release/1.0") lands
 * at `refs.tags.release["1.0"]`, not `refs.tags["release/1.0"]` — a flat mock
 * shape would hide exactly the bug this nesting causes (see git-ops.ts). */
function remoteInfoWithTags(tags: Record<string, string>) {
  const tree: Record<string, unknown> = {};
  for (const [name, oid] of Object.entries(tags)) {
    const parts = name.split("/");
    const last = parts.pop() as string;
    let node = tree;
    for (const part of parts) {
      node[part] = node[part] ?? {};
      node = node[part] as Record<string, unknown>;
    }
    node[last] = oid;
  }
  return { capabilities: [], refs: { tags: tree } };
}

/**
 * Recursively copies a git object and everything it reaches (commit parents,
 * trees, blobs, peeled tags) from one MemoryFS-backed repo into another,
 * using isomorphic-git's real object store — no synthetic data. Used to give
 * `mockFetch` genuine "only what was asked for" semantics in tests, so a
 * fetch that (incorrectly) asked for an unrelated branch's oid would actually
 * pull that branch's objects, and a correct per-tag fetch provably would not.
 */
async function copyReachableObjects(
  srcFs: NodeFS,
  srcDir: string,
  destFs: NodeFS,
  destDir: string,
  oid: string,
  visited: Set<string> = new Set(),
): Promise<void> {
  if (visited.has(oid)) return;
  visited.add(oid);
  const { type, object } = await git.readObject({ fs: srcFs, dir: srcDir, oid, format: "wrapped" });
  const gitdir = destDir.endsWith("/") ? `${destDir}.git` : `${destDir}/.git`;
  await placeLooseObject(
    destFs as unknown as Parameters<typeof placeLooseObject>[0],
    gitdir,
    oid,
    object as Uint8Array,
  );
  if (type === "commit") {
    const { commit } = await git.readCommit({ fs: srcFs, dir: srcDir, oid });
    await copyReachableObjects(srcFs, srcDir, destFs, destDir, commit.tree, visited);
    for (const parent of commit.parent) {
      await copyReachableObjects(srcFs, srcDir, destFs, destDir, parent, visited);
    }
  } else if (type === "tree") {
    const { tree } = await git.readTree({ fs: srcFs, dir: srcDir, oid });
    for (const entry of tree) {
      await copyReachableObjects(srcFs, srcDir, destFs, destDir, entry.oid, visited);
    }
  } else if (type === "tag") {
    const { tag } = await git.readTag({ fs: srcFs, dir: srcDir, oid });
    await copyReachableObjects(srcFs, srcDir, destFs, destDir, tag.object, visited);
  }
}

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const author = { name: "t", email: "t@x.com", timestamp: 1_700_000_000, timezoneOffset: 0 };
const tagger = { name: "tagger", email: "tag@x.com", timestamp: 1_700_000_100, timezoneOffset: 0 };
const MISSING_OID = "f".repeat(40);

async function buildRepo(
  dir: string,
  commits: Record<string, string>[],
  fs: NodeFS = new MemoryFS().toNodeFS() as unknown as NodeFS,
): Promise<{ fs: NodeFS; shas: string[] }> {
  await git.init({ fs, dir, defaultBranch: "main" });
  const shas: string[] = [];
  for (const files of commits) {
    for (const [path, content] of Object.entries(files)) {
      // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
      await (fs as any).promises.writeFile(`${dir}/${path}`, content);
      await git.add({ fs, dir, filepath: path });
    }
    shas.push(await git.commit({ fs, dir, message: "c", author }));
  }
  return { fs, shas };
}

beforeEach(() => {
  vi.clearAllMocks();
  listTagsOverride.fn = null;
  // Default: no tags advertised. Individual tests override with the tag set
  // they need before calling cloneRepo/listRepoTags.
  mockGetRemoteInfo.mockResolvedValue(remoteInfoWithTags({}));
});

describe("collectRepoTags", () => {
  it("lists lightweight and annotated tags, dereferencing annotated ones", async () => {
    const { fs, shas } = await buildRepo("/repo", [{ "a.txt": "one" }, { "b.txt": "two" }]);
    const [c1, c2] = shas as [string, string];
    await git.tag({ fs, dir: "/repo", ref: "lightweight", object: c2 });
    await git.annotatedTag({
      fs,
      dir: "/repo",
      ref: "ann",
      object: c1,
      message: "release one\n",
      tagger,
    });

    const tags = await collectRepoTags(fs, "/repo");
    expect(tags.map((t) => t.name)).toEqual(["ann", "lightweight"]); // sorted

    const ann = tags[0];
    expect(ann?.annotated).toBe(true);
    expect(ann?.targetSha).toBe(c1);
    expect(ann?.oid).not.toBe(c1); // the ref holds the tag object, not the commit
    expect(ann?.message).toBe("release one");
    expect(ann?.tagger).toBe("tagger <tag@x.com>");
    expect(ann?.timestamp).toBe(tagger.timestamp);
    expect(ann?.unresolvable).toBe(false);

    const lw = tags[1];
    expect(lw?.annotated).toBe(false);
    expect(lw?.oid).toBe(c2);
    expect(lw?.targetSha).toBe(c2);
    expect(lw?.message).toBeUndefined();
    expect(lw?.unresolvable).toBe(false);
  });

  it("returns an empty list for a repo without tags", async () => {
    const { fs } = await buildRepo("/repo", [{ "a.txt": "one" }]);
    expect(await collectRepoTags(fs, "/repo")).toEqual([]);
  });

  it("skips a listed tag whose ref cannot be resolved at all", async () => {
    const { fs } = await buildRepo("/repo", [{ "a.txt": "one" }]);
    // listTags names a tag that has no ref on disk (e.g. deleted between calls).
    listTagsOverride.fn = async () => ["phantom"];
    expect(await collectRepoTags(fs, "/repo")).toEqual([]);
  });

  it("marks a lightweight tag whose object is missing as unresolvable (shallow degrade)", async () => {
    const { fs } = await buildRepo("/repo", [{ "a.txt": "one" }]);
    await git.writeRef({
      fs,
      dir: "/repo",
      ref: "refs/tags/ghost",
      value: MISSING_OID,
      force: true,
    });

    const tags = await collectRepoTags(fs, "/repo");
    const ghost = tags.find((t) => t.name === "ghost");
    expect(ghost).toBeDefined();
    expect(ghost?.oid).toBe(MISSING_OID);
    expect(ghost?.unresolvable).toBe(true);
    expect(ghost?.targetSha).toBeNull(); // never learned the target
  });

  it("keeps an annotated tag's metadata when only its TARGET is missing", async () => {
    const { fs } = await buildRepo("/repo", [{ "a.txt": "one" }]);
    // A real tag object pointing at a commit that is not in the local store —
    // exactly what a shallow fetch window produces.
    const tagOid = await git.writeTag({
      fs,
      dir: "/repo",
      tag: {
        object: MISSING_OID,
        type: "commit",
        tag: "broken",
        tagger,
        message: "points outside the window\n",
      },
    });
    await git.writeRef({ fs, dir: "/repo", ref: "refs/tags/broken", value: tagOid, force: true });

    const tags = await collectRepoTags(fs, "/repo");
    const broken = tags.find((t) => t.name === "broken");
    expect(broken?.annotated).toBe(true);
    expect(broken?.message).toBe("points outside the window");
    expect(broken?.targetSha).toBe(MISSING_OID); // intended target is still reported
    expect(broken?.unresolvable).toBe(true);
  });

  it("peels a tag-of-tag chain down to the commit", async () => {
    const { fs, shas } = await buildRepo("/repo", [{ "a.txt": "one" }]);
    const c1 = shas[0] as string;
    const inner = await git.writeTag({
      fs,
      dir: "/repo",
      tag: { object: c1, type: "commit", tag: "inner", tagger, message: "inner\n" },
    });
    const outer = await git.writeTag({
      fs,
      dir: "/repo",
      tag: { object: inner, type: "tag", tag: "outer", tagger, message: "outer\n" },
    });
    await git.writeRef({ fs, dir: "/repo", ref: "refs/tags/outer", value: outer, force: true });

    const tags = await collectRepoTags(fs, "/repo");
    const entry = tags.find((t) => t.name === "outer");
    expect(entry?.annotated).toBe(true);
    expect(entry?.targetSha).toBe(c1);
    expect(entry?.message).toBe("outer"); // first tag object in the chain wins
    expect(entry?.unresolvable).toBe(false);
  });

  it("resolves a tag-of-tag chain longer than the old fixed hop cap", async () => {
    const { fs, shas } = await buildRepo("/repo", [{ "a.txt": "one" }]);
    const c1 = shas[0] as string;
    let current = c1;
    let currentType: "commit" | "tag" = "commit";
    // 11 tag objects deep — one more than the old fixed 10-hop limit.
    for (let i = 0; i < 11; i++) {
      current = await git.writeTag({
        fs,
        dir: "/repo",
        tag: { object: current, type: currentType, tag: `t${i}`, tagger, message: `t${i}\n` },
      });
      currentType = "tag";
    }
    await git.writeRef({ fs, dir: "/repo", ref: "refs/tags/deep", value: current, force: true });

    const tags = await collectRepoTags(fs, "/repo");
    const entry = tags.find((t) => t.name === "deep");
    expect(entry?.annotated).toBe(true);
    expect(entry?.targetSha).toBe(c1);
    expect(entry?.unresolvable).toBe(false);
  });

  it("marks a self-referential tag object unresolvable instead of looping forever", async () => {
    const { fs } = await buildRepo("/repo", [{ "a.txt": "one" }]);
    // A real tag-of-tag cycle can't exist through normal writes (an oid is a
    // hash of content that would have to embed that same oid). Simulate the
    // on-disk corruption the visited-oid guard defends against: place a loose
    // tag object, at an oid we choose, whose own `object` field is that same
    // oid — placeLooseObject bypasses hash verification, so this is a genuine
    // self-reference once read back.
    const selfOid = "c".repeat(40);
    const content = new TextEncoder().encode(
      `object ${selfOid}\ntype commit\ntag cycle\ntagger Test <test@x.com> 1700000000 +0000\n\nself-referential (corrupted fixture)\n`,
    );
    const header = new TextEncoder().encode(`tag ${content.length}\0`);
    const bytes = new Uint8Array(header.length + content.length);
    bytes.set(header, 0);
    bytes.set(content, header.length);
    await placeLooseObject(
      fs as unknown as Parameters<typeof placeLooseObject>[0],
      "/repo/.git",
      selfOid,
      bytes,
    );
    await git.writeRef({ fs, dir: "/repo", ref: "refs/tags/cycle", value: selfOid, force: true });

    const tags = await collectRepoTags(fs, "/repo");
    const entry = tags.find((t) => t.name === "cycle");
    expect(entry?.unresolvable).toBe(true);
  });
});

describe("cloneRepo includeTags", () => {
  it("enumerates tags via getRemoteInfo, then fetches each individually (shallow by default)", async () => {
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      await buildRepo(dir, [{ "a.txt": "one" }], fs);
    });
    mockGetRemoteInfo.mockResolvedValue(
      remoteInfoWithTags({ "v1.0.0": "a".repeat(40), "v2.0.0": "b".repeat(40) }),
    );
    mockFetch.mockResolvedValue({});

    const result = await cloneRepo("https://r.example/repo.git", "tok", logger, {
      includeTags: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.tagsTruncated).toBe(false);
    expect(result.data.totalTagCount).toBe(2);

    expect(mockGetRemoteInfo).toHaveBeenCalledTimes(1);
    const infoArgs = mockGetRemoteInfo.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(infoArgs.url).toBe("https://r.example/repo.git");

    // One fetch per tag — never a combined all-refs fetch.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    for (const call of mockFetch.mock.calls) {
      const args = call[0] as Record<string, unknown>;
      expect(args.tags).toBe(true);
      expect(args.singleBranch).toBe(true);
      expect(args.depth).toBe(50);
      expect(args.url).toBe("https://r.example/repo.git");
    }
    const remoteRefs = mockFetch.mock.calls.map((c) => (c[0] as Record<string, unknown>).remoteRef);
    expect(remoteRefs).toEqual(["refs/tags/v1.0.0", "refs/tags/v2.0.0"]);
  });

  it("fetches tags with full history when fullHistory is set (no depth)", async () => {
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      await buildRepo(dir, [{ "a.txt": "one" }], fs);
    });
    mockGetRemoteInfo.mockResolvedValue(remoteInfoWithTags({ "v1.0.0": "a".repeat(40) }));
    mockFetch.mockResolvedValue({});

    await cloneRepo("https://r.example/repo.git", "tok", logger, {
      fullHistory: true,
      includeTags: true,
    });
    const args = mockFetch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("depth" in args).toBe(false);
    expect(args.tags).toBe(true);
    expect(args.singleBranch).toBe(true);
  });

  it("filters out peeled-tag `^{}` advertisement keys — they aren't tag names", async () => {
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      await buildRepo(dir, [{ "a.txt": "one" }], fs);
    });
    mockGetRemoteInfo.mockResolvedValue(
      remoteInfoWithTags({ "v1.0.0": "a".repeat(40), "v1.0.0^{}": "b".repeat(40) }),
    );
    mockFetch.mockResolvedValue({});

    const result = await cloneRepo("https://r.example/repo.git", "tok", logger, {
      includeTags: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.totalTagCount).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((mockFetch.mock.calls[0]?.[0] as Record<string, unknown>).remoteRef).toBe(
      "refs/tags/v1.0.0",
    );
  });

  it("fetches a hierarchical tag name, which getRemoteInfo nests several levels deep", async () => {
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      await buildRepo(dir, [{ "a.txt": "one" }], fs);
    });
    // "release/1.0" advertises as refs/tags/release/1.0, which getRemoteInfo
    // nests as refs.tags.release["1.0"] — a plain Object.keys(refs.tags)
    // would yield "release" (a nested object, not an oid) instead of the
    // real tag name.
    mockGetRemoteInfo.mockResolvedValue(
      remoteInfoWithTags({ "release/1.0": "a".repeat(40), "v1/rc1": "b".repeat(40) }),
    );
    mockFetch.mockResolvedValue({});

    const result = await cloneRepo("https://r.example/repo.git", "tok", logger, {
      includeTags: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.totalTagCount).toBe(2);

    const remoteRefs = mockFetch.mock.calls
      .map((c) => (c[0] as Record<string, unknown>).remoteRef)
      .sort();
    expect(remoteRefs).toEqual(["refs/tags/release/1.0", "refs/tags/v1/rc1"]);
  });

  it("does not enumerate or fetch tags unless asked", async () => {
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      await buildRepo(dir, [{ "a.txt": "one" }], fs);
    });
    const result = await cloneRepo("https://r.example/repo.git", "tok", logger);
    expect(result.success).toBe(true);
    expect(mockGetRemoteInfo).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails the clone when remote tag enumeration fails", async () => {
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      await buildRepo(dir, [{ "a.txt": "one" }], fs);
    });
    mockGetRemoteInfo.mockRejectedValue(new Error("network down"));

    const result = await cloneRepo("https://r.example/repo.git", "tok", logger, {
      includeTags: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("Failed to enumerate remote tags");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails the clone when an individual tag fetch fails, naming the tag", async () => {
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      await buildRepo(dir, [{ "a.txt": "one" }], fs);
    });
    mockGetRemoteInfo.mockResolvedValue(
      remoteInfoWithTags({ "v1.0.0": "a".repeat(40), "v2.0.0": "b".repeat(40) }),
    );
    mockFetch.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("network down"));

    const result = await cloneRepo("https://r.example/repo.git", "tok", logger, {
      includeTags: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("Failed to fetch tag");
      expect(result.error.message).toContain("v2.0.0");
    }
  });

  it("caps the number of tags fetched at MAX_TAGS and reports truncation", async () => {
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      await buildRepo(dir, [{ "a.txt": "one" }], fs);
    });
    const manyTags: Record<string, string> = {};
    for (let i = 0; i < MAX_TAGS + 37; i++) {
      manyTags[`t${String(i).padStart(5, "0")}`] = i.toString(16).padStart(40, "0");
    }
    mockGetRemoteInfo.mockResolvedValue(remoteInfoWithTags(manyTags));
    mockFetch.mockResolvedValue({});

    const result = await cloneRepo("https://r.example/repo.git", "tok", logger, {
      includeTags: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.tagsTruncated).toBe(true);
    expect(result.data.totalTagCount).toBe(MAX_TAGS + 37);
    // Only the cap's worth of tags were actually fetched — not silently more
    // or fewer.
    expect(mockFetch).toHaveBeenCalledTimes(MAX_TAGS);
  });

  it("keeps the highest-sorting tags, not the lowest, when truncating", async () => {
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      await buildRepo(dir, [{ "a.txt": "one" }], fs);
    });
    // v0..v(MAX_TAGS+9): a plain lexicographic sort keeps the "v0*" tags and
    // drops "v1*" — the opposite of what a release listing wants.
    const manyTags: Record<string, string> = {};
    const total = MAX_TAGS + 10;
    for (let i = 0; i < total; i++) {
      manyTags[`v${String(i).padStart(5, "0")}`] = i.toString(16).padStart(40, "0");
    }
    mockGetRemoteInfo.mockResolvedValue(remoteInfoWithTags(manyTags));
    mockFetch.mockResolvedValue({});

    const result = await cloneRepo("https://r.example/repo.git", "tok", logger, {
      includeTags: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.tagsTruncated).toBe(true);

    const fetchedNames = mockFetch.mock.calls
      .map((c) => (c[0] as Record<string, unknown>).remoteRef as string)
      .map((ref) => ref.replace("refs/tags/", ""))
      .sort();
    const expectedKept = Object.keys(manyTags).sort().slice(-MAX_TAGS);
    expect(fetchedNames).toEqual(expectedKept);
    // The lowest-sorting names were the ones dropped.
    expect(fetchedNames).not.toContain("v00000");
    expect(fetchedNames).toContain(`v${String(total - 1).padStart(5, "0")}`);
  });

  it("does not materialize a large branch's objects that no tag references", async () => {
    // A "remote" repo, separate from the destination fs, with:
    //  - main: one commit
    //  - a tag pointing at that same commit
    //  - a "big" branch with its own commits/blobs, reachable from no tag
    const remoteDir = "/remote";
    const { fs: remoteFs, shas } = await buildRepo(remoteDir, [{ "a.txt": "one" }]);
    const c1 = shas[0] as string;

    await (
      remoteFs as unknown as { promises: { writeFile: (p: string, c: string) => Promise<void> } }
    ).promises.writeFile(`${remoteDir}/big1.txt`, "x".repeat(500));
    await git.add({ fs: remoteFs, dir: remoteDir, filepath: "big1.txt" });
    const big1 = await git.commit({
      fs: remoteFs,
      dir: remoteDir,
      message: "big1",
      author,
      ref: "refs/heads/big",
      parent: [c1],
    });

    await git.tag({ fs: remoteFs, dir: remoteDir, ref: "v1.0.0", object: c1 });

    // The main clone mirrors what a real singleBranch clone would produce:
    // only main's own object graph.
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      await git.init({ fs, dir, defaultBranch: "main" });
      await copyReachableObjects(remoteFs, remoteDir, fs, dir, c1);
      await git.writeRef({ fs, dir, ref: "refs/heads/main", value: c1, force: true });
    });

    mockGetRemoteInfo.mockResolvedValue(remoteInfoWithTags({ "v1.0.0": c1 }));

    // A faithful per-tag fetch: copy only the requested ref's own object
    // graph from the "remote" — exactly what a real singleBranch fetch does.
    mockFetch.mockImplementation(
      async ({ fs, dir, remoteRef }: { fs: NodeFS; dir: string; remoteRef: string }) => {
        const name = remoteRef.replace("refs/tags/", "");
        const oid = await git.resolveRef({
          fs: remoteFs,
          dir: remoteDir,
          ref: `refs/tags/${name}`,
        });
        await copyReachableObjects(remoteFs, remoteDir, fs, dir, oid);
        await git.writeRef({ fs, dir, ref: `refs/tags/${name}`, value: oid, force: true });
        return {};
      },
    );

    const result = await cloneRepo("https://r.example/repo.git", "tok", logger, {
      includeTags: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    // The tag's target is present.
    await expect(
      git.readObject({ fs: result.data.fs, dir: result.data.dir, oid: c1 }),
    ).resolves.toBeDefined();
    // The untagged branch's own commit was never fetched.
    await expect(
      git.readObject({ fs: result.data.fs, dir: result.data.dir, oid: big1 }),
    ).rejects.toThrow();

    // Every tags-fetch call asked for exactly one tag ref — never a
    // whole-repo (`singleBranch: false`) fetch, and never the branch ref.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    for (const call of mockFetch.mock.calls) {
      const args = call[0] as Record<string, unknown>;
      expect(args.singleBranch).toBe(true);
      expect(args.remoteRef).toBe("refs/tags/v1.0.0");
    }
  });
});

describe("listRepoTags", () => {
  it("clones when a tag has not been listed before", async () => {
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      const { shas } = await buildRepo(dir, [{ "a.txt": "one" }], fs);
      await git.tag({ fs, dir, ref: "v1.0.0", object: shas[0] });
      await git.annotatedTag({
        fs,
        dir,
        ref: "v2.0.0",
        object: shas[0],
        message: "second\n",
        tagger,
      });
    });
    mockGetRemoteInfo.mockResolvedValue(
      remoteInfoWithTags({
        "v1.0.0": "a".repeat(40),
        "v2.0.0": "b".repeat(40),
        "v2.0.0^{}": "a".repeat(40),
      }),
    );
    mockFetch.mockResolvedValue({});

    const result = await listRepoTags("https://r.example/repo.git", "tok", logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(mockClone).toHaveBeenCalledTimes(1);
    expect(result.data.tags.map((t) => t.name)).toEqual(["v1.0.0", "v2.0.0"]);
    expect(result.data.tags[1]?.annotated).toBe(true);
    expect(result.data.tags[1]?.message).toBe("second");
    expect(result.data.truncated).toBe(false);
    expect(result.data.totalTagCount).toBe(2);
  });

  it("lists no tags without cloning when the remote advertises none", async () => {
    const result = await listRepoTags("https://r.example/repo.git", "tok", logger);
    expect(result).toEqual({
      success: true,
      data: { tags: [], truncated: false, totalTagCount: 0 },
    });
    expect(mockClone).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("lists from the advertisement and the cache without cloning", async () => {
    const tagObject = "b".repeat(40);
    const commit = "a".repeat(40);
    mockGetRemoteInfo.mockResolvedValue(
      remoteInfoWithTags({ ann: tagObject, "release/2.0": commit }),
    );
    const cached: Record<string, TagDetails> = {
      [tagObject]: {
        annotated: true,
        targetSha: commit,
        message: "release one",
        tagger: "t <t@x.com>",
        timestamp: 7,
      },
      [commit]: { annotated: false, targetSha: commit },
    };
    const detailCache = {
      get: vi.fn(async (oid: string) => cached[oid] ?? null),
      put: vi.fn(async () => {}),
    };

    const result = await listRepoTags("https://r.example/repo.git", "tok", logger, undefined, {
      detailCache,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(mockClone).not.toHaveBeenCalled();
    expect(result.data.tags).toEqual([
      {
        name: "ann",
        oid: tagObject,
        targetSha: commit,
        annotated: true,
        message: "release one",
        tagger: "t <t@x.com>",
        timestamp: 7,
        unresolvable: false,
      },
      {
        name: "release/2.0",
        oid: commit,
        targetSha: commit,
        annotated: false,
        unresolvable: false,
      },
    ]);
  });

  it("does not take a tag for lightweight because the remote advertised no peeled entry", async () => {
    // An annotated tag, advertised without its `ann^{}` line. Nothing cached
    // says what it is, so it is read by cloning, not guessed.
    let tagOid = "";
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      const { shas } = await buildRepo(dir, [{ "a.txt": "one" }], fs);
      await git.annotatedTag({ fs, dir, ref: "ann", object: shas[0], message: "m\n", tagger });
      tagOid = await git.resolveRef({ fs, dir, ref: "refs/tags/ann" });
    });
    mockFetch.mockResolvedValue({});
    await mockClone({ fs: new MemoryFS().toNodeFS() as unknown as NodeFS, dir: "/repo" });
    mockClone.mockClear();
    mockGetRemoteInfo.mockResolvedValue(remoteInfoWithTags({ ann: tagOid }));
    const detailCache = { get: async () => null, put: async () => {} };

    const result = await listRepoTags("https://r.example/repo.git", "tok", logger, undefined, {
      detailCache,
    });
    expect(mockClone).toHaveBeenCalledTimes(1);
    expect(result.success && result.data.tags[0]).toMatchObject({ annotated: true, message: "m" });
  });

  it("clones when there are tags and no cache to describe them", async () => {
    mockGetRemoteInfo.mockResolvedValue(remoteInfoWithTags({ "v1.0.0": "a".repeat(40) }));
    mockClone.mockRejectedValue(new Error("clone reached"));
    const result = await listRepoTags("https://r.example/repo.git", "tok", logger);
    expect(result.success).toBe(false);
    expect(mockClone).toHaveBeenCalledTimes(1);
  });

  it("stops reading cached details at the first batch with a miss", async () => {
    const advertisedTags: Record<string, string> = {};
    for (let i = 0; i < 60; i++) {
      const name = `t${String(i).padStart(3, "0")}`;
      advertisedTags[name] = i.toString(16).padStart(40, "0");
      advertisedTags[`${name}^{}`] = "a".repeat(40);
    }
    mockGetRemoteInfo.mockResolvedValue(remoteInfoWithTags(advertisedTags));
    mockClone.mockRejectedValue(new Error("clone reached"));
    const detailCache = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };

    const result = await listRepoTags("https://r.example/repo.git", "tok", logger, undefined, {
      detailCache,
    });
    // The miss sent the listing to the clone, without reading all 60 first.
    expect(result.success).toBe(false);
    expect(mockClone).toHaveBeenCalledTimes(1);
    expect(detailCache.get.mock.calls.length).toBeLessThan(60);
    expect(detailCache.get.mock.calls.length).toBeGreaterThan(0);
  });

  it("stores what a clone read, so the next listing does not clone", async () => {
    let tagOid = "";
    let commitOid = "";
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      const { shas } = await buildRepo(dir, [{ "a.txt": "one" }], fs);
      commitOid = shas[0] as string;
      await git.annotatedTag({
        fs,
        dir,
        ref: "ann",
        object: commitOid,
        message: "first\n",
        tagger,
      });
      tagOid = await git.resolveRef({ fs, dir, ref: "refs/tags/ann" });
    });
    mockFetch.mockResolvedValue({});
    // The advertisement has to name the oids the clone will hold, so build the
    // same repository once to learn them.
    await mockClone({ fs: new MemoryFS().toNodeFS() as unknown as NodeFS, dir: "/repo" });
    mockClone.mockClear();
    mockGetRemoteInfo.mockResolvedValue(remoteInfoWithTags({ ann: tagOid, "ann^{}": commitOid }));

    const stored = new Map<string, TagDetails>();
    const detailCache = {
      get: async (oid: string) => stored.get(oid) ?? null,
      put: async (oid: string, details: TagDetails) => {
        stored.set(oid, details);
      },
    };

    const first = await listRepoTags("https://r.example/repo.git", "tok", logger, undefined, {
      detailCache,
    });
    expect(mockClone).toHaveBeenCalledTimes(1);
    expect(stored.get(tagOid)).toEqual({
      annotated: true,
      targetSha: commitOid,
      message: "first",
      tagger: "tagger <tag@x.com>",
      timestamp: tagger.timestamp,
    });

    const second = await listRepoTags("https://r.example/repo.git", "tok", logger, undefined, {
      detailCache,
    });
    expect(mockClone).toHaveBeenCalledTimes(1);
    // Both paths describe the tag identically.
    expect(second).toEqual(first);
  });

  it("clones when the cache does not answer in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      mockGetRemoteInfo.mockResolvedValue(remoteInfoWithTags({ "v1.0.0": "a".repeat(40) }));
      mockClone.mockRejectedValue(new Error("clone reached"));
      let readReached = (): void => {};
      const reached = new Promise<void>((resolve) => {
        readReached = resolve;
      });
      const detailCache = {
        get: () => {
          readReached();
          return new Promise<null>(() => {});
        },
        put: async () => {},
      };

      const pending = listRepoTags("https://r.example/repo.git", "tok", logger, undefined, {
        detailCache,
      });
      await reached;
      await vi.advanceTimersByTimeAsync(TAG_DETAIL_READ_TIMEOUT_MS + 1);
      const result = await pending;

      expect(result.success).toBe(false);
      expect(mockClone).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not store a tag that did not resolve", async () => {
    const missing = "f".repeat(40);
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      const { shas } = await buildRepo(dir, [{ "a.txt": "one" }], fs);
      await git.tag({ fs, dir, ref: "good", object: shas[0] });
      await git.writeRef({ fs, dir, ref: "refs/tags/dangling", value: missing, force: true });
    });
    mockFetch.mockResolvedValue({});
    mockGetRemoteInfo.mockResolvedValue(
      remoteInfoWithTags({ good: "a".repeat(40), dangling: missing }),
    );
    const detailCache = {
      get: async () => null,
      put: vi.fn(async (_oid: string, _details: TagDetails) => {}),
    };

    const result = await listRepoTags("https://r.example/repo.git", "tok", logger, undefined, {
      detailCache,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.tags.find((t) => t.name === "dangling")?.unresolvable).toBe(true);
    // Only `good` is stored; `dangling` is read again by the next listing.
    expect(detailCache.put).toHaveBeenCalledTimes(1);
    expect(detailCache.put.mock.calls[0]?.[1]).toMatchObject({ annotated: false });
  });

  it("answers without waiting for a cache store that never finishes", async () => {
    // Only the timeout clock is faked: the in-memory git work still needs real
    // turns of the event loop to run.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let tagOid = "";
      let commitOid = "";
      mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
        const { shas } = await buildRepo(dir, [{ "a.txt": "one" }], fs);
        commitOid = shas[0] as string;
        await git.annotatedTag({ fs, dir, ref: "ann", object: commitOid, message: "m\n", tagger });
        tagOid = await git.resolveRef({ fs, dir, ref: "refs/tags/ann" });
      });
      mockFetch.mockResolvedValue({});
      await mockClone({ fs: new MemoryFS().toNodeFS() as unknown as NodeFS, dir: "/repo" });
      mockGetRemoteInfo.mockResolvedValue(remoteInfoWithTags({ ann: tagOid, "ann^{}": commitOid }));
      let storeReached = (): void => {};
      const reached = new Promise<void>((resolve) => {
        storeReached = resolve;
      });
      const detailCache = {
        get: async () => null,
        put: () => {
          storeReached();
          return new Promise<void>(() => {});
        },
      };

      const pending = listRepoTags("https://r.example/repo.git", "tok", logger, undefined, {
        detailCache,
      });
      // Let the clone finish in real time first. Advancing the fake clock any
      // earlier would also run down the clone's own timeout.
      await reached;
      await vi.advanceTimersByTimeAsync(TAG_DETAIL_STORE_TIMEOUT_MS + 1);
      const result = await pending;

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.tags.map((t) => t.name)).toEqual(["ann"]);
      expect(logger.warn).toHaveBeenCalledWith(
        "Tag details were not all stored",
        expect.objectContaining({ remote: "https://r.example/repo.git" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a failure to read the advertisement", async () => {
    mockGetRemoteInfo.mockRejectedValue(new Error("unreachable"));
    const result = await listRepoTags("https://r.example/repo.git", "tok", logger);
    expect(result.success).toBe(false);
    expect(mockClone).not.toHaveBeenCalled();
  });

  it("propagates a clone failure", async () => {
    mockClone.mockRejectedValue(new Error("no such repo"));
    mockGetRemoteInfo.mockResolvedValue(
      remoteInfoWithTags({ ann: "b".repeat(40), "ann^{}": "a".repeat(40) }),
    );
    const result = await listRepoTags("https://r.example/repo.git", "tok", logger);
    expect(result.success).toBe(false);
  });

  it("maps a collection failure to a Git error", async () => {
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      await buildRepo(dir, [{ "a.txt": "one" }], fs);
    });
    mockFetch.mockResolvedValue({});
    listTagsOverride.fn = async () => {
      throw new Error("refs are corrupt");
    };
    mockGetRemoteInfo.mockResolvedValue(
      remoteInfoWithTags({ ann: "b".repeat(40), "ann^{}": "a".repeat(40) }),
    );
    const result = await listRepoTags("https://r.example/repo.git", "tok", logger);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("Failed to list tags");
  });

  it("reports truncation and the true remote total when the tag count exceeds MAX_TAGS", async () => {
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      await buildRepo(dir, [{ "a.txt": "one" }], fs);
    });
    const manyTags: Record<string, string> = {};
    for (let i = 0; i < MAX_TAGS + 10; i++) {
      manyTags[`t${String(i).padStart(5, "0")}`] = i.toString(16).padStart(40, "0");
    }
    mockGetRemoteInfo.mockResolvedValue(remoteInfoWithTags(manyTags));
    // Each per-tag fetch actually writes the local ref so collectRepoTags has
    // something to find (pointed at an already-present commit).
    let mainSha = "";
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      const { shas } = await buildRepo(dir, [{ "a.txt": "one" }], fs);
      mainSha = shas[0] as string;
    });
    mockFetch.mockImplementation(
      async ({ fs, dir, remoteRef }: { fs: NodeFS; dir: string; remoteRef: string }) => {
        await git.writeRef({ fs, dir, ref: remoteRef, value: mainSha, force: true });
        return {};
      },
    );

    const result = await listRepoTags("https://r.example/repo.git", "tok", logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.truncated).toBe(true);
    expect(result.data.totalTagCount).toBe(MAX_TAGS + 10);
    // Exactly MAX_TAGS tags were fetched and are therefore listed — the
    // truncation is real, not just reported while everything still lists.
    expect(result.data.tags).toHaveLength(MAX_TAGS);
  });
});

// walkRepoObjects' listTags guards need the isomorphic-git mock, so they live
// here rather than in the backup suite.
describe("walkRepoObjects tag-listing guards", () => {
  it("treats a listTags failure as 'no tags' instead of failing the walk", async () => {
    const { fs } = await buildRepo("/repo", [{ "a.txt": "one" }]);
    listTagsOverride.fn = async () => {
      throw new Error("boom");
    };
    const walk = await walkRepoObjects(fs, "/repo", 10_000_000, logger);
    expect(walk.success).toBe(true);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    expect(walk.data.tags).toEqual([]);
  });

  it("skips a listed tag whose ref does not resolve, with a warning", async () => {
    const { fs } = await buildRepo("/repo", [{ "a.txt": "one" }]);
    listTagsOverride.fn = async () => ["phantom"];
    const walk = await walkRepoObjects(fs, "/repo", 10_000_000, logger);
    expect(walk.success).toBe(true);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    expect(walk.data.tags).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith("Backup: skipping unreadable tag ref", {
      name: "phantom",
    });
  });
});

describe("snapshotRepo clones with tags", () => {
  const project: ProjectEntry = {
    id: "p1",
    name: "repo",
    slug: "repo",
    namespace: "@owner",
    ownerId: "u1",
    ownerType: "user",
    remote: "https://acct.artifacts.cloudflare.net/git/@owner/repo.git",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  function makeEnv(): Env {
    return {
      ARTIFACTS: {
        get: vi.fn(async () => ({
          createToken: vi.fn(async () => ({ plaintext: "tok?expires=9999999999" })),
        })),
      } as unknown as Env["ARTIFACTS"],
    } as Env;
  }

  it("passes includeTags+fullHistory to the clone and records tags in the manifest", async () => {
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      const { shas } = await buildRepo(dir, [{ "a.txt": "one" }], fs);
      await git.annotatedTag({
        fs,
        dir,
        ref: "v1.0.0",
        object: shas[0],
        message: "release\n",
        tagger,
      });
    });
    mockGetRemoteInfo.mockResolvedValue(remoteInfoWithTags({ "v1.0.0": "a".repeat(40) }));
    mockFetch.mockResolvedValue({});

    const result = await snapshotRepo(makeEnv(), project, "2026-08-18T00:00:00Z", logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("ok");
    if (result.data.status !== "ok") return;
    expect(result.data.snapshot.manifest.tags?.map((t) => t.name)).toEqual(["v1.0.0"]);

    // The backup clone is full-history AND tag-fetching, one tag ref at a time.
    const cloneArgs = mockClone.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("depth" in cloneArgs).toBe(false);
    const fetchArgs = mockFetch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(fetchArgs.tags).toBe(true);
    expect(fetchArgs.singleBranch).toBe(true);
    expect(fetchArgs.remoteRef).toBe("refs/tags/v1.0.0");
    expect("depth" in fetchArgs).toBe(false);
  });

  it("still skips an empty repo", async () => {
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      await git.init({ fs, dir, defaultBranch: "main" });
    });
    mockFetch.mockResolvedValue({});
    const result = await snapshotRepo(makeEnv(), project, "2026-08-18T00:00:00Z", logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ status: "skipped", reason: "empty" });
  });
});

describe("pushTags", () => {
  it("pushes each refs/tags/* ref and mirrors the force flag", async () => {
    mockPush.mockResolvedValue({ ok: true });
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    const result = await pushTags(
      "https://r.example/repo.git",
      "tok",
      fs,
      "/",
      ["v1", "v2"],
      logger,
      {
        force: true,
      },
    );
    expect(result.success).toBe(true);
    expect(mockPush).toHaveBeenCalledTimes(2);
    const first = mockPush.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(first.ref).toBe("refs/tags/v1");
    expect(first.remoteRef).toBe("refs/tags/v1");
    expect(first.force).toBe(true);
    expect(first.url).toBe("https://r.example/repo.git");
    const second = mockPush.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(second.ref).toBe("refs/tags/v2");
  });

  it("fails on the first tag that cannot be pushed, naming it", async () => {
    mockPush.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error("rejected"));
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    const result = await pushTags(
      "https://r.example/repo.git",
      "tok",
      fs,
      "/",
      ["v1", "v2"],
      logger,
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("v2");
  });

  it("is a no-op for an empty tag list", async () => {
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    const result = await pushTags("https://r.example/repo.git", "tok", fs, "/", [], logger);
    expect(result.success).toBe(true);
    expect(mockPush).not.toHaveBeenCalled();
  });
});
