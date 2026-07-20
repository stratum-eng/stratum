import { describe, expect, it, vi } from "vitest";
import { computeBackfillPlan } from "../src/storage/backfill-plan";
import type { Env } from "../src/types";
import type { Logger } from "../src/utils/logger";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

/** Fake D1 returning a per-table NULL-project_id count from a map. */
function makeD1(nullCounts: Record<string, number>): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: () => ({ first: async () => null }),
      first: async () => {
        const match = sql.match(/FROM (\w+) WHERE project_id IS NULL/);
        const table = match?.[1] ?? "";
        return { n: nullCounts[table] ?? 0 };
      },
    }),
  } as unknown as D1Database;
}

/** Fake KV serving project entries for listProjects (single page). */
function makeKV(projects: { id: string; name: string }[]): KVNamespace {
  const store = new Map<string, string>();
  for (const p of projects) {
    store.set(`project:@ns:${p.id}`, JSON.stringify({ ...p, slug: p.name, namespace: "@ns" }));
  }
  return {
    list: async () => ({
      keys: [...store.keys()].map((name) => ({ name })),
      list_complete: true,
      cursor: "",
    }),
    get: async (key: string) => store.get(key) ?? null,
  } as unknown as KVNamespace;
}

describe("computeBackfillPlan (read-only)", () => {
  it("reports per-table NULL-project_id counts and their total", async () => {
    const env = {
      DB: makeD1({ changes: 3, issues: 2, webhooks: 1 }),
      STATE: makeKV([{ id: "proj_a", name: "alpha" }]),
    } as unknown as Env;

    const result = await computeBackfillPlan(env, logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.totalNullRows).toBe(6);
    expect(result.data.tables.find((t) => t.table === "changes")?.nullRows).toBe(3);
    expect(result.data.tables).toHaveLength(7); // all seven tables reported
  });

  it("classifies unique names as backfillable and shared names as collisions", async () => {
    const env = {
      DB: makeD1({}),
      STATE: makeKV([
        { id: "proj_a", name: "alpha" }, // unique
        { id: "proj_b1", name: "beta" }, // collision with proj_b2
        { id: "proj_b2", name: "beta" },
      ]),
    } as unknown as Env;

    const result = await computeBackfillPlan(env, logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.projects.total).toBe(3);
    expect(result.data.projects.backfillable).toBe(1); // only "alpha"
    expect(result.data.projects.collisions).toEqual([
      { name: "beta", projectIds: ["proj_b1", "proj_b2"] },
    ]);
  });
});
