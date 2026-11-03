/**
 * OIDC SSO login flow (#253 Task 5): real routers against a real SQLite D1
 * (every migration applied) and REAL crypto — the stubbed IdP serves a genuine
 * ES256 JWKS and signs genuine id_tokens, so jose's verification runs for
 * real. Only `globalThis.fetch` (token endpoint + JWKS) is mocked.
 */
import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ssoRouter } from "../src/routes/sso";
import { upsertIdentity } from "../src/storage/identities";
import {
  consumeOidcLoginState,
  createOidcLoginState,
  purgeExpiredOidcStates,
  setSsoConnectionEnabled,
  setSsoDomainsVerified,
  upsertSsoConnection,
} from "../src/storage/sso";
import { createUser, disableUser } from "../src/storage/users";
import type { Env } from "../src/types";
import { SSO_SECRET_SALT, encryptToken } from "../src/utils/crypto";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
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

const ISSUER = "https://idp.example.com";
const CLIENT_ID = "stratum-client";
const CLIENT_SECRET = "idp-client-secret";
const TOKEN_ENDPOINT = "https://idp.example.com/oauth2/token";
const JWKS_URI = "https://idp.example.com/oauth2/jwks";
const AUTHZ_ENDPOINT = "https://idp.example.com/oauth2/authorize";
const SSO_SECRET = "test-sso-encryption-secret";
const ORG_SLUG = "acme";
const EMAIL_DOMAIN = "corp.example.com";
const BASE = "https://stratum.test";

type Raw = ReturnType<typeof makeSqliteD1>["raw"];

// One real ES256 key pair for the whole suite (key generation is slow-ish).
const keys = await generateKeyPair("ES256");
const publicJwk = { ...(await exportJWK(keys.publicKey)), kid: "test-key", alg: "ES256" };

interface IdTokenOptions {
  nonce: string;
  sub?: string;
  email?: string | null;
  emailVerified?: boolean | string;
  issuer?: string;
  audience?: string | string[];
  azp?: string;
}

async function signIdToken(opts: IdTokenOptions): Promise<string> {
  const claims: Record<string, unknown> = { nonce: opts.nonce };
  const email = opts.email === undefined ? `alice@${EMAIL_DOMAIN}` : opts.email;
  if (email !== null) claims.email = email;
  if (opts.emailVerified !== undefined) claims.email_verified = opts.emailVerified;
  if (opts.azp !== undefined) claims.azp = opts.azp;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? CLIENT_ID)
    .setSubject(opts.sub ?? "idp-subject-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}

/** An HS256 token "signed" with the shared client secret — must be refused. */
async function signHs256IdToken(nonce: string): Promise<string> {
  return new SignJWT({ nonce, email: `alice@${EMAIL_DOMAIN}` })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setSubject("idp-subject-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(CLIENT_SECRET));
}

describe("OIDC SSO login", () => {
  let db: D1Database;
  let raw: Raw;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;
  let connectionId: string;
  let orgId: string;
  /** What the stubbed token endpoint returns; tests set the id_token per flow. */
  let tokenResponse: () => Response;
  let tokenRequests: URLSearchParams[];
  let tokenRedirectModes: (string | undefined)[];

  function setIdToken(idToken: string): void {
    tokenResponse = () =>
      new Response(JSON.stringify({ id_token: idToken, token_type: "Bearer" }), {
        headers: { "content-type": "application/json" },
      });
  }

  beforeEach(async () => {
    ({ db, raw } = makeSqliteD1());
    env = {
      DB: db,
      STATE: makeFakeKV(),
      SSO_ENCRYPTION_SECRET: SSO_SECRET,
    } as unknown as Env;
    app = new Hono<{ Bindings: Env }>();
    app.route("/auth/sso", ssoRouter);

    // Seed owner, org, and a verified+enabled connection.
    raw
      .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
      .run("usr_owner", "owner@example.com", "owner-user", "hash_owner");
    orgId = "org_acme";
    raw
      .prepare("INSERT INTO orgs (id, name, slug, owner_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(orgId, "Acme", ORG_SLUG, "usr_owner", new Date().toISOString());

    const ciphertext = await encryptToken(CLIENT_SECRET, SSO_SECRET, SSO_SECRET_SALT);
    const upserted = await upsertSsoConnection(db, logger, {
      orgId,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecretCiphertext: ciphertext,
      authorizationEndpoint: AUTHZ_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      jwksUri: JWKS_URI,
      emailDomains: [EMAIL_DOMAIN],
    });
    if (!upserted.success) throw new Error("seed connection failed");
    connectionId = upserted.data.connection.id;
    const verified = await setSsoDomainsVerified(db, logger, connectionId, [EMAIL_DOMAIN]);
    if (!verified.success) throw new Error("seed verify failed");
    const enabled = await setSsoConnectionEnabled(db, logger, connectionId, true);
    if (!enabled.success) throw new Error("seed enable failed");

    tokenRequests = [];
    tokenRedirectModes = [];
    tokenResponse = () => new Response("not configured by test", { status: 500 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith(JWKS_URI)) {
          return new Response(JSON.stringify({ keys: [publicJwk] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.startsWith(TOKEN_ENDPOINT)) {
          tokenRequests.push(new URLSearchParams(String(init?.body)));
          tokenRedirectModes.push(init?.redirect);
          return tokenResponse();
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function startLogin(
    slug = ORG_SLUG,
    query = "",
  ): Promise<{ state: string; nonce: string; cookie: string; location: URL }> {
    const res = await app.fetch(new Request(`${BASE}/auth/sso/${slug}/start${query}`), env);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    const cookie = /stratum_sso_state=([^;]+)/.exec(setCookie)?.[1] ?? "";
    return {
      state: location.searchParams.get("state") ?? "",
      nonce: location.searchParams.get("nonce") ?? "",
      cookie,
      location,
    };
  }

  function callbackRequest(state: string, cookie?: string, code = "authcode-1"): Request {
    const headers: Record<string, string> = {};
    if (cookie !== undefined) headers.Cookie = `stratum_sso_state=${cookie}`;
    return new Request(`${BASE}/auth/sso/callback?code=${code}&state=${state}`, { headers });
  }

  function userRow(email: string): { id: string; username: string } | undefined {
    return raw.prepare("SELECT id, username FROM users WHERE email = ?").get(email) as
      | { id: string; username: string }
      | undefined;
  }

  // ==========================================================================
  // 501 unconfigured
  // ==========================================================================

  it("returns 501 on every /auth/sso endpoint when SSO_ENCRYPTION_SECRET is unset", async () => {
    const bare = { ...env, SSO_ENCRYPTION_SECRET: undefined } as unknown as Env;
    for (const path of ["/auth/sso", `/auth/sso/${ORG_SLUG}/start`, "/auth/sso/callback"]) {
      const res = await app.fetch(new Request(`${BASE}${path}`), bare);
      expect(res.status).toBe(501);
    }
  });

  // ==========================================================================
  // Picker page
  // ==========================================================================

  describe("picker page", () => {
    it("renders the form", async () => {
      const res = await app.fetch(new Request(`${BASE}/auth/sso`), env);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Single sign-on");
      expect(html).toContain('name="identifier"');
    });

    it("resolves an org slug to its start route", async () => {
      const res = await app.fetch(new Request(`${BASE}/auth/sso?identifier=${ORG_SLUG}`), env);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`/auth/sso/${ORG_SLUG}/start`);
    });

    it("resolves a work email by verified domain and carries a valid redirect_to", async () => {
      const res = await app.fetch(
        new Request(
          `${BASE}/auth/sso?identifier=someone%40${EMAIL_DOMAIN}&redirect_to=%2Fprojects%2Ffoo`,
        ),
        env,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        `/auth/sso/${ORG_SLUG}/start?redirect_to=%2Fprojects%2Ffoo`,
      );
    });

    it("shows the generic not-found message for an unknown identifier", async () => {
      const res = await app.fetch(
        new Request(`${BASE}/auth/sso?identifier=nobody%40unknown.example`),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(
        "No SSO configuration found for that organization or email domain.",
      );
    });

    it("does not resolve a disabled connection by slug", async () => {
      await setSsoConnectionEnabled(db, logger, connectionId, false);
      const res = await app.fetch(new Request(`${BASE}/auth/sso?identifier=${ORG_SLUG}`), env);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("No SSO configuration found");
    });

    it("renders callback error codes from the query string", async () => {
      const res = await app.fetch(new Request(`${BASE}/auth/sso?error=domain_not_allowed`), env);
      expect(await res.text()).toContain("Guest accounts cannot sign in here");
    });
  });

  // ==========================================================================
  // Start
  // ==========================================================================

  describe("start", () => {
    it("redirects to the IdP with code+PKCE parameters and sets the binding cookie", async () => {
      const { state, nonce, cookie, location } = await startLogin();
      expect(location.origin + location.pathname).toBe(AUTHZ_ENDPOINT);
      expect(location.searchParams.get("response_type")).toBe("code");
      expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(location.searchParams.get("redirect_uri")).toBe(`${BASE}/auth/sso/callback`);
      expect(location.searchParams.get("scope")).toBe("openid email profile");
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(state).toMatch(/^[0-9a-f]{64}$/);
      expect(nonce).toMatch(/^[0-9a-f]{64}$/);
      expect(cookie).toBe(state);

      const row = raw
        .prepare("SELECT * FROM oidc_login_states WHERE state = ?")
        .get(state) as Record<string, unknown>;
      expect(row.connection_id).toBe(connectionId);
      expect(row.consumed_at).toBeNull();
    });

    it("renders a generic 404 page for an unknown slug", async () => {
      const res = await app.fetch(new Request(`${BASE}/auth/sso/nope/start`), env);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("No SSO configuration found");
    });

    it("refuses a disabled connection", async () => {
      await setSsoConnectionEnabled(db, logger, connectionId, false);
      const res = await app.fetch(new Request(`${BASE}/auth/sso/${ORG_SLUG}/start`), env);
      expect(res.status).toBe(404);
    });

    it("stores a valid redirect_to and drops external / scheme-relative ones", async () => {
      const good = await startLogin(ORG_SLUG, "?redirect_to=%2Fprojects%2Ffoo");
      const goodRow = raw
        .prepare("SELECT redirect_to FROM oidc_login_states WHERE state = ?")
        .get(good.state) as { redirect_to: string | null };
      expect(goodRow.redirect_to).toBe("/projects/foo");

      // The %09 cases hide an ASCII tab at index 1: browsers strip tab/newline
      // from a Location per the WHATWG URL spec, turning "/\t/evil.com" into
      // the scheme-relative "//evil.com".
      for (const bad of [
        "https%3A%2F%2Fevil.example",
        "%2F%2Fevil.example",
        "%2F%5Cevil",
        "%2F%09%2Fevil.com",
        "%2F%09%5Cevil.com",
      ]) {
        const started = await startLogin(ORG_SLUG, `?redirect_to=${bad}`);
        const badRow = raw
          .prepare("SELECT redirect_to FROM oidc_login_states WHERE state = ?")
          .get(started.state) as { redirect_to: string | null };
        expect(badRow.redirect_to).toBeNull();
      }
    });

    it("blocks the 31st start from one IP within the hour", async () => {
      for (let i = 0; i < 30; i++) {
        const res = await app.fetch(new Request(`${BASE}/auth/sso/${ORG_SLUG}/start`), env);
        expect(res.status).toBe(302);
      }
      const blocked = await app.fetch(new Request(`${BASE}/auth/sso/${ORG_SLUG}/start`), env);
      expect(blocked.status).toBe(429);
      expect(await blocked.text()).toContain("Too many sign-in attempts");
    });
  });

  // ==========================================================================
  // Callback: state binding + replay
  // ==========================================================================

  describe("callback state validation", () => {
    it("redirects IdP error params to the generic idp_error code without reflecting them", async () => {
      const res = await app.fetch(
        new Request(
          `${BASE}/auth/sso/callback?error=access_denied&error_description=%3Cscript%3Ex%3C%2Fscript%3E`,
        ),
        env,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/auth/sso?error=idp_error");
    });

    it("rejects a callback with no binding cookie and leaves the state unconsumed", async () => {
      const { state } = await startLogin();
      const res = await app.fetch(callbackRequest(state), env);
      expect(res.headers.get("Location")).toBe("/auth/sso?error=invalid_state");
      const row = raw
        .prepare("SELECT consumed_at FROM oidc_login_states WHERE state = ?")
        .get(state) as { consumed_at: string | null };
      expect(row.consumed_at).toBeNull();
    });

    it("rejects a callback whose cookie does not match the state", async () => {
      const { state } = await startLogin();
      const other = await startLogin();
      const res = await app.fetch(callbackRequest(state, other.cookie), env);
      expect(res.headers.get("Location")).toBe("/auth/sso?error=invalid_state");
    });

    it("rejects a missing state parameter", async () => {
      const res = await app.fetch(new Request(`${BASE}/auth/sso/callback?code=x`), env);
      expect(res.headers.get("Location")).toBe("/auth/sso?error=invalid_state");
    });

    it("rejects an expired state", async () => {
      const { state, cookie } = await startLogin();
      raw
        .prepare("UPDATE oidc_login_states SET expires_at = ? WHERE state = ?")
        .run(Math.floor(Date.now() / 1000) - 10, state);
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/auth/sso?error=invalid_state");
    });

    it("drops a control-character redirect_to end-to-end and lands on /", async () => {
      const { state, nonce, cookie } = await startLogin(ORG_SLUG, "?redirect_to=%2F%09%2Fevil.com");
      setIdToken(await signIdToken({ nonce }));
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/");
    });

    it("re-validates the stored redirect_to at callback time (DB value is not trusted)", async () => {
      const { state, nonce, cookie } = await startLogin();
      raw
        .prepare("UPDATE oidc_login_states SET redirect_to = ? WHERE state = ?")
        .run("/\t/evil.com", state);
      setIdToken(await signIdToken({ nonce }));
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/");
    });

    it("rejects a replayed state (second callback with the same state)", async () => {
      const { state, nonce, cookie } = await startLogin();
      setIdToken(await signIdToken({ nonce }));
      const first = await app.fetch(callbackRequest(state, cookie), env);
      expect(first.headers.get("Location")).toBe("/");
      const replay = await app.fetch(callbackRequest(state, cookie), env);
      expect(replay.headers.get("Location")).toBe("/auth/sso?error=invalid_state");
    });
  });

  // ==========================================================================
  // Callback: token + id_token verification
  // ==========================================================================

  describe("id_token verification", () => {
    it("completes the happy path: JIT user, membership, scim row, identity, session, audit", async () => {
      const { state, nonce, cookie } = await startLogin(ORG_SLUG, "?redirect_to=%2Fprojects%2Ffoo");
      setIdToken(await signIdToken({ nonce, email: `Alice@${EMAIL_DOMAIN}` }));

      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/projects/foo");
      expect(res.headers.get("Set-Cookie")).toContain("stratum_session=");

      // Token exchange used client_secret_post + PKCE against the stub.
      const tokenReq = tokenRequests[0];
      expect(tokenReq?.get("grant_type")).toBe("authorization_code");
      expect(tokenReq?.get("client_id")).toBe(CLIENT_ID);
      expect(tokenReq?.get("client_secret")).toBe(CLIENT_SECRET);
      expect(tokenReq?.get("code")).toBe("authcode-1");
      expect(tokenReq?.get("redirect_uri")).toBe(`${BASE}/auth/sso/callback`);
      expect(tokenReq?.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // A redirect from the admin-supplied endpoint would re-send the secret
      // and verifier to a host that never passed validateOidcUrl.
      expect(tokenRedirectModes[0]).toBe("error");

      // Email normalized to lowercase; username derived from the local part.
      const user = userRow(`alice@${EMAIL_DOMAIN}`);
      expect(user).toBeDefined();
      expect(user?.username).toBe("alice");

      const member = raw
        .prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?")
        .get(orgId, user?.id) as { role: string } | undefined;
      expect(member?.role).toBe("member");

      const scim = raw
        .prepare("SELECT active FROM scim_members WHERE connection_id = ? AND user_id = ?")
        .get(connectionId, user?.id) as { active: number } | undefined;
      expect(scim?.active).toBe(1);

      const identity = raw
        .prepare(
          "SELECT user_id, provider, connection_id FROM identities WHERE issuer = ? AND subject = ?",
        )
        .get(ISSUER, "idp-subject-1") as Record<string, unknown> | undefined;
      expect(identity?.user_id).toBe(user?.id);
      expect(identity?.provider).toBe("oidc");
      expect(identity?.connection_id).toBe(connectionId);

      const audit = raw
        .prepare("SELECT detail FROM audit_log WHERE action = 'session.created' AND actor_id = ?")
        .get(user?.id) as { detail: string } | undefined;
      expect(audit).toBeDefined();
      const detail = JSON.parse(audit?.detail ?? "{}") as Record<string, unknown>;
      expect(detail.method).toBe("oidc");
      expect(detail.orgId).toBe(orgId);
    });

    it("signs a returning user in via the (issuer, sub) identity without re-writing membership", async () => {
      const first = await startLogin();
      setIdToken(await signIdToken({ nonce: first.nonce }));
      await app.fetch(callbackRequest(first.state, first.cookie), env);
      const user = userRow(`alice@${EMAIL_DOMAIN}`);
      raw.prepare("DELETE FROM org_members WHERE org_id = ? AND user_id = ?").run(orgId, user?.id);

      const second = await startLogin();
      setIdToken(await signIdToken({ nonce: second.nonce }));
      const res = await app.fetch(callbackRequest(second.state, second.cookie), env);
      expect(res.headers.get("Location")).toBe("/");
      expect(res.headers.get("Set-Cookie")).toContain("stratum_session=");
      // Sub-match signs in only — the removed membership is NOT re-created.
      const member = raw
        .prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?")
        .get(orgId, user?.id);
      expect(member).toBeUndefined();
    });

    it("parks a returning user who has a passkey behind the second factor (#256)", async () => {
      const first = await startLogin();
      setIdToken(await signIdToken({ nonce: first.nonce }));
      await app.fetch(callbackRequest(first.state, first.cookie), env);
      const user = userRow(`alice@${EMAIL_DOMAIN}`);
      raw
        .prepare(
          "INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key, counter, name, created_at) VALUES ('pk_1', ?, 'cred', 'key', 0, 'k', ?)",
        )
        .run(user?.id, new Date().toISOString());
      raw.prepare("DELETE FROM sessions").run();

      const second = await startLogin(ORG_SLUG, "?redirect_to=%2Fprojects%2Ffoo");
      setIdToken(await signIdToken({ nonce: second.nonce }));
      const res = await app.fetch(callbackRequest(second.state, second.cookie), env);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/auth/2fa");
      expect(res.headers.get("Set-Cookie")).toContain("stratum_2fa=");
      expect(res.headers.get("Set-Cookie")).not.toContain("stratum_session=");
      expect(raw.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    });

    it("adopts an existing account by email: links identity + scim_members + membership", async () => {
      const created = await createUser(db, `bob@${EMAIL_DOMAIN}`, logger, "bob");
      if (!created.success) throw new Error("seed user failed");

      const { state, nonce, cookie } = await startLogin();
      setIdToken(await signIdToken({ nonce, sub: "bob-sub", email: `bob@${EMAIL_DOMAIN}` }));
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/");

      const identity = raw
        .prepare("SELECT user_id FROM identities WHERE issuer = ? AND subject = ?")
        .get(ISSUER, "bob-sub") as { user_id: string } | undefined;
      expect(identity?.user_id).toBe(created.data.user.id);
      const scim = raw
        .prepare("SELECT active FROM scim_members WHERE connection_id = ? AND user_id = ?")
        .get(connectionId, created.data.user.id) as { active: number } | undefined;
      expect(scim?.active).toBe(1);
      const member = raw
        .prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?")
        .get(orgId, created.data.user.id) as { role: string } | undefined;
      expect(member?.role).toBe("member");
    });

    it("adopting an existing org admin keeps their role (no demotion to member)", async () => {
      const created = await createUser(db, `frank@${EMAIL_DOMAIN}`, logger, "frank");
      if (!created.success) throw new Error("seed user failed");
      raw
        .prepare(
          "INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)",
        )
        .run(orgId, created.data.user.id, new Date().toISOString());

      const { state, nonce, cookie } = await startLogin();
      setIdToken(await signIdToken({ nonce, sub: "frank-sub", email: `frank@${EMAIL_DOMAIN}` }));
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/");

      const member = raw
        .prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?")
        .get(orgId, created.data.user.id) as { role: string } | undefined;
      expect(member?.role).toBe("admin");
    });

    it("grants the second org's membership on a cross-connection (issuer, sub) match", async () => {
      // Org B: the same IdP issuer serving a second org with its own verified domain.
      const betaDomain = "beta.example.com";
      raw
        .prepare("INSERT INTO orgs (id, name, slug, owner_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("org_beta", "Beta", "beta", "usr_owner", new Date().toISOString());
      const ciphertext = await encryptToken(CLIENT_SECRET, SSO_SECRET, SSO_SECRET_SALT);
      const upserted = await upsertSsoConnection(db, logger, {
        orgId: "org_beta",
        issuer: ISSUER,
        clientId: CLIENT_ID,
        clientSecretCiphertext: ciphertext,
        authorizationEndpoint: AUTHZ_ENDPOINT,
        tokenEndpoint: TOKEN_ENDPOINT,
        jwksUri: JWKS_URI,
        emailDomains: [betaDomain],
      });
      if (!upserted.success) throw new Error("seed beta connection failed");
      const betaConnectionId = upserted.data.connection.id;
      await setSsoDomainsVerified(db, logger, betaConnectionId, [betaDomain]);
      await setSsoConnectionEnabled(db, logger, betaConnectionId, true);

      // The identity was established through org A's connection.
      const created = await createUser(db, `gina@${betaDomain}`, logger, "gina");
      if (!created.success) throw new Error("seed user failed");
      await upsertIdentity(db, logger, {
        userId: created.data.user.id,
        provider: "oidc",
        issuer: ISSUER,
        subject: "gina-sub",
        email: `gina@${betaDomain}`,
        connectionId,
      });

      const { state, nonce, cookie } = await startLogin("beta");
      setIdToken(await signIdToken({ nonce, sub: "gina-sub", email: `gina@${betaDomain}` }));
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/");
      expect(res.headers.get("Set-Cookie")).toContain("stratum_session=");

      const member = raw
        .prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?")
        .get("org_beta", created.data.user.id) as { role: string } | undefined;
      expect(member?.role).toBe("member");
      const scim = raw
        .prepare("SELECT active FROM scim_members WHERE connection_id = ? AND user_id = ?")
        .get(betaConnectionId, created.data.user.id) as { active: number } | undefined;
      expect(scim?.active).toBe(1);
      // The identity row still points at the connection that established it.
      const identity = raw
        .prepare("SELECT connection_id FROM identities WHERE issuer = ? AND subject = ?")
        .get(ISSUER, "gina-sub") as { connection_id: string } | undefined;
      expect(identity?.connection_id).toBe(connectionId);

      // Established once: an org admin removing the user from org B is not
      // overridden by the user's next login through B's connection.
      raw
        .prepare("DELETE FROM org_members WHERE org_id = ? AND user_id = ?")
        .run("org_beta", created.data.user.id);
      const again = await startLogin("beta");
      setIdToken(
        await signIdToken({ nonce: again.nonce, sub: "gina-sub", email: `gina@${betaDomain}` }),
      );
      const second = await app.fetch(callbackRequest(again.state, again.cookie), env);
      expect(second.headers.get("Location")).toBe("/");
      const readded = raw
        .prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?")
        .get("org_beta", created.data.user.id);
      expect(readded).toBeUndefined();
    });

    it("rejects a nonce mismatch", async () => {
      const { state, cookie } = await startLogin();
      setIdToken(await signIdToken({ nonce: "f".repeat(64) }));
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/auth/sso?error=invalid_state");
      // The state was valid, so this is an org-scoped failed sign-in (#255).
      const failure = raw
        .prepare(
          "SELECT actor_type, subject, org_id, detail FROM audit_log WHERE action = 'auth.failed'",
        )
        .all() as { actor_type: string; subject: string; org_id: string; detail: string }[];
      expect(failure).toHaveLength(1);
      expect(failure[0]).toMatchObject({
        actor_type: "system",
        subject: connectionId,
        org_id: orgId,
      });
      expect(JSON.parse(failure[0]?.detail ?? "{}")).toEqual({
        method: "sso",
        reason: "nonce_mismatch",
        connectionId,
      });
    });

    it("rejects an HS256 id_token (asymmetric algs only)", async () => {
      const { state, nonce, cookie } = await startLogin();
      setIdToken(await signHs256IdToken(nonce));
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/auth/sso?error=sso_failed");
    });

    it("rejects a wrong issuer", async () => {
      const { state, nonce, cookie } = await startLogin();
      setIdToken(await signIdToken({ nonce, issuer: "https://evil.example" }));
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/auth/sso?error=sso_failed");
    });

    it("rejects a wrong audience", async () => {
      const { state, nonce, cookie } = await startLogin();
      setIdToken(await signIdToken({ nonce, audience: "some-other-client" }));
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/auth/sso?error=sso_failed");
    });

    it("rejects a multi-audience token whose azp is not our client_id", async () => {
      const { state, nonce, cookie } = await startLogin();
      setIdToken(
        await signIdToken({ nonce, audience: [CLIENT_ID, "other-client"], azp: "other-client" }),
      );
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/auth/sso?error=sso_failed");
    });

    it("accepts a multi-audience token whose azp is our client_id", async () => {
      const { state, nonce, cookie } = await startLogin();
      setIdToken(
        await signIdToken({ nonce, audience: [CLIENT_ID, "other-client"], azp: CLIENT_ID }),
      );
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/");
    });

    it("rejects a token whose exchange fails", async () => {
      const { state, cookie } = await startLogin();
      tokenResponse = () => new Response("{}", { status: 400 });
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/auth/sso?error=sso_failed");
    });
  });

  // ==========================================================================
  // Callback: email claim rules
  // ==========================================================================

  describe("email claim rules", () => {
    it("rejects a missing email claim", async () => {
      const { state, nonce, cookie } = await startLogin();
      setIdToken(await signIdToken({ nonce, email: null }));
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/auth/sso?error=no_email");
    });

    it("rejects email_verified boolean false", async () => {
      const { state, nonce, cookie } = await startLogin();
      setIdToken(await signIdToken({ nonce, emailVerified: false }));
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/auth/sso?error=unverified_email");
    });

    it('rejects email_verified string "false" (Entra string booleans)', async () => {
      const { state, nonce, cookie } = await startLogin();
      setIdToken(await signIdToken({ nonce, emailVerified: "false" }));
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/auth/sso?error=unverified_email");
    });

    it("accepts email_verified true and absent alike", async () => {
      const first = await startLogin();
      setIdToken(await signIdToken({ nonce: first.nonce, emailVerified: true }));
      const okRes = await app.fetch(callbackRequest(first.state, first.cookie), env);
      expect(okRes.headers.get("Location")).toBe("/");

      // Absent claim: the org controls both the DNS-verified domain and the
      // IdP, so a missing email_verified is treated as verified.
      const second = await startLogin();
      setIdToken(await signIdToken({ nonce: second.nonce }));
      const absentRes = await app.fetch(callbackRequest(second.state, second.cookie), env);
      expect(absentRes.headers.get("Location")).toBe("/");
    });

    it("rejects an out-of-domain guest with domain_not_allowed", async () => {
      const { state, nonce, cookie } = await startLogin();
      setIdToken(await signIdToken({ nonce, email: "guest@partner.example" }));
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/auth/sso?error=domain_not_allowed");
      // No account was provisioned for the guest.
      expect(userRow("guest@partner.example")).toBeUndefined();
    });
  });

  // ==========================================================================
  // Callback: disabled accounts + connection lifecycle
  // ==========================================================================

  describe("disabled accounts and connection lifecycle", () => {
    it("refuses a disabled user on the (issuer, sub) branch", async () => {
      const created = await createUser(db, `carol@${EMAIL_DOMAIN}`, logger, "carol");
      if (!created.success) throw new Error("seed user failed");
      await upsertIdentity(db, logger, {
        userId: created.data.user.id,
        provider: "oidc",
        issuer: ISSUER,
        subject: "carol-sub",
        email: `carol@${EMAIL_DOMAIN}`,
        connectionId,
      });
      await disableUser(db, created.data.user.id, logger);

      const { state, nonce, cookie } = await startLogin();
      setIdToken(await signIdToken({ nonce, sub: "carol-sub", email: `carol@${EMAIL_DOMAIN}` }));
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/auth/sso?error=account_disabled");
      expect(res.headers.get("Set-Cookie") ?? "").not.toContain("stratum_session=");
      // Attributed to the disabled account, in the org's trail (#255).
      const failure = raw
        .prepare("SELECT actor_id, org_id, detail FROM audit_log WHERE action = 'auth.failed'")
        .get() as { actor_id: string; org_id: string; detail: string } | undefined;
      expect(failure).toMatchObject({ actor_id: created.data.user.id, org_id: orgId });
      expect(JSON.parse(failure?.detail ?? "{}")).toMatchObject({ reason: "account_disabled" });
    });

    it("refuses a disabled user on the email-adopt branch (no membership written)", async () => {
      const created = await createUser(db, `dave@${EMAIL_DOMAIN}`, logger, "dave");
      if (!created.success) throw new Error("seed user failed");
      await disableUser(db, created.data.user.id, logger);

      const { state, nonce, cookie } = await startLogin();
      setIdToken(await signIdToken({ nonce, sub: "dave-sub", email: `dave@${EMAIL_DOMAIN}` }));
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/auth/sso?error=account_disabled");
      const scim = raw
        .prepare("SELECT * FROM scim_members WHERE user_id = ?")
        .get(created.data.user.id);
      expect(scim).toBeUndefined();
    });

    it("refuses when the connection was disabled between start and callback", async () => {
      const { state, nonce, cookie } = await startLogin();
      await setSsoConnectionEnabled(db, logger, connectionId, false);
      setIdToken(await signIdToken({ nonce }));
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/auth/sso?error=sso_failed");
    });
  });

  // ==========================================================================
  // JIT username collisions
  // ==========================================================================

  describe("JIT username derivation", () => {
    it("dedupes a taken username with a numeric suffix", async () => {
      const taken = await createUser(db, "eve@elsewhere.example", logger, "eve");
      if (!taken.success) throw new Error("seed user failed");

      const { state, nonce, cookie } = await startLogin();
      setIdToken(await signIdToken({ nonce, sub: "eve-sub", email: `eve@${EMAIL_DOMAIN}` }));
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/");
      expect(userRow(`eve@${EMAIL_DOMAIN}`)?.username).toBe("eve-2");
    });

    it("does not claim an existing org slug as a JIT username", async () => {
      // The org slug "acme" already exists — the derived base must skip to -2.
      const { state, nonce, cookie } = await startLogin();
      setIdToken(await signIdToken({ nonce, sub: "acme-sub", email: `acme@${EMAIL_DOMAIN}` }));
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/");
      expect(userRow(`acme@${EMAIL_DOMAIN}`)?.username).toBe("acme-2");
    });

    it("truncates a long local part to the 39-char cap instead of the random fallback", async () => {
      const local = "a".repeat(50);
      const { state, nonce, cookie } = await startLogin();
      setIdToken(await signIdToken({ nonce, sub: "long-sub", email: `${local}@${EMAIL_DOMAIN}` }));
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/");
      expect(userRow(`${local}@${EMAIL_DOMAIN}`)?.username).toBe("a".repeat(39));
    });

    it("falls back to a generated username when the local part cannot produce one", async () => {
      const { state, nonce, cookie } = await startLogin();
      // "123" sanitizes to nothing valid (numbers-only local part).
      setIdToken(await signIdToken({ nonce, sub: "num-sub", email: `123@${EMAIL_DOMAIN}` }));
      const res = await app.fetch(callbackRequest(state, cookie), env);
      expect(res.headers.get("Location")).toBe("/");
      expect(userRow(`123@${EMAIL_DOMAIN}`)?.username).toMatch(/^sso-[0-9a-f]{6}$/);
    });
  });
});

// ============================================================================
// Storage: oidc_login_states
// ============================================================================

describe("oidc_login_states storage", () => {
  it("createOidcLoginState persists a row consumable exactly once", async () => {
    const { db } = makeSqliteD1();
    const created = await createOidcLoginState(db, logger, {
      connectionId: "ssoc_1",
      nonce: "n1",
      codeVerifier: "v1",
      redirectTo: "/somewhere",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const consumed = await consumeOidcLoginState(db, logger, created.data);
    expect(consumed.success).toBe(true);
    if (!consumed.success) return;
    expect(consumed.data).toEqual({
      state: created.data,
      connectionId: "ssoc_1",
      nonce: "n1",
      codeVerifier: "v1",
      redirectTo: "/somewhere",
    });

    const again = await consumeOidcLoginState(db, logger, created.data);
    expect(again.success).toBe(true);
    if (again.success) expect(again.data).toBeNull();
  });

  it("concurrent consumes have exactly one winner", async () => {
    const { db } = makeSqliteD1();
    const created = await createOidcLoginState(db, logger, {
      connectionId: "ssoc_1",
      nonce: "n1",
      codeVerifier: "v1",
      redirectTo: null,
    });
    if (!created.success) throw new Error("create failed");

    const results = await Promise.all([
      consumeOidcLoginState(db, logger, created.data),
      consumeOidcLoginState(db, logger, created.data),
    ]);
    const winners = results.filter((r) => r.success && r.data !== null);
    expect(winners).toHaveLength(1);
  });

  it("returns null for an unknown state", async () => {
    const { db } = makeSqliteD1();
    const consumed = await consumeOidcLoginState(db, logger, "no-such-state");
    expect(consumed.success).toBe(true);
    if (consumed.success) expect(consumed.data).toBeNull();
  });

  it("returns null for an expired state and purge removes it", async () => {
    const { db, raw } = makeSqliteD1();
    const created = await createOidcLoginState(db, logger, {
      connectionId: "ssoc_1",
      nonce: "n1",
      codeVerifier: "v1",
      redirectTo: null,
    });
    if (!created.success) throw new Error("create failed");
    raw
      .prepare("UPDATE oidc_login_states SET expires_at = ? WHERE state = ?")
      .run(Math.floor(Date.now() / 1000) - 10, created.data);

    const consumed = await consumeOidcLoginState(db, logger, created.data);
    expect(consumed.success).toBe(true);
    if (consumed.success) expect(consumed.data).toBeNull();

    const purged = await purgeExpiredOidcStates(db, logger);
    expect(purged.success).toBe(true);
    if (purged.success) expect(purged.data).toBe(1);
    const remaining = raw.prepare("SELECT COUNT(*) as n FROM oidc_login_states").get() as {
      n: number;
    };
    expect(remaining.n).toBe(0);
  });

  it("purge keeps unexpired rows (consumed tombstones included)", async () => {
    const { db, raw } = makeSqliteD1();
    const created = await createOidcLoginState(db, logger, {
      connectionId: "ssoc_1",
      nonce: "n1",
      codeVerifier: "v1",
      redirectTo: null,
    });
    if (!created.success) throw new Error("create failed");
    await consumeOidcLoginState(db, logger, created.data);

    const purged = await purgeExpiredOidcStates(db, logger);
    expect(purged.success).toBe(true);
    if (purged.success) expect(purged.data).toBe(0);
    const remaining = raw.prepare("SELECT COUNT(*) as n FROM oidc_login_states").get() as {
      n: number;
    };
    expect(remaining.n).toBe(1);
  });
});
