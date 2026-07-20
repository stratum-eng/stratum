import { describe, expect, it, vi } from "vitest";
import { listProjects, listProjectsByNamespace, listWorkspaces } from "../src/storage/state";
import type { Logger } from "../src/utils/logger";

const log = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => log),
} as unknown as Logger;

/** Fake KV that records the peak number of concurrent get() calls. */
function makeCountingKV(projectCount: number): { kv: KVNamespace; peak: () => number } {
  const store = new Map<string, string>();
  for (let i = 0; i < projectCount; i++) {
    store.set(
      `project:@o:p${i}`,
      JSON.stringify({ id: `proj_${i}`, name: `p${i}`, slug: `p${i}` }),
    );
  }
  let inFlight = 0;
  let peak = 0;
  const kv = {
    list: async (_opts?: { prefix?: string; cursor?: string }) => ({
      keys: [...store.keys()].map((name) => ({ name })),
      list_complete: true,
      cursor: "",
    }),
    get: async (key: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1)); // force overlap
      inFlight--;
      return store.get(key) ?? null;
    },
  } as unknown as KVNamespace;
  return { kv, peak: () => peak };
}

describe("listProjects KV fan-out is bounded", () => {
  it("returns every project but never exceeds the concurrency cap", async () => {
    const { kv, peak } = makeCountingKV(60);
    const result = await listProjects(kv, log);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(60); // all projects, none dropped
    // The unbounded version would peak at 60 concurrent gets; bounded stays ≤ 25.
    expect(peak()).toBeLessThanOrEqual(25);
  });
});

/** Fake KV with REAL cursor pagination + prefix filtering (small pages). */
function makePaginatedKV(entries: Record<string, string>, pageSize: number): KVNamespace {
  return {
    list: async (opts?: { prefix?: string; cursor?: string }) => {
      const prefix = opts?.prefix ?? "";
      const all = Object.keys(entries)
        .filter((k) => k.startsWith(prefix))
        .sort();
      const start = opts?.cursor ? Number(opts.cursor) : 0;
      const page = all.slice(start, start + pageSize);
      const complete = start + pageSize >= all.length;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: complete,
        cursor: complete ? "" : String(start + pageSize),
      };
    },
    get: async (key: string) => entries[key] ?? null,
  } as unknown as KVNamespace;
}

describe("KV list cursor is followed to exhaustion (no page-1 truncation)", () => {
  it("listProjectsByNamespace returns projects spanning multiple KV pages", async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 7; i++) {
      entries[`project:@ns:p${i}`] = JSON.stringify({
        id: `proj_${i}`,
        name: `p${i}`,
        slug: `p${i}`,
        namespace: "@ns",
      });
    }
    // A project in another namespace must NOT leak in (prefix filtering).
    entries["project:@other:x"] = JSON.stringify({ id: "x", name: "x", slug: "x" });
    const kv = makePaginatedKV(entries, 3); // 3 per page → @ns spans 3 pages

    const result = await listProjectsByNamespace(kv, "@ns", log);

    expect(result.success && result.data).toHaveLength(7);
  });

  it("listWorkspaces returns workspaces spanning multiple KV pages", async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      entries[`workspace:proj_1:w${i}`] = JSON.stringify({
        name: `w${i}`,
        parent: "proj_1",
        remote: "r",
        createdAt: "t",
      });
    }
    const kv = makePaginatedKV(entries, 2); // 2 per page → 3 pages

    const result = await listWorkspaces(kv, "proj_1", log);

    expect(result.success && result.data).toHaveLength(5);
  });
});
