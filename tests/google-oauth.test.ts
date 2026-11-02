import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authRouter } from "../src/routes/auth";
import type { Env } from "../src/types";

vi.mock("../src/storage/users", () => ({
  createUser: vi.fn(),
  getUser: vi.fn(),
  getUserByEmail: vi.fn(),
  signInGitHubUser: vi.fn(),
}));

vi.mock("../src/storage/sessions", () => ({
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("../src/storage/audit", () => ({
  recordAudit: vi.fn().mockResolvedValue({ success: true, data: undefined }),
}));

vi.mock("../src/storage/identities", () => ({
  getIdentityByIssuerSubject: vi.fn(),
  upsertIdentity: vi.fn(),
}));

import { recordAudit } from "../src/storage/audit";
import { getIdentityByIssuerSubject, upsertIdentity } from "../src/storage/identities";
import { createSession } from "../src/storage/sessions";
import { createUser, getUser, getUserByEmail } from "../src/storage/users";
import { AppError, NotFoundError } from "../src/utils/errors";

const GOOGLE_ISSUER = "https://accounts.google.com";

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
    // Defaults: no identity linked yet (fall through to email match), and
    // identity persistence succeeds. Individual tests override as needed.
    vi.mocked(getIdentityByIssuerSubject).mockResolvedValue({
      success: false,
      error: new NotFoundError("Identity", "none"),
    });
    vi.mocked(upsertIdentity).mockImplementation(async (_db, _logger, input) => ({
      success: true,
      data: { id: "idn_1", createdAt: "", ...input, connectionId: input.connectionId ?? null },
    }));
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

  it("rejects a known state without the binding cookie (login CSRF)", async () => {
    const app = makeApp();
    const env = makeEnv({ STATE: makeKv({ "oauth_state:goodstate": "1" }) });
    const res = await app.fetch(
      new Request("http://localhost/auth/google/callback?code=ok&state=goodstate"),
      env,
    );
    expect(res.status).toBe(400);
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
      new Request("http://localhost/auth/google/callback?code=ok&state=goodstate", {
        headers: { Cookie: "stratum_oauth_state=goodstate" },
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toContain("stratum_session=sess_1");
    expect(createUser).not.toHaveBeenCalled();
  });

  it("asks a new identity to choose a username instead of creating an account", async () => {
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

    const res = await app.fetch(
      new Request("http://localhost/auth/google/callback?code=ok&state=goodstate", {
        headers: { Cookie: "stratum_oauth_state=goodstate" },
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/signup/complete");
    expect(res.headers.get("Set-Cookie")).toContain("stratum_pending_signup=");
    // The account does not exist until its owner has named it (tests/oauth-signup.test.ts).
    expect(createUser).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses a disabled account before minting a session (no session.created audit)", async () => {
    const app = makeApp();
    const env = makeEnv({ STATE: makeKv({ "oauth_state:goodstate": "1" }) });

    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "google-token" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ sub: "g-123", email: "disabled@example.com", email_verified: true }),
        { status: 200 },
      );
    });

    vi.mocked(getUserByEmail).mockResolvedValue({
      success: true,
      data: {
        id: "usr_disabled",
        email: "disabled@example.com",
        username: "disabled",
        tokenHash: "h",
        createdAt: "",
        disabledAt: "2026-08-01T00:00:00.000Z",
      },
    });

    const res = await app.fetch(
      new Request("http://localhost/auth/google/callback?code=ok&state=goodstate", {
        headers: { Cookie: "stratum_oauth_state=goodstate" },
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/login?error=account_disabled");
    expect(res.headers.get("Set-Cookie") ?? "").not.toContain("stratum_session");
    expect(createSession).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
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
      new Request("http://localhost/auth/google/callback?code=ok&state=goodstate", {
        headers: { Cookie: "stratum_oauth_state=goodstate" },
      }),
      env,
    );
    expect(res.status).toBe(422);
  });

  function mockGoogleUserinfo(user: { sub: string; email?: string; email_verified?: boolean }) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "google-token" }), { status: 200 });
      }
      if (url.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
        return new Response(JSON.stringify(user), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  }

  function callbackRequest() {
    return new Request("http://localhost/auth/google/callback?code=ok&state=goodstate", {
      headers: { Cookie: "stratum_oauth_state=goodstate" },
    });
  }

  it("persists an identities row keyed by sub after sign-in", async () => {
    const app = makeApp();
    const env = makeEnv({ STATE: makeKv({ "oauth_state:goodstate": "1" }) });
    mockGoogleUserinfo({ sub: "g-123", email: "user@example.com", email_verified: true });

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

    const res = await app.fetch(callbackRequest(), env);
    expect(res.status).toBe(302);
    expect(upsertIdentity).toHaveBeenCalledWith(env.DB, expect.anything(), {
      userId: "usr_1",
      provider: "google",
      issuer: GOOGLE_ISSUER,
      subject: "g-123",
      email: "user@example.com",
    });
  });

  it("resolves by (issuer, sub) before email — the sub match wins", async () => {
    const app = makeApp();
    const env = makeEnv({ STATE: makeKv({ "oauth_state:goodstate": "1" }) });
    // Identity for sub g-sub-x points at user A; user B holds the email.
    mockGoogleUserinfo({ sub: "g-sub-x", email: "shared@example.com", email_verified: true });

    vi.mocked(getIdentityByIssuerSubject).mockResolvedValue({
      success: true,
      data: {
        id: "idn_a",
        userId: "usr_a",
        provider: "google",
        issuer: GOOGLE_ISSUER,
        subject: "g-sub-x",
        email: "old@example.com",
        connectionId: null,
        createdAt: "",
      },
    });
    vi.mocked(getUser).mockResolvedValue({
      success: true,
      data: { id: "usr_a", email: "old@example.com", username: "a", tokenHash: "h", createdAt: "" },
    });
    vi.mocked(getUserByEmail).mockResolvedValue({
      success: true,
      data: {
        id: "usr_b",
        email: "shared@example.com",
        username: "b",
        tokenHash: "h",
        createdAt: "",
      },
    });
    vi.mocked(createSession).mockResolvedValue({
      success: true,
      data: { id: "sess_a", userId: "usr_a", expiresAt: "2099-01-01T00:00:00.000Z" },
    });

    const res = await app.fetch(callbackRequest(), env);
    expect(res.status).toBe(302);
    expect(getIdentityByIssuerSubject).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      GOOGLE_ISSUER,
      "g-sub-x",
    );
    expect(createSession).toHaveBeenCalledWith(env.DB, "usr_a", expect.anything());
    expect(getUserByEmail).not.toHaveBeenCalled();
  });

  it("signs in a linked user whose email claim is unverified — the sub is the credential", async () => {
    const app = makeApp();
    const env = makeEnv({ STATE: makeKv({ "oauth_state:goodstate": "1" }) });
    mockGoogleUserinfo({ sub: "g-sub-uv", email: "linked@example.com", email_verified: false });

    vi.mocked(getIdentityByIssuerSubject).mockResolvedValue({
      success: true,
      data: {
        id: "idn_uv",
        userId: "usr_uv",
        provider: "google",
        issuer: GOOGLE_ISSUER,
        subject: "g-sub-uv",
        email: "stored@example.com",
        connectionId: null,
        createdAt: "",
      },
    });
    vi.mocked(getUser).mockResolvedValue({
      success: true,
      data: {
        id: "usr_uv",
        email: "stored@example.com",
        username: "uv",
        tokenHash: "h",
        createdAt: "",
      },
    });
    vi.mocked(createSession).mockResolvedValue({
      success: true,
      data: { id: "sess_uv", userId: "usr_uv", expiresAt: "2099-01-01T00:00:00.000Z" },
    });

    const res = await app.fetch(callbackRequest(), env);

    expect(res.status).toBe(302);
    expect(createSession).toHaveBeenCalledWith(env.DB, "usr_uv", expect.anything());
    // The unverified claim must not overwrite the identity email.
    expect(upsertIdentity).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      expect.objectContaining({ subject: "g-sub-uv", email: "stored@example.com" }),
    );
  });

  it("refuses a disabled account matched by identity before minting a session", async () => {
    const app = makeApp();
    const env = makeEnv({ STATE: makeKv({ "oauth_state:goodstate": "1" }) });
    mockGoogleUserinfo({ sub: "g-dis", email: "disabled@example.com", email_verified: true });

    vi.mocked(getIdentityByIssuerSubject).mockResolvedValue({
      success: true,
      data: {
        id: "idn_d",
        userId: "usr_disabled",
        provider: "google",
        issuer: GOOGLE_ISSUER,
        subject: "g-dis",
        email: "disabled@example.com",
        connectionId: null,
        createdAt: "",
      },
    });
    vi.mocked(getUser).mockResolvedValue({
      success: true,
      data: {
        id: "usr_disabled",
        email: "disabled@example.com",
        username: "disabled",
        tokenHash: "h",
        createdAt: "",
        disabledAt: "2026-08-01T00:00:00.000Z",
      },
    });

    const res = await app.fetch(callbackRequest(), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/login?error=account_disabled");
    expect(createSession).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("fails the login closed when the identity lookup hits a storage error", async () => {
    const app = makeApp();
    const env = makeEnv({ STATE: makeKv({ "oauth_state:goodstate": "1" }) });
    mockGoogleUserinfo({ sub: "g-err", email: "user@example.com", email_verified: true });

    // A DB failure must NOT fall through to email match / account creation —
    // that path could mint a duplicate account for an already-linked subject.
    vi.mocked(getIdentityByIssuerSubject).mockResolvedValue({
      success: false,
      error: new AppError("Failed to get identity", "STORAGE_ERROR", 500),
    });

    const res = await app.fetch(callbackRequest(), env);
    expect(res.status).toBe(500);
    expect(res.headers.get("Set-Cookie") ?? "").not.toContain("stratum_session");
    expect(getUserByEmail).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("still signs in when persisting the identity row fails (non-fatal)", async () => {
    const app = makeApp();
    const env = makeEnv({ STATE: makeKv({ "oauth_state:goodstate": "1" }) });
    mockGoogleUserinfo({ sub: "g-123", email: "user@example.com", email_verified: true });

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
    vi.mocked(upsertIdentity).mockResolvedValue({
      success: false,
      error: new AppError("Failed to upsert identity", "STORAGE_ERROR", 500),
    });
    vi.mocked(createSession).mockResolvedValue({
      success: true,
      data: { id: "sess_1", userId: "usr_1", expiresAt: "2099-01-01T00:00:00.000Z" },
    });

    const res = await app.fetch(callbackRequest(), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toContain("stratum_session=sess_1");
  });
});
