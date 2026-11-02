/**
 * Issue #349: the OAuth 2.1 authorization flow, end to end over HTTP.
 *
 * Driven through the real routers against real SQLite, because the properties
 * worth testing here are the ones that only exist when the pieces are wired
 * together: that an unregistered redirect URI is *rendered* rather than
 * redirected to, that a code minted for one client cannot be redeemed by
 * another, that PKCE is not optional, and that the middleware stack does not
 * eat a `client_secret_basic` header before the token endpoint sees it.
 *
 * `authMiddleware` and `csrfMiddleware` are mounted exactly as `src/index.ts`
 * mounts them — the consent POST is a session-authenticated, state-changing
 * request, so its same-origin check is part of the behaviour under test.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { csrfMiddleware } from "../src/middleware/csrf";
import { securityHeadersMiddleware } from "../src/middleware/security-headers";
import { mcpOAuthRouter } from "../src/routes/mcp-oauth";
import { createSession } from "../src/storage/sessions";
import type { Env } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import type { Logger } from "../src/utils/logger";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const ORIGIN = "https://stratum.test";
const REDIRECT = "http://127.0.0.1:9876/callback";
const VERIFIER = "a".repeat(64);

let app: Hono<{ Bindings: Env }>;
let env: Env;
let db: D1Database;
let sessionCookie: string;
let CHALLENGE: string;

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

interface RegistrationResponse {
  client_id: string;
  client_secret: string;
  error: string;
}

/** Registers a client and returns its id (plus the secret, when confidential). */
async function register(
  body: Record<string, unknown> = {},
): Promise<{ status: number; json: RegistrationResponse }> {
  const response = await app.fetch(
    new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Editor",
        redirect_uris: [REDIRECT],
        ...body,
      }),
    }),
    env,
  );
  return { status: response.status, json: (await response.json()) as RegistrationResponse };
}

/** Runs the consent POST and returns the `Location` it redirects to. */
async function consent(
  fields: Record<string, string>,
  opts: { origin?: string; cookie?: string } = {},
): Promise<Response> {
  const form = new URLSearchParams({ decision: "allow", ...fields });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: opts.origin ?? ORIGIN,
  };
  const cookie = opts.cookie ?? sessionCookie;
  if (cookie !== "") headers.Cookie = cookie;
  return app.fetch(
    new Request(`${ORIGIN}/oauth/authorize`, { method: "POST", headers, body: form.toString() }),
    env,
  );
}

async function exchange(form: Record<string, string>, authHeader?: string): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (authHeader !== undefined) headers.Authorization = authHeader;
  return app.fetch(
    new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers,
      body: new URLSearchParams(form).toString(),
    }),
    env,
  );
}

/** Registers, consents, and returns the authorization code. */
async function codeFor(
  clientId: string,
  overrides: Record<string, string> = {},
): Promise<string | null> {
  const response = await consent({
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "mcp:read mcp:write",
    code_challenge: CHALLENGE,
    state: "xyz",
    ...overrides,
  });
  const location = response.headers.get("location");
  return location === null ? null : new URL(location).searchParams.get("code");
}

beforeEach(async () => {
  const made = makeSqliteD1();
  db = made.db;
  env = { DB: db } as unknown as Env;
  CHALLENGE = await pkceChallenge(VERIFIER);

  app = new Hono<{ Bindings: Env }>();
  app.use("*", securityHeadersMiddleware);
  app.use("*", authMiddleware);
  app.use("*", csrfMiddleware);
  app.route("/", mcpOAuthRouter);

  await db
    .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
    .bind("usr_1", "u@test", "alice", await hashToken("legacy"))
    .run();
  const session = await createSession(db, "usr_1", logger);
  if (!session.success) throw new Error("session setup failed");
  sessionCookie = `stratum_session=${session.data.id}`;
});

describe("discovery", () => {
  it("builds both metadata documents from the request origin", async () => {
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const response = await app.fetch(new Request(`${ORIGIN}${path}`), env);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = JSON.stringify(await response.json());
      // Never a configured base URL: a self-hosted instance must advertise
      // itself, and a client that reached us at one hostname must not be sent
      // to authorize at another.
      expect(body).toContain(ORIGIN);
      expect(body).not.toContain("usestratum.dev/oauth");
    }
  });

  it("advertises S256 only, so a client cannot negotiate down to plain", async () => {
    const response = await app.fetch(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
      env,
    );
    const body = (await response.json()) as { code_challenge_methods_supported: string[] };
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
  });
});

describe("dynamic client registration", () => {
  it("registers a public client without any credential", async () => {
    const { status, json } = await register();
    expect(status).toBe(201);
    expect(json.client_id).toMatch(/^mcpc_[0-9a-f]{32}$/);
    expect(json.client_secret).toBeUndefined();
  });

  it("returns a secret exactly once for a confidential client", async () => {
    const { json } = await register({ token_endpoint_auth_method: "client_secret_post" });
    expect(json.client_secret).toMatch(/^stratum_mcpcs_[0-9a-f]{32}$/);
  });

  it("refuses a redirect URI it would never redirect to", async () => {
    const { status, json } = await register({ redirect_uris: ["http://evil.example/cb"] });
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_redirect_uri");
  });

  it("refuses a scope it does not grant", async () => {
    const { status, json } = await register({ scope: "admin:all" });
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_scope");
  });
});

describe("authorization", () => {
  it("sends an unauthenticated visitor to sign in, remembering the whole request", async () => {
    const { json } = await register();
    const url = `${ORIGIN}/oauth/authorize?response_type=code&client_id=${json.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=xyz`;
    const response = await app.fetch(new Request(url), env);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/login");
    // The query string has to survive the round trip, or the editor waiting on
    // the redirect just times out after the user signs in.
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("redirect_after_login=");
    expect(decodeURIComponent(cookie)).toContain(`client_id=${json.client_id}`);
  });

  it("renders the consent screen naming the client, the target and the scopes", async () => {
    const { json } = await register();
    const url = `${ORIGIN}/oauth/authorize?response_type=code&client_id=${json.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${CHALLENGE}&code_challenge_method=S256&scope=mcp%3Awrite`;
    const response = await app.fetch(new Request(url, { headers: { Cookie: sessionCookie } }), env);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Test Editor");
    expect(html).toContain(REDIRECT);
    expect(html).toContain("alice");
    // The write scope must be spelled out, not shown as a raw scope token.
    expect(html).toContain("Create workspaces, commit files");
    // And the screen must say the name is self-asserted.
    expect(html).toContain("register itself under any name");
  });

  it("lets the browser follow the post-consent redirect chain to the client", async () => {
    // Chromium and WebKit enforce the consent page's `form-action` against
    // every hop of the redirect chain that answers its form POST. Under the
    // site-wide `'self'`, clicking Allow minted a code the browser then refused
    // to deliver; naming the client's origin still broke when the client's own
    // callback redirected onward. So this page — and only this page — carries
    // no `form-action` at all. The middleware sets the site-wide policy first;
    // the route must win, and the rest of the policy must survive.
    const { json } = await register();
    const url = `${ORIGIN}/oauth/authorize?response_type=code&client_id=${json.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${CHALLENGE}&code_challenge_method=S256`;
    const consentPage = await app.fetch(
      new Request(url, { headers: { Cookie: sessionCookie } }),
      env,
    );
    expect(consentPage.status).toBe(200);
    const consentCsp = consentPage.headers.get("Content-Security-Policy") ?? "";
    expect(consentCsp).not.toContain("form-action");
    expect(consentCsp).toContain("frame-ancestors 'none'");
    expect(consentCsp).toContain("script-src 'nonce-");

    // The error page redirects nowhere, so it keeps the default.
    const errorPage = await app.fetch(
      new Request(
        `${ORIGIN}/oauth/authorize?response_type=code&client_id=${json.client_id}&redirect_uri=${encodeURIComponent("https://attacker.example/steal")}&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
        { headers: { Cookie: sessionCookie } },
      ),
      env,
    );
    expect(errorPage.status).toBe(400);
    expect(errorPage.headers.get("Content-Security-Policy")).toContain("form-action 'self';");
  });

  it("RENDERS rather than redirects when the redirect URI is not registered", async () => {
    const { json } = await register();

    // Each of these is a published way to steal an authorization code when the
    // comparison is anything looser than byte-for-byte equality against the
    // registered list. A different host is the obvious one; the rest are the
    // ones that survive prefix matching, origin-only matching, and "ignore the
    // query string".
    const attacks = [
      "https://attacker.example/steal",
      // Prefix matching: the registered URI is a prefix of this one.
      `${REDIRECT}/../../evil`,
      `${REDIRECT}.attacker.example`,
      `${REDIRECT}extra`,
      // Origin-only matching: same origin, attacker-chosen path.
      "http://127.0.0.1:9876/evil",
      // Ignoring the query string.
      `${REDIRECT}?next=https://attacker.example`,
    ];

    for (const attack of attacks) {
      const url = `${ORIGIN}/oauth/authorize?response_type=code&client_id=${json.client_id}&redirect_uri=${encodeURIComponent(attack)}&code_challenge=${CHALLENGE}&code_challenge_method=S256`;
      const response = await app.fetch(
        new Request(url, { headers: { Cookie: sessionCookie } }),
        env,
      );

      // Bouncing any of these to the unverified URI is the open redirect that
      // turns the endpoint into a phishing gadget, so it must never be a 302.
      expect(response.status, attack).toBe(400);
      expect(response.headers.get("location"), attack).toBeNull();
      expect(await response.text()).toContain("Redirect URI mismatch");
    }
  });

  it("redirects PKCE and scope failures back to the verified URI, echoing state", async () => {
    const { json } = await register();
    const base = `${ORIGIN}/oauth/authorize?response_type=code&client_id=${json.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=xyz`;

    for (const [query, expected] of [
      ["", "invalid_request"],
      [`&code_challenge=${CHALLENGE}&code_challenge_method=plain`, "invalid_request"],
      ["&code_challenge=short&code_challenge_method=S256", "invalid_request"],
      [`&code_challenge=${CHALLENGE}&code_challenge_method=S256&scope=admin`, "invalid_scope"],
    ] as const) {
      const response = await app.fetch(
        new Request(base + query, { headers: { Cookie: sessionCookie } }),
        env,
      );
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.searchParams.get("error")).toBe(expected);
      expect(location.searchParams.get("state")).toBe("xyz");
    }
  });

  it("refuses a resource indicator naming a different server", async () => {
    const { json } = await register();
    const url = `${ORIGIN}/oauth/authorize?response_type=code&client_id=${json.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${CHALLENGE}&code_challenge_method=S256&resource=${encodeURIComponent("https://elsewhere.example/mcp")}`;
    const response = await app.fetch(new Request(url, { headers: { Cookie: sessionCookie } }), env);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("invalid_target");
  });

  it("returns access_denied when the user cancels", async () => {
    const { json } = await register();
    const response = await app.fetch(
      new Request(`${ORIGIN}/oauth/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
          Cookie: sessionCookie,
        },
        body: new URLSearchParams({
          decision: "deny",
          client_id: json.client_id,
          redirect_uri: REDIRECT,
          scope: "mcp:read",
          code_challenge: CHALLENGE,
          state: "xyz",
        }).toString(),
      }),
      env,
    );
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("re-validates the consent POST instead of trusting its hidden fields", async () => {
    const { json } = await register();
    // The hidden fields round-tripped through a page, and a page is not a trust
    // boundary — a tampered redirect_uri must be caught again here.
    const response = await consent({
      client_id: json.client_id,
      redirect_uri: "https://attacker.example/steal",
      scope: "mcp:read",
      code_challenge: CHALLENGE,
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("rejects a cross-site consent POST", async () => {
    const { json } = await register();
    const response = await consent(
      {
        client_id: json.client_id,
        redirect_uri: REDIRECT,
        scope: "mcp:read",
        code_challenge: CHALLENGE,
      },
      { origin: "https://attacker.example" },
    );
    expect(response.status).toBe(403);
  });

  it("refuses a consent POST with no session", async () => {
    const { json } = await register();
    const response = await consent(
      {
        client_id: json.client_id,
        redirect_uri: REDIRECT,
        scope: "mcp:read",
        code_challenge: CHALLENGE,
      },
      { cookie: "" },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Not signed in");
  });
});

describe("token endpoint", () => {
  it("completes the flow for a Claude Code style localhost redirect on a different port", async () => {
    // Claude Code registers `http://localhost:<port>/callback` and binds whatever
    // ephemeral port is free on each run, so the port at authorization time is
    // routinely not the one in the registration. RFC 8252 §7.3.
    const { status, json } = await register({
      redirect_uris: ["http://localhost:9876/callback"],
    });
    expect(status).toBe(201);
    const used = "http://localhost:41234/callback";

    const consented = await consent({
      client_id: json.client_id,
      redirect_uri: used,
      scope: "mcp:read mcp:write",
      code_challenge: CHALLENGE,
      state: "xyz",
    });
    const location = new URL(consented.headers.get("location") ?? "");
    expect(location.origin).toBe("http://localhost:41234");
    expect(location.pathname).toBe("/callback");
    const code = location.searchParams.get("code");
    expect(code).not.toBeNull();

    // The token request presents the URI the code was actually bound to.
    const response = await exchange({
      grant_type: "authorization_code",
      code: code as string,
      code_verifier: VERIFIER,
      redirect_uri: used,
      client_id: json.client_id,
    });
    expect(response.status).toBe(200);
  });

  it("does not let the loopback port exception cross to a different host", async () => {
    const { json } = await register({
      redirect_uris: ["http://localhost:9876/callback"],
    });
    const response = await consent({
      client_id: json.client_id,
      redirect_uri: "http://127.0.0.1:9876/callback",
      scope: "mcp:read",
      code_challenge: CHALLENGE,
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("Redirect URI mismatch");
  });

  it("completes the authorization_code grant with a valid verifier", async () => {
    const { json } = await register();
    const code = await codeFor(json.client_id);
    expect(code).not.toBeNull();

    const response = await exchange({
      grant_type: "authorization_code",
      code: code as string,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
      client_id: json.client_id,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, string>;
    expect(body.access_token).toMatch(/^stratum_mcp_[0-9a-f]{32}$/);
    expect(body.refresh_token).toMatch(/^stratum_mcprt_[0-9a-f]{32}$/);
    expect(body.token_type).toBe("Bearer");
    expect(body.scope).toBe("mcp:read mcp:write");
  });

  it("rejects a wrong or missing PKCE verifier", async () => {
    const { json } = await register();

    const wrong = await exchange({
      grant_type: "authorization_code",
      code: (await codeFor(json.client_id)) as string,
      code_verifier: "b".repeat(64),
      redirect_uri: REDIRECT,
      client_id: json.client_id,
    });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe("invalid_grant");

    const missing = await exchange({
      grant_type: "authorization_code",
      code: (await codeFor(json.client_id)) as string,
      redirect_uri: REDIRECT,
      client_id: json.client_id,
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("rejects a redirect_uri that does not match the authorization request", async () => {
    const { json } = await register({ redirect_uris: [REDIRECT, "https://other.example/cb"] });
    const response = await exchange({
      grant_type: "authorization_code",
      code: (await codeFor(json.client_id)) as string,
      code_verifier: VERIFIER,
      // Registered, but not the one this code was bound to.
      redirect_uri: "https://other.example/cb",
      client_id: json.client_id,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("refuses a code presented by a different registered client", async () => {
    const mine = await register();
    const other = await register({ client_name: "Other" });
    const response = await exchange({
      grant_type: "authorization_code",
      code: (await codeFor(mine.json.client_id)) as string,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
      client_id: other.json.client_id,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("leaves the code usable when a redemption fails validation", async () => {
    const mine = await register();
    const other = await register({ client_name: "Interceptor" });
    const code = (await codeFor(mine.json.client_id)) as string;

    // Three doomed attempts, from an attacker who merely observed the code.
    // If any of them consumed it, the legitimate exchange below would report a
    // replay — and the replay path would revoke every grant the real client
    // holds for this user. Observing a code must not be enough to do that.
    const wrongClient = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
      client_id: other.json.client_id,
    });
    expect(wrongClient.status).toBe(400);

    const wrongVerifier = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: "b".repeat(64),
      redirect_uri: REDIRECT,
      client_id: mine.json.client_id,
    });
    expect(wrongVerifier.status).toBe(400);

    const wrongRedirect = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      redirect_uri: "http://127.0.0.1:9876/other",
      client_id: mine.json.client_id,
    });
    expect(wrongRedirect.status).toBe(400);

    // The rightful client still redeems it.
    const legitimate = await exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
      client_id: mine.json.client_id,
    });
    expect(legitimate.status).toBe(200);
  });

  it("revokes everything the grant produced when a code is replayed", async () => {
    const { json } = await register();
    const code = (await codeFor(json.client_id)) as string;
    const form = {
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
      client_id: json.client_id,
    };

    const first = await exchange(form);
    expect(first.status).toBe(200);
    const issued = (await first.json()) as Record<string, string | undefined>;

    const replay = await exchange(form);
    expect(replay.status).toBe(400);

    // RFC 6749 §10.5: a code presented twice means it leaked, so the token it
    // already produced is now worthless too.
    const refresh = await exchange({
      grant_type: "refresh_token",
      refresh_token: issued.refresh_token as string,
      client_id: json.client_id,
    });
    expect(refresh.status).toBe(400);
  });

  it("rotates on refresh and retires the presented token", async () => {
    const { json } = await register();
    const first = await exchange({
      grant_type: "authorization_code",
      code: (await codeFor(json.client_id)) as string,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
      client_id: json.client_id,
    });
    const issued = (await first.json()) as Record<string, string>;

    const refreshed = await exchange({
      grant_type: "refresh_token",
      refresh_token: issued.refresh_token as string,
      client_id: json.client_id,
    });
    expect(refreshed.status).toBe(200);
    const rotated = (await refreshed.json()) as Record<string, string>;
    expect(rotated.refresh_token).not.toBe(issued.refresh_token);

    const reuse = await exchange({
      grant_type: "refresh_token",
      refresh_token: issued.refresh_token as string,
      client_id: json.client_id,
    });
    expect(reuse.status).toBe(400);
  });

  it("accepts client_secret_basic, which the auth middleware must not eat", async () => {
    const { json } = await register({ token_endpoint_auth_method: "client_secret_basic" });
    const code = (await codeFor(json.client_id)) as string;
    const basic = btoa(
      `${encodeURIComponent(json.client_id)}:${encodeURIComponent(json.client_secret)}`,
    );

    const response = await exchange(
      {
        grant_type: "authorization_code",
        code,
        code_verifier: VERIFIER,
        redirect_uri: REDIRECT,
      },
      `Basic ${basic}`,
    );
    // A non-Bearer Authorization header is a 401 everywhere else; this endpoint
    // is exempted precisely so RFC 6749 §2.3.1 works.
    expect(response.status).toBe(200);
  });

  it("rejects a confidential client presenting the wrong secret", async () => {
    const { json } = await register({ token_endpoint_auth_method: "client_secret_post" });
    const response = await exchange({
      grant_type: "authorization_code",
      code: (await codeFor(json.client_id)) as string,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
      client_id: json.client_id,
      client_secret: "stratum_mcpcs_00000000000000000000000000000000",
    });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_client");
  });

  it("rejects an unsupported grant type and an unknown client", async () => {
    const { json } = await register();
    const badGrant = await exchange({ grant_type: "password", client_id: json.client_id });
    expect(((await badGrant.json()) as { error: string }).error).toBe("unsupported_grant_type");

    const unknown = await exchange({ grant_type: "authorization_code", client_id: "mcpc_nope" });
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as { error: string }).error).toBe("invalid_client");
  });
});

describe("request hardening", () => {
  it("returns invalid_client for malformed Basic credentials rather than a 500", async () => {
    const { json } = await register({ token_endpoint_auth_method: "client_secret_basic" });
    // `decodeURIComponent` throws URIError on `%zz`; unhandled, that is a 500
    // from an unauthenticated endpoint.
    const response = await exchange(
      { grant_type: "authorization_code", code: "x", code_verifier: VERIFIER },
      `Basic ${btoa("%zz:%zz")}`,
    );
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_client");
    expect(json.client_id).toBeDefined();
  });

  it("caps the form-encoded bodies, not just the JSON one", async () => {
    // /oauth/token and /oauth/revoke read their bodies as text and
    // POST /oauth/authorize as form data; all three carry the same handful of
    // short fields, and two of the three are unauthenticated.
    const huge = "x".repeat(128 * 1024);
    for (const path of ["/oauth/token", "/oauth/revoke"]) {
      const response = await app.fetch(
        new Request(`${ORIGIN}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: huge, grant_type: "refresh_token" }).toString(),
        }),
        env,
      );
      expect(response.status, path).toBe(413);
    }

    // POST /oauth/authorize takes the same cap through the same helper, but it
    // is session-authenticated and carries different fields, so the loop above
    // cannot reach it — and a regression there would pass unnoticed.
    const { json } = await register();
    const consent = await app.fetch(
      new Request(`${ORIGIN}/oauth/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
          Cookie: sessionCookie,
        },
        body: new URLSearchParams({
          decision: "allow",
          client_id: json.client_id,
          redirect_uri: REDIRECT,
          scope: "mcp:read",
          code_challenge: CHALLENGE,
          state: huge,
        }).toString(),
      }),
      env,
    );
    expect(consent.status, "/oauth/authorize").toBe(413);
  });
});

describe("revocation", () => {
  it("returns 200 whether or not the token existed", async () => {
    for (const token of ["stratum_mcp_00000000000000000000000000000000", "not-a-token"]) {
      const response = await app.fetch(
        new Request(`${ORIGIN}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }).toString(),
        }),
        env,
      );
      // Reporting the difference would make this a free oracle for testing
      // stolen tokens.
      expect(response.status).toBe(200);
    }
  });

  it("kills the grant from either half of the pair", async () => {
    const { json } = await register();
    const issued = (await (
      await exchange({
        grant_type: "authorization_code",
        code: (await codeFor(json.client_id)) as string,
        code_verifier: VERIFIER,
        redirect_uri: REDIRECT,
        client_id: json.client_id,
      })
    ).json()) as Record<string, string>;

    await app.fetch(
      new Request(`${ORIGIN}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: issued.access_token as string }).toString(),
      }),
      env,
    );

    const refresh = await exchange({
      grant_type: "refresh_token",
      refresh_token: issued.refresh_token as string,
      client_id: json.client_id,
    });
    expect(refresh.status).toBe(400);
  });
});
