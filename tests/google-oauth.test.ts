import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authRouter } from "../src/routes/auth";
import type { Env } from "../src/types";

vi.mock("../src/storage/users", () => ({
  createUser: vi.fn(),
  getUserByEmail: vi.fn(),
  upsertGitHubUser: vi.fn(),
}));

vi.mock("../src/storage/sessions", () => ({
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("../src/storage/audit", () => ({
  recordAudit: vi.fn().mockResolvedValue({ success: true, data: undefined }),
}));

import { createSession } from "../src/storage/sessions";
import { createUser, getUserByEmail } from "../src/storage/users";

const fetchMock = vi.fn();

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/auth", authRouter);
  return app;
}

function makeKv(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(initial));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: makeKv(),
    DB: {} as D1Database,
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    GOOGLE_REDIRECT_URI: "https://app.example.com/auth/google/callback",
    ...overrides,
  } as Env;
}

describe("Google OAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 501 when not configured", async () => {
    const app = makeApp();
    const env = makeEnv({ GOOGLE_CLIENT_ID: undefined });
    const res = await app.fetch(new Request("http://localhost/auth/google"), env);
    expect(res.status).toBe(501);
  });

  it("redirects to Google with a stored state", async () => {
    const app = makeApp();
    const env = makeEnv();
    const res = await app.fetch(new Request("http://localhost/auth/google"), env);
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location).toContain("client_id=google-client");
    expect(location).toContain("scope=openid+email+profile");
  });

  it("rejects callbacks with an unknown state", async () => {
    const app = makeApp();
    const env = makeEnv();
    const res = await app.fetch(
      new Request("http://localhost/auth/google/callback?code=x&state=forged"),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("creates a session for a verified Google account", async () => {
    const app = makeApp();
    const env = makeEnv({ STATE: makeKv({ "oauth_state:goodstate": "1" }) });

    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "google-token" }), { status: 200 });
      }
      if (url.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
        return new Response(
          JSON.stringify({ sub: "g-123", email: "user@example.com", email_verified: true }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.mocked(getUserByEmail).mockResolvedValue({
      success: true,
      data: {
        id: "usr_1",
        email: "user@example.com",
        username: "user",
        tokenHash: "h",
        createdAt: "",
      },
    });
    vi.mocked(createSession).mockResolvedValue({
      success: true,
      data: { id: "sess_1", userId: "usr_1", expiresAt: "2099-01-01T00:00:00.000Z" },
    });

    const res = await app.fetch(
      new Request("http://localhost/auth/google/callback?code=ok&state=goodstate"),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toContain("stratum_session=sess_1");
    expect(createUser).not.toHaveBeenCalled();
  });

  it("creates a new account when the email is unknown", async () => {
    const app = makeApp();
    const env = makeEnv({ STATE: makeKv({ "oauth_state:goodstate": "1" }) });

    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "google-token" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ sub: "g-9", email: "new@example.com", email_verified: true }),
        { status: 200 },
      );
    });

    vi.mocked(getUserByEmail).mockResolvedValue({
      success: false,
      error: new Error("not found") as never,
    });
    vi.mocked(createUser).mockResolvedValue({
      success: true,
      data: {
        user: {
          id: "usr_new",
          email: "new@example.com",
          username: "new",
          tokenHash: "h",
          createdAt: "",
        },
        plaintext: "stratum_user_x",
      },
    });
    vi.mocked(createSession).mockResolvedValue({
      success: true,
      data: { id: "sess_2", userId: "usr_new", expiresAt: "2099-01-01T00:00:00.000Z" },
    });

    const res = await app.fetch(
      new Request("http://localhost/auth/google/callback?code=ok&state=goodstate"),
      env,
    );
    expect(res.status).toBe(302);
    expect(createUser).toHaveBeenCalledWith(env.DB, "new@example.com", expect.any(Object));
  });

  it("rejects unverified Google emails", async () => {
    const app = makeApp();
    const env = makeEnv({ STATE: makeKv({ "oauth_state:goodstate": "1" }) });

    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "google-token" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ sub: "g-1", email: "x@example.com", email_verified: false }),
        { status: 200 },
      );
    });

    const res = await app.fetch(
      new Request("http://localhost/auth/google/callback?code=ok&state=goodstate"),
      env,
    );
    expect(res.status).toBe(422);
  });
});
