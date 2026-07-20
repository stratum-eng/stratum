import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

vi.mock("../src/storage/backfill-plan", () => ({ computeBackfillPlan: vi.fn() }));

import { backfillRouter } from "../src/routes/backfill";
import { computeBackfillPlan } from "../src/storage/backfill-plan";

const ADMIN_KEY = "admin-secret";

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/admin/backfill-project-id", backfillRouter);
  return app;
}

const env = { DB: {}, STATE: {}, ADMIN_API_KEY: ADMIN_KEY } as unknown as Env;
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/admin/backfill-project-id/plan", {
    method: "GET",
    headers,
  });
}

describe("GET /api/admin/backfill-project-id/plan", () => {
  beforeEach(() => vi.clearAllMocks());

  it("403 without admin credentials", async () => {
    const res = await makeApp().fetch(req(), env, ctx);
    expect(res.status).toBe(403);
    expect(computeBackfillPlan).not.toHaveBeenCalled();
  });

  it("200 with the plan for an admin", async () => {
    vi.mocked(computeBackfillPlan).mockResolvedValue({
      success: true,
      data: {
        tables: [{ table: "changes", nullRows: 3 }],
        totalNullRows: 3,
        projects: { total: 1, backfillable: 1, collisions: [] },
      },
    } as never);

    const res = await makeApp().fetch(req({ "X-Admin-API-Key": ADMIN_KEY }), env, ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: { totalNullRows: number } };
    expect(body.plan.totalNullRows).toBe(3);
  });
});
