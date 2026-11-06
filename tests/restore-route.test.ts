import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

vi.mock("../src/backup/plan-restore", () => ({ planRestore: vi.fn() }));
vi.mock("../src/backup/apply-repo-restore", () => ({ applyRepoRestore: vi.fn() }));

import { applyRepoRestore } from "../src/backup/apply-repo-restore";
import { planRestore } from "../src/backup/plan-restore";
import { restoreRouter } from "../src/routes/restore";

const ADMIN_KEY = "admin-secret";

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/admin/restore", restoreRouter);
  return app;
}

const env = { DB: {}, BACKUPS: {}, ADMIN_API_KEY: ADMIN_KEY } as unknown as Env;
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/admin/restore/2026-07-20T00:00:00.000Z/plan", {
    method: "GET",
    headers,
  });
}

describe("GET /api/admin/restore/:runTs/plan", () => {
  beforeEach(() => vi.clearAllMocks());

  it("403 without admin credentials", async () => {
    const res = await makeApp().fetch(req(), env, ctx);
    expect(res.status).toBe(403);
    expect(planRestore).not.toHaveBeenCalled();
  });

  it("200 with the plan for an admin", async () => {
    vi.mocked(planRestore).mockResolvedValue({
      success: true,
      data: {
        runTs: "2026-07-20T00:00:00.000Z",
        complete: true,
        d1: [],
        kv: { projects: 0, workspaces: 0, ok: true },
        repos: [],
        restorable: true,
        errors: [],
      },
    } as never);

    const res = await makeApp().fetch(req({ "X-Admin-API-Key": ADMIN_KEY }), env, ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: { restorable: boolean } };
    expect(body.plan.restorable).toBe(true);
    expect(planRestore).toHaveBeenCalledWith(env, "2026-07-20T00:00:00.000Z", expect.any(Object));
  });

  it("500 when the backups bucket is not configured", async () => {
    const res = await makeApp().fetch(
      req({ "X-Admin-API-Key": ADMIN_KEY }),
      { DB: {}, ADMIN_API_KEY: ADMIN_KEY } as unknown as Env,
      ctx,
    );
    expect(res.status).toBe(500);
    expect(planRestore).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/restore/:runTs/repos/:projectId", () => {
  beforeEach(() => vi.clearAllMocks());

  const RUN = "2026-07-20T00:00:00.000Z";
  const applied = {
    success: true,
    data: {
      runTs: RUN,
      projectId: "proj_1",
      mode: "drill",
      verification: { ok: true, checked: 1, mismatches: [] },
    },
  } as never;

  function makeAuditedEnv() {
    const rows: unknown[][] = [];
    const db = {
      prepare: () => ({
        bind: (...values: unknown[]) => ({
          run: async () => {
            rows.push(values);
            return { success: true, meta: {} };
          },
        }),
      }),
    };
    return { env: { ...env, DB: db } as unknown as Env, rows };
  }

  function post(
    body?: string,
    headers: Record<string, string> = { "X-Admin-API-Key": ADMIN_KEY },
    path = `${RUN}/repos/proj_1`,
  ) {
    return makeApp().fetch(
      new Request(`http://localhost/api/admin/restore/${path}`, {
        method: "POST",
        headers,
        ...(body !== undefined ? { body } : {}),
      }),
      makeAuditedEnv().env,
      ctx,
    );
  }

  it("403 without admin credentials, doing nothing", async () => {
    const res = await post('{"drill":true}', {});
    expect(res.status).toBe(403);
    expect(applyRepoRestore).not.toHaveBeenCalled();
  });

  it("runs a drill", async () => {
    vi.mocked(applyRepoRestore).mockResolvedValue(applied);
    const res = await post('{"drill":true}');
    expect(res.status).toBe(200);
    expect(vi.mocked(applyRepoRestore).mock.calls[0]?.slice(1, 4)).toEqual([
      RUN,
      "proj_1",
      { force: false, drill: true },
    ]);
  });

  it("treats an empty body as a plain restore, without force", async () => {
    vi.mocked(applyRepoRestore).mockResolvedValue(applied);
    expect((await post()).status).toBe(200);
    expect(vi.mocked(applyRepoRestore).mock.calls[0]?.[3]).toEqual({ force: false, drill: false });
  });

  it.each([
    ['{"force":true,"drill":true}', "cannot be combined"],
    ['{"force":"false"}', "force must be a boolean"],
    ['{"drill":1}', "drill must be a boolean"],
    ["not json", "must be JSON"],
    ["[]", "JSON object"],
  ])("400 for %s, doing nothing", async (body, message) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(message);
    expect(applyRepoRestore).not.toHaveBeenCalled();
  });

  it("413 for an oversized body, doing nothing", async () => {
    const res = await post(`{"drill":true,"padding":"${"é".repeat(600)}"}`);
    expect(res.status).toBe(413);
    expect(applyRepoRestore).not.toHaveBeenCalled();
  });

  it("400 for a run or project id that could escape its key", async () => {
    for (const path of ["..%2F..%2Fsecret/repos/proj_1", `${RUN}/repos/a%2Fb`]) {
      const res = await post('{"drill":true}', undefined, path);
      expect(res.status).toBe(400);
    }
    expect(applyRepoRestore).not.toHaveBeenCalled();
  });

  it("audits before and after, with who and what", async () => {
    vi.mocked(applyRepoRestore).mockResolvedValue(applied);
    const { env: audited, rows } = makeAuditedEnv();
    const res = await makeApp().fetch(
      new Request(`http://localhost/api/admin/restore/${RUN}/repos/proj_1`, {
        method: "POST",
        headers: { "X-Admin-API-Key": ADMIN_KEY },
        body: '{"drill":true}',
      }),
      audited,
      ctx,
    );
    expect(res.status).toBe(200);
    const text = rows.map((row) => JSON.stringify(row));
    expect(text).toHaveLength(2);
    expect(text[0]).toContain("backup.repo_restore");
    expect(text[0]).toContain("started");
    expect(text[1]).toContain("verified");
  });

  it.each([
    [409, "CONFLICT", 409],
    [404, "NOT_FOUND", 404],
    [504, "PUSH_TIMEOUT", 504],
    [500, "STORAGE_ERROR", 500],
  ])("answers %i for %s", async (expected, code, statusCode) => {
    vi.mocked(applyRepoRestore).mockResolvedValue({
      success: false,
      error: Object.assign(new Error("boom"), { code, statusCode }),
    } as never);
    expect((await post('{"force":true}')).status).toBe(expected);
  });
});
