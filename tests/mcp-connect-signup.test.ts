/**
 * Issue #410: a first-time visitor who adds Stratum's MCP server to an editor
 * can create an account from the sign-in page and land back on the consent
 * screen, without the authorization request being lost in the magic-link
 * round trip.
 *
 * Driven over HTTP through the real routers, mounted at the paths
 * `src/index.ts` uses, against real SQLite. A small cookie jar plays the
 * browser, because what is under test is which browser a destination follows:
 * the one that asked for the link reaches the consent screen, any other one
 * gets "reconnect your editor".
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { csrfMiddleware } from "../src/middleware/csrf";
import { securityHeadersMiddleware } from "../src/middleware/security-headers";
import { emailAuthRouter } from "../src/routes/email-auth";
import { loginRouter } from "../src/routes/login";
import { mcpOAuthRouter } from "../src/routes/mcp-oauth";
import { signupRouter } from "../src/routes/signup";
import { createMagicLink } from "../src/storage/magic-links";
import type { Env } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { oauthAuthorizeTarget } from "../src/utils/post-login-redirect";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeMagicLinkLimiters } from "./helpers/magic-link-limiter";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

const ORIGIN = "https://stratum.test";
const REDIRECT = "http://127.0.0.1:9876/callback";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

let app: Hono<{ Bindings: Env }>;
let env: Env;
let db: D1Database;
let sent: { to: string; text: string }[];

/** One browser: remembers cookies across requests, as a real one would. */
class Browser {
  private cookies = new Map<string, string>();

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set(
        "Cookie",
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    if (init.method === "POST") headers.set("Origin", ORIGIN);
    const response = await app.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), env);
    // Node's Headers has getSetCookie(); the Workers types this repo compiles
    // against do not declare it.
    const setCookies = (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
    for (const line of setCookies) {
      const [pair = "", ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a: string) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  post(path: string, fields: Record<string, string>): Promise<Response> {
    return this.fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  }

  has(name: string): boolean {
    return this.cookies.has(name);
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }
}

async function registerClient(): Promise<string> {
  const response = await app.fetch(
    new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Test Editor", redirect_uris: [REDIRECT] }),
    }),
    env,
  );
  const json = (await response.json()) as { client_id: string };
  return json.client_id;
}

function authorizePath(clientId: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "mcp:read",
    state: "st-1",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    ...extra,
  });
  return `/oauth/authorize?${params}`;
}

/** The verify token from the most recent magic-link email. */
function lastToken(): string {
  const text = sent.at(-1)?.text ?? "";
  const match = /verify\?token=([0-9a-f]{64})/.exec(text);
  if (!match?.[1]) throw new Error(`No magic link in: ${text}`);
  return match[1];
}

/** Opens a page and follows same-origin redirects, as a browser would. */
async function follow(browser: Browser, first: Response): Promise<Response> {
  let response = first;
  for (let hops = 0; hops < 5 && response.status >= 300 && response.status < 400; hops++) {
    const location = response.headers.get("Location") ?? "";
    const url = new URL(location, ORIGIN);
    if (url.origin !== ORIGIN) return response;
    response = await browser.fetch(url.pathname + url.search);
  }
  return response;
}

beforeEach(async () => {
  db = makeSqliteD1().db;
  sent = [];
  env = {
    DB: db,
    STATE: makeFakeKV(),
    MAGIC_LINK_LIMITER: makeMagicLinkLimiters().namespace,
    EMAIL: {
      send: vi.fn(async (message: { to: string; text: string }) => {
        sent.push({ to: message.to, text: message.text });
        return { messageId: "m" };
      }),
    },
    EMAIL_FROM_ADDRESS: "noreply@stratum.test",
  } as unknown as Env;

  app = new Hono<{ Bindings: Env }>();
  app.use("*", securityHeadersMiddleware);
  app.use("*", authMiddleware);
  app.use("*", csrfMiddleware);
  app.route("/auth/email", emailAuthRouter);
  app.route("/auth/login", loginRouter);
  app.route("/auth/signup", signupRouter);
  app.route("/", mcpOAuthRouter);
});

describe("MCP connect → signup → consent (#410)", () => {
  it("authorize while logged out → signup → verify lands on the consent screen", async () => {
    const clientId = await registerClient();
    const browser = new Browser();
    const authorize = authorizePath(clientId);

    // 1. The editor opens the authorize URL; we are not signed in.
    const toLogin = await browser.fetch(authorize);
    expect(toLogin.status).toBe(302);
    expect(toLogin.headers.get("Location")).toBe("/auth/login");

    // 2. The sign-in page offers account creation for this flow.
    const login = await browser.fetch("/auth/login");
    const loginHtml = await login.text();
    expect(loginHtml).toContain("New to Stratum?");
    expect(loginHtml).toContain('href="/auth/signup"');

    // 3. Signup page knows where this ends.
    const signupHtml = await (await browser.fetch("/auth/signup")).text();
    expect(signupHtml).toContain("connect your editor");

    // 4. Submit signup; the link is bound to this browser.
    const sendRes = await browser.post("/auth/email/send-signup", {
      email: "new@example.com",
      username: "newbie",
      rememberMe: "true",
    });
    expect(sendRes.headers.get("Location")).toBe("/auth/signup?success=email_sent");
    expect(browser.has("magic_link_binding")).toBe(true);
    // The email carries only the token — never the destination.
    expect(sent.at(-1)?.text).not.toContain("oauth");

    // 5. Open the link, confirm, and follow the redirects.
    const token = lastToken();
    const confirmPage = await browser.fetch(`/auth/email/verify?token=${token}`);
    expect(confirmPage.status).toBe(200);
    const verified = await browser.post("/auth/email/verify", { token });
    expect(verified.status).toBe(302);
    expect(verified.headers.get("Location")).toBe(authorize);
    expect(browser.has("magic_link_binding")).toBe(false);

    const consent = await follow(browser, verified);
    expect(consent.status).toBe(200);
    const consentHtml = await consent.text();
    expect(consentHtml).toContain("Test Editor");
    expect(consentHtml).toContain('name="decision"');

    const user = await db
      .prepare("SELECT username FROM users WHERE email = ?")
      .bind("new@example.com")
      .first<{ username: string }>();
    expect(user?.username).toBe("newbie");
  });

  it("still reaches consent after the ten-minute remembered-redirect cookie has gone", async () => {
    const clientId = await registerClient();
    const browser = new Browser();
    const authorize = authorizePath(clientId);
    await browser.fetch(authorize);
    await browser.post("/auth/email/send-signup", { email: "slow@example.com", username: "slow" });

    // The remembered-redirect cookie expired while the email sat unread.
    browser.set("redirect_after_login", "");
    const verified = await browser.post("/auth/email/verify", { token: lastToken() });
    expect(verified.headers.get("Location")).toBe(authorize);
  });

  it("returns a sign-in magic link to the consent screen too", async () => {
    await db
      .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
      .bind("usr_x", "old@example.com", "oldie", "h")
      .run();
    const clientId = await registerClient();
    const browser = new Browser();
    const authorize = authorizePath(clientId);
    await browser.fetch(authorize);
    await browser.post("/auth/email/send-login", { email: "old@example.com" });
    const verified = await browser.post("/auth/email/verify", { token: lastToken() });
    expect(verified.headers.get("Location")).toBe(authorize);
  });

  it("sets the binding cookie whether or not a sign-in address has an account", async () => {
    const clientId = await registerClient();
    const browser = new Browser();
    await browser.fetch(authorizePath(clientId));
    const res = await browser.post("/auth/email/send-login", { email: "nobody@example.com" });
    expect(res.headers.get("Location")).toBe("/auth/login?success=login_link_sent");
    // Same Set-Cookie as for a real account: no enumeration via headers.
    expect(browser.has("magic_link_binding")).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("on a different device, signs the user up and says to reconnect the editor", async () => {
    const clientId = await registerClient();
    const laptop = new Browser();
    await laptop.fetch(authorizePath(clientId));
    await laptop.post("/auth/email/send-signup", { email: "phone@example.com", username: "phony" });

    const phone = new Browser();
    const verified = await phone.post("/auth/email/verify", { token: lastToken() });
    expect(verified.status).toBe(302);
    expect(verified.headers.get("Location")).toBe("/auth/email/reconnect?signed=up");

    const page = await follow(phone, verified);
    const html = await page.text();
    expect(html).toContain("You're signed up. Reconnect your editor.");
    // Signed in all the same: the account work is done.
    expect(phone.has("stratum_session")).toBe(true);
  });

  it("refuses a binding nonce that does not match the link", async () => {
    const clientId = await registerClient();
    const browser = new Browser();
    await browser.fetch(authorizePath(clientId));
    await browser.post("/auth/email/send-signup", {
      email: "nonce@example.com",
      username: "nonce",
    });
    const attacker = new Browser();
    attacker.set("magic_link_binding", "f".repeat(64));
    const verified = await attacker.post("/auth/email/verify", { token: lastToken() });
    expect(verified.headers.get("Location")).toBe("/auth/email/reconnect?signed=up");
  });

  it("leaves an ordinary signup going to the dashboard", async () => {
    const browser = new Browser();
    const loginHtml = await (await browser.fetch("/auth/login")).text();
    expect(loginHtml).not.toContain("New to Stratum?");
    await browser.post("/auth/email/send-signup", {
      email: "plain@example.com",
      username: "plain",
    });
    expect(browser.has("magic_link_binding")).toBe(false);
    const verified = await browser.post("/auth/email/verify", { token: lastToken() });
    expect(verified.headers.get("Location")).toBe("/");
  });
});

describe("invite pre-fill (#410)", () => {
  it("carries an invite from the authorize URL into the signup form", async () => {
    env = { ...env, BETA_GATE: "1", REFERRAL_SERVICE_URL: "https://referral.test" } as Env;
    const clientId = await registerClient();
    const browser = new Browser();
    await browser.fetch(authorizePath(clientId, { invite: "ABCDE12345" }));

    const loginHtml = await (await browser.fetch("/auth/login")).text();
    expect(loginHtml).toContain('href="/auth/signup?invite=ABCDE12345"');

    const signupHtml = await (await browser.fetch("/auth/signup")).text();
    expect(signupHtml).toMatch(/name="inviteCode"[^>]*value="ABCDE12345"/);
  });

  it("does not echo an invite that is not a plausible code", async () => {
    const clientId = await registerClient();
    const browser = new Browser();
    await browser.fetch(authorizePath(clientId, { invite: '"><script>x</script>' }));
    const loginHtml = await (await browser.fetch("/auth/login")).text();
    expect(loginHtml).toContain('href="/auth/signup"');
    expect(loginHtml).not.toContain("<script>x");
  });
});

describe("hostile return-to (#410, no open-redirect regression from #376)", () => {
  const HOSTILE = [
    "https://evil.example/oauth/authorize?client_id=x",
    "//evil.example/oauth/authorize",
    "/\\evil.example/oauth/authorize",
    "/.//evil.example/oauth/authorize",
    "/oauth/authorize/..//evil.example",
    "/%2e//evil.example/oauth/authorize",
    "/oauth/authorizeX?client_id=x",
    "/oauth/authorize/../settings",
    "/settings",
    "javascript:alert(1)",
  ];

  it.each(HOSTILE)("does not treat %s as an authorize target", (raw) => {
    expect(oauthAuthorizeTarget(raw, `${ORIGIN}/auth/login`)).toBeNull();
  });

  it.each(HOSTILE)("a remembered %s neither prompts signup nor binds a link", async (raw) => {
    const browser = new Browser();
    browser.set("redirect_after_login", encodeURIComponent(raw));
    const loginHtml = await (await browser.fetch("/auth/login")).text();
    expect(loginHtml).not.toContain("New to Stratum?");
    await browser.post("/auth/email/send-signup", {
      email: `h${HOSTILE.indexOf(raw)}@example.com`,
      username: `hostile${HOSTILE.indexOf(raw)}`,
    });
    expect(browser.has("magic_link_binding")).toBe(false);
    const verified = await browser.post("/auth/email/verify", { token: lastToken() });
    const location = verified.headers.get("Location") ?? "";
    expect(location.startsWith("/")).toBe(true);
    expect(location.startsWith("//")).toBe(false);
    expect(new URL(location, ORIGIN).origin).toBe(ORIGIN);
  });

  it.each(HOSTILE)("a link payload carrying %s is refused at verify", async (raw) => {
    const browser = new Browser();
    // Even a matching binding cannot launder a target that fails the allowlist:
    // the payload is re-validated, not trusted because we wrote it.
    const nonce = "a".repeat(64);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
    const binding = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    browser.set("magic_link_binding", nonce);
    const token = "b".repeat(64);
    const stored = await createMagicLink(
      db,
      token,
      {
        email: "payload@example.com",
        username: "payloadie",
        intent: "signup",
        returnTo: raw,
        returnBinding: binding,
      },
      900,
      logger,
    );
    expect(stored.success).toBe(true);
    const verified = await browser.post("/auth/email/verify", { token });
    expect(verified.headers.get("Location")).toBe("/auth/email/reconnect?signed=up");
  });
});
