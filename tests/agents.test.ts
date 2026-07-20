import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { agentsRouter } from "../src/routes/agents";
import type { Env } from "../src/types";

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock("../src/storage/agents", () => ({
  createAgent: vi.fn(),
  getAgent: vi.fn(),
  getAgentByToken: vi.fn(),
  listAgents: vi.fn(),
  deleteAgent: vi.fn(),
}));

vi.mock("../src/utils/logger", () => ({
  createLogger: vi.fn(() => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => ({
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    })),
  })),
}));

import { createAgent, deleteAgent, getAgent, listAgents } from "../src/storage/agents";
import { getUserByToken } from "../src/storage/users";

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.route("/api/agents", agentsRouter);
  return app;
}

function makeEnv(): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: {} as KVNamespace,
    DB: {} as D1Database,
  };
}

function request(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  const hasBody = body !== undefined;
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
}

import { NotFoundError } from "../src/utils/errors";

const mockUser = {
  id: "usr_owner",
  email: "owner@example.com",
  username: "owner",
  tokenHash: "userhash",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const mockAgent = {
  id: "agt_abc123",
  name: "my-agent",
  ownerId: "usr_owner",
  tokenHash: "agenthash",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const userAuthHeader = { Authorization: "Bearer stratum_user_token" };

describe("POST /api/agents", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
    vi.mocked(getUserByToken).mockResolvedValue({
      success: true,
      data: mockUser,
    });
    vi.mocked(createAgent).mockResolvedValue({
      success: true,
      data: {
        agent: mockAgent,
        plaintext: "stratum_agent_deadbeef",
      },
    });
  });

  it("creates agent with user auth and returns 201", async () => {
    const res = await app.fetch(
      request("POST", "/api/agents", { name: "my-agent" }, userAuthHeader),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      agent: { id: string; name: string; ownerId: string };
      token: string;
    };
    expect(body.agent.id).toBe("agt_abc123");
    expect(body.agent.name).toBe("my-agent");
    expect(body.agent.ownerId).toBe("usr_owner");
    expect(body.token).toBe("stratum_agent_deadbeef");
    expect(body.agent).not.toHaveProperty("tokenHash");
    expect(createAgent).toHaveBeenCalledWith(
      env.DB,
      "usr_owner",
      "my-agent",
      expect.any(Object),
      undefined,
      undefined,
      undefined,
    );
  });

  it("creates agent with optional model field", async () => {
    const agentWithModel = { ...mockAgent, model: "claude-3-5-sonnet" };
    vi.mocked(createAgent).mockResolvedValue({
      success: true,
      data: {
        agent: agentWithModel,
        plaintext: "stratum_agent_deadbeef",
      },
    });

    const res = await app.fetch(
      request(
        "POST",
        "/api/agents",
        { name: "my-agent", model: "claude-3-5-sonnet" },
        userAuthHeader,
      ),
      env,
    );
    expect(res.status).toBe(201);
    expect(createAgent).toHaveBeenCalledWith(
      env.DB,
      "usr_owner",
      "my-agent",
      expect.any(Object),
      "claude-3-5-sonnet",
      undefined,
      undefined,
    );
  });

  it("returns 401 when no auth header provided", async () => {
    const res = await app.fetch(request("POST", "/api/agents", { name: "my-agent" }), env);
    expect(res.status).toBe(401);
  });

  it("returns 400 when name is missing", async () => {
    const res = await app.fetch(request("POST", "/api/agents", {}, userAuthHeader), env);
    expect(res.status).toBe(400);
  });

  it("returns 400 when name is not a string", async () => {
    const res = await app.fetch(request("POST", "/api/agents", { name: 42 }, userAuthHeader), env);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/agents", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
    vi.mocked(getUserByToken).mockResolvedValue({
      success: true,
      data: mockUser,
    });
    vi.mocked(listAgents).mockResolvedValue({
      success: true,
      data: [mockAgent],
    });
  });

  it("lists agents for authenticated user", async () => {
    const res = await app.fetch(request("GET", "/api/agents", undefined, userAuthHeader), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: (typeof mockAgent)[] };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]?.id).toBe("agt_abc123");
    expect(listAgents).toHaveBeenCalledWith(env.DB, "usr_owner", expect.any(Object));
  });

  it("returns 401 when not authenticated", async () => {
    const res = await app.fetch(request("GET", "/api/agents"), env);
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/agents/:id", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
    vi.mocked(getUserByToken).mockResolvedValue({
      success: true,
      data: mockUser,
    });
    vi.mocked(getAgent).mockResolvedValue({
      success: true,
      data: mockAgent,
    });
    vi.mocked(deleteAgent).mockResolvedValue({
      success: true,
      data: undefined,
    });
  });

  it("deletes agent owned by current user", async () => {
    const res = await app.fetch(
      request("DELETE", "/api/agents/agt_abc123", undefined, userAuthHeader),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean; id: string };
    expect(body.deleted).toBe(true);
    expect(body.id).toBe("agt_abc123");
    expect(deleteAgent).toHaveBeenCalledWith(env.DB, "agt_abc123", expect.any(Object));
  });

  it("returns 403 when agent is owned by another user", async () => {
    vi.mocked(getAgent).mockResolvedValue({
      success: true,
      data: { ...mockAgent, ownerId: "usr_other" },
    });

    const res = await app.fetch(
      request("DELETE", "/api/agents/agt_abc123", undefined, userAuthHeader),
      env,
    );
    expect(res.status).toBe(403);
    expect(deleteAgent).not.toHaveBeenCalled();
  });

  it("returns 404 when agent does not exist", async () => {
    vi.mocked(getAgent).mockResolvedValue({
      success: false,
      error: new NotFoundError("Agent", "agt_missing"),
    });

    const res = await app.fetch(
      request("DELETE", "/api/agents/agt_missing", undefined, userAuthHeader),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("returns 401 when not authenticated", async () => {
    const res = await app.fetch(request("DELETE", "/api/agents/agt_abc123"), env);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/agents/:id — SEC-4 owner scoping", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
    vi.mocked(getUserByToken).mockResolvedValue({ success: true, data: mockUser });
    vi.mocked(getAgent).mockResolvedValue({ success: true, data: mockAgent });
  });

  it("returns the agent to its owner", async () => {
    const res = await app.fetch(
      request("GET", "/api/agents/agt_abc123", undefined, userAuthHeader),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ownerId: string; model?: string };
    expect(body.ownerId).toBe("usr_owner");
  });

  it("returns 404 (no existence leak) when the agent belongs to another user", async () => {
    vi.mocked(getAgent).mockResolvedValue({
      success: true,
      data: { ...mockAgent, ownerId: "usr_other" },
    });
    const res = await app.fetch(
      request("GET", "/api/agents/agt_abc123", undefined, userAuthHeader),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 to an anonymous caller", async () => {
    const res = await app.fetch(request("GET", "/api/agents/agt_abc123"), env);
    expect(res.status).toBe(404);
  });
});
