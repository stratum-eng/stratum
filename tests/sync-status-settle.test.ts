/**
 * A project stopped following its source for good after one sync: the job that
 * ran it updated the project entry and left the sync status saying "in
 * progress", which is what the next push and the next manual sync consult
 * before standing aside.
 */
import { describe, expect, it } from "vitest";
import {
  SYNC_IN_PROGRESS_TTL_MS,
  getSyncStatus,
  isSyncInProgress,
  setSyncInProgress,
  settleSyncStatus,
} from "../src/storage/sync";
import { createLogger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";

const logger = createLogger({ component: "Test" });

async function statusOf(kv: ReturnType<typeof makeFakeKV>) {
  const result = await getSyncStatus(kv, "@acme", "api", logger);
  if (!result.success) throw result.error;
  return result.data;
}

describe("isSyncInProgress", () => {
  const now = Date.parse("2026-11-10T12:00:00.000Z");
  const claimed = (msAgo: number) => ({
    lastSyncStatus: "in_progress" as const,
    lastCheckedAt: new Date(now - msAgo).toISOString(),
  });

  it("holds while the claim is fresh", () => {
    expect(isSyncInProgress(claimed(60_000), now)).toBe(true);
    expect(isSyncInProgress(claimed(SYNC_IN_PROGRESS_TTL_MS - 1), now)).toBe(true);
  });

  it("lapses once the claim is older than any sync could run", () => {
    expect(isSyncInProgress(claimed(SYNC_IN_PROGRESS_TTL_MS), now)).toBe(false);
    expect(isSyncInProgress(claimed(19 * 3600_000), now)).toBe(false);
  });

  it("is false for every other state, and for no record", () => {
    for (const lastSyncStatus of ["success", "failed", "idle"] as const) {
      expect(
        isSyncInProgress({ lastSyncStatus, lastCheckedAt: new Date(now).toISOString() }, now),
      ).toBe(false);
    }
    expect(isSyncInProgress(null, now)).toBe(false);
    expect(isSyncInProgress(undefined, now)).toBe(false);
  });

  it("does not trust a claim whose time cannot be read", () => {
    expect(isSyncInProgress({ lastSyncStatus: "in_progress", lastCheckedAt: "" }, now)).toBe(false);
  });
});

describe("settleSyncStatus", () => {
  it("clears the in-progress claim when a sync succeeds, and records the commit", async () => {
    const kv = makeFakeKV();
    await setSyncInProgress(kv, "@acme", "api", logger);
    expect(isSyncInProgress(await statusOf(kv))).toBe(true);

    await settleSyncStatus(kv, "@acme", "api", { status: "success", commit: "abc123" }, logger);

    const status = await statusOf(kv);
    expect(isSyncInProgress(status)).toBe(false);
    expect(status).toMatchObject({
      lastSyncStatus: "success",
      lastSyncedCommit: "abc123",
      hasUpdates: false,
      commitsBehind: 0,
    });
    expect(status?.lastSyncedAt).toBeDefined();
  });

  it("clears it when a sync fails, keeping what was last synced", async () => {
    const kv = makeFakeKV();
    await settleSyncStatus(kv, "@acme", "api", { status: "success", commit: "abc123" }, logger);
    const before = await statusOf(kv);
    await setSyncInProgress(kv, "@acme", "api", logger);

    await settleSyncStatus(
      kv,
      "@acme",
      "api",
      { status: "failed", error: "clone timed out" },
      logger,
    );

    const status = await statusOf(kv);
    expect(status).toMatchObject({
      lastSyncStatus: "failed",
      lastSyncError: "clone timed out",
      lastSyncedCommit: "abc123",
      lastSyncedAt: before?.lastSyncedAt,
    });
  });

  it("keeps the last known commit when a successful sync could not name its own", async () => {
    const kv = makeFakeKV();
    await settleSyncStatus(kv, "@acme", "api", { status: "success", commit: "abc123" }, logger);
    await settleSyncStatus(kv, "@acme", "api", { status: "success" }, logger);
    expect((await statusOf(kv))?.lastSyncedCommit).toBe("abc123");
  });

  it("releases the claim of a job that was dropped, and records no result", async () => {
    const kv = makeFakeKV();
    await settleSyncStatus(kv, "@acme", "api", { status: "success", commit: "abc123" }, logger);
    const before = await statusOf(kv);
    await setSyncInProgress(kv, "@acme", "api", logger);

    await settleSyncStatus(kv, "@acme", "api", { status: "abandoned" }, logger);

    const status = await statusOf(kv);
    expect(isSyncInProgress(status)).toBe(false);
    expect(status).toMatchObject({
      lastSyncStatus: "idle",
      lastSyncedCommit: "abc123",
      lastSyncedAt: before?.lastSyncedAt,
    });
    expect(status?.lastSyncError).toBeUndefined();
  });

  it("leaves a finished sync's result alone when a dropped job reports after it", async () => {
    const kv = makeFakeKV();
    await settleSyncStatus(kv, "@acme", "api", { status: "failed", error: "diverged" }, logger);
    await settleSyncStatus(kv, "@acme", "api", { status: "abandoned" }, logger);
    expect(await statusOf(kv)).toMatchObject({
      lastSyncStatus: "failed",
      lastSyncError: "diverged",
    });
  });

  it("keeps the project's sync settings", async () => {
    const kv = makeFakeKV();
    await kv.put(
      "sync-status:@acme:api",
      JSON.stringify({
        namespace: "@acme",
        slug: "api",
        lastCheckedAt: new Date().toISOString(),
        lastSyncStatus: "in_progress",
        hasUpdates: true,
        autoSyncEnabled: true,
        syncFrequency: 30,
      }),
    );
    await settleSyncStatus(kv, "@acme", "api", { status: "success" }, logger);
    expect(await statusOf(kv)).toMatchObject({ autoSyncEnabled: true, syncFrequency: 30 });
  });

  it("does not throw when the status cannot be written", async () => {
    const kv = makeFakeKV();
    kv.put = async () => {
      throw new Error("KV unavailable");
    };
    await expect(
      settleSyncStatus(kv, "@acme", "api", { status: "success" }, logger),
    ).resolves.toBeUndefined();
  });
});
