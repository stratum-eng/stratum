/**
 * The "choose your username" step of a GitHub or Google signup.
 *
 * Covers the hand-off from the two OAuth callbacks (a first-time identity is
 * parked, not created), the form itself, and the POST that finally creates the
 * account under the chosen name — including the closed-beta invite check that
 * the callbacks used to have to refuse outright.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authRouter } from "../src/routes/auth";
import { oauthSignupRouter } from "../src/routes/oauth-signup";
import type { Env, User } from "../src/types";
import { makeFakeKV } from "./helpers/fake-kv";

vi.mock("../src/storage/users", () => ({
  createUser: vi.fn(),
  getUserByEmail: vi.fn(),
  getUserByGitHubId: vi.fn(),
  getUserByUsername: vi.fn(),
  linkGitHub: vi.fn(),
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

vi.mock("../src/beta/gate", () => ({
  betaGateEnabled: vi.fn(() => false),
  validateInviteCode: vi.fn(),
  admitAndDeliverCodes: vi.fn().mockResolvedValue(undefined),
}));

import { admitAndDeliverCodes, betaGateEnabled, validateInviteCode } from "../src/beta/gate";
import { createSession, getSession } from "../src/storage/sessions";
import {
  createUser,
  getUserByEmail,
  getUserByGitHubId,
  getUserByUsername,
  linkGitHub,
  signInGitHubUser,
} from "../src/storage/users";

const COMPLETE = "/auth/signup/complete";
const fetchMock = vi.fn();

const notFound = { success: false as const, error: new Error("not found") as never };
const user = (overrides: Partial<User> = {}): User => ({
  id: "usr_1",
  email: "octo@example.com",
  username: "octo",
  tokenHash: "h",
  createdAt: "",
  ...overrides,
});

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/auth", authRouter);
  app.route(COMPLETE, oauthSignupRouter);
  return app;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: makeFakeKV(),
    DB: {} as D1Database,
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret",
    OAUTH_REDIRECT_URI: "https://app.example.com/auth/github/callback",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    GOOGLE_REDIRECT_URI: "https://app.example.com/auth/google/callback",
    ...overrides,
  } as Env;
}

type KV = ReturnType<typeof makeFakeKV>;

function kvOf(env: Env): KV {
  return env.STATE as KV;
}

function mockGitHub(
  emails: { email: string; primary: boolean; verified: boolean }[],
  login = "Octo_Cat",
) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "gh-token" }), { status: 200 });
    }
    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify({ id: 12345, login }), { status: 200 });
    }
    if (url === "https://api.github.com/user/emails") {
      return new Response(JSON.stringify(emails), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function mockGoogle(email: string) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "google-token" }), { status: 200 });
    }
    if (url.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
      return new Response(JSON.stringify({ sub: "g-1", email, email_verified: true }), {
        status: 200,
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function withState(env: Env): void {
  kvOf(env).store.set("oauth_state:goodstate", "1");
}

function callback(app: Hono<{ Bindings: Env }>, env: Env, provider: "github" | "google") {
  withState(env);
  return app.fetch(
    new Request(`http://localhost/auth/${provider}/callback?code=ok&state=goodstate`, {
      headers: { Cookie: "stratum_oauth_state=goodstate" },
    }),
    env,
  );
}

/** Every Set-Cookie line on a response; the workers-types Headers lacks the accessor. */
function setCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

function cookieValue(res: Response, name: string): string | undefined {
  for (const line of setCookies(res)) {
    const [pair] = line.split(";");
    const [key, value] = (pair ?? "").split("=");
    if (key === name) return value;
  }
  return undefined;
}

function cookieLine(res: Response, name: string): string | undefined {
  return setCookies(res).find((line) => line.startsWith(`${name}=`));
}

/** Everything the callback stored, keyed by the token it handed the browser. */
function pendingRecord(env: Env, token: string): Record<string, unknown> {
  const raw = kvOf(env).store.get(`pending_signup:${token}`);
  if (!raw) throw new Error("no pending record");
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Park a record directly, as a callback would have. */
function park(env: Env, record: Record<string, unknown>): string {
  const token = "a".repeat(64);
  kvOf(env).store.set(`pending_signup:${token}`, JSON.stringify(record));
  return token;
}

const GITHUB_RECORD = {
  provider: "github",
  email: "octo@example.com",
  suggestedUsername: "octo-cat",
  github: { id: "12345", login: "Octo_Cat" },
  createdAt: 0,
};

function post(
  app: Hono<{ Bindings: Env }>,
  env: Env,
  token: string | undefined,
  fields: Record<string, string>,
  headers: Record<string, string> = { Origin: "http://localhost" },
) {
  const body = new URLSearchParams(fields);
  return app.fetch(
    new Request(`http://localhost${COMPLETE}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(token ? { Cookie: `stratum_pending_signup=${token}` } : {}),
        ...headers,
      },
      body,
    }),
    env,
  );
}

describe("OAuth signup: choosing a username", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(betaGateEnabled).mockReturnValue(false);
    vi.mocked(getUserByEmail).mockResolvedValue(notFound);
    vi.mocked(getUserByGitHubId).mockResolvedValue(notFound);
    vi.mocked(getUserByUsername).mockResolvedValue(notFound);
    vi.mocked(getSession).mockResolvedValue(notFound);
    // No account behind the identity — the callback's cue to park it.
    vi.mocked(signInGitHubUser).mockResolvedValue({ success: true, data: null });
    vi.mocked(linkGitHub).mockResolvedValue({ success: true, data: undefined });
    vi.mocked(createSession).mockResolvedValue({
      success: true,
      data: { id: "sess_1", userId: "usr_new", expiresAt: "2099-01-01T00:00:00.000Z" },
    });
    vi.mocked(createUser).mockResolvedValue({
      success: true,
      data: { user: user({ id: "usr_new", username: "chosen" }), plaintext: "stratum_user_x" },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("GitHub callback", () => {
    it("parks a first-time identity and sends it to the username form", async () => {
      const app = makeApp();
      const env = makeEnv();
      mockGitHub([{ email: "octo@example.com", primary: true, verified: true }]);

      const res = await callback(app, env, "github");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(COMPLETE);
      const token = cookieValue(res, "stratum_pending_signup");
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(cookieLine(res, "stratum_pending_signup")).toContain("HttpOnly");
      expect(cookieLine(res, "stratum_pending_signup")).toContain("Path=/auth");
      expect(pendingRecord(env, token ?? "")).toMatchObject({
        provider: "github",
        email: "octo@example.com",
        suggestedUsername: "octo-cat",
        github: { id: "12345", login: "Octo_Cat" },
      });
      // Nothing is created and nobody is signed in until the form comes back.
      expect(createUser).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      expect(cookieValue(res, "stratum_session")).toBeUndefined();
    });

    it("carries a safe `next` into the parked record and drops an unsafe one", async () => {
      const app = makeApp();
      const env = makeEnv();
      mockGitHub([{ email: "octo@example.com", primary: true, verified: true }]);

      withState(env);
      const safe = await app.fetch(
        new Request(
          "http://localhost/auth/github/callback?code=ok&state=goodstate&next=%2Fp%2Fdemo%3Ftab%3D1",
          { headers: { Cookie: "stratum_oauth_state=goodstate" } },
        ),
        env,
      );
      expect(pendingRecord(env, cookieValue(safe, "stratum_pending_signup") ?? "").next).toBe(
        "/p/demo?tab=1",
      );

      withState(env);
      const unsafe = await app.fetch(
        new Request(
          "http://localhost/auth/github/callback?code=ok&state=goodstate&next=%2F%2Fevil.com",
          { headers: { Cookie: "stratum_oauth_state=goodstate" } },
        ),
        env,
      );
      expect(
        pendingRecord(env, cookieValue(unsafe, "stratum_pending_signup") ?? "").next,
      ).toBeUndefined();
    });

    it("carries a `next` given to /auth/github through the state record", async () => {
      const app = makeApp();
      const env = makeEnv();
      mockGitHub([{ email: "octo@example.com", primary: true, verified: true }]);

      const start = await app.fetch(
        new Request("http://localhost/auth/github?next=%2Fp%2Fdemo%3Ftab%3D1"),
        env,
      );
      expect(start.status).toBe(302);
      const state = cookieValue(start, "stratum_oauth_state") ?? "";
      expect(state).not.toBe("");
      // GitHub gets only the state; the destination stays server-side.
      expect(start.headers.get("Location")).not.toContain("next");
      expect(kvOf(env).store.get(`oauth_state:${state}`)).toBe(
        JSON.stringify({ next: "/p/demo?tab=1" }),
      );

      const res = await app.fetch(
        new Request(`http://localhost/auth/github/callback?code=ok&state=${state}`, {
          headers: { Cookie: `stratum_oauth_state=${state}` },
        }),
        env,
      );
      expect(res.headers.get("Location")).toBe(COMPLETE);
      expect(pendingRecord(env, cookieValue(res, "stratum_pending_signup") ?? "").next).toBe(
        "/p/demo?tab=1",
      );
      // The state is single-use, destination included.
      expect(kvOf(env).store.has(`oauth_state:${state}`)).toBe(false);
    });

    it("drops an unsafe `next` at /auth/github rather than storing it", async () => {
      const app = makeApp();
      const env = makeEnv();

      const start = await app.fetch(
        new Request("http://localhost/auth/github?next=https%3A%2F%2Fevil.example%2F"),
        env,
      );
      const state = cookieValue(start, "stratum_oauth_state") ?? "";
      expect(kvOf(env).store.get(`oauth_state:${state}`)).toBe("1");
    });

    it("carries a `next` given to /auth/google through the username step, over the cookie", async () => {
      const app = makeApp();
      const env = makeEnv();
      mockGoogle("jane@example.com");

      const start = await app.fetch(
        new Request("http://localhost/auth/google?next=%2Fp%2Fdemo%3Ftab%3D1"),
        env,
      );
      const state = cookieValue(start, "stratum_oauth_state") ?? "";
      expect(start.headers.get("Location")).not.toContain("next");

      const parked = await app.fetch(
        new Request(`http://localhost/auth/google/callback?code=ok&state=${state}`, {
          headers: { Cookie: `stratum_oauth_state=${state}` },
        }),
        env,
      );
      expect(parked.headers.get("Location")).toBe(COMPLETE);
      const token = cookieValue(parked, "stratum_pending_signup") ?? "";
      expect(pendingRecord(env, token).next).toBe("/p/demo?tab=1");

      const res = await post(
        app,
        env,
        token,
        { username: "jane" },
        {
          Origin: "http://localhost",
          Cookie: `stratum_pending_signup=${token}; redirect_after_login=%2Foauth%2Fauthorize%3Fx%3D1`,
        },
      );

      expect(res.headers.get("Location")).toBe("/p/demo?tab=1");
      // The competing cookie lost, and is spent anyway.
      expect(cookieLine(res, "redirect_after_login")).toContain("Max-Age=0");
    });

    it("suggests nothing when the GitHub handle cannot become a username", async () => {
      const app = makeApp();
      const env = makeEnv();
      mockGitHub([{ email: "octo@example.com", primary: true, verified: true }], "42");

      const res = await callback(app, env, "github");

      expect(pendingRecord(env, cookieValue(res, "stratum_pending_signup") ?? "")).toMatchObject({
        suggestedUsername: null,
      });
    });

    it("refuses an identity whose only email is unverified", async () => {
      const app = makeApp();
      const env = makeEnv();
      mockGitHub([{ email: "victim@example.com", primary: true, verified: false }]);

      const res = await callback(app, env, "github");

      expect(res.status).toBe(422);
      expect(signInGitHubUser).not.toHaveBeenCalled();
      expect(createUser).not.toHaveBeenCalled();
    });

    it("never matches an existing account on an unverified email", async () => {
      const app = makeApp();
      const env = makeEnv();
      mockGitHub([
        { email: "victim@example.com", primary: true, verified: false },
        { email: "attacker@example.com", primary: false, verified: true },
      ]);

      const res = await callback(app, env, "github");

      expect(res.status).toBe(302);
      // Only the verified address is ever handed to the lookup, so an
      // unverified one can neither match nor link an existing account.
      expect(signInGitHubUser).toHaveBeenCalledWith(
        env.DB,
        expect.objectContaining({ email: "attacker@example.com" }),
        expect.anything(),
      );
      expect(signInGitHubUser).not.toHaveBeenCalledWith(
        env.DB,
        expect.objectContaining({ email: "victim@example.com" }),
        expect.anything(),
      );
      expect(pendingRecord(env, cookieValue(res, "stratum_pending_signup") ?? "")).toMatchObject({
        email: "attacker@example.com",
      });
    });

    it("still signs an existing account straight in", async () => {
      const app = makeApp();
      const env = makeEnv();
      mockGitHub([{ email: "octo@example.com", primary: true, verified: true }]);
      vi.mocked(getUserByGitHubId).mockResolvedValue({ success: true, data: user() });
      vi.mocked(signInGitHubUser).mockResolvedValue({ success: true, data: user() });

      const res = await callback(app, env, "github");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");
      expect(cookieValue(res, "stratum_session")).toBe("sess_1");
      expect(cookieValue(res, "stratum_pending_signup")).toBeUndefined();
      expect(createUser).not.toHaveBeenCalled();
    });

    it("links an existing account found by verified email rather than asking for a name", async () => {
      const app = makeApp();
      const env = makeEnv();
      mockGitHub([{ email: "octo@example.com", primary: true, verified: true }]);
      vi.mocked(getUserByEmail).mockResolvedValue({ success: true, data: user() });
      vi.mocked(signInGitHubUser).mockResolvedValue({ success: true, data: user() });

      const res = await callback(app, env, "github");

      expect(res.headers.get("Location")).toBe("/");
      expect(signInGitHubUser).toHaveBeenCalledWith(
        env.DB,
        { githubId: "12345", email: "octo@example.com", username: "Octo_Cat" },
        expect.anything(),
      );
      expect(cookieValue(res, "stratum_pending_signup")).toBeUndefined();
    });
  });

  describe("Google callback", () => {
    it("parks a first-time identity with a name suggested from the email", async () => {
      const app = makeApp();
      const env = makeEnv();
      mockGoogle("Jane.Doe+work@example.com");

      const res = await callback(app, env, "google");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(COMPLETE);
      const token = cookieValue(res, "stratum_pending_signup") ?? "";
      expect(pendingRecord(env, token)).toMatchObject({
        provider: "google",
        email: "Jane.Doe+work@example.com",
        suggestedUsername: "janedoework",
      });
      expect(pendingRecord(env, token).github).toBeUndefined();
      expect(createUser).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
    });

    it("still signs an existing account straight in", async () => {
      const app = makeApp();
      const env = makeEnv();
      mockGoogle("octo@example.com");
      vi.mocked(getUserByEmail).mockResolvedValue({ success: true, data: user() });

      const res = await callback(app, env, "google");

      expect(res.status).toBe(302);
      expect(cookieValue(res, "stratum_session")).toBe("sess_1");
      expect(cookieValue(res, "stratum_pending_signup")).toBeUndefined();
    });
  });

  describe("GET the form", () => {
    it("sends a visitor with nothing parked back to signup", async () => {
      const app = makeApp();
      const env = makeEnv();

      const res = await app.fetch(new Request(`http://localhost${COMPLETE}`), env);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/auth/signup?error=signup_expired");
    });

    it("treats a cookie whose record has expired the same way, and clears it", async () => {
      const app = makeApp();
      const env = makeEnv();

      const res = await app.fetch(
        new Request(`http://localhost${COMPLETE}`, {
          headers: { Cookie: `stratum_pending_signup=${"b".repeat(64)}` },
        }),
        env,
      );

      expect(res.headers.get("Location")).toBe("/auth/signup?error=signup_expired");
      expect(cookieLine(res, "stratum_pending_signup")).toContain("Max-Age=0");
    });

    it("sends a signed-in visitor with nothing parked home instead", async () => {
      const app = makeApp();
      const env = makeEnv();
      vi.mocked(getSession).mockResolvedValue({
        success: true,
        data: { id: "sess_1", userId: "usr_new", expiresAt: "2099-01-01T00:00:00.000Z" },
      });

      const res = await app.fetch(
        new Request(`http://localhost${COMPLETE}`, {
          headers: { Cookie: "stratum_session=sess_1" },
        }),
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");
    });

    it("renders the form prefilled with the suggestion and the verified email", async () => {
      const app = makeApp();
      const env = makeEnv();
      const token = park(env, GITHUB_RECORD);

      const res = await app.fetch(
        new Request(`http://localhost${COMPLETE}`, {
          headers: { Cookie: `stratum_pending_signup=${token}` },
        }),
        env,
      );

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('value="octo-cat"');
      expect(html).toContain("octo@example.com");
      expect(html).toContain("GitHub");
      expect(html).toContain("@Octo_Cat");
      expect(html).toContain("fixed while you own projects");
      expect(html).not.toContain('name="inviteCode"');
    });

    it("keeps what the user typed over the suggestion after an error", async () => {
      const app = makeApp();
      const env = makeEnv();
      const token = park(env, GITHUB_RECORD);

      const res = await app.fetch(
        new Request(`http://localhost${COMPLETE}?error=username_taken&username=octo`, {
          headers: { Cookie: `stratum_pending_signup=${token}` },
        }),
        env,
      );

      const html = await res.text();
      expect(html).toContain('value="octo"');
      expect(html).not.toContain('value="octo-cat"');
      expect(html).toContain("already taken");
    });

    it("escapes a hostile username echoed back from the query", async () => {
      const app = makeApp();
      const env = makeEnv();
      const token = park(env, GITHUB_RECORD);

      const res = await app.fetch(
        new Request(
          `http://localhost${COMPLETE}?error=invalid_username&username=${encodeURIComponent('"><script>x</script>')}`,
          { headers: { Cookie: `stratum_pending_signup=${token}` } },
        ),
        env,
      );

      const html = await res.text();
      expect(html).not.toContain("<script>x</script>");
      expect(html).toContain("&quot;&gt;&lt;script&gt;");
    });

    it("asks for an invite code while the beta gate is on", async () => {
      const app = makeApp();
      const env = makeEnv();
      vi.mocked(betaGateEnabled).mockReturnValue(true);
      const token = park(env, GITHUB_RECORD);

      const res = await app.fetch(
        new Request(`http://localhost${COMPLETE}`, {
          headers: { Cookie: `stratum_pending_signup=${token}` },
        }),
        env,
      );

      expect(await res.text()).toContain('name="inviteCode"');
    });
  });

  describe("POST the form", () => {
    it("rejects a cross-site submission before touching the parked record", async () => {
      const app = makeApp();
      const env = makeEnv();
      const token = park(env, GITHUB_RECORD);

      const res = await post(app, env, token, { username: "chosen" }, {});

      expect(res.status).toBe(403);
      expect(kvOf(env).store.has(`pending_signup:${token}`)).toBe(true);
      expect(createUser).not.toHaveBeenCalled();
    });

    it("sends a submission with nothing parked back to signup", async () => {
      const app = makeApp();
      const env = makeEnv();

      const res = await post(app, env, undefined, { username: "chosen" });

      expect(res.headers.get("Location")).toBe("/auth/signup?error=signup_expired");
      expect(createUser).not.toHaveBeenCalled();
    });

    it("treats a re-submission from a browser that is already signed in as done", async () => {
      const app = makeApp();
      const env = makeEnv();
      vi.mocked(getSession).mockResolvedValue({
        success: true,
        data: { id: "sess_1", userId: "usr_new", expiresAt: "2099-01-01T00:00:00.000Z" },
      });

      const res = await post(
        app,
        env,
        undefined,
        { username: "chosen" },
        { Origin: "http://localhost", Cookie: "stratum_session=sess_1" },
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");
      expect(cookieLine(res, "stratum_pending_signup")).toContain("Max-Age=0");
      expect(createUser).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
    });

    it("still reports an expired signup when the session cookie is stale", async () => {
      const app = makeApp();
      const env = makeEnv();
      vi.mocked(getSession).mockResolvedValue({
        success: true,
        data: { id: "sess_1", userId: "usr_new", expiresAt: "2000-01-01T00:00:00.000Z" },
      });

      const res = await post(
        app,
        env,
        undefined,
        { username: "chosen" },
        { Origin: "http://localhost", Cookie: "stratum_session=sess_1" },
      );

      expect(res.headers.get("Location")).toBe("/auth/signup?error=signup_expired");
      expect(createUser).not.toHaveBeenCalled();
    });

    it("creates the account under the chosen name, links GitHub, and signs in", async () => {
      const app = makeApp();
      const env = makeEnv();
      const token = park(env, { ...GITHUB_RECORD, next: "/p/demo" });

      const res = await post(app, env, token, { username: "Chosen ", rememberMe: "true" });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/p/demo");
      expect(createUser).toHaveBeenCalledWith(
        env.DB,
        "octo@example.com",
        expect.anything(),
        "chosen",
      );
      expect(linkGitHub).toHaveBeenCalledWith(
        env.DB,
        "usr_new",
        "12345",
        "Octo_Cat",
        expect.anything(),
      );
      expect(createSession).toHaveBeenCalledWith(env.DB, "usr_new", expect.anything(), true);
      expect(cookieLine(res, "stratum_session")).toContain("stratum_session=sess_1");
      expect(cookieLine(res, "stratum_session")).toContain("Max-Age=2592000");
      // The parked record is spent, on both sides.
      expect(kvOf(env).store.has(`pending_signup:${token}`)).toBe(false);
      expect(cookieLine(res, "stratum_pending_signup")).toContain("Max-Age=0");
      expect(admitAndDeliverCodes).not.toHaveBeenCalled();
    });

    it("creates a Google account without any GitHub link and lands on the dashboard", async () => {
      const app = makeApp();
      const env = makeEnv();
      const token = park(env, {
        provider: "google",
        email: "jane@example.com",
        suggestedUsername: "jane",
        createdAt: 0,
      });

      const res = await post(app, env, token, { username: "jane" });

      expect(res.headers.get("Location")).toBe("/");
      expect(createUser).toHaveBeenCalledWith(
        env.DB,
        "jane@example.com",
        expect.anything(),
        "jane",
      );
      expect(linkGitHub).not.toHaveBeenCalled();
      // No "keep me signed in": a one-day cookie, as with a magic link.
      expect(cookieLine(res, "stratum_session")).toContain("Max-Age=86400");
      expect(createSession).toHaveBeenCalledWith(env.DB, "usr_new", expect.anything(), false);
    });

    it("prefers the remembered post-login destination when no `next` was carried", async () => {
      const app = makeApp();
      const env = makeEnv();
      const token = park(env, GITHUB_RECORD);

      const res = await post(
        app,
        env,
        token,
        { username: "chosen" },
        {
          Origin: "http://localhost",
          Cookie: `stratum_pending_signup=${token}; redirect_after_login=%2Foauth%2Fauthorize%3Fx%3D1`,
        },
      );

      expect(res.headers.get("Location")).toBe("/oauth/authorize?x=1");
      expect(cookieLine(res, "redirect_after_login")).toContain("Max-Age=0");
    });

    it("bounces an invalid name back to the form with what was typed", async () => {
      const app = makeApp();
      const env = makeEnv();
      const token = park(env, GITHUB_RECORD);

      const res = await post(app, env, token, { username: "-nope" });

      expect(res.headers.get("Location")).toBe(`${COMPLETE}?error=invalid_username&username=-nope`);
      expect(createUser).not.toHaveBeenCalled();
      expect(kvOf(env).store.has(`pending_signup:${token}`)).toBe(true);
    });

    it("bounces a taken name back to the form and keeps the record for another try", async () => {
      const app = makeApp();
      const env = makeEnv();
      const token = park(env, GITHUB_RECORD);
      vi.mocked(getUserByUsername).mockResolvedValue({ success: true, data: user() });

      const res = await post(app, env, token, { username: "octo" });

      expect(res.headers.get("Location")).toBe(`${COMPLETE}?error=username_taken&username=octo`);
      expect(createUser).not.toHaveBeenCalled();
      expect(kvOf(env).store.has(`pending_signup:${token}`)).toBe(true);
    });

    it("reports a failed insert without spending the record", async () => {
      const app = makeApp();
      const env = makeEnv();
      const token = park(env, GITHUB_RECORD);
      vi.mocked(createUser).mockResolvedValue(notFound);

      const res = await post(app, env, token, { username: "chosen" });

      expect(res.headers.get("Location")).toBe(`${COMPLETE}?error=signup_failed&username=chosen`);
      expect(createSession).not.toHaveBeenCalled();
      expect(kvOf(env).store.has(`pending_signup:${token}`)).toBe(true);
    });

    it("signs in instead of duplicating when the email was registered meanwhile", async () => {
      const app = makeApp();
      const env = makeEnv();
      const token = park(env, GITHUB_RECORD);
      vi.mocked(getUserByEmail).mockResolvedValue({ success: true, data: user({ id: "usr_1" }) });

      const res = await post(app, env, token, { username: "chosen" });

      expect(res.status).toBe(302);
      expect(createUser).not.toHaveBeenCalled();
      expect(linkGitHub).toHaveBeenCalledWith(
        env.DB,
        "usr_1",
        "12345",
        "Octo_Cat",
        expect.anything(),
      );
      expect(createSession).toHaveBeenCalledWith(env.DB, "usr_1", expect.anything(), false);
      expect(kvOf(env).store.has(`pending_signup:${token}`)).toBe(false);
    });

    it("ignores a malformed pending cookie", async () => {
      const app = makeApp();
      const env = makeEnv();
      park(env, GITHUB_RECORD);

      const res = await post(app, env, "../not-a-token", { username: "chosen" });

      expect(res.headers.get("Location")).toBe("/auth/signup?error=signup_expired");
      expect(createUser).not.toHaveBeenCalled();
    });

    describe("under the closed beta", () => {
      beforeEach(() => {
        vi.mocked(betaGateEnabled).mockReturnValue(true);
      });

      it("requires an invite code", async () => {
        const app = makeApp();
        const env = makeEnv();
        const token = park(env, GITHUB_RECORD);

        const res = await post(app, env, token, { username: "chosen" });

        expect(res.headers.get("Location")).toBe(
          `${COMPLETE}?error=invite_required&username=chosen`,
        );
        expect(validateInviteCode).not.toHaveBeenCalled();
        expect(createUser).not.toHaveBeenCalled();
      });

      it("rejects a code the referral service refuses", async () => {
        const app = makeApp();
        const env = makeEnv();
        const token = park(env, GITHUB_RECORD);
        vi.mocked(validateInviteCode).mockResolvedValue({ valid: false, referrerUserId: null });

        const res = await post(app, env, token, { username: "chosen", inviteCode: "nope1" });

        expect(res.headers.get("Location")).toBe(
          `${COMPLETE}?error=invalid_invite&username=chosen`,
        );
        expect(validateInviteCode).toHaveBeenCalledWith(env, "NOPE1", expect.anything());
        expect(createUser).not.toHaveBeenCalled();
      });

      it("creates the account and redeems the code once it is accepted", async () => {
        const app = makeApp();
        const env = makeEnv();
        const token = park(env, {
          provider: "google",
          email: "jane@example.com",
          suggestedUsername: "jane",
          createdAt: 0,
        });
        vi.mocked(validateInviteCode).mockResolvedValue({ valid: true, referrerUserId: "usr_ref" });

        const res = await post(app, env, token, { username: "jane", inviteCode: " abc12 " });

        expect(res.status).toBe(302);
        expect(createUser).toHaveBeenCalledWith(
          env.DB,
          "jane@example.com",
          expect.anything(),
          "jane",
        );
        expect(admitAndDeliverCodes).toHaveBeenCalledWith(
          env,
          {
            userId: "usr_new",
            email: "jane@example.com",
            inviteCode: "ABC12",
            source: "google_oauth",
          },
          expect.anything(),
        );
        expect(cookieValue(res, "stratum_session")).toBe("sess_1");
      });

      it("lets an already-registered email sign in without a code", async () => {
        const app = makeApp();
        const env = makeEnv();
        const token = park(env, GITHUB_RECORD);
        vi.mocked(getUserByEmail).mockResolvedValue({ success: true, data: user() });

        const res = await post(app, env, token, { username: "chosen" });

        expect(res.status).toBe(302);
        expect(cookieValue(res, "stratum_session")).toBe("sess_1");
        expect(validateInviteCode).not.toHaveBeenCalled();
        expect(createUser).not.toHaveBeenCalled();
      });
    });
  });
});
