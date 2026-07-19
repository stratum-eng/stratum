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

  it("fails safe on a garbage retention value: keeps everything, deletes nothing", async () => {
    const r2 = makeFakeR2();
    for (const d of ["01", "02", "03"]) await seedRun(r2, `2026-07-${d}T00:00:00Z`, true);

    // A non-numeric BACKUP_RETENTION reaches pruneRuns as NaN; slice(NaN) would
    // otherwise coerce to 0 and delete every run (including the in-flight one).
    const pruned = await pruneRuns(r2, Number.NaN, logger);
    expect(pruned.success && pruned.data.prunedRuns).toBe(0);
    expect([...r2.store.keys()].some((k) => k.startsWith("2026-07-01"))).toBe(true);
  });

  it("paginates listing across R2 pages", async () => {
    const r2 = makeFakeR2(2); // tiny page size forces pagination
    for (const d of ["01", "02", "03", "04", "05"])
      await seedRun(r2, `2026-07-${d}T00:00:00Z`, true);
    const runs = await listRuns(r2, logger);
    expect(runs.success && runs.data.length).toBe(5);
  });
});
