import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

vi.mock("../src/backup/plan-restore", () => ({ planRestore: vi.fn() }));

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
