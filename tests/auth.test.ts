import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import type { Env } from "../src/types";
import { NotFoundError } from "../src/utils/errors";

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(),
  getUser: vi.fn(async () => ({
    success: true,
    data: {
      id: "usr_abc",
      email: "test@example.com",
      username: "test",
      tokenHash: "hash",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  })),
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

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.get("/test", (c) => {
    return c.json({
      userId: c.get("userId") ?? null,
      agentId: c.get("agentId") ?? null,
    });
  });
  return app;
}

function makeEnv(): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: {} as KVNamespace,
    DB: {} as D1Database,
  };
}

function request(path: string, headers?: Record<string, string>): Request {
  return new Request(`http://localhost${path}`, headers ? { headers } : {});
}

describe("authMiddleware", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
  });

  it("continues without auth header, sets no userId or agentId", async () => {
    const res = await app.fetch(request("/test"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string | null; agentId: string | null };
    expect(body.userId).toBeNull();
    expect(body.agentId).toBeNull();
  });

  it("sets userId for valid user token", async () => {
    vi.mocked(getUserByToken).mockResolvedValue({
      success: true,
      data: {
        id: "usr_abc",
        email: "test@example.com",
        username: "test",
        tokenHash: "hash",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });

    const res = await app.fetch(
      request("/test", { Authorization: "Bearer stratum_user_abc123" }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string | null };
    expect(body.userId).toBe("usr_abc");
    expect(getUserByToken).toHaveBeenCalledWith(env.DB, "stratum_user_abc123", expect.any(Object));
  });

  it("sets agentId for valid agent token", async () => {
    vi.mocked(getAgentByToken).mockResolvedValue({
      success: true,
      data: {
        id: "agt_xyz",
        name: "my-agent",
        ownerId: "usr_abc",
        tokenHash: "hash",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });

    const res = await app.fetch(
      request("/test", { Authorization: "Bearer stratum_agent_xyz123" }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentId: string | null };
    expect(body.agentId).toBe("agt_xyz");
    expect(getAgentByToken).toHaveBeenCalledWith(
      env.DB,
      "stratum_agent_xyz123",
      expect.any(Object),
    );
  });

  it("returns 401 for token with unrecognized prefix", async () => {
    const res = await app.fetch(
      request("/test", { Authorization: "Bearer unknown_token_abc" }),
      env,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid token");
  });

  it("returns 401 when user token not found in DB", async () => {
    vi.mocked(getUserByToken).mockResolvedValue({
      success: false,
      error: new NotFoundError("User", "notfound"),
    });

    const res = await app.fetch(
      request("/test", { Authorization: "Bearer stratum_user_notfound" }),
      env,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid token");
  });

  it("returns 401 when agent token not found in DB", async () => {
    vi.mocked(getAgentByToken).mockResolvedValue({
      success: false,
      error: new NotFoundError("Agent", "notfound"),
    });

    const res = await app.fetch(
      request("/test", { Authorization: "Bearer stratum_agent_notfound" }),
      env,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid token");
  });
});

// disabled_at is reversible (unlike deleting_at): every path must reject while
// it is set, and the SAME credential must work again once it is cleared.
describe("authMiddleware — disabled_at enforcement", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  const liveUser = {
    id: "usr_abc",
    email: "test@example.com",
    username: "test",
    tokenHash: "hash",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const disabledUser = { ...liveUser, disabledAt: "2026-08-01T00:00:00.000Z" };
  const agent = {
    id: "agt_xyz",
    name: "my-agent",
    ownerId: "usr_abc",
    tokenHash: "hash",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const session = { id: "sess_1", userId: "usr_abc", expiresAt: "2099-01-01T00:00:00.000Z" };

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
  });

  it("rejects a disabled user's token with 401, then the SAME token works after re-enable", async () => {
    const req = () => request("/test", { Authorization: "Bearer stratum_user_abc123" });

    vi.mocked(getUserByToken).mockResolvedValueOnce({ success: true, data: disabledUser });
    const denied = await app.fetch(req(), env);
    expect(denied.status).toBe(401);
    expect(((await denied.json()) as { error: string }).error).toBe("Invalid token");

    vi.mocked(getUserByToken).mockResolvedValueOnce({ success: true, data: liveUser });
    const allowed = await app.fetch(req(), env);
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as { userId: string | null }).userId).toBe("usr_abc");
  });

  it("rejects an agent whose OWNER is disabled with 401, then the SAME token works after re-enable", async () => {
    const req = () => request("/test", { Authorization: "Bearer stratum_agent_xyz123" });
    vi.mocked(getAgentByToken).mockResolvedValue({ success: true, data: agent });

    vi.mocked(getUser).mockResolvedValueOnce({ success: true, data: disabledUser });
    const denied = await app.fetch(req(), env);
    expect(denied.status).toBe(401);

    vi.mocked(getUser).mockResolvedValueOnce({ success: true, data: liveUser });
    const allowed = await app.fetch(req(), env);
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as { agentId: string | null }).agentId).toBe("agt_xyz");
  });

  it("rejects a disabled user's session with 401 (session kept), then the SAME cookie works after re-enable", async () => {
    const req = () => request("/test", { Cookie: "stratum_session=sess_1" });
    vi.mocked(getSession).mockResolvedValue({ success: true, data: session });

    vi.mocked(getUser).mockResolvedValueOnce({ success: true, data: disabledUser });
    const denied = await app.fetch(req(), env);
    expect(denied.status).toBe(401);
    // Disable is reversible: the session row must survive so re-enabling
    // restores access without a fresh login.
    expect(deleteSession).not.toHaveBeenCalled();

    vi.mocked(getUser).mockResolvedValueOnce({ success: true, data: liveUser });
    const allowed = await app.fetch(req(), env);
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as { userId: string | null }).userId).toBe("usr_abc");
  });
});
