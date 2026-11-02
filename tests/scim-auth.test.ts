import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { rateLimitMiddleware } from "../src/middleware/rate-limit";
import type { Env } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import { AppError, NotFoundError } from "../src/utils/errors";
import { makeFakeKV } from "./helpers/fake-kv";

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

vi.mock("../src/storage/sso", () => ({
  getSsoConnectionByScimTokenHash: vi.fn(),
}));

import { getSsoConnectionByScimTokenHash } from "../src/storage/sso";
import { getUserByToken } from "../src/storage/users";

interface EchoBody {
  userId: string | null;
  agentId: string | null;
  scimConnectionId: string | null;
}

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.get("/test", (c) => {
    return c.json({
      userId: c.get("userId") ?? null,
      agentId: c.get("agentId") ?? null,
      scimConnectionId: c.get("scimConnectionId") ?? null,
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

const connection = {
  id: "ssoc_1",
  orgId: "org_1",
  protocol: "oidc" as const,
  issuer: "https://idp.example.com",
  clientId: "cid",
  clientSecretCiphertext: "ct",
  authorizationEndpoint: "https://idp.example.com/auth",
  tokenEndpoint: "https://idp.example.com/token",
  jwksUri: "https://idp.example.com/jwks",
  emailDomains: ["corp.example.com"],
  domainsVerifiedAt: "2026-01-01T00:00:00.000Z",
  domainVerificationToken: "tok",
  scimTokenHash: "hash",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("authMiddleware — stratum_scim_* bearer", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
  });

  it("sets scimConnectionId (and NO userId) for a valid SCIM token", async () => {
    vi.mocked(getSsoConnectionByScimTokenHash).mockResolvedValue({
      success: true,
      data: connection,
    });

    const token = "stratum_scim_abc123";
    const res = await app.fetch(request("/test", { Authorization: `Bearer ${token}` }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as EchoBody;
    expect(body.scimConnectionId).toBe("ssoc_1");
    expect(body.userId).toBeNull();
    expect(body.agentId).toBeNull();
    // The lookup receives the token's HASH — plaintext never reaches storage.
    expect(getSsoConnectionByScimTokenHash).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      await hashToken(token),
    );
  });

  it("returns a SCIM-envelope 401 for an unknown SCIM token", async () => {
    vi.mocked(getSsoConnectionByScimTokenHash).mockResolvedValue({
      success: false,
      error: new NotFoundError("SSO connection", "by-scim-token"),
    });

    const res = await app.fetch(
      request("/test", { Authorization: "Bearer stratum_scim_unknown" }),
      env,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toBe("application/scim+json");
    const body = (await res.json()) as { schemas: string[]; status: string; detail: string };
    expect(body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
    expect(body.status).toBe("401");
    expect(body.detail).toBe("Invalid token");
  });

  it("returns a SCIM-envelope 401 when the connection lookup errors (fail closed)", async () => {
    vi.mocked(getSsoConnectionByScimTokenHash).mockResolvedValue({
      success: false,
      error: new AppError("boom", "STORAGE_ERROR", 500),
    });

    const res = await app.fetch(
      request("/test", { Authorization: "Bearer stratum_scim_broken" }),
      env,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toBe("application/scim+json");
    expect(((await res.json()) as { schemas: string[] }).schemas).toEqual([
      "urn:ietf:params:scim:api:messages:2.0:Error",
    ]);
  });

  it("does NOT set scimConnectionId for a user token", async () => {
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
    const body = (await res.json()) as EchoBody;
    expect(body.userId).toBe("usr_abc");
    expect(body.scimConnectionId).toBeNull();
    expect(getSsoConnectionByScimTokenHash).not.toHaveBeenCalled();
  });
});

describe("rateLimitMiddleware — per-connection SCIM bucket", () => {
  const HOUR_MS = 3600 * 1000;

  function makeScimApp(connectionId: string) {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", async (c, next) => {
      c.set("scimConnectionId", connectionId);
      await next();
    });
    app.use("*", rateLimitMiddleware());
    app.get("/scim/v2/Users", (c) => c.json({ ok: true }));
    return app;
  }

  it("counts SCIM requests in a per-connection hourly bucket", async () => {
    const kv = makeFakeKV();
    const env = { ...makeEnv(), STATE: kv };
    const app = makeScimApp("ssoc_rl");

    const res = await app.fetch(request("/scim/v2/Users"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("3000");

    const bucket = Math.floor(Date.now() / HOUR_MS);
    expect(kv.store.get(`ratelimit:scim:ssoc_rl:${bucket}`)).toBe("1");
  });

  it("returns 429 once the connection's 3000/hour window is exhausted", async () => {
    const kv = makeFakeKV();
    const env = { ...makeEnv(), STATE: kv };
    const app = makeScimApp("ssoc_rl");

    const bucket = Math.floor(Date.now() / HOUR_MS);
    kv.store.set(`ratelimit:scim:ssoc_rl:${bucket}`, "3000");

    const res = await app.fetch(request("/scim/v2/Users"), env);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("keys the bucket per connection — one tenant cannot exhaust another's", async () => {
    const kv = makeFakeKV();
    const env = { ...makeEnv(), STATE: kv };

    const bucket = Math.floor(Date.now() / HOUR_MS);
    kv.store.set(`ratelimit:scim:ssoc_busy:${bucket}`, "3000");

    const res = await makeScimApp("ssoc_quiet").fetch(request("/scim/v2/Users"), env);
    expect(res.status).toBe(200);
  });
});
