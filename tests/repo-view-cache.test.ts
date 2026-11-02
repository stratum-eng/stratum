import { describe, expect, it, vi } from "vitest";
import type { RepoView } from "../src/storage/git-ops";
import {
  REPO_VIEW_CACHE_MAX_BYTES,
  claimRepoViewRefresh,
  readRepoViewCache,
  releaseRepoViewRefresh,
  writeRepoViewCache,
} from "../src/storage/repo-view-cache";
import type { Logger } from "../src/utils/logger";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
} as unknown as Logger;

const project = { id: "proj_1" };
const TIP = "a".repeat(40);

function makeKV(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

function view(overrides: Partial<RepoView> = {}): RepoView {
  return {
    headSha: TIP,
    files: ["README.md"],
    commits: [{ sha: TIP, message: "m", author: "A <a@x>", timestamp: 1 }],
    readme: "# hi",
    complete: true,
    ...overrides,
  };
}

describe("repo view cache", () => {
  it("round-trips a view for the commit it was taken at", async () => {
    const { kv } = makeKV();
    await writeRepoViewCache(kv, project, "main", view(), logger);

    const cached = await readRepoViewCache(kv, project, "main", logger);

    expect(cached).toEqual(view());
  });

  it("returns an entry with the commit it was taken at, so the caller can tell it is behind", async () => {
    const { kv } = makeKV();
    await writeRepoViewCache(kv, project, "main", view(), logger);

    const cached = await readRepoViewCache(kv, project, "main", logger);

    expect(cached?.headSha).toBe(TIP);
  });

  it("keeps branches apart, including ones whose names need escaping", async () => {
    const { kv } = makeKV();
    await writeRepoViewCache(kv, project, "release/2.x", view(), logger);

    expect(await readRepoViewCache(kv, project, "main", logger)).toBeNull();
    expect(await readRepoViewCache(kv, project, "release/2.x", logger)).not.toBeNull();
  });

  it("does not write a view whose file listing failed", async () => {
    const { kv, store } = makeKV();
    await writeRepoViewCache(kv, project, "main", view({ files: null, complete: false }), logger);
    expect(store.size).toBe(0);
  });

  it("does not write an incomplete view even when its file list is present", async () => {
    const { kv, store } = makeKV();
    await writeRepoViewCache(kv, project, "main", view({ complete: false }), logger);
    expect(store.size).toBe(0);
  });

  it("caches a complete view of a repo that has no README", async () => {
    const { kv } = makeKV();
    await writeRepoViewCache(kv, project, "main", view({ readme: null }), logger);
    expect(await readRepoViewCache(kv, project, "main", logger)).toEqual(view({ readme: null }));
  });

  it("does not write a view over the size cap", async () => {
    const { kv, store } = makeKV();
    const huge = view({ readme: "x".repeat(REPO_VIEW_CACHE_MAX_BYTES) });
    await writeRepoViewCache(kv, project, "main", huge, logger);
    expect(store.size).toBe(0);
  });

  it("treats a corrupt or foreign-shaped entry as a miss", async () => {
    const { kv, store } = makeKV();
    await writeRepoViewCache(kv, project, "main", view(), logger);
    const key = [...store.keys()][0] as string;

    store.set(key, "{not json");
    expect(await readRepoViewCache(kv, project, "main", logger)).toBeNull();

    store.set(key, JSON.stringify({ v: 99, headSha: TIP, files: [], commits: [], readme: null }));
    expect(await readRepoViewCache(kv, project, "main", logger)).toBeNull();
  });

  it("treats a KV failure as a miss rather than an error", async () => {
    const kv = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        throw new Error("kv down");
      },
    } as unknown as KVNamespace;

    await expect(writeRepoViewCache(kv, project, "main", view(), logger)).resolves.toBeUndefined();
    expect(await readRepoViewCache(kv, project, "main", logger)).toBeNull();
  });

  it("lets one viewer claim a branch's refresh until the claim expires", async () => {
    const { kv, store } = makeKV();

    expect(await claimRepoViewRefresh(kv, project, "main", logger)).toBe(true);
    expect(await claimRepoViewRefresh(kv, project, "main", logger)).toBe(false);
    // Another branch has its own claim.
    expect(await claimRepoViewRefresh(kv, project, "release/2.x", logger)).toBe(true);

    // The TTL lapsing — in KV and in this isolate — is what frees it.
    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ["Date"] });
    try {
      for (const key of store.keys()) if (key.endsWith(":main")) store.delete(key);
      expect(await claimRepoViewRefresh(kv, project, "main", logger)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a burst of concurrent viewers one claim between them", async () => {
    const { kv } = makeKV();

    const claims = await Promise.all([
      claimRepoViewRefresh(kv, project, "main", logger),
      claimRepoViewRefresh(kv, project, "main", logger),
      claimRepoViewRefresh(kv, project, "main", logger),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("defers to a claim another isolate wrote to KV", async () => {
    const { kv, store } = makeKV();
    store.set("repo_view_refresh:proj_1:main", "1");

    expect(await claimRepoViewRefresh(kv, project, "main", logger)).toBe(false);
  });

  it("declines a refresh claim when KV fails", async () => {
    const kv = {
      get: async () => {
        throw new Error("kv down");
      },
    } as unknown as KVNamespace;

    expect(await claimRepoViewRefresh(kv, project, "main", logger)).toBe(false);
  });

  it("keys entries by project id, so a project recreated at the same path never reads the old one's view", async () => {
    const { kv } = makeKV();
    await writeRepoViewCache(kv, { id: "proj_old" }, "main", view(), logger);

    expect(await readRepoViewCache(kv, { id: "proj_new" }, "main", logger)).toBeNull();
  });

  it("frees a released claim at once, in KV and in this isolate", async () => {
    const { kv, store } = makeKV();
    expect(await claimRepoViewRefresh(kv, project, "main", logger)).toBe(true);

    await releaseRepoViewRefresh(kv, project, "main", logger);

    expect(store.size).toBe(0);
    expect(await claimRepoViewRefresh(kv, project, "main", logger)).toBe(true);
  });
});
