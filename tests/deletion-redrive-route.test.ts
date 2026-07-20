import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

vi.mock("../src/queue/deletion-runner", () => ({ redriveDeletionJob: vi.fn() }));
vi.mock("../src/storage/deletion-jobs", () => ({ getDeletionJob: vi.fn() }));
vi.mock("../src/storage/audit", () => ({ recordAudit: vi.fn(async () => ({ success: true })) }));

import { redriveDeletionJob } from "../src/queue/deletion-runner";
import { deletionJobsRouter } from "../src/routes/deletion-jobs";
import { recordAudit } from "../src/storage/audit";
import { getDeletionJob } from "../src/storage/deletion-jobs";

const ADMIN_KEY = "admin-secret";

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/admin/deletion-jobs", deletionJobsRouter);
  return app;
}

const env = { DB: {}, ADMIN_API_KEY: ADMIN_KEY } as unknown as Env;
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/admin/deletion-jobs/del_1/redrive", {
    method: "POST",
    headers,
  });
}

describe("POST /api/admin/deletion-jobs/:id/redrive", () => {
  beforeEach(() => vi.clearAllMocks());

  it("403 without admin credentials", async () => {
    const res = await makeApp().fetch(req(), env, ctx);
    expect(res.status).toBe(403);
    expect(redriveDeletionJob).not.toHaveBeenCalled();
  });

  it("re-drives and 200s for an admin on an incomplete job", async () => {
    vi.mocked(redriveDeletionJob).mockResolvedValue({
      success: true,
      data: { reopened: true },
    } as never);
    vi.mocked(getDeletionJob).mockResolvedValue({
      success: true,
      data: { id: "del_1", state: "pending" },
    } as never);

    const res = await makeApp().fetch(req({ "X-Admin-API-Key": ADMIN_KEY }), env, ctx);

    expect(res.status).toBe(200);
    expect(redriveDeletionJob).toHaveBeenCalledWith(env, "del_1", expect.any(Object));
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ action: "deletion.redrive", subject: "del_1" }),
    );
  });

  it("409 (NOT_REDRIVABLE) when the job exists but is not incomplete", async () => {
    vi.mocked(redriveDeletionJob).mockResolvedValue({
      success: true,
      data: { reopened: false },
    } as never);
    vi.mocked(getDeletionJob).mockResolvedValue({
      success: true,
      data: { id: "del_1", state: "completed" },
    } as never);

    const res = await makeApp().fetch(req({ "X-Admin-API-Key": ADMIN_KEY }), env, ctx);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("NOT_REDRIVABLE");
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("404 when the job does not exist", async () => {
    vi.mocked(redriveDeletionJob).mockResolvedValue({
      success: true,
      data: { reopened: false },
    } as never);
    vi.mocked(getDeletionJob).mockResolvedValue({ success: true, data: null } as never);

    const res = await makeApp().fetch(req({ "X-Admin-API-Key": ADMIN_KEY }), env, ctx);

    expect(res.status).toBe(404);
  });
});
