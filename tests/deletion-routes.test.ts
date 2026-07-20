import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

vi.mock("../src/storage/users", () => ({
  getUser: vi.fn(),
  getUserByToken: vi.fn(),
  markUserDeleting: vi.fn(async () => ({ success: true, data: "2026-06-17T00:00:00.000Z" })),
  getUserByUsername: vi.fn(),
  rotateUserToken: vi.fn(),
}));
vi.mock("../src/storage/agents", () => ({ getAgentByToken: vi.fn() }));
vi.mock("../src/storage/deletion-jobs", () => ({
  // created: true → a fresh job; the route proceeds to audit + drive.
  createDeletionJob: vi.fn(async () => ({
    success: true,
    data: { job: { id: "del_1" }, created: true },
  })),
  findActiveJobForTarget: vi.fn(async () => ({ success: true, data: null })),
}));
vi.mock("../src/storage/audit", () => ({ recordAudit: vi.fn(async () => ({ success: true })) }));
vi.mock("../src/queue/deletion-runner", () => ({
  runDeletionJob: vi.fn(async () => ({ success: true, data: undefined })),
}));
vi.mock("../src/storage/deletion", () => ({
  captureDeletionTarget: vi.fn(async () => ({ success: true, data: { projectId: "proj_1" } })),
}));
vi.mock("../src/storage/state", () => ({
  getProjectByPath: vi.fn(),
}));

import { projectsRouter } from "../src/routes/projects";
import { usersRouter } from "../src/routes/users";
import { recordAudit } from "../src/storage/audit";
import { createDeletionJob } from "../src/storage/deletion-jobs";
import { getProjectByPath } from "../src/storage/state";
import { getUser, markUserDeleting } from "../src/storage/users";

// Auth is injected directly (no real token) so we control userId per test.
function makeApp(userId: string | undefined) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    if (userId) c.set("userId", userId);
    await next();
  });
  app.route("/api/projects", projectsRouter);
  app.route("/api/users", usersRouter);
  return app;
}

const env = { DB: {}, STATE: {}, ARTIFACTS: {} } as unknown as Env;
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function jsonReq(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const ownedProject = {
  id: "proj_1",
  name: "api",
  slug: "api",
  namespace: "@alice",
  ownerId: "usr_1",
  ownerType: "user",
  remote: "https://artifacts/x.git",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("DELETE /api/projects/:namespace/:slug", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404 for a non-owner (does not reveal existence)", async () => {
    vi.mocked(getProjectByPath).mockResolvedValue({ success: true, data: ownedProject } as never);
    const app = makeApp("usr_other");
    const res = await app.fetch(
      jsonReq("DELETE", "/api/projects/@alice/api", { confirm: "@alice/api" }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
    expect(createDeletionJob).not.toHaveBeenCalled();
  });

  it("400 on a confirm-token mismatch", async () => {
    vi.mocked(getProjectByPath).mockResolvedValue({ success: true, data: ownedProject } as never);
    const app = makeApp("usr_1");
    const res = await app.fetch(
      jsonReq("DELETE", "/api/projects/@alice/api", { confirm: "wrong" }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(createDeletionJob).not.toHaveBeenCalled();
  });

  it("202 + enqueues a job for the owner with the exact confirm token", async () => {
    vi.mocked(getProjectByPath).mockResolvedValue({ success: true, data: ownedProject } as never);
    const app = makeApp("usr_1");
    const res = await app.fetch(
      jsonReq("DELETE", "/api/projects/@alice/api", { confirm: "@alice/api" }),
      env,
      ctx,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; jobId: string };
    expect(body.status).toBe("deleting");
    expect(body.jobId).toBe("del_1");
    expect(createDeletionJob).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ kind: "project", targetId: "proj_1" }),
    );
  });

  it("returns the in-flight job (no re-audit) when a delete is already active", async () => {
    vi.mocked(getProjectByPath).mockResolvedValue({ success: true, data: ownedProject } as never);
    vi.mocked(createDeletionJob).mockResolvedValueOnce({
      success: true,
      data: { job: { id: "del_existing" }, created: false },
    } as never);
    const app = makeApp("usr_1");
    const res = await app.fetch(
      jsonReq("DELETE", "/api/projects/@alice/api", { confirm: "@alice/api" }),
      env,
      ctx,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toBe("del_existing");
    // A deduped request must not record a second deletion.requested audit entry.
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/users/me", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sets deleting_at + enqueues an account job on a valid confirm", async () => {
    vi.mocked(getUser).mockResolvedValue({
      success: true,
      data: {
        id: "usr_1",
        email: "a@b.com",
        username: "alice",
        tokenHash: "h",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    } as never);
    const app = makeApp("usr_1");
    const res = await app.fetch(jsonReq("DELETE", "/api/users/me", { confirm: "alice" }), env, ctx);
    expect(res.status).toBe(202);
    expect(markUserDeleting).toHaveBeenCalledWith(env.DB, "usr_1", expect.any(Object));
    expect(createDeletionJob).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ kind: "account", target: { userId: "usr_1" } }),
    );
  });

  it("400 on a confirm-token mismatch (username)", async () => {
    vi.mocked(getUser).mockResolvedValue({
      success: true,
      data: {
        id: "usr_1",
        email: "a@b.com",
        username: "alice",
        tokenHash: "h",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    } as never);
    const app = makeApp("usr_1");
    const res = await app.fetch(
      jsonReq("DELETE", "/api/users/me", { confirm: "not-alice" }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(markUserDeleting).not.toHaveBeenCalled();
    expect(createDeletionJob).not.toHaveBeenCalled();
  });

  it("401 when unauthenticated", async () => {
    const app = makeApp(undefined);
    const res = await app.fetch(jsonReq("DELETE", "/api/users/me", { confirm: "alice" }), env, ctx);
    expect(res.status).toBe(401);
  });
});
