import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiTokenSummary } from "../src/storage/api-tokens";
import type { Env } from "../src/types";
/**
 * Issue #254: the scoped-token surfaces on the server-rendered settings page.
 *
 * The properties under test are the ones that would be silently lost: the
 * listing must never carry a hash, the freshly minted plaintext must be shown
 * exactly once and never cached, the whole page must work without a line of
 * client JS, and a caller holding an API token rather than a browser session
 * must not reach any of it.
 */
import { formatDate } from "../src/ui/format";

vi.mock("../src/storage/audit", () => ({ recordAudit: vi.fn(async () => ({ success: true })) }));
// Spread the real module and override only what touches D1. Listing the
// exports by hand silently drops any added later — `isExpired`, which the page
// calls to count active tokens, would arrive as undefined and 500 the render.
vi.mock("../src/storage/api-tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage/api-tokens")>()),
  createApiToken: vi.fn(),
  listApiTokens: vi.fn(),
  revokeApiToken: vi.fn(),
}));
vi.mock("../src/storage/users", () => ({
  getUser: vi.fn(async (_db: unknown, userId: string) =>
    userId === "usr_1"
      ? {
          success: true,
          data: {
            id: "usr_1",
            email: "alice@example.com",
            username: "alice",
            tokenHash: "hash",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }
      : { success: false, error: { message: "not found" } },
  ),
  rotateUserToken: vi.fn(async () => ({ success: true, data: "stratum_user_rotated" })),
  disableLegacyToken: vi.fn(async () => ({ success: true, data: undefined })),
}));
vi.mock("../src/storage/agents", () => ({
  listAgents: vi.fn(async () => ({ success: true, data: [] })),
  getAgent: vi.fn(),
  createAgent: vi.fn(),
  deleteAgent: vi.fn(),
}));

import { uiRouter } from "../src/routes/ui";
import { createAgent, deleteAgent, getAgent } from "../src/storage/agents";
import { createApiToken, listApiTokens, revokeApiToken } from "../src/storage/api-tokens";
import { recordAudit } from "../src/storage/audit";
import { disableLegacyToken, rotateUserToken } from "../src/storage/users";

const env = { DB: {} } as unknown as Env;
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/** How the caller reached the page: a browser session, an API token, or nothing. */
type Identity = { userId?: string; authVia?: "token" | "session"; apiTokenId?: string };

/** Mounts the UI router with an injected identity, so each test controls how
 * the caller authenticated without standing up real auth. */
function makeApp(identity: Identity) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    if (identity.userId) c.set("userId", identity.userId);
    if (identity.authVia) c.set("authVia", identity.authVia);
    if (identity.apiTokenId) c.set("apiTokenId", identity.apiTokenId);
    await next();
  });
  app.route("/", uiRouter);
  return app;
}

const SESSION = { userId: "usr_1", authVia: "session" as const };
/** The LEGACY credential: a token caller with no scoped-token row id. */
const TOKEN = { userId: "usr_1", authVia: "token" as const };
/** A scoped token (#254) — same `read_write` power, told apart by `apiTokenId`. */
const SCOPED_TOKEN = { userId: "usr_1", authVia: "token" as const, apiTokenId: "tok_1" };

function get(path: string, identity: Identity = SESSION): Promise<Response> {
  return Promise.resolve(makeApp(identity).fetch(new Request(`http://localhost${path}`), env, ctx));
}

function post(
  path: string,
  form: Record<string, string>,
  identity: Identity = SESSION,
): Promise<Response> {
  return Promise.resolve(
    makeApp(identity).fetch(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      }),
      env,
      ctx,
    ),
  );
}

const ACTIVE_TOKEN: ApiTokenSummary = {
  id: "tok_ci",
  name: "buildkite",
  tokenPrefix: "stratum_user_1a2b3c4d",
  scope: "read",
  expiresAt: "2099-01-01T00:00:00.000Z",
  lastUsedAt: "2026-08-01T00:00:00.000Z",
  createdAt: "2026-07-01T00:00:00.000Z",
};

const REVOKED_TOKEN: ApiTokenSummary = {
  id: "tok_laptop",
  name: "old laptop",
  tokenPrefix: "stratum_user_99887766",
  scope: "read_write",
  createdAt: "2026-01-01T00:00:00.000Z",
  revokedAt: "2026-02-01T00:00:00.000Z",
};

const PLAINTEXT = "stratum_user_abcd1234abcd1234abcd1234abcd1234";

function listReturns(tokens: ApiTokenSummary[]): void {
  vi.mocked(listApiTokens).mockResolvedValue({ success: true, data: tokens } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  listReturns([]);
});

describe("GET /settings — the token listing", () => {
  it("shows each token's name, prefix, scope, expiry, last used, and status", async () => {
    listReturns([ACTIVE_TOKEN, REVOKED_TOKEN]);
    const html = await (await get("/settings")).text();

    expect(html).toContain("buildkite");
    expect(html).toContain("stratum_user_1a2b3c4d");
    expect(html).toContain("Read-only");
    expect(html).toContain("Never used"); // the revoked token was never used
    expect(html).toContain("Revoked");
    expect(html).toContain(formatDate(ACTIVE_TOKEN.lastUsedAt ?? ""));
    expect(html).toContain(formatDate(ACTIVE_TOKEN.expiresAt ?? ""));
    // Read & write, rendered for the revoked row.
    expect(html).toContain("Read &amp; write");
  });

  it("never renders a token hash, even if one reaches the view model", async () => {
    const hash = "deadbeef".repeat(8);
    listReturns([{ ...ACTIVE_TOKEN, tokenHash: hash } as unknown as ApiTokenSummary]);
    const html = await (await get("/settings")).text();

    expect(html).not.toContain(hash);
    // Nothing hash-shaped at all: a 64-character hex run is the only thing a
    // SHA-256 digest could look like.
    expect(html).not.toMatch(/[a-f0-9]{64}/);
  });

  it("offers an empty state rather than a bare table when there are no tokens", async () => {
    const html = await (await get("/settings")).text();
    expect(html).toContain("No API tokens yet");
    expect(html).not.toContain("Last used");
  });

  it("defaults the scope selector to read-only", async () => {
    const html = await (await get("/settings")).text();
    const readOption = /<option value="read"[^>]*selected/.test(html);
    expect(readOption).toBe(true);
    expect(html).toMatch(/<option value="read_write"(?![^>]*selected)/);
  });

  it("renders no client-side script anywhere on the page", async () => {
    listReturns([ACTIVE_TOKEN, REVOKED_TOKEN]);
    const html = await (await get("/settings")).text();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+="/);
  });

  it("renders only known notices, never text from the query string", async () => {
    const html = await (await get("/settings?notice=%3Cscript%3Ealert(1)%3C%2Fscript%3E")).text();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("alert(1)");

    const disabled = await (await get("/settings?notice=legacy-disabled")).text();
    expect(disabled).toContain("legacy API key has been disabled");
  });

  it.each(["constructor", "toString", "__proto__", "valueOf"])(
    "renders no notice for the inherited name %s",
    async (name) => {
      // A bare index lookup on the notice table resolves these to values off
      // Object.prototype, which are not notices at all.
      const clean = await (await get("/settings")).text();
      const html = await (await get(`/settings?notice=${name}`)).text();
      expect(html).toBe(clean);
    },
  );
});

describe("POST /settings/tokens — creating a token", () => {
  beforeEach(() => {
    vi.mocked(createApiToken).mockResolvedValue({
      success: true,
      data: {
        token: {
          id: "tok_new",
          name: "ci",
          tokenPrefix: "stratum_user_abcd1234",
          scope: "read",
          createdAt: "2026-08-28T00:00:00.000Z",
        },
        plaintext: PLAINTEXT,
      },
    } as never);
  });

  it("shows the plaintext exactly once and forbids caching it", async () => {
    const res = await post("/settings/tokens", { name: "ci" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const html = await res.text();
    expect(html.split(PLAINTEXT).length - 1).toBe(1);
    expect(html).toContain("shown only once");

    // This page carries one inline script (the nonce'd copy button added in
    // #312), so "no script at all" is no longer the invariant. What the
    // assertion was protecting still is: the secret must never be handed to
    // client-side code. That script reads the value out of the DOM and never
    // re-serializes it, so no script block may contain the plaintext.
    const scriptBodies = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(
      (match) => match[1] ?? "",
    );
    for (const body of scriptBodies) expect(body).not.toContain(PLAINTEXT);
  });

  it("defaults to the WEAKER scope when the form does not say", async () => {
    await post("/settings/tokens", { name: "ci" });
    expect(createApiToken).toHaveBeenCalledWith(env.DB, expect.anything(), {
      userId: "usr_1",
      name: "ci",
      scope: "read",
    });
  });

  it("passes through an explicit read_write scope and expiry", async () => {
    await post("/settings/tokens", { name: "deploy", scope: "read_write", expiresInDays: "90" });
    expect(createApiToken).toHaveBeenCalledWith(env.DB, expect.anything(), {
      userId: "usr_1",
      name: "deploy",
      scope: "read_write",
      expiresInDays: 90,
    });
  });

  it("audits the creation", async () => {
    await post("/settings/tokens", { name: "ci" });
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      expect.objectContaining({ action: "token.created", actorId: "usr_1", subject: "tok_new" }),
    );
  });

  const invalid: Array<{ label: string; form: Record<string, string> }> = [
    { label: "an empty name", form: { name: "  " } },
    { label: "a name over 100 characters", form: { name: "x".repeat(101) } },
    { label: "a zero-day expiry", form: { name: "ci", expiresInDays: "0" } },
    { label: "an expiry beyond a year", form: { name: "ci", expiresInDays: "366" } },
    { label: "a non-numeric expiry", form: { name: "ci", expiresInDays: "soon" } },
    { label: "an unknown scope", form: { name: "ci", scope: "admin" } },
  ];

  it.each(invalid)("rejects $label without reaching storage", async ({ form }) => {
    const res = await post("/settings/tokens", form);
    expect(res.status).toBe(400);
    expect(createApiToken).not.toHaveBeenCalled();
  });

  it("shows the cap message when the user already holds the maximum", async () => {
    vi.mocked(createApiToken).mockResolvedValue({
      success: false,
      error: {
        message: "At most 20 active tokens per user. Revoke one first.",
        code: "TOKEN_LIMIT_REACHED",
        statusCode: 409,
      },
    } as never);

    const res = await post("/settings/tokens", { name: "ci" });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("At most 20 active tokens per user");
  });
});

describe("POST /settings/tokens/:id/revoke", () => {
  it("revokes the token, audits it, and redirects so a refresh cannot re-post", async () => {
    vi.mocked(revokeApiToken).mockResolvedValue({ success: true, data: undefined } as never);

    const res = await post("/settings/tokens/tok_ci/revoke", {});
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/settings?notice=token-revoked");
    expect(revokeApiToken).toHaveBeenCalledWith(env.DB, expect.anything(), {
      userId: "usr_1",
      tokenId: "tok_ci",
    });
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      expect.objectContaining({ action: "token.revoked", subject: "tok_ci" }),
    );
  });

  it("404s an id that is not the caller's", async () => {
    vi.mocked(revokeApiToken).mockResolvedValue({
      success: false,
      error: { message: "Token not found", code: "NOT_FOUND", statusCode: 404 },
    } as never);

    const res = await post("/settings/tokens/tok_someone_else/revoke", {});
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("No such token");
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe("POST /settings/legacy-token/disable", () => {
  it("disables the legacy credential, audits it, and explains the effect", async () => {
    const res = await post("/settings/legacy-token/disable", {});
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/settings?notice=legacy-disabled");
    expect(disableLegacyToken).toHaveBeenCalledWith(env.DB, "usr_1", expect.anything());
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      expect.objectContaining({ action: "token.legacy_disabled", actorId: "usr_1" }),
    );

    const followed = await (await get("/settings?notice=legacy-disabled")).text();
    expect(followed).toContain("your existing tokens keep working");
  });

  it("surfaces a failure instead of claiming success", async () => {
    vi.mocked(disableLegacyToken).mockResolvedValue({
      success: false,
      error: { message: "boom", code: "DATABASE_ERROR", statusCode: 500 },
    } as never);

    const res = await post("/settings/legacy-token/disable", {});
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Could not disable the legacy API key");
  });
});

describe("the settings surfaces require a browser session", () => {
  const routes: Array<{ label: string; call: (identity: Identity) => Promise<Response> }> = [
    { label: "the settings page", call: (id) => get("/settings", id) },
    { label: "create", call: (id) => post("/settings/tokens", { name: "ci" }, id) },
    { label: "revoke", call: (id) => post("/settings/tokens/tok_ci/revoke", {}, id) },
    { label: "legacy disable", call: (id) => post("/settings/legacy-token/disable", {}, id) },
    // An agent token outlives the credential that minted it, so the same rule
    // has to cover these two: a `read_write` token that could mint one would
    // leave "revoke the lost laptop" incomplete.
    { label: "agent create", call: (id) => post("/settings/agents", { name: "bot" }, id) },
    { label: "agent revoke", call: (id) => post("/settings/agents/agt_1/delete", {}, id) },
  ];

  it.each(routes)("403s an API-token caller on $label", async ({ call }) => {
    const res = await call(TOKEN);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("signed-in browser session");
    expect(createApiToken).not.toHaveBeenCalled();
    expect(revokeApiToken).not.toHaveBeenCalled();
    expect(disableLegacyToken).not.toHaveBeenCalled();
    expect(listApiTokens).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
    expect(deleteAgent).not.toHaveBeenCalled();
  });

  it.each(routes)("sends an unauthenticated caller to sign in on $label", async ({ call }) => {
    const res = await call({});
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/email");
    expect(createApiToken).not.toHaveBeenCalled();
    expect(revokeApiToken).not.toHaveBeenCalled();
    expect(disableLegacyToken).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
    expect(deleteAgent).not.toHaveBeenCalled();
  });

  // A scoped token is the case #254 was written for; it must be refused here
  // too, not merely the legacy credential.
  it.each(routes)("403s a scoped-token caller on $label", async ({ call }) => {
    const res = await call(SCOPED_TOKEN);
    expect(res.status).toBe(403);
    expect(createAgent).not.toHaveBeenCalled();
    expect(deleteAgent).not.toHaveBeenCalled();
  });
});

describe("the agent surfaces still work for a browser session", () => {
  it("mints an agent token and shows the plaintext once, uncached", async () => {
    vi.mocked(createAgent).mockResolvedValue({
      success: true,
      data: { agent: { id: "agt_1" }, plaintext: "stratum_agent_fresh" },
    } as unknown as Awaited<ReturnType<typeof createAgent>>);
    const res = await post("/settings/agents", { name: "bot" }, SESSION);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toContain("stratum_agent_fresh");
  });

  it("revokes an agent the caller owns", async () => {
    vi.mocked(getAgent).mockResolvedValue({
      success: true,
      data: { id: "agt_1", ownerId: "usr_1" },
    } as unknown as Awaited<ReturnType<typeof getAgent>>);
    vi.mocked(deleteAgent).mockResolvedValue({
      success: true,
      data: undefined,
    } as unknown as Awaited<ReturnType<typeof deleteAgent>>);
    const res = await post("/settings/agents/agt_1/delete", {}, SESSION);
    expect(res.status).toBe(302);
    expect(deleteAgent).toHaveBeenCalled();
  });

  it("does not revoke an agent owned by someone else", async () => {
    vi.mocked(getAgent).mockResolvedValue({
      success: true,
      data: { id: "agt_1", ownerId: "usr_other" },
    } as unknown as Awaited<ReturnType<typeof getAgent>>);
    await post("/settings/agents/agt_1/delete", {}, SESSION);
    expect(deleteAgent).not.toHaveBeenCalled();
  });
});

describe("POST /settings/rotate-token — the legacy key stays reachable, scoped tokens do not", () => {
  it("still rotates for a session", async () => {
    const res = await post("/settings/rotate-token", {}, SESSION);
    expect(res.status).toBe(200);
    expect(rotateUserToken).toHaveBeenCalled();
  });

  it("still rotates for the legacy credential, so existing automation survives", async () => {
    const res = await post("/settings/rotate-token", {}, TOKEN);
    expect(res.status).toBe(200);
    expect(rotateUserToken).toHaveBeenCalled();
  });

  it("403s a SCOPED token, which must not mint a key that outlives its revocation", async () => {
    const res = await post("/settings/rotate-token", {}, SCOPED_TOKEN);
    expect(res.status).toBe(403);
    expect(rotateUserToken).not.toHaveBeenCalled();
  });
});
