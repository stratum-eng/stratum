import { describe, expect, it, vi } from "vitest";
import { getBlob, listRuns, pruneRuns, putBlob } from "../src/storage/backup-store";
import type { Logger } from "../src/utils/logger";
import { makeFakeR2 } from "./helpers/fake-r2";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const bytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);

describe("backup blob codec", () => {
  it("round-trips plaintext when no encryption secret is set", async () => {
    const r2 = makeFakeR2();
    const env = {};
    await putBlob(r2, "run/x.ndjson", bytes("hello"), env, logger);
    const got = await getBlob(r2, "run/x.ndjson", env, logger);
    expect(got.success && got.data && str(got.data)).toBe("hello");
    // Stored form is not the raw bytes (has a format header).
    expect(r2.store.get("run/x.ndjson")?.length).toBe(6);
  });

  it("encrypts at rest and round-trips with the secret", async () => {
    const r2 = makeFakeR2();
    const env = { BACKUP_ENCRYPTION_SECRET: "s3cr3t" };
    await putBlob(r2, "run/x.pack", bytes("payload"), env, logger);
    const stored = r2.store.get("run/x.pack");
    expect(stored && str(stored)).not.toContain("payload"); // ciphertext, not plaintext
    const got = await getBlob(r2, "run/x.pack", env, logger);
    expect(got.success && got.data && str(got.data)).toBe("payload");
  });

  it("fails to read an encrypted blob without the secret", async () => {
    const r2 = makeFakeR2();
    await putBlob(r2, "run/x", bytes("secret"), { BACKUP_ENCRYPTION_SECRET: "k" }, logger);
    const got = await getBlob(r2, "run/x", {}, logger);
    expect(got.success).toBe(false);
  });

  it("returns null for a missing blob", async () => {
    const r2 = makeFakeR2();
    const got = await getBlob(r2, "nope", {}, logger);
    expect(got.success && got.data).toBeNull();
  });
});

describe("run listing + retention", () => {
  async function seedRun(r2: ReturnType<typeof makeFakeR2>, ts: string, complete: boolean) {
    await putBlob(r2, `${ts}/d1/changes.ndjson`, bytes("{}"), {}, logger);
    await putBlob(r2, `${ts}/repos/p1.pack`, bytes("pk"), {}, logger);
    if (complete) await putBlob(r2, `${ts}/_manifest.json`, bytes("{}"), {}, logger);
  }

  it("lists runs newest-first and flags incomplete (no manifest) runs", async () => {
    const r2 = makeFakeR2();
    await seedRun(r2, "2026-07-01T00:00:00Z", true);
    await seedRun(r2, "2026-07-03T00:00:00Z", false); // crashed run
    await seedRun(r2, "2026-07-02T00:00:00Z", true);

    const runs = await listRuns(r2, logger);
    expect(runs.success).toBe(true);
    if (!runs.success) return;
    expect(runs.data.map((r) => r.runTs)).toEqual([
      "2026-07-03T00:00:00Z",
      "2026-07-02T00:00:00Z",
      "2026-07-01T00:00:00Z",
    ]);
    expect(runs.data.find((r) => r.runTs === "2026-07-03T00:00:00Z")?.complete).toBe(false);
  });

  it("prunes whole older runs, keeping the newest N intact", async () => {
    const r2 = makeFakeR2();
    for (const d of ["01", "02", "03", "04"]) await seedRun(r2, `2026-07-${d}T00:00:00Z`, true);

    const pruned = await pruneRuns(r2, 2, logger);
    expect(pruned.success && pruned.data.prunedRuns).toBe(2);

    // Newest two survive with all their files; oldest two are gone entirely.
    expect(r2.store.has("2026-07-04T00:00:00Z/_manifest.json")).toBe(true);
    expect(r2.store.has("2026-07-03T00:00:00Z/repos/p1.pack")).toBe(true);
    expect([...r2.store.keys()].some((k) => k.startsWith("2026-07-02"))).toBe(false);
    expect([...r2.store.keys()].some((k) => k.startsWith("2026-07-01"))).toBe(false);
  });

  it("counts retention by complete runs: collects crash garbage, protects the in-flight prefix", async () => {
    const r2 = makeFakeR2();
    await seedRun(r2, "2026-07-01T00:00:00Z", true); // old complete, beyond window
    await seedRun(r2, "2026-07-02T00:00:00Z", true); // complete, within window
    await seedRun(r2, "2026-07-03T00:00:00Z", false); // crashed run in the middle
    await seedRun(r2, "2026-07-04T00:00:00Z", true); // complete, within window
    await seedRun(r2, "2026-07-05T00:00:00Z", false); // newest = simulated in-flight

    const pruned = await pruneRuns(r2, 2, logger);
    expect(pruned.success && pruned.data.prunedRuns).toBe(2); // 07-03 garbage + 07-01 old

    const survives = (ts: string) =>
      [...r2.store.keys()].some((k) => k.startsWith(ts.slice(0, 10)));
    expect(survives("2026-07-05")).toBe(true); // in-flight prefix protected
    expect(survives("2026-07-04")).toBe(true); // newest complete
    expect(survives("2026-07-02")).toBe(true); // 2nd-newest complete
    expect(survives("2026-07-03")).toBe(false); // crash garbage collected
    expect(survives("2026-07-01")).toBe(false); // old complete beyond window
  });

  it("fails safe on a garbage retention value: keeps everything, deletes nothing", async () => {
    const r2 = makeFakeR2();
    for (const d of ["01", "02", "03"]) await seedRun(r2, `2026-07-${d}T00:00:00Z`, true);

    // A non-numeric BACKUP_RETENTION reaches pruneRuns as NaN; slice(NaN) would
    // otherwise coerce to 0 and delete every run (including the in-flight one).
    const pruned = await pruneRuns(r2, Number.NaN, logger);
    expect(pruned.success && pruned.data.prunedRuns).toBe(0);
    expect([...r2.store.keys()].some((k) => k.startsWith("2026-07-01"))).toBe(true);
  });

  describe("health-aware retention (#401)", () => {
    async function seedManifest(
      r2: ReturnType<typeof makeFakeR2>,
      ts: string,
      manifest: Record<string, unknown>,
      env: { BACKUP_ENCRYPTION_SECRET?: string } = {},
    ) {
      await putBlob(r2, `${ts}/d1/changes.ndjson`, bytes("{}"), env, logger);
      await putBlob(r2, `${ts}/_manifest.json`, bytes(JSON.stringify(manifest)), env, logger);
    }
    const day = (n: number) => `2026-07-${String(n).padStart(2, "0")}T00:00:00Z`;
    const survives = (r2: ReturnType<typeof makeFakeR2>, ts: string) =>
      [...r2.store.keys()].some((k) => k.startsWith(`${ts}/`));

    it("keeps the healthy run when N+1 unhealthy runs follow it", async () => {
      const r2 = makeFakeR2();
      const keep = 3;
      await seedManifest(r2, day(1), { healthy: true });
      for (let d = 2; d <= keep + 2; d++) await seedManifest(r2, day(d), { healthy: false });

      const pruned = await pruneRuns(r2, keep, logger);
      expect(pruned.success).toBe(true);

      expect(survives(r2, day(1))).toBe(true); // the last good backup
      // Unhealthy runs still age out: only those among the newest `keep` survive.
      expect([2, 3, 4, 5].filter((d) => survives(r2, day(d)))).toEqual([3, 4, 5]);
    });

    it("does not let unhealthy runs take BACKUP_RETENTION slots", async () => {
      const r2 = makeFakeR2();
      await seedManifest(r2, day(1), { healthy: true });
      await seedManifest(r2, day(2), { healthy: true });
      await seedManifest(r2, day(3), { healthy: true });
      await seedManifest(r2, day(4), { healthy: false });
      await seedManifest(r2, day(5), { healthy: true });
      await seedManifest(r2, day(6), { healthy: false });

      const pruned = await pruneRuns(r2, 3, logger);

      // Three healthy runs fill the window (5, 3, 2); the unhealthy 6 and 4 are
      // within the newest three complete runs, so they are kept beside them.
      expect(pruned.success && pruned.data.prunedRuns).toBe(1);
      expect([1, 2, 3, 4, 5, 6].filter((d) => survives(r2, day(d)))).toEqual([2, 3, 4, 5, 6]);
    });

    it("counts manifests without a health field toward the window, but still keeps the newest known-healthy run", async () => {
      const r2 = makeFakeR2();
      await seedManifest(r2, day(1), { healthy: true });
      await seedManifest(r2, day(2), {}); // predates the `healthy` field
      await seedManifest(r2, day(3), {});

      await pruneRuns(r2, 2, logger);

      expect([1, 2, 3].filter((d) => survives(r2, day(d)))).toEqual([1, 2, 3]);
    });

    it("prunes unknown-health runs beyond the window like before", async () => {
      const r2 = makeFakeR2();
      for (let d = 1; d <= 4; d++) await seedManifest(r2, day(d), {});

      const pruned = await pruneRuns(r2, 2, logger);

      expect(pruned.success && pruned.data.prunedRuns).toBe(2);
      expect([1, 2, 3, 4].filter((d) => survives(r2, day(d)))).toEqual([3, 4]);
    });

    it("reads encrypted manifests with the configured secret", async () => {
      const r2 = makeFakeR2();
      const env = { BACKUP_ENCRYPTION_SECRET: "k" };
      await seedManifest(r2, day(1), { healthy: true }, env);
      for (let d = 2; d <= 4; d++) await seedManifest(r2, day(d), { healthy: false }, env);

      await pruneRuns(r2, 1, logger, env);

      expect([1, 2, 3, 4].filter((d) => survives(r2, day(d)))).toEqual([1, 4]);
    });

    it("prunes nothing when a run manifest cannot be read", async () => {
      const r2 = makeFakeR2();
      await seedManifest(r2, day(1), { healthy: true });
      for (let d = 2; d <= 4; d++) await seedManifest(r2, day(d), { healthy: false });
      const realGet = r2.get.bind(r2);
      r2.get = (async (key: string) => {
        if (key.startsWith(day(3))) throw new Error("R2 unavailable");
        return realGet(key);
      }) as typeof r2.get;

      const pruned = await pruneRuns(r2, 1, logger);

      expect(pruned.success).toBe(false);
      expect([1, 2, 3, 4].every((d) => survives(r2, day(d)))).toBe(true);
    });
  });

  it("paginates listing across R2 pages", async () => {
    const r2 = makeFakeR2(2); // tiny page size forces pagination
    for (const d of ["01", "02", "03", "04", "05"])
      await seedRun(r2, `2026-07-${d}T00:00:00Z`, true);
    const runs = await listRuns(r2, logger);
    expect(runs.success && runs.data.length).toBe(5);
  });
});
