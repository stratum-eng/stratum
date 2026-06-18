import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { usersRouter } from "../src/routes/users";
import type { Env } from "../src/types";
import { NotFoundError } from "../src/utils/errors";

vi.mock("../src/storage/users", () => ({
  getUser: vi.fn(),
  getUserByToken: vi.fn(),
}));

vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(),
}));

import { getUser, getUserByToken } from "../src/storage/users";

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.route("/api/users", usersRouter);
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

const mockUser = {
  id: "usr_abc123",
  email: "test@example.com",
  username: "test",
  tokenHash: "somehash",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("POST /api/users — removed", () => {
  // Unauthenticated user/token creation was removed: accounts are bootstrapped
  // only through verified flows (OAuth, magic link, dev-login). The route must
  // not exist.
  it("no longer mints a user+token from an email", async () => {
    const app = makeApp();
    const res = await app.fetch(
      request("POST", "/api/users", { email: "attacker@example.com" }),
      makeEnv(),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/users/me", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
  });

  it("returns current user when authenticated", async () => {
    vi.mocked(getUserByToken).mockResolvedValue({
      success: true,
      data: mockUser,
    });
    vi.mocked(getUser).mockResolvedValue({
      success: true,
      data: mockUser,
    });

    const res = await app.fetch(
      request("GET", "/api/users/me", undefined, {
        Authorization: "Bearer stratum_user_deadbeef",
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; email: string; createdAt: string };
    expect(body.id).toBe("usr_abc123");
    expect(body.email).toBe("test@example.com");
    expect(body).not.toHaveProperty("tokenHash");
  });

  it("returns 401 when no auth header", async () => {
    const res = await app.fetch(request("GET", "/api/users/me"), env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 when token is invalid", async () => {
    vi.mocked(getUserByToken).mockResolvedValue({
      success: false,
      error: new NotFoundError("User", "badtoken"),
    });
    const res = await app.fetch(
      request("GET", "/api/users/me", undefined, {
        Authorization: "Bearer stratum_user_badtoken",
      }),
      env,
    );
    expect(res.status).toBe(401);
  });
});
