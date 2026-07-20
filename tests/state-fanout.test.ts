import { describe, expect, it, vi } from "vitest";
import { listProjects } from "../src/storage/state";
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
