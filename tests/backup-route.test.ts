import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/admin", () => ({ isAdminRequest: vi.fn() }));
vi.mock("../src/backup/run-backup", () => ({ runBackup: vi.fn() }));
vi.mock("../src/storage/backup-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/storage/backup-store")>();
  return { ...actual, listRuns: vi.fn() };
});

import { runBackup } from "../src/backup/run-backup";
import { backupRouter } from "../src/routes/backup";
import { listRuns } from "../src/storage/backup-store";
import type { Env } from "../src/types";
import { isAdminRequest } from "../src/utils/admin";
import { makeFakeD1 } from "./helpers/fake-d1";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeFakeR2 } from "./helpers/fake-r2";

function app() {
  const a = new Hono<{ Bindings: Env }>();
  a.route("/", backupRouter);
  return a;
}

function makeEnv(): Env {
  return {
    BACKUPS: makeFakeR2(),
    DB: makeFakeD1(),
    STATE: makeFakeKV(),
  } as unknown as Env;
}

const summary = {
  runTs: "2026-07-19T06:00:00Z",
  d1: [],
  kv: { projects: 0, workspaces: 0, ok: true },
  repos: { total: 0, backedUp: 2, skipped: [], failed: [], deferred: 0 },
  bytes: 100,
  prunedRuns: 0,
  healthy: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runBackup).mockResolvedValue(summary);
  vi.mocked(listRuns).mockResolvedValue({
    success: true,
    data: [{ runTs: "2026-07-19T06:00:00Z", complete: true }],
  });
});

describe("backup admin route", () => {
  it("rejects non-admins on POST and GET", async () => {
    vi.mocked(isAdminRequest).mockResolvedValue(false);
    const env = makeEnv();
    expect((await app().request("/", { method: "POST" }, env)).status).toBe(403);
    expect((await app().request("/", {}, env)).status).toBe(403);
    expect(runBackup).not.toHaveBeenCalled();
  });

  it("runs a backup and records an audit entry for admins", async () => {
    vi.mocked(isAdminRequest).mockResolvedValue(true);
    const env = makeEnv();
    const res = await app().request("/", { method: "POST" }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: typeof summary };
    expect(body.summary.repos.backedUp).toBe(2);
    expect(runBackup).toHaveBeenCalledOnce();

    const audit = (env.DB as unknown as { rows: (t: string) => { action: string }[] }).rows(
      "audit_log",
    );
    expect(audit.some((r) => r.action === "backup.run")).toBe(true);
  });

  it("returns 409 when runBackup reports a run already in progress", async () => {
    vi.mocked(isAdminRequest).mockResolvedValue(true);
    vi.mocked(runBackup).mockResolvedValue({ ...summary, skipped: "locked" });
    const env = makeEnv();
    const res = await app().request("/", { method: "POST" }, env);
    expect(res.status).toBe(409);
    // No audit entry is recorded for a run that never started.
    const audit = (env.DB as unknown as { rows: (t: string) => { action: string }[] }).rows(
      "audit_log",
    );
    expect(audit.some((r) => r.action === "backup.run")).toBe(false);
  });

  it("lists runs on GET for admins", async () => {
    vi.mocked(isAdminRequest).mockResolvedValue(true);
    const res = await app().request("/", {}, makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: { runTs: string; complete: boolean }[] };
    expect(body.runs[0]?.complete).toBe(true);
  });
});
