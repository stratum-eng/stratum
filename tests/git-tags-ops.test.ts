import git from "isomorphic-git";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotRepo, walkRepoObjects } from "../src/backup/repo-snapshot";
import {
  type NodeFS,
  cloneRepo,
  collectRepoTags,
  listRepoTags,
  pushTags,
} from "../src/storage/git-ops";
import { MemoryFS } from "../src/storage/memory-fs";
import { placeLooseObject } from "../src/storage/object-loader";
import type { Env, ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";

// Partial isomorphic-git mock: `clone`, `fetch`, and `push` are the only
// network-coupled calls the code under test makes; everything else (init,
// commit, tag, readObject, …) stays real so the tests exercise genuine git
// object stores in MemoryFS.
const { mockClone, mockFetch, mockPush, listTagsOverride } = vi.hoisted(() => ({
  mockClone: vi.fn(),
  mockFetch: vi.fn(),
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
      push: (args: unknown) => mockPush(args),
      listTags: (args: unknown) =>
        listTagsOverride.fn
          ? listTagsOverride.fn(args)
          : actual.default.listTags(args as Parameters<typeof actual.default.listTags>[0]),
    },
  };
});

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
  it("follows the singleBranch clone with a tags fetch (shallow by default)", async () => {
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      await buildRepo(dir, [{ "a.txt": "one" }], fs);
    });
    mockFetch.mockResolvedValue({});

    const result = await cloneRepo("https://r.example/repo.git", "tok", logger, {
      includeTags: true,
    });
    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const args = mockFetch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.tags).toBe(true);
    expect(args.singleBranch).toBe(false);
    expect(args.depth).toBe(50);
    expect(args.url).toBe("https://r.example/repo.git");
  });

  it("fetches tags with full history when fullHistory is set (no depth)", async () => {
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      await buildRepo(dir, [{ "a.txt": "one" }], fs);
    });
    mockFetch.mockResolvedValue({});

    await cloneRepo("https://r.example/repo.git", "tok", logger, {
      fullHistory: true,
      includeTags: true,
    });
    const args = mockFetch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("depth" in args).toBe(false);
    expect(args.tags).toBe(true);
  });

  it("does not fetch tags unless asked", async () => {
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      await buildRepo(dir, [{ "a.txt": "one" }], fs);
    });
    const result = await cloneRepo("https://r.example/repo.git", "tok", logger);
    expect(result.success).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails the clone when the tags fetch fails", async () => {
    mockClone.mockImplementation(async ({ fs, dir }: { fs: NodeFS; dir: string }) => {
      await buildRepo(dir, [{ "a.txt": "one" }], fs);
    });
    mockFetch.mockRejectedValue(new Error("network down"));

    const result = await cloneRepo("https://r.example/repo.git", "tok", logger, {
      includeTags: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("Failed to fetch tags");
  });
});

describe("listRepoTags", () => {
  it("clones with tags and returns the collected entries", async () => {
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
    mockFetch.mockResolvedValue({});

    const result = await listRepoTags("https://r.example/repo.git", "tok", logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.map((t) => t.name)).toEqual(["v1.0.0", "v2.0.0"]);
    expect(result.data[1]?.annotated).toBe(true);
    expect(result.data[1]?.message).toBe("second");
  });

  it("propagates a clone failure", async () => {
    mockClone.mockRejectedValue(new Error("no such repo"));
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
    const result = await listRepoTags("https://r.example/repo.git", "tok", logger);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("Failed to list tags");
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
    mockFetch.mockResolvedValue({});

    const result = await snapshotRepo(makeEnv(), project, "2026-08-18T00:00:00Z", logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("ok");
    if (result.data.status !== "ok") return;
    expect(result.data.snapshot.manifest.tags?.map((t) => t.name)).toEqual(["v1.0.0"]);

    // The backup clone is full-history AND tag-fetching.
    const cloneArgs = mockClone.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("depth" in cloneArgs).toBe(false);
    const fetchArgs = mockFetch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(fetchArgs.tags).toBe(true);
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
