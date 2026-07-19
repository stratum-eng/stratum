import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import type { Env } from "../src/types";
import { NotFoundError } from "../src/utils/errors";

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(),
  getUser: vi.fn(async () => ({ success: false, error: new Error("nf") })),
}));

vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(),
}));

import { getAgentByToken } from "../src/storage/agents";
import { getUserByToken } from "../src/storage/users";

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
