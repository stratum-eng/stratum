/**
 * Issue #254: the token management API.
 *
 * The property under test that is easy to lose: these routes require a browser
 * SESSION. A read_write token that could mint tokens, revoke its siblings, and
 * rotate the legacy credential makes the feature circular — the "revoke the lost
 * laptop" story fails if the lost laptop can issue itself a replacement.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

vi.mock("../src/storage/audit", () => ({ recordAudit: vi.fn(async () => ({ success: true })) }));
vi.mock("../src/storage/api-tokens", () => ({
  MIN_TOKEN_EXPIRY_DAYS: 1,
  MAX_TOKEN_EXPIRY_DAYS: 365,
  createApiToken: vi.fn(),
  listApiTokens: vi.fn(),
  revokeApiToken: vi.fn(),
  resolveApiToken: vi.fn(),
  touchApiTokenLastUsed: vi.fn(),
  isExpired: vi.fn(() => false),
}));
vi.mock("../src/storage/users", () => ({
  disableLegacyToken: vi.fn(async () => ({ success: true, data: undefined })),
  getUser: vi.fn(),
  getUserByUsername: vi.fn(),
  markUserDeleting: vi.fn(),
  rotateUserToken: vi.fn(async () => ({ success: true, data: "stratum_user_new" })),
}));
vi.mock("../src/storage/deletion-jobs", () => ({ createDeletionJob: vi.fn() }));

import { usersRouter } from "../src/routes/users";
import { createApiToken, listApiTokens, revokeApiToken } from "../src/storage/api-tokens";
import { recordAudit } from "../src/storage/audit";
import { disableLegacyToken, rotateUserToken } from "../src/storage/users";

const env = { DB: {} } as unknown as Env;
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/** Mounts the router with an injected identity, so each test controls how the
 * caller authenticated without standing up real auth. */
function makeApp(identity: {
  userId?: string;
  authVia?: "token" | "session";
  apiTokenId?: string;
}) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    if (identity.userId) c.set("userId", identity.userId);
    if (identity.authVia) c.set("authVia", identity.authVia);
    if (identity.apiTokenId) c.set("apiTokenId", identity.apiTokenId);
    await next();
  });
  app.route("/api/users", usersRouter);
  return app;
}

const SESSION = { userId: "usr_1", authVia: "session" as const };
/** The LEGACY credential: a token caller carrying no scoped-token row id. */
const TOKEN = { userId: "usr_1", authVia: "token" as const };
/** A scoped token (#254). Distinguished from the legacy key by `apiTokenId` —
 * both resolve to `read_write`, so the scope alone cannot tell them apart. */
const SCOPED_TOKEN = { userId: "usr_1", authVia: "token" as const, apiTokenId: "tok_1" };

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => vi.clearAllMocks());

describe("token management requires a session", () => {
  const cases: Array<{ label: string; method: string; path: string; body?: unknown }> = [
    { label: "list", method: "GET", path: "/api/users/me/tokens" },
    { label: "create", method: "POST", path: "/api/users/me/tokens", body: { name: "ci" } },
    { label: "revoke", method: "DELETE", path: "/api/users/me/tokens/tok_1" },
    { label: "disable legacy", method: "POST", path: "/api/users/me/legacy-token/disable" },
  ];

  it.each(cases)("403s an API token on $label", async ({ method, path, body }) => {
    const res = await makeApp(TOKEN).fetch(req(method, path, body), env, ctx);
    expect(res.status).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "SESSION_REQUIRED" });
    expect(createApiToken).not.toHaveBeenCalled();
    expect(revokeApiToken).not.toHaveBeenCalled();
    expect(disableLegacyToken).not.toHaveBeenCalled();
  });

  it.each(cases)("401s an unauthenticated caller on $label", async ({ method, path, body }) => {
    const res = await makeApp({}).fetch(req(method, path, body), env, ctx);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/users/me/tokens", () => {
  beforeEach(() => {
    vi.mocked(createApiToken).mockResolvedValue({
      success: true,
      data: {
        token: {
          id: "tok_1",
          name: "ci",
          tokenPrefix: "stratum_user_abcd1234",
          scope: "read",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        plaintext: "stratum_user_abcd1234abcd1234abcd1234abcd1234",
      },
    } as never);
  });

  it("returns the plaintext once, and forbids caching it", async () => {
    const res = await makeApp(SESSION).fetch(
      req("POST", "/api/users/me/tokens", { name: "ci" }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    // The plaintext exists nowhere else after this response.
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { plaintext: string };
    expect(body.plaintext).toMatch(/^stratum_user_/);
  });

  it("defaults to the WEAKER scope when the caller does not say", async () => {
    await makeApp(SESSION).fetch(req("POST", "/api/users/me/tokens", { name: "ci" }), env, ctx);
    expect(createApiToken).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ scope: "read" }),
    );
  });

  it("audits the creation", async () => {
    await makeApp(SESSION).fetch(req("POST", "/api/users/me/tokens", { name: "ci" }), env, ctx);
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      // `subject` is the indexed field an audit query filters on, so the token
      // id belongs there rather than buried in the free-form detail blob.
      expect.objectContaining({ action: "token.created", actorId: "usr_1", subject: "tok_1" }),
    );
  });

  it.each([
    ["a missing name", {}],
    ["an empty name", { name: "   " }],
    ["an unknown scope", { name: "ci", scope: "admin" }],
    ["a non-integer expiry", { name: "ci", expiresInDays: 1.5 }],
    ["a zero expiry", { name: "ci", expiresInDays: 0 }],
    ["an over-long expiry", { name: "ci", expiresInDays: 400 }],
    ["a non-numeric expiry", { name: "ci", expiresInDays: "30" }],
  ])("400s %s", async (_label, body) => {
    const res = await makeApp(SESSION).fetch(req("POST", "/api/users/me/tokens", body), env, ctx);
    expect(res.status).toBe(400);
    expect(createApiToken).not.toHaveBeenCalled();
  });

  it("400s a JSON body of null rather than throwing", async () => {
    const res = await makeApp(SESSION).fetch(
      new Request("http://localhost/api/users/me/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "null",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("409s at the token cap", async () => {
    vi.mocked(createApiToken).mockResolvedValue({
      success: false,
      error: { message: "too many", code: "TOKEN_LIMIT_REACHED", statusCode: 409 },
    } as never);
    const res = await makeApp(SESSION).fetch(
      req("POST", "/api/users/me/tokens", { name: "ci" }),
      env,
      ctx,
    );
    expect(res.status).toBe(409);
  });

  it("400s a storage validation failure instead of reporting it as a conflict", async () => {
    // A 409 tells the caller to free a token slot and retry, which can never
    // fix a rejected name or expiry.
    vi.mocked(createApiToken).mockResolvedValue({
      success: false,
      error: { message: "name already in use", code: "INVALID_TOKEN_NAME", statusCode: 400 },
    } as never);
    // A body the route itself accepts, so the rejection can only come from
    // storage — which is the mapping under test.
    const res = await makeApp(SESSION).fetch(
      req("POST", "/api/users/me/tokens", { name: "ci" }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_TOKEN_NAME" });
  });
});

describe("GET and DELETE", () => {
  it("lists without exposing a hash", async () => {
    vi.mocked(listApiTokens).mockResolvedValue({
      success: true,
      data: [
        {
          id: "tok_1",
          name: "ci",
          tokenPrefix: "stratum_user_abcd1234",
          scope: "read",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    } as never);
    const res = await makeApp(SESSION).fetch(req("GET", "/api/users/me/tokens"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("hash");
  });

  it("404s another user's token id without disclosing that it exists", async () => {
    vi.mocked(revokeApiToken).mockResolvedValue({
      success: false,
      error: { message: "not found", code: "NOT_FOUND", statusCode: 404 },
    } as never);
    const res = await makeApp(SESSION).fetch(
      req("DELETE", "/api/users/me/tokens/tok_someone_else"),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("revokes and audits", async () => {
    vi.mocked(revokeApiToken).mockResolvedValue({ success: true, data: undefined } as never);
    const res = await makeApp(SESSION).fetch(req("DELETE", "/api/users/me/tokens/tok_1"), env, ctx);
    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ action: "token.revoked", subject: "tok_1" }),
    );
  });
});

describe("legacy token disable", () => {
  it("disables and audits", async () => {
    const res = await makeApp(SESSION).fetch(
      req("POST", "/api/users/me/legacy-token/disable"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(disableLegacyToken).toHaveBeenCalledWith(env.DB, "usr_1", expect.any(Object));
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ action: "token.legacy_disabled" }),
    );
  });
});

describe("rotate-token: legacy callers keep working, scoped tokens cannot escalate", () => {
  it("still works with the legacy key, so existing automation is not broken", async () => {
    const res = await makeApp(TOKEN).fetch(req("POST", "/api/users/me/rotate-token"), env, ctx);
    // Deliberately NOT session-gated: it predates this change and restricting it
    // would break callers that rely on it today.
    expect(res.status).toBe(200);
  });

  it("still works with a session", async () => {
    const res = await makeApp(SESSION).fetch(req("POST", "/api/users/me/rotate-token"), env, ctx);
    expect(res.status).toBe(200);
  });

  it("403s a SCOPED token, which must not mint a credential that outlives it", async () => {
    // The containment property: the legacy key never expires and cannot be
    // revoked one-at-a-time, so a scoped token able to rotate it would survive
    // its own revocation — "revoke the lost laptop" would not contain anything.
    const res = await makeApp(SCOPED_TOKEN).fetch(
      req("POST", "/api/users/me/rotate-token"),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "SESSION_REQUIRED" });
    expect(rotateUserToken).not.toHaveBeenCalled();
  });
});
