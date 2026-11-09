/**
 * Telemetry consent at signup (#257).
 *
 * With `TELEMETRY_CONSENT_AT_SIGNUP = "true"` a new account is opted out of
 * telemetry unless a person ticked the box on the form that created it; with
 * the variable unset nothing changes. These tests run the whole Worker
 * (`src/index.ts`) against a real SQLite D1 through every door that creates an
 * account — magic link, the OAuth username step, agent-requested signup, the
 * legacy one-field form, SSO just-in-time, SCIM and dev-login — and read the
 * `users.telemetry_opt_out` column the telemetry paths actually consult.
 */
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { createSession } from "../src/storage/sessions";
import {
  rotateScimToken,
  setSsoConnectionEnabled,
  setSsoDomainsVerified,
  upsertSsoConnection,
} from "../src/storage/sso";
import type { Env } from "../src/types";
import { SSO_SECRET_SALT, encryptToken } from "../src/utils/crypto";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeMagicLinkLimiters } from "./helpers/magic-link-limiter";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

// Raw import, as in tests/wrangler-telemetry-config.test.ts.
import wranglerToml from "../wrangler.toml?raw";

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
const POSTHOG_HOST = "https://posthog.test";
const ISSUER = "https://idp.example.com";
const TOKEN_ENDPOINT = `${ISSUER}/oauth2/token`;
const JWKS_URI = `${ISSUER}/oauth2/jwks`;
const CLIENT_ID = "stratum-client";
const SSO_SECRET = "test-sso-encryption-secret";
const SSO_DOMAIN = "corp.example.com";
const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const CONSENT_ON = { TELEMETRY_CONSENT_AT_SIGNUP: "true" } as const;

const keys = await generateKeyPair("ES256");
const publicJwk = { ...(await exportJWK(keys.publicKey)), kid: "test-key", alg: "ES256" };

interface SentEmail {
  to: string;
  text: string;
}
interface CapturedEvent {
  event: string;
  distinct_id: string;
}

let env: Env;
let raw: ReturnType<typeof makeSqliteD1>["raw"];
let sent: SentEmail[];
let captured: CapturedEvent[];
let background: Promise<unknown>[];
let idToken = "";

/** Collects `waitUntil` work so a test can let it finish before asserting. */
const ctx = {
  waitUntil: (promise: Promise<unknown>) => {
    background.push(promise);
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function makeEnv(overrides: Partial<Env> = {}): Env {
  const sqlite = makeSqliteD1();
  raw = sqlite.raw;
  sent = [];
  captured = [];
  background = [];
  return {
    DB: sqlite.db,
    STATE: makeFakeKV(),
    MAGIC_LINK_LIMITER: makeMagicLinkLimiters().namespace,
    EMAIL: {
      send: vi.fn(async (message: SentEmail) => {
        sent.push(message);
        return { messageId: "m" };
      }),
    },
    EMAIL_FROM_ADDRESS: "noreply@stratum.test",
    // Server-side telemetry is on, so "opted out" is observable as an event
    // that was not sent rather than only as a column value.
    POSTHOG_API_KEY: "phc_server_test",
    POSTHOG_HOST,
    SSO_ENCRYPTION_SECRET: SSO_SECRET,
    ...overrides,
  } as unknown as Env;
}

beforeEach(() => {
  env = makeEnv();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${POSTHOG_HOST}/capture/`) {
        captured.push(JSON.parse(String(init?.body)) as CapturedEvent);
        return new Response("{}");
      }
      if (url.startsWith(JWKS_URI)) return Response.json({ keys: [publicJwk] });
      if (url.startsWith(TOKEN_ENDPOINT)) {
        return Response.json({ id_token: idToken, token_type: "Bearer" });
      }
      return new Response("unexpected", { status: 599 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function call(path: string, init: RequestInit = {}, e: Env = env): Promise<Response> {
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, init), e, ctx);
  await Promise.all(background.splice(0));
  return res;
}

function post(
  path: string,
  fields: Record<string, string>,
  e: Env = env,
  headers: Record<string, string> = {},
): Promise<Response> {
  return call(
    path,
    {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/x-www-form-urlencoded",
        "CF-Connecting-IP": "203.0.113.7",
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
    },
    e,
  );
}

/** The stored preference for an account, or undefined when no such account exists. */
function optOutOf(email: string): number | undefined {
  const row = raw.prepare("SELECT telemetry_opt_out FROM users WHERE email = ?").get(email) as
    | { telemetry_opt_out: number }
    | undefined;
  return row?.telemetry_opt_out;
}

function userIdOf(email: string): string {
  const row = raw.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
  return row.id;
}

function signupEventsFor(email: string): CapturedEvent[] {
  const id = userIdOf(email);
  return captured.filter((e) => e.event === "auth_completed" && e.distinct_id === id);
}

/** The consent `<input>` tag in a page, or null when the page has none. */
function consentInput(html: string): string | null {
  return /<input[^>]*name="telemetryConsent"[^>]*>/.exec(html)?.[0] ?? null;
}

function linkTokenFromEmail(): string {
  const match = sent.at(-1)?.text.match(/verify\?token=([0-9a-f]+)/);
  if (!match?.[1]) throw new Error("no magic link in email");
  return match[1];
}

async function magicLinkSignup(
  email: string,
  username: string,
  e: Env,
  extra: Record<string, string> = {},
): Promise<void> {
  const send = await post("/auth/email/send-signup", { email, username, ...extra }, e);
  expect(send.headers.get("Location")).toContain("success=email_sent");
  const verify = await post("/auth/email/verify", { token: linkTokenFromEmail() }, e);
  expect(verify.status).toBe(302);
  expect(verify.headers.get("Location")).not.toContain("error=");
}

const PENDING_TOKEN = "ab".repeat(32);

async function parkOAuthSignup(email: string, e: Env): Promise<Record<string, string>> {
  await e.STATE.put(
    `pending_signup:${PENDING_TOKEN}`,
    JSON.stringify({ provider: "google", email, suggestedUsername: null, createdAt: Date.now() }),
  );
  return { Cookie: `stratum_pending_signup=${PENDING_TOKEN}` };
}

async function oauthSignup(
  email: string,
  username: string,
  e: Env,
  extra: Record<string, string> = {},
): Promise<void> {
  const cookie = await parkOAuthSignup(email, e);
  const res = await post("/auth/signup/complete", { username, ...extra }, e, cookie);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).not.toContain("error=");
}

/** Requests an account as an agent would, then approves it as its human would. */
async function agentSignup(
  email: string,
  username: string,
  e: Env,
  extra: Record<string, string> = {},
): Promise<void> {
  const requested = await call(
    "/api/agent-signup",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
      // A field an agent might invent to consent for its human. It must not count.
      body: JSON.stringify({ email, username, agentName: "Claude Code", telemetryConsent: "on" }),
    },
    e,
  );
  expect(requested.status).toBe(202);
  const { userCode } = (await requested.json()) as { userCode: string };
  const approved = await post(
    "/auth/email/verify",
    { token: linkTokenFromEmail(), userCode, ...extra },
    e,
  );
  expect(approved.headers.get("Location")).toContain("agent-approved");
}

async function seedSso(e: Env): Promise<string> {
  raw
    .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
    .run("usr_owner", "owner@example.com", "owner-user", "hash_owner");
  raw
    .prepare("INSERT INTO orgs (id, name, slug, owner_id) VALUES (?, ?, ?, ?)")
    .run("org_acme", "Acme", "acme", "usr_owner");
  const upserted = await upsertSsoConnection(e.DB, logger, {
    orgId: "org_acme",
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecretCiphertext: await encryptToken("client-secret", SSO_SECRET, SSO_SECRET_SALT),
    authorizationEndpoint: `${ISSUER}/oauth2/authorize`,
    tokenEndpoint: TOKEN_ENDPOINT,
    jwksUri: JWKS_URI,
    emailDomains: [SSO_DOMAIN],
  });
  if (!upserted.success) throw new Error("seed: connection");
  const id = upserted.data.connection.id;
  const verified = await setSsoDomainsVerified(e.DB, logger, id, [SSO_DOMAIN]);
  const enabled = await setSsoConnectionEnabled(e.DB, logger, id, true);
  if (!verified.success || !enabled.success) throw new Error("seed: enable");
  return id;
}

async function ssoJitSignIn(email: string, e: Env): Promise<void> {
  await seedSso(e);
  const start = await call("/auth/sso/acme/start", {}, e);
  expect(start.status).toBe(302);
  const location = new URL(start.headers.get("Location") ?? "");
  const cookie = /stratum_sso_state=([^;]+)/.exec(start.headers.get("Set-Cookie") ?? "")?.[1];
  idToken = await new SignJWT({ nonce: location.searchParams.get("nonce"), email })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setSubject("idp-subject-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
  const callback = await call(
    `/auth/sso/callback?code=authcode-1&state=${location.searchParams.get("state")}`,
    { headers: { Cookie: `stratum_sso_state=${cookie}` } },
    e,
  );
  expect(callback.status).toBe(302);
  expect(callback.headers.get("Location")).not.toContain("error");
}

async function scimProvision(email: string, e: Env): Promise<void> {
  const connectionId = await seedSso(e);
  const rotated = await rotateScimToken(e.DB, logger, connectionId);
  if (!rotated.success) throw new Error("seed: scim token");
  const res = await call(
    "/scim/v2/Users",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rotated.data}`,
        "Content-Type": "application/scim+json",
      },
      body: JSON.stringify({ schemas: [USER_SCHEMA], userName: email }),
    },
    e,
  );
  expect(res.status).toBe(201);
}

async function devLogin(email: string, e: Env): Promise<void> {
  const res = await app.fetch(
    new Request(`http://localhost/dev-login?email=${encodeURIComponent(email)}`),
    { ...e, DEV_LOGIN_ENABLED: "true" } as Env,
    ctx,
  );
  expect(res.status).toBe(302);
}

describe("with TELEMETRY_CONSENT_AT_SIGNUP unset (the self-hosted default)", () => {
  it("shows no consent box on the signup form", async () => {
    const html = await (await call("/auth/signup")).text();
    expect(html).toContain('name="username"');
    expect(consentInput(html)).toBeNull();
  });

  it("shows no consent box on the OAuth username form", async () => {
    const cookie = await parkOAuthSignup("o@example.com", env);
    const html = await (await call("/auth/signup/complete", { headers: cookie })).text();
    expect(html).toContain('name="username"');
    expect(consentInput(html)).toBeNull();
  });

  it("shows no consent box on the agent-signup approval page", async () => {
    await call("/api/agent-signup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
      body: JSON.stringify({ email: "a@example.com", username: "agenthuman", agentName: "Bot" }),
    });
    const html = await (await call(`/auth/email/verify?token=${linkTokenFromEmail()}`)).text();
    expect(html).toContain('name="userCode"');
    expect(consentInput(html)).toBeNull();
  });

  it("creates a magic-link account opted in, and reports its signup", async () => {
    await magicLinkSignup("m@example.com", "magicperson", env);
    expect(optOutOf("m@example.com")).toBe(0);
    expect(signupEventsFor("m@example.com")).toHaveLength(1);
  });

  it("ignores a consent field nobody was shown: an unticked signup stays opted in", async () => {
    // The point of "off": the absence of a tick must not start opting anyone out.
    await oauthSignup("o@example.com", "oauthperson", env);
    expect(optOutOf("o@example.com")).toBe(0);
  });

  it("creates every unasked account opted in, as before", async () => {
    await agentSignup("a@example.com", "agenthuman", env);
    expect(optOutOf("a@example.com")).toBe(0);

    env = makeEnv();
    await ssoJitSignIn(`jit@${SSO_DOMAIN}`, env);
    expect(optOutOf(`jit@${SSO_DOMAIN}`)).toBe(0);

    env = makeEnv();
    await scimProvision(`scim@${SSO_DOMAIN}`, env);
    expect(optOutOf(`scim@${SSO_DOMAIN}`)).toBe(0);

    env = makeEnv();
    await devLogin("localperson@example.com", env);
    expect(optOutOf("localperson@example.com")).toBe(0);
  });
});

describe('with TELEMETRY_CONSENT_AT_SIGNUP = "true"', () => {
  beforeEach(() => {
    env = makeEnv(CONSENT_ON);
  });

  it.each(["1", "TRUE", "yes", ""])("is not turned on by %j — only the literal true", async (v) => {
    env = makeEnv({ TELEMETRY_CONSENT_AT_SIGNUP: v });
    expect(consentInput(await (await call("/auth/signup")).text())).toBeNull();
    await magicLinkSignup("m@example.com", "magicperson", env);
    expect(optOutOf("m@example.com")).toBe(0);
  });

  describe("the consent box", () => {
    function expectUnticked(html: string): void {
      const input = consentInput(html);
      expect(input).not.toBeNull();
      expect(input).toContain('type="checkbox"');
      expect(input).not.toMatch(/\bchecked\b/);
      // Valueless on purpose: a ticked box must submit the literal "on".
      expect(input).not.toMatch(/\bvalue=/);
      expect(html).toContain("https://docs.usestratum.dev/guides/faq/#can-i-turn-off-telemetry");
    }

    it("is on the signup form, unticked, inside the form that posts it", async () => {
      const html = await (await call("/auth/signup")).text();
      expectUnticked(html);
      const form = /<form[^>]*action="\/auth\/email\/send-signup"[\s\S]*?<\/form>/.exec(html)?.[0];
      expect(consentInput(form ?? "")).not.toBeNull();
    });

    it("is on the OAuth username form, unticked", async () => {
      const cookie = await parkOAuthSignup("o@example.com", env);
      const html = await (await call("/auth/signup/complete", { headers: cookie })).text();
      expectUnticked(html);
    });

    it("stays unticked when the OAuth form is shown again after an error", async () => {
      const cookie = await parkOAuthSignup("o@example.com", env);
      const rejected = await post(
        "/auth/signup/complete",
        { username: "-bad-", telemetryConsent: "on" },
        env,
        cookie,
      );
      const again = await call(rejected.headers.get("Location") ?? "", { headers: cookie });
      expectUnticked(await again.text());
      expect(optOutOf("o@example.com")).toBeUndefined();
    });

    it("is on the agent-signup approval page, unticked", async () => {
      await call("/api/agent-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
        body: JSON.stringify({ email: "a@example.com", username: "agenthuman", agentName: "Bot" }),
      });
      const html = await (await call(`/auth/email/verify?token=${linkTokenFromEmail()}`)).text();
      expectUnticked(html);
    });

    it("is not on the ordinary sign-in confirm page", async () => {
      await post("/auth/email/send-signup", { email: "m@example.com", username: "magicperson" });
      const html = await (await call(`/auth/email/verify?token=${linkTokenFromEmail()}`)).text();
      expect(html).toContain("Complete your sign-in");
      expect(consentInput(html)).toBeNull();
    });
  });

  describe("magic-link signup", () => {
    it("creates the account opted out when the box was left unticked, and sends no signup event", async () => {
      await magicLinkSignup("m@example.com", "magicperson", env);
      expect(optOutOf("m@example.com")).toBe(1);
      expect(signupEventsFor("m@example.com")).toHaveLength(0);
      expect(captured.filter((e) => e.distinct_id === userIdOf("m@example.com"))).toHaveLength(0);
    });

    it("creates the account opted in when the box was ticked", async () => {
      await magicLinkSignup("m@example.com", "magicperson", env, { telemetryConsent: "on" });
      expect(optOutOf("m@example.com")).toBe(0);
      expect(signupEventsFor("m@example.com")).toHaveLength(1);
    });

    it.each(["true", "1", "off", "ON"])("reads %j as no consent", async (value) => {
      await magicLinkSignup("m@example.com", "magicperson", env, { telemetryConsent: value });
      expect(optOutOf("m@example.com")).toBe(1);
    });

    it("does not take consent from the verify request, only from the signup form", async () => {
      await post("/auth/email/send-signup", { email: "m@example.com", username: "magicperson" });
      await post("/auth/email/verify", { token: linkTokenFromEmail(), telemetryConsent: "on" });
      expect(optOutOf("m@example.com")).toBe(1);
    });
  });

  describe("OAuth signup", () => {
    it("creates the account opted out when the box was left unticked", async () => {
      await oauthSignup("o@example.com", "oauthperson", env);
      expect(optOutOf("o@example.com")).toBe(1);
      expect(signupEventsFor("o@example.com")).toHaveLength(0);
    });

    it("creates the account opted in when the box was ticked", async () => {
      await oauthSignup("o@example.com", "oauthperson", env, { telemetryConsent: "on" });
      expect(optOutOf("o@example.com")).toBe(0);
      expect(signupEventsFor("o@example.com")).toHaveLength(1);
    });
  });

  describe("agent-requested signup", () => {
    it("creates the account opted out, whatever the agent sent", async () => {
      await agentSignup("a@example.com", "agenthuman", env);
      expect(optOutOf("a@example.com")).toBe(1);
      expect(signupEventsFor("a@example.com")).toHaveLength(0);
    });

    it("creates the account opted in only when the human ticks the box on the approval page", async () => {
      await agentSignup("a@example.com", "agenthuman", env, { telemetryConsent: "on" });
      expect(optOutOf("a@example.com")).toBe(0);
    });
  });

  describe("paths with nobody to ask", () => {
    it("creates a legacy one-field magic-link account opted out", async () => {
      const send = await post("/auth/email/send", { email: "legacy@example.com" });
      expect(send.headers.get("Location")).toContain("success=email_sent");
      await post("/auth/email/verify", { token: linkTokenFromEmail() });
      expect(optOutOf("legacy@example.com")).toBe(1);
    });

    it("creates an SSO just-in-time account opted out", async () => {
      await ssoJitSignIn(`jit@${SSO_DOMAIN}`, env);
      expect(optOutOf(`jit@${SSO_DOMAIN}`)).toBe(1);
    });

    it("creates a SCIM-provisioned account opted out", async () => {
      await scimProvision(`scim@${SSO_DOMAIN}`, env);
      expect(optOutOf(`scim@${SSO_DOMAIN}`)).toBe(1);
    });

    it("creates a dev-login account opted out", async () => {
      await devLogin("localperson@example.com", env);
      expect(optOutOf("localperson@example.com")).toBe(1);
    });
  });

  describe("accounts that already exist", () => {
    beforeEach(() => {
      raw
        .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
        .run("usr_old_in", "in@example.com", "oldin", "hash_in");
      raw
        .prepare(
          "INSERT INTO users (id, email, username, token_hash, telemetry_opt_out) VALUES (?, ?, ?, ?, 1)",
        )
        .run("usr_old_out", "out@example.com", "oldout", "hash_out");
    });

    it("keeps an opted-in account opted in through a sign-in", async () => {
      await post("/auth/email/send-login", { email: "in@example.com" });
      const verify = await post("/auth/email/verify", { token: linkTokenFromEmail() });
      expect(verify.headers.get("Location")).not.toContain("error=");
      expect(optOutOf("in@example.com")).toBe(0);
      expect(optOutOf("out@example.com")).toBe(1);
    });

    it("keeps an opted-in account opted in when its owner finishes a signup link for the same address", async () => {
      // The link was minted before the account existed; verify finds the
      // account and signs in. An unticked box on that form must not opt it out.
      raw.prepare("DELETE FROM users WHERE id = 'usr_old_in'").run();
      await post("/auth/email/send-signup", { email: "in@example.com", username: "newname" });
      raw
        .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
        .run("usr_old_in", "in@example.com", "oldin", "hash_in");
      await post("/auth/email/verify", { token: linkTokenFromEmail() });
      expect(optOutOf("in@example.com")).toBe(0);
    });

    it("keeps an opted-out account opted out when SCIM adopts it", async () => {
      raw
        .prepare(
          "INSERT INTO users (id, email, username, token_hash, telemetry_opt_out) VALUES (?, ?, ?, ?, 1)",
        )
        .run("usr_corp", `corp@${SSO_DOMAIN}`, "corp", "hash_corp");
      const connectionId = await seedSso(env);
      const rotated = await rotateScimToken(env.DB, logger, connectionId);
      if (!rotated.success) throw new Error("seed: scim token");
      await call("/scim/v2/Users", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rotated.data}`,
          "Content-Type": "application/scim+json",
        },
        body: JSON.stringify({ schemas: [USER_SCHEMA], userName: `corp@${SSO_DOMAIN}` }),
      });
      expect(optOutOf(`corp@${SSO_DOMAIN}`)).toBe(1);
      expect(optOutOf("in@example.com")).toBe(0);
    });
  });

  it("lets someone who signed up opted out opt in later from Settings", async () => {
    await magicLinkSignup("m@example.com", "magicperson", env);
    expect(optOutOf("m@example.com")).toBe(1);

    const session = await createSession(env.DB, userIdOf("m@example.com"), logger);
    if (!session.success) throw session.error;
    const cookie = { Cookie: `stratum_session=${session.data.id}` };

    const settings = await (await call("/settings", { headers: cookie })).text();
    const box = /<input[^>]*name="analytics"[^>]*>/.exec(settings)?.[0];
    expect(box).toBeDefined();
    expect(box).not.toMatch(/\bchecked\b/);

    const saved = await post("/settings/telemetry", { analytics: "on" }, env, cookie);
    expect(saved.status).toBe(302);
    expect(optOutOf("m@example.com")).toBe(0);
  });
});

describe("wrangler.toml", () => {
  /** The uncommented lines of one `[section]`, up to the next section header. */
  function activeLines(section: string): string[] {
    const start = wranglerToml.indexOf(`\n[${section}]\n`);
    expect(start).toBeGreaterThan(-1);
    const rest = wranglerToml.slice(start + section.length + 3);
    const end = rest.search(/^\s*\[/m);
    return (end === -1 ? rest : rest.slice(0, end))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"));
  }
  const SETTING = 'TELEMETRY_CONSENT_AT_SIGNUP = "true"';

  // Named environments replace top-level [vars] rather than inheriting them,
  // so the hosted instance only asks if each of its own blocks says so.
  it.each(["env.production.vars", "env.staging.vars"])("turns consent on in [%s]", (section) => {
    expect(activeLines(section)).toContain(SETTING);
  });

  it("leaves it off in the top-level [vars] a self-hoster starts from", () => {
    expect(activeLines("vars").join("\n")).not.toContain("TELEMETRY_CONSENT_AT_SIGNUP");
  });
});
