import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TREE_READS,
  TREE_LISTING_MAX_BYTES,
  TREE_TOO_LARGE,
  getCommitLogPreferNative,
  kvTagDetailCache,
  kvTreeListingCache,
  listFilesInRepoPreferNative,
  loadRepoViewPreferNative,
  readFileFromRepoPreferNative,
  readRepoViewNative,
} from "../src/storage/artifacts-reads";
import {
  getCommitLog,
  listFilesInRepo,
  loadRepoView,
  readFileFromRepo,
} from "../src/storage/git-ops";
import type {
  ArtifactsCommitMetadata,
  ArtifactsNamespace,
  ArtifactsRepo,
  ArtifactsTreeEntry,
} from "../src/types";
import type { Logger } from "../src/utils/logger";

vi.mock("../src/storage/git-ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    loadRepoView: vi.fn(),
    readFileFromRepo: vi.fn(),
    getCommitLog: vi.fn(),
    listFilesInRepo: vi.fn(),
  };
});

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
} as unknown as Logger;

/** Untyped here for the same reason as in the source: this repo's `lib` is ES2022. */
const DISPOSE = (Symbol as unknown as { dispose: symbol }).dispose;

const REMOTE = "https://acct.artifacts.cloudflare.net/git/stratum-prod/owner__repo.git";
const HEAD = "a".repeat(40);
const ROOT = "1".repeat(40);

const hash = (n: number): string => n.toString(16).padStart(40, "0");
const entry = (
  name: string,
  type: ArtifactsTreeEntry["type"],
  h: string = hash(name.length),
): ArtifactsTreeEntry => ({ name, type, hash: h, mode: type === "tree" ? "40000" : "100644" });

function commit(
  sha: string,
  overrides: Partial<ArtifactsCommitMetadata> = {},
): ArtifactsCommitMetadata {
  return {
    hash: sha,
    treeHash: ROOT,
    message: "Initial commit\n",
    author: { name: "Ada", email: "ada@example.com" },
    committer: { name: "Ada", email: "ada@example.com" },
    parents: [],
    authoredAt: 1_700_000_000,
    committedAt: 1_700_000_000,
    ...overrides,
  };
}

type FakeRepo = {
  [K in "info" | "log" | "readTree" | "readFile"]: ReturnType<typeof vi.fn>;
} & { disposed: number };

/** A fake repo stub serving `trees` by hash, with a README blob. */
function fakeArtifacts(
  trees: Record<string, ArtifactsTreeEntry[]>,
  opts: { log?: ArtifactsCommitMetadata[]; readme?: string | null } = {},
): { artifacts: ArtifactsNamespace; repo: FakeRepo; getName: () => string | undefined } {
  let requested: string | undefined;
  const repo = {
    disposed: 0,
    info: vi.fn(async () => ({ name: "owner__repo", remote: REMOTE, defaultBranch: "main" })),
    log: vi.fn(async () => opts.log ?? [commit(HEAD)]),
    readTree: vi.fn(async (h: string) => trees[h] ?? null),
    readFile: vi.fn(async ({ path }: { ref: string; path: string }) => {
      const root = trees[ROOT] ?? [];
      if (!root.some((e) => e.name === path && e.type !== "tree")) return null;
      const text = opts.readme === undefined ? "# Hello" : opts.readme;
      return text === null ? null : new Blob([text]);
    }),
    [DISPOSE]() {
      repo.disposed++;
    },
  };
  const artifacts = {
    get: vi.fn(async (name: string) => {
      requested = name;
      return repo as unknown as ArtifactsRepo;
    }),
  } as unknown as ArtifactsNamespace;
  return { artifacts, repo: repo as unknown as FakeRepo, getName: () => requested };
}

describe("readRepoViewNative", () => {
  it("reads files, commits and README without cloning, and disposes the stub", async () => {
    const SRC = hash(100);
    const LIB = hash(101);
    const { artifacts, repo, getName } = fakeArtifacts({
      [ROOT]: [
        entry("README.md", "blob"),
        entry("run.sh", "exec"),
        entry("link", "symlink"),
        entry("vendor", "gitlink"),
        entry("src", "tree", SRC),
      ],
      [SRC]: [entry("index.ts", "blob"), entry("lib", "tree", LIB)],
      [LIB]: [entry("util.ts", "blob")],
    });

    const result = await readRepoViewNative(artifacts, REMOTE, logger, "main");

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(getName()).toBe("owner__repo");
    expect(repo.log).toHaveBeenCalledWith({ ref: "main", limit: 20 });
    expect(result.data.headSha).toBe(HEAD);
    // Submodules contribute no paths, matching a clone's checkout walk.
    expect([...(result.data.files ?? [])].sort()).toEqual(
      ["README.md", "link", "run.sh", "src/index.ts", "src/lib/util.ts"].sort(),
    );
    expect(result.data.commits).toEqual([
      {
        sha: HEAD,
        message: "Initial commit",
        author: "Ada <ada@example.com>",
        timestamp: 1_700_000_000,
      },
    ]);
    expect(result.data.readme).toBe("# Hello");
    expect(result.data.complete).toBe(true);
    expect(repo.disposed).toBe(1);
  });

  it("is complete without a README when the repo has none", async () => {
    const { artifacts } = fakeArtifacts({ [ROOT]: [entry("a.txt", "blob")] });

    const result = await readRepoViewNative(artifacts, REMOTE, logger);

    expect(result.success && result.data).toMatchObject({ readme: null, complete: true });
  });

  it("logs a README read that fails, rather than dropping it silently", async () => {
    const warn = vi.fn();
    const { artifacts, repo } = fakeArtifacts({ [ROOT]: [entry("README.md", "blob")] });
    repo.readFile.mockRejectedValue(new Error("INTERNAL_ERROR"));

    const result = await readRepoViewNative(artifacts, REMOTE, { ...logger, warn } as Logger);

    expect(result.success && result.data).toMatchObject({ readme: null, complete: false });
    expect(warn).toHaveBeenCalledWith(
      "Failed to read README for native repo view",
      expect.objectContaining({ error: "INTERNAL_ERROR" }),
    );
  });

  it("marks the view incomplete when an existing README does not read", async () => {
    const { artifacts } = fakeArtifacts({ [ROOT]: [entry("readme.md", "blob")] }, { readme: null });

    const result = await readRepoViewNative(artifacts, REMOTE, logger);

    expect(result.success && result.data).toMatchObject({ readme: null, complete: false });
  });

  it("fails for a branch with no commits, as the clone path does", async () => {
    // The page shows Sync Now for a failed read but not for an empty repo, so
    // an unresolvable branch must not come back as a successful empty view.
    const { artifacts, repo } = fakeArtifacts({}, { log: [] });

    const result = await readRepoViewNative(artifacts, REMOTE, logger, "gone");

    expect(result.success).toBe(false);
    expect(repo.readTree).not.toHaveBeenCalled();
  });

  it("fails rather than listing a tree with a hole in it", async () => {
    const { artifacts, repo } = fakeArtifacts({
      [ROOT]: [entry("src", "tree", hash(100))],
    });

    const result = await readRepoViewNative(artifacts, REMOTE, logger);

    expect(result.success).toBe(false);
    expect(repo.disposed).toBe(1);
  });

  it("gives up with TREE_TOO_LARGE past the directory cap, so the caller clones", async () => {
    const dirs = Array.from({ length: MAX_TREE_READS }, (_, i) =>
      entry(`d${i}`, "tree", hash(1000 + i)),
    );
    const trees: Record<string, ArtifactsTreeEntry[]> = { [ROOT]: dirs };
    for (const d of dirs) trees[d.hash] = [entry("f.txt", "blob")];
    const { artifacts } = fakeArtifacts(trees);

    const result = await readRepoViewNative(artifacts, REMOTE, logger);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(TREE_TOO_LARGE);
  });

  it("refuses a repo from another namespace that shares the remote's repo name", async () => {
    const { artifacts, repo } = fakeArtifacts({ [ROOT]: [entry("a.txt", "blob")] });
    repo.info.mockResolvedValue({
      name: "owner__repo",
      remote: "https://acct.artifacts.cloudflare.net/git/stratum-staging/owner__repo.git",
      defaultBranch: "main",
    });

    const result = await readRepoViewNative(artifacts, REMOTE, logger);

    expect(result.success).toBe(false);
  });

  it("reports a runtime without the read API as an error and still disposes the stub", async () => {
    const { artifacts, repo } = fakeArtifacts({});
    repo.log.mockRejectedValue(new TypeError("repo.log is not a function"));

    const result = await readRepoViewNative(artifacts, REMOTE, logger);

    expect(result.success).toBe(false);
    expect(repo.disposed).toBe(1);
  });
});

function memoryKV(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

describe("readRepoViewNative with a tree listing cache", () => {
  const SRC = hash(100);
  const DOCS = hash(200);
  const baseTrees = (): Record<string, ArtifactsTreeEntry[]> => ({
    [ROOT]: [entry("src", "tree", SRC), entry("docs", "tree", DOCS), entry("a.txt", "blob")],
    [SRC]: [entry("index.ts", "blob")],
    [DOCS]: [entry("guide.md", "blob")],
  });

  it("re-reads no directories for a tree it has already walked", async () => {
    const { kv } = memoryKV();
    const treeCache = kvTreeListingCache(kv, "proj_1", logger);
    const first = fakeArtifacts(baseTrees());
    await readRepoViewNative(first.artifacts, REMOTE, logger, "main", { treeCache });
    expect(first.repo.readTree).toHaveBeenCalledTimes(3);

    const second = fakeArtifacts(baseTrees());
    const result = await readRepoViewNative(second.artifacts, REMOTE, logger, "main", {
      treeCache,
    });

    expect(second.repo.readTree).not.toHaveBeenCalled();
    expect([...(result.success ? (result.data.files ?? []) : [])].sort()).toEqual([
      "a.txt",
      "docs/guide.md",
      "src/index.ts",
    ]);
  });

  it("after a push, reads only the trees on the changed path", async () => {
    const { kv } = memoryKV();
    const treeCache = kvTreeListingCache(kv, "proj_1", logger);
    await readRepoViewNative(fakeArtifacts(baseTrees()).artifacts, REMOTE, logger, "main", {
      treeCache,
    });

    // A file added under src/: src and the root get new hashes; docs does not.
    const NEW_ROOT = hash(300);
    const NEW_SRC = hash(301);
    const pushed = fakeArtifacts(
      {
        [NEW_ROOT]: [
          entry("src", "tree", NEW_SRC),
          entry("docs", "tree", DOCS),
          entry("a.txt", "blob"),
        ],
        [NEW_SRC]: [entry("index.ts", "blob"), entry("new.ts", "blob")],
      },
      { log: [commit("b".repeat(40), { treeHash: NEW_ROOT })] },
    );

    const result = await readRepoViewNative(pushed.artifacts, REMOTE, logger, "main", {
      treeCache,
    });

    expect(pushed.repo.readTree.mock.calls.map(([h]) => h).sort()).toEqual(
      [NEW_ROOT, NEW_SRC].sort(),
    );
    expect(result.success && result.data.files).toContain("src/new.ts");
    expect(result.success && result.data.files).toContain("docs/guide.md");
  });

  it("does not count cached directories against the read cap", async () => {
    const { kv } = memoryKV();
    const treeCache = kvTreeListingCache(kv, "proj_1", logger);
    const dirs = Array.from({ length: MAX_TREE_READS }, (_, i) =>
      entry(`d${i}`, "tree", hash(1000 + i)),
    );
    for (const d of dirs) await treeCache.put(d.hash, ["f.txt"]);
    const { artifacts } = fakeArtifacts({ [ROOT]: dirs });

    const result = await readRepoViewNative(artifacts, REMOTE, logger, "main", { treeCache });

    expect(result.success && result.data.files?.length).toBe(MAX_TREE_READS);
  });

  it("defers listing writes to waitUntil when given one", async () => {
    const { kv, store } = memoryKV();
    const deferred: Promise<unknown>[] = [];
    const { artifacts } = fakeArtifacts(baseTrees());

    await readRepoViewNative(artifacts, REMOTE, logger, "main", {
      treeCache: kvTreeListingCache(kv, "proj_1", logger),
      waitUntil: (p) => deferred.push(p),
    });

    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(store.size).toBe(3);
  });

  it("reads a README whose name is not the usual spelling", async () => {
    const { artifacts, repo } = fakeArtifacts(
      { [ROOT]: [entry("readme.md", "blob")] },
      { readme: "lower" },
    );

    const result = await readRepoViewNative(artifacts, REMOTE, logger);

    expect(result.success && result.data).toMatchObject({ readme: "lower", complete: true });
    expect(repo.readFile).toHaveBeenCalledWith({ ref: HEAD, path: "readme.md" });
  });
});

describe("kvTreeListingCache", () => {
  it("keeps projects apart even for the same tree hash", async () => {
    const { kv } = memoryKV();
    await kvTreeListingCache(kv, "proj_a", logger).put(ROOT, ["secret.txt"]);

    expect(await kvTreeListingCache(kv, "proj_b", logger).get(ROOT)).toBeNull();
    expect(await kvTreeListingCache(kv, "proj_a", logger).get(ROOT)).toEqual(["secret.txt"]);
  });

  it("does not store a listing over the size cap", async () => {
    const { kv, store } = memoryKV();
    await kvTreeListingCache(kv, "proj_1", logger).put(ROOT, ["x".repeat(TREE_LISTING_MAX_BYTES)]);
    expect(store.size).toBe(0);
  });

  it("treats a corrupt entry or a KV failure as a miss", async () => {
    const { kv, store } = memoryKV();
    const cache = kvTreeListingCache(kv, "proj_1", logger);
    await cache.put(ROOT, ["a"]);
    store.set([...store.keys()][0] as string, "{not json");
    expect(await cache.get(ROOT)).toBeNull();

    const broken = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        throw new Error("kv down");
      },
    } as unknown as KVNamespace;
    const brokenCache = kvTreeListingCache(broken, "proj_1", logger);
    expect(await brokenCache.get(ROOT)).toBeNull();
    await expect(brokenCache.put(ROOT, ["a"])).resolves.toBeUndefined();
  });
});

describe("kvTagDetailCache", () => {
  const OID = "d".repeat(40);

  it("returns what it stored, and nothing for another project", async () => {
    const { kv } = memoryKV();
    const details = { message: "release one", tagger: "t <t@x.com>", timestamp: 7 };
    await kvTagDetailCache(kv, "proj_1", logger).put(OID, details);

    expect(await kvTagDetailCache(kv, "proj_1", logger).get(OID)).toEqual(details);
    expect(await kvTagDetailCache(kv, "proj_2", logger).get(OID)).toBeNull();
  });

  it("stores a tag with no message or tagger as a hit, not a miss", async () => {
    const { kv } = memoryKV();
    const cache = kvTagDetailCache(kv, "proj_1", logger);
    await cache.put(OID, {});
    expect(await cache.get(OID)).toEqual({});
  });

  it("treats a malformed entry as a miss", async () => {
    const { kv, store } = memoryKV();
    const cache = kvTagDetailCache(kv, "proj_1", logger);
    await cache.put(OID, { message: "ok" });
    const [key] = [...store.keys()] as [string];

    for (const bad of [
      "not json",
      "[]",
      "null",
      '{"message":1}',
      '{"tagger":1}',
      '{"timestamp":"x"}',
    ]) {
      store.set(key, bad);
      expect(await cache.get(OID)).toBeNull();
    }
  });

  it("does not store an oversized message", async () => {
    const { kv, store } = memoryKV();
    await kvTagDetailCache(kv, "proj_1", logger).put(OID, { message: "x".repeat(70_000) });
    expect(store.size).toBe(0);
  });

  it("survives a KV that throws on read and on write", async () => {
    const kv = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        throw new Error("kv down");
      },
    } as unknown as KVNamespace;
    const cache = kvTagDetailCache(kv, "proj_1", logger);
    expect(await cache.get(OID)).toBeNull();
    await expect(cache.put(OID, { message: "m" })).resolves.toBeUndefined();
  });
});

describe("loadRepoViewPreferNative", () => {
  beforeEach(() => {
    vi.mocked(loadRepoView).mockReset();
  });

  it("does not clone when the native read succeeds", async () => {
    const { artifacts } = fakeArtifacts({ [ROOT]: [entry("a.txt", "blob")] });

    const result = await loadRepoViewPreferNative(artifacts, REMOTE, "tok", logger, "main");

    expect(result.success).toBe(true);
    expect(vi.mocked(loadRepoView)).not.toHaveBeenCalled();
  });

  it("falls back to a clone when the native read fails", async () => {
    const { artifacts, repo } = fakeArtifacts({});
    repo.log.mockRejectedValue(new Error("INTERNAL_ERROR"));
    vi.mocked(loadRepoView).mockResolvedValue({
      success: true,
      data: { headSha: HEAD, files: ["CLONED.md"], commits: [], readme: null, complete: true },
    });

    const result = await loadRepoViewPreferNative(artifacts, REMOTE, "tok", logger, "dev");

    expect(vi.mocked(loadRepoView)).toHaveBeenCalledWith(REMOTE, "tok", logger, "dev");
    expect(result.success && result.data.files).toEqual(["CLONED.md"]);
  });
});

describe("single-purpose native readers", () => {
  beforeEach(() => {
    vi.mocked(readFileFromRepo).mockReset();
    vi.mocked(getCommitLog).mockReset();
    vi.mocked(listFilesInRepo).mockReset();
  });

  it("reads a file natively, and reports a missing one as FS_ERROR without cloning", async () => {
    const { artifacts } = fakeArtifacts({ [ROOT]: [entry("README.md", "blob")] });

    const found = await readFileFromRepoPreferNative(artifacts, REMOTE, "tok", "README.md", logger);
    const missing = await readFileFromRepoPreferNative(artifacts, REMOTE, "tok", "nope.ts", logger);

    expect(found).toEqual({ success: true, data: "# Hello" });
    expect(missing.success).toBe(false);
    if (!missing.success) expect(missing.error.code).toBe("FS_ERROR");
    expect(vi.mocked(readFileFromRepo)).not.toHaveBeenCalled();
  });

  it("falls back to a clone for a file when the native read fails", async () => {
    const { artifacts, repo } = fakeArtifacts({});
    repo.readFile.mockRejectedValue(new Error("INTERNAL_ERROR"));
    vi.mocked(readFileFromRepo).mockResolvedValue({ success: true, data: "cloned" });

    const result = await readFileFromRepoPreferNative(
      artifacts,
      REMOTE,
      "tok",
      "a.ts",
      logger,
      "dev",
    );

    expect(result).toEqual({ success: true, data: "cloned" });
    expect(vi.mocked(readFileFromRepo)).toHaveBeenCalledWith(REMOTE, "tok", "a.ts", logger, "dev");
  });

  it("never reads more history than the 50 commits the clone path returned", async () => {
    const { artifacts, repo } = fakeArtifacts({});

    await getCommitLogPreferNative(artifacts, REMOTE, "tok", logger, 1000, "main");

    expect(repo.log).toHaveBeenCalledWith({ ref: "main", limit: 50 });
  });

  it("reads the commit log natively", async () => {
    const { artifacts, repo } = fakeArtifacts({});

    const result = await getCommitLogPreferNative(artifacts, REMOTE, "tok", logger, 1, "main");

    expect(repo.log).toHaveBeenCalledWith({ ref: "main", limit: 1 });
    expect(result.success && result.data[0]?.sha).toBe(HEAD);
    expect(vi.mocked(getCommitLog)).not.toHaveBeenCalled();
  });

  it("leaves an unresolvable ref to the clone path, whose error callers rely on", async () => {
    const { artifacts } = fakeArtifacts({}, { log: [] });
    vi.mocked(getCommitLog).mockResolvedValue({ success: true, data: [] });

    await getCommitLogPreferNative(artifacts, REMOTE, "tok", logger, 1, "gone");

    expect(vi.mocked(getCommitLog)).toHaveBeenCalledWith(REMOTE, "tok", logger, 1, "gone");
  });

  it("lists files natively", async () => {
    const { artifacts } = fakeArtifacts({ [ROOT]: [entry("a.txt", "blob")] });

    const result = await listFilesInRepoPreferNative(artifacts, REMOTE, "tok", logger);

    expect(result).toEqual({ success: true, data: ["a.txt"] });
    expect(vi.mocked(listFilesInRepo)).not.toHaveBeenCalled();
  });

  // Every reader opens its repo through withArtifactsRepo, so every one must
  // refuse a same-named repo from another namespace — never serve its content.
  const OTHER_NAMESPACE =
    "https://acct.artifacts.cloudflare.net/git/stratum-staging/owner__repo.git";
  const mismatched = () => {
    const fake = fakeArtifacts({ [ROOT]: [entry("README.md", "blob")] });
    fake.repo.info.mockResolvedValue({
      name: "owner__repo",
      remote: OTHER_NAMESPACE,
      defaultBranch: "main",
    });
    return fake;
  };

  it("does not serve a file from a same-named repo in another namespace", async () => {
    vi.mocked(readFileFromRepo).mockResolvedValue({ success: true, data: "from the clone" });

    const result = await readFileFromRepoPreferNative(
      mismatched().artifacts,
      REMOTE,
      "tok",
      "README.md",
      logger,
    );

    expect(result).toEqual({ success: true, data: "from the clone" });
    expect(vi.mocked(readFileFromRepo)).toHaveBeenCalledTimes(1);
  });

  it("does not serve a commit log from a same-named repo in another namespace", async () => {
    vi.mocked(getCommitLog).mockResolvedValue({ success: true, data: [] });

    const result = await getCommitLogPreferNative(mismatched().artifacts, REMOTE, "tok", logger);

    expect(result).toEqual({ success: true, data: [] });
    expect(vi.mocked(getCommitLog)).toHaveBeenCalledTimes(1);
  });

  it("does not serve a file listing from a same-named repo in another namespace", async () => {
    vi.mocked(listFilesInRepo).mockResolvedValue({ success: true, data: [] });

    const result = await listFilesInRepoPreferNative(mismatched().artifacts, REMOTE, "tok", logger);

    expect(result).toEqual({ success: true, data: [] });
    expect(vi.mocked(listFilesInRepo)).toHaveBeenCalledTimes(1);
  });
});
