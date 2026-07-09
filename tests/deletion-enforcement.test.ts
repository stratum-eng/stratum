import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { isTargetDeleting } from "../src/storage/deletion";
import type { Env, ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(),
}));
vi.mock("../src/storage/sessions", () => ({
  getSession: vi.fn(),
  deleteSession: vi.fn(),
}));

import { getAgentByToken } from "../src/storage/agents";
import { deleteSession, getSession } from "../src/storage/sessions";
import { getUser, getUserByToken } from "../src/storage/users";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.get("/test", (c) => c.json({ userId: c.get("userId") ?? null }));
  return app;
}

const env = {
  ARTIFACTS: {} as Env["ARTIFACTS"],
  STATE: {} as KVNamespace,
  DB: {} as D1Database,
} as Env;

function request(headers?: Record<string, string>): Request {
  return new Request("http://localhost/test", headers ? { headers } : {});
}

const liveUser = {
  id: "usr_1",
  email: "a@b.com",
  username: "alice",
  tokenHash: "h",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("deleting enforcement — auth middleware", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a deleting user's token with 401", async () => {
    vi.mocked(getUserByToken).mockResolvedValue({
      success: true,
      data: { ...liveUser, deletingAt: "2026-06-17T00:00:00.000Z" },
    });
    const res = await makeApp().fetch(request({ Authorization: "Bearer stratum_user_abc" }), env);
    expect(res.status).toBe(401);
  });

  it("allows a live user's token", async () => {
    vi.mocked(getUserByToken).mockResolvedValue({ success: true, data: liveUser });
    const res = await makeApp().fetch(request({ Authorization: "Bearer stratum_user_abc" }), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { userId: string | null }).userId).toBe("usr_1");
  });

  it("rejects a deleting user's session with 401 without setting userId", async () => {
    vi.mocked(getSession).mockResolvedValue({
      success: true,
      data: {
        id: "sess_1",
        userId: "usr_1",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    });
    vi.mocked(getUser).mockResolvedValue({
      success: true,
      data: { ...liveUser, deletingAt: "2026-06-17T00:00:00.000Z" },
    });
    const res = await makeApp().fetch(request({ Cookie: "stratum_session=sess_1" }), env);
    expect(res.status).toBe(401);
    // The acting session is NOT destroyed here — only its NEXT request is gated.
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("allows a live user's session", async () => {
    vi.mocked(getSession).mockResolvedValue({
      success: true,
      data: { id: "sess_1", userId: "usr_1", expiresAt: "2099-01-01T00:00:00.000Z" },
    });
    vi.mocked(getUser).mockResolvedValue({ success: true, data: liveUser });
    const res = await makeApp().fetch(request({ Cookie: "stratum_session=sess_1" }), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { userId: string | null }).userId).toBe("usr_1");
  });

  it("allows an agent whose owner is live", async () => {
    vi.mocked(getAgentByToken).mockResolvedValue({
      success: true,
      data: {
        id: "agt_1",
        name: "a",
        ownerId: "usr_1",
        tokenHash: "h",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    vi.mocked(getUser).mockResolvedValue({ success: true, data: liveUser });
    const res = await makeApp().fetch(request({ Authorization: "Bearer stratum_agent_x" }), env);
    expect(res.status).toBe(200);
  });

  it("rejects an agent whose OWNER is deleting with 401", async () => {
    vi.mocked(getAgentByToken).mockResolvedValue({
      success: true,
      data: {
        id: "agt_1",
        name: "a",
        ownerId: "usr_1",
        tokenHash: "h",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    vi.mocked(getUser).mockResolvedValue({
      success: true,
      data: { ...liveUser, deletingAt: "2026-06-17T00:00:00.000Z" },
    });
    const res = await makeApp().fetch(request({ Authorization: "Bearer stratum_agent_x" }), env);
    expect(res.status).toBe(401);
  });
});

function makeProject(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    id: "proj_1",
    name: "api",
    slug: "api",
    namespace: "@alice",
    ownerId: "usr_1",
    ownerType: "user",
    remote: "https://artifacts/x.git",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeDb(deletingAt: string | null): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => ({ deleting_at: deletingAt }),
      }),
    }),
  } as unknown as D1Database;
}

describe("isTargetDeleting", () => {
  it("returns true when the owning user is deleting", async () => {
    const envDel = { DB: makeDb("2026-06-17T00:00:00.000Z") } as Env;
    expect(await isTargetDeleting(envDel, makeProject(), mockLogger)).toBe(true);
  });

  it("returns false when the owning user is live", async () => {
    const envLive = { DB: makeDb(null) } as Env;
    expect(await isTargetDeleting(envLive, makeProject(), mockLogger)).toBe(false);
  });

  it("returns false for an org-owned project without a DB lookup", async () => {
    const throwingDb = {
      prepare: () => {
        throw new Error("should not be called");
      },
    } as unknown as D1Database;
    const orgEnv = { DB: throwingDb } as Env;
    expect(await isTargetDeleting(orgEnv, makeProject({ ownerType: "org" }), mockLogger)).toBe(
      false,
    );
  });
});
