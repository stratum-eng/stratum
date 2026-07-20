import { describe, expect, it, vi } from "vitest";
import { planRestore } from "../src/backup/plan-restore";
import type { RepoSnapshot } from "../src/backup/repo-snapshot";
import type { BackupDeps } from "../src/backup/run-backup";
import { runBackup } from "../src/backup/run-backup";
import { RUN_MANIFEST_KEY, putBlob } from "../src/storage/backup-store";
import { setProject, setWorkspace } from "../src/storage/state";
import type { Env, ProjectEntry, WorkspaceEntry } from "../src/types";
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
} as unknown as Parameters<typeof planRestore>[2];

const RUN_TS = "2026-07-20T00:00:00.000Z";

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

function workspace(name: string, parent: string): WorkspaceEntry {
  return {
    name,
    parent,
    remote: `https://acct.artifacts.cloudflare.net/git/@owner/${parent}#${name}`,
    createdAt: "2026-01-02T00:00:00.000Z",
  };
}

function snapshot(id: string): RepoSnapshot {
  return {
    pack: new Uint8Array([1, 2, 3]),
    manifest: {
      projectId: id,
      project: project(id),
      tipSha: `sha-${id}`,
      objectCount: 1,
      byteCount: 3,
      capturedAt: RUN_TS,
    },
  };
}

const okSnapshots: BackupDeps = {
  snapshotRepo: async (_env, p) => ok({ status: "ok", snapshot: snapshot(p.id) }),
};

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    BACKUPS: makeFakeR2(),
    DB: makeFakeD1(),
    STATE: makeFakeKV(),
    ...overrides,
  } as Env;
}

/** Seed KV with projects + a workspace, then run a real backup into the env's R2. */
async function seedAndBackup(env: Env): Promise<void> {
  await setProject(env.STATE, project("alpha"), logger);
  await setProject(env.STATE, project("beta"), logger);
  await setWorkspace(env.STATE, "alpha", workspace("feature-x", "alpha"), logger);
  await runBackup(env, logger, RUN_TS, okSnapshots);
}

describe("planRestore", () => {
  it("reports a clean backup as restorable with correct leg counts", async () => {
    const env = makeEnv();
    await seedAndBackup(env);

    const result = await planRestore(env, RUN_TS, logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const plan = result.data;

    expect(plan.complete).toBe(true);
    expect(plan.restorable).toBe(true);
    expect(plan.errors).toEqual([]);
    expect(plan.kv).toMatchObject({ projects: 2, workspaces: 1, ok: true });
    expect(plan.repos).toHaveLength(2);
    expect(plan.repos.every((r) => r.ok && r.hasPack)).toBe(true);
    expect(plan.repos.map((r) => r.tipSha).sort()).toEqual(["sha-alpha", "sha-beta"]);
    expect(plan.d1.every((t) => t.ok)).toBe(true);
  });

  it("flags a run with no manifest as incomplete and not restorable", async () => {
    const env = makeEnv();
    await seedAndBackup(env);
    const bucket = env.BACKUPS as R2Bucket & { store: Map<string, Uint8Array> };
    bucket.store.delete(`${RUN_TS}/${RUN_MANIFEST_KEY}`);

    const result = await planRestore(env, RUN_TS, logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.complete).toBe(false);
    expect(result.data.restorable).toBe(false);
    expect(result.data.errors.some((e) => e.includes("_manifest.json"))).toBe(true);
  });

  it("fails the table leg when a D1 dump blob is missing", async () => {
    const env = makeEnv();
    await seedAndBackup(env);
    const bucket = env.BACKUPS as R2Bucket & { store: Map<string, Uint8Array> };
    const tableKey = [...bucket.store.keys()].find((k) => k.startsWith(`${RUN_TS}/d1/`));
    expect(tableKey).toBeDefined();
    if (tableKey) bucket.store.delete(tableKey);

    const result = await planRestore(env, RUN_TS, logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.restorable).toBe(false);
    expect(result.data.d1.some((t) => !t.ok && t.error?.includes("missing"))).toBe(true);
  });

  it("fails a repo leg when its pack blob is gone but the manifest remains", async () => {
    const env = makeEnv();
    await seedAndBackup(env);
    const bucket = env.BACKUPS as R2Bucket & { store: Map<string, Uint8Array> };
    bucket.store.delete(`${RUN_TS}/repos/alpha.pack`);

    const result = await planRestore(env, RUN_TS, logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.restorable).toBe(false);
    const alpha = result.data.repos.find((r) => r.projectId === "alpha");
    expect(alpha).toMatchObject({ hasPack: false, ok: false });
  });

  it("detects a truncated table dump via the manifest row-count cross-check", async () => {
    // Seed real rows so the manifest records a non-zero count, then overwrite the
    // dump with a header-only (zero-row) blob through the same encode path.
    const db = makeFakeD1();
    db.seed("events", [{ id: "e1" }, { id: "e2" }, { id: "e3" }]);
    const env = makeEnv({ DB: db });
    await seedAndBackup(env);
    const bucket = env.BACKUPS as R2Bucket & { store: Map<string, Uint8Array> };

    // Confirm the manifest captured 3 rows for `events`, then truncate the dump.
    const truncated = new TextEncoder().encode(
      JSON.stringify({ __table: "events", __columns: ["id"] }),
    );
    const wrote = await putBlob(bucket, `${RUN_TS}/d1/events.ndjson`, truncated, env, logger);
    expect(wrote.success).toBe(true);

    const result = await planRestore(env, RUN_TS, logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const events = result.data.d1.find((t) => t.table === "events");
    expect(events).toMatchObject({ expectedRows: 3, parsedRows: 0, ok: false });
    expect(result.data.restorable).toBe(false);
  });

  it("is not restorable when decryption fails (wrong secret)", async () => {
    const env = makeEnv({ BACKUP_ENCRYPTION_SECRET: "correct-secret" } as Partial<Env>);
    await seedAndBackup(env);

    // Read the same bucket back with a different secret: every blob fails to decode.
    const wrongEnv = { ...env, BACKUP_ENCRYPTION_SECRET: "wrong-secret" } as Env;
    const result = await planRestore(wrongEnv, RUN_TS, logger);

    // getBlob surfaces a decode error for the manifest → planRestore returns err,
    // or, if the manifest slips through, the legs fail. Either way: not restorable.
    if (result.success) {
      expect(result.data.restorable).toBe(false);
    } else {
      expect(result.error).toBeDefined();
    }
  });
});
