import { describe, expect, it, vi } from "vitest";
import type { RepoSnapshot } from "../src/backup/repo-snapshot";
import type { BackupDeps } from "../src/backup/run-backup";
import { runBackup } from "../src/backup/run-backup";
import { RUN_MANIFEST_KEY } from "../src/storage/backup-store";
import { setProject } from "../src/storage/state";
import type { Env, ProjectEntry } from "../src/types";
import { ok } from "../src/utils/result";
import { makeFakeD1 } from "./helpers/fake-d1";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeFakeR2 } from "./helpers/fake-r2";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Parameters<typeof runBackup>[1];

function project(id: string): ProjectEntry {
  return {
    id,
    name: id,
    slug: id,
    namespace: "@owner",
    ownerId: "u1",
    ownerType: "user",
    remote: `https://acct.artifacts.cloudflare.net/git/@owner/${id}.git`,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function fakeSnapshot(id: string): RepoSnapshot {
  return {
    pack: new Uint8Array([1, 2, 3]),
    manifest: {
      projectId: id,
      project: project(id),
      tipSha: `sha-${id}`,
      objectCount: 1,
      byteCount: 3,
      capturedAt: "2026-07-19T00:00:00Z",
    },
  };
}

/** Snapshot dep that always succeeds — keeps the Artifacts clone out of the test. */
const okSnapshots: BackupDeps = {
  snapshotRepo: async (_env, p) => ok({ status: "ok", snapshot: fakeSnapshot(p.id) }),
};

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    BACKUPS: makeFakeR2(),
    DB: makeFakeD1(),
    STATE: makeFakeKV(),
    ...overrides,
  } as unknown as Env;
}

describe("runBackup orchestrator", () => {
  it("writes D1 + KV + repo blobs under one run, manifest LAST", async () => {
    const env = makeEnv();
    await setProject(env.STATE as KVNamespace, project("alpha"), logger);
    (env.DB as unknown as { seed: (t: string, r: unknown[]) => void }).seed("users", [
      { id: "u1", name: "A" },
    ]);

    const summary = await runBackup(env, logger, "2026-07-19T06:00:00Z", okSnapshots);

    const bucket = env.BACKUPS as unknown as { store: Map<string, Uint8Array> };
    const keys = [...bucket.store.keys()];
    expect(keys).toContain("2026-07-19T06:00:00Z/d1/users.ndjson");
    expect(keys).toContain("2026-07-19T06:00:00Z/kv/projects.json");
    expect(keys).toContain("2026-07-19T06:00:00Z/repos/alpha.pack");
    expect(keys).toContain("2026-07-19T06:00:00Z/repos/alpha.manifest.json");
    // Manifest is the final write — its presence marks the run complete.
    expect(keys[keys.length - 1]).toBe(`2026-07-19T06:00:00Z/${RUN_MANIFEST_KEY}`);

    expect(summary.repos.backedUp).toBe(1);
    expect(summary.healthy).toBe(true);
    expect(summary.kv.projects).toBe(1);
    expect(summary.d1.find((t) => t.table === "users")?.rowCount).toBe(1);
  });

  it("rotates repo coverage across runs via the cursor when capped", async () => {
    const env = makeEnv({ MAX_REPOS_PER_RUN: "1" } as Partial<Env>);
    await setProject(env.STATE as KVNamespace, project("alpha"), logger);
    await setProject(env.STATE as KVNamespace, project("bravo"), logger);

    const run1 = await runBackup(env, logger, "2026-07-19T06:00:00Z", okSnapshots);
    expect(run1.repos.backedUp).toBe(1);
    expect(run1.repos.deferred).toBe(1);

    const cursors1 = (env.DB as unknown as { rows: (t: string) => { project_id: string }[] }).rows(
      "backup_state",
    );
    expect(cursors1.length).toBe(1);
    const firstId = cursors1[0]?.project_id;

    const run2 = await runBackup(env, logger, "2026-07-19T07:00:00Z", okSnapshots);
    expect(run2.repos.backedUp).toBe(1);

    const cursors2 = (env.DB as unknown as { rows: (t: string) => { project_id: string }[] }).rows(
      "backup_state",
    );
    // Both projects now have a cursor — the second run covered the other one.
    expect(cursors2.map((r) => r.project_id).sort()).toEqual(["alpha", "bravo"]);
    expect(cursors2.length).toBe(2);
    expect(firstId).toBeDefined();
  });

  it("is fail-soft: one repo failing does not abort the run", async () => {
    const env = makeEnv();
    await setProject(env.STATE as KVNamespace, project("good"), logger);
    await setProject(env.STATE as KVNamespace, project("bad"), logger);

    const flaky: BackupDeps = {
      snapshotRepo: async (_env, p) => {
        if (p.id === "bad") throw new Error("clone exploded");
        return ok({ status: "ok", snapshot: fakeSnapshot(p.id) });
      },
    };

    const summary = await runBackup(env, logger, "2026-07-19T06:00:00Z", flaky);

    expect(summary.repos.backedUp).toBe(1);
    expect(summary.repos.failed.map((f) => f.projectId)).toEqual(["bad"]);
    // Run still completed (manifest written) BUT is flagged unhealthy — a reader
    // must not treat this as restorable just because it's "complete".
    expect(summary.healthy).toBe(false);
    const bucket = env.BACKUPS as unknown as { store: Map<string, Uint8Array> };
    expect([...bucket.store.keys()]).toContain(`2026-07-19T06:00:00Z/${RUN_MANIFEST_KEY}`);
  });

  it("skips cleanly when no BACKUPS bucket is configured", async () => {
    const env = makeEnv({ BACKUPS: undefined } as Partial<Env>);
    const summary = await runBackup(env, logger, "2026-07-19T06:00:00Z", okSnapshots);
    expect(summary.skipped).toBe("no-backups-bucket");
    expect(summary.repos.backedUp).toBe(0);
  });

  it("single-flights: refuses to start while another run holds the lock", async () => {
    const env = makeEnv();
    await setProject(env.STATE as KVNamespace, project("alpha"), logger);
    await (env.STATE as KVNamespace).put("backup:lock", "2026-07-19T05:00:00Z");

    const summary = await runBackup(env, logger, "2026-07-19T06:00:00Z", okSnapshots);
    expect(summary.skipped).toBe("locked");
    expect(summary.repos.backedUp).toBe(0);
    // Nothing was written for the blocked run.
    const bucket = env.BACKUPS as unknown as { store: Map<string, Uint8Array> };
    expect([...bucket.store.keys()]).toHaveLength(0);
  });

  it("releases the lock after a successful run", async () => {
    const env = makeEnv();
    await setProject(env.STATE as KVNamespace, project("alpha"), logger);
    await runBackup(env, logger, "2026-07-19T06:00:00Z", okSnapshots);
    expect(await (env.STATE as KVNamespace).get("backup:lock")).toBeNull();
  });
});
