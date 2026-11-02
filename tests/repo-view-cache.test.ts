import { describe, expect, it } from "vitest";
import type { RepoView } from "../src/storage/git-ops";
import {
  REPO_VIEW_CACHE_MAX_BYTES,
  readRepoViewCache,
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

const project = { namespace: "@owner", slug: "repo" };
const TIP = "a".repeat(40);

function makeKV(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
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

    const cached = await readRepoViewCache(kv, project, "main", TIP, logger);

    expect(cached).toEqual(view());
  });

  it("misses once the branch tip is a different commit", async () => {
    const { kv } = makeKV();
    await writeRepoViewCache(kv, project, "main", view(), logger);

    expect(await readRepoViewCache(kv, project, "main", "b".repeat(40), logger)).toBeNull();
  });

  it("keeps branches apart, including ones whose names need escaping", async () => {
    const { kv } = makeKV();
    await writeRepoViewCache(kv, project, "release/2.x", view(), logger);

    expect(await readRepoViewCache(kv, project, "main", TIP, logger)).toBeNull();
    expect(await readRepoViewCache(kv, project, "release/2.x", TIP, logger)).not.toBeNull();
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
    expect(await readRepoViewCache(kv, project, "main", TIP, logger)).toEqual(
      view({ readme: null }),
    );
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
    expect(await readRepoViewCache(kv, project, "main", TIP, logger)).toBeNull();

    store.set(key, JSON.stringify({ v: 99, headSha: TIP, files: [], commits: [], readme: null }));
    expect(await readRepoViewCache(kv, project, "main", TIP, logger)).toBeNull();
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
    expect(await readRepoViewCache(kv, project, "main", TIP, logger)).toBeNull();
  });
});
