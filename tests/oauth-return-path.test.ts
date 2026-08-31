import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authRouter } from "../src/routes/auth";
import type { Env } from "../src/types";
import { isSafeRedirectTarget } from "../src/utils/post-login-redirect";
import { makeFakeKV } from "./helpers/fake-kv";

vi.mock("../src/storage/users", () => ({
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

import { createSession } from "../src/storage/sessions";
import { getUserByEmail, signInGitHubUser } from "../src/storage/users";

const fetchMock = vi.fn();

const USER = {
  id: "usr_1",
  email: "user@example.com",
  username: "user",
  tokenHash: "h",
  createdAt: "",
};

// Every shape here passes a naive "starts with one slash" check or is
// otherwise read by a browser as pointing off-origin. The dot-segment ones
// are the subtle case: they are same-origin as written, but URL parsing
// normalizes them to a protocol-relative `//evil.example`.
const OFF_ORIGIN = [
  "https://evil.example/pwn",
  "http://evil.example",
  "//evil.example/pwn",
  "/\\evil.example/pwn",
  "\\\\evil.example",
  "/\t/evil.example",
  "/.//evil.example/pwn",
  "/..//evil.example",
  "/a/..//evil.example",
  "/%2e//evil.example",
  "/./\\evil.example",
  "javascript:alert(1)",
  "settings",
];

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/auth", authRouter);
  return app;
}

function makeEnv(state: KVNamespace): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: state,
    DB: {} as D1Database,
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret",
    OAUTH_REDIRECT_URI: "https://app.example.com/auth/github/callback",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    GOOGLE_REDIRECT_URI: "https://app.example.com/auth/google/callback",
  } as Env;
}

/** The `state` an authorize redirect minted, read back off its Location header. */
function stateFrom(res: Response): string {
  const location = res.headers.get("Location") ?? "";
  const state = new URL(location).searchParams.get("state");
  if (!state) throw new Error(`No state in ${location}`);
  return state;
}

function mockGoogleIdentity() {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    }
    if (url.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
      return new Response(
        JSON.stringify({ sub: "g-1", email: "user@example.com", email_verified: true }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.mocked(getUserByEmail).mockResolvedValue({ success: true, data: USER });
}

function mockGitHubIdentity() {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    }
    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify({ id: 42, login: "octocat" }), { status: 200 });
    }
    if (url === "https://api.github.com/user/emails") {
      return new Response(
        JSON.stringify([{ email: "user@example.com", primary: true, verified: true }]),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.mocked(signInGitHubUser).mockResolvedValue({ success: true, data: USER });
}

const PROVIDERS = [
  ["github", mockGitHubIdentity],
  ["google", mockGoogleIdentity],
] as const;

describe("isSafeRedirectTarget", () => {
  it.each(["/settings", "/p/acme/web?tab=changes", "/p/demo#files"])("accepts %s", (target) => {
    expect(isSafeRedirectTarget(target, "https://app.example.com/auth/github")).toBe(true);
  });

  it.each(OFF_ORIGIN)("rejects %s", (target) => {
    expect(isSafeRedirectTarget(target, "https://app.example.com/auth/github")).toBe(false);
  });
});

describe("OAuth post-login return path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(createSession).mockResolvedValue({
      success: true,
      data: { id: "sess_1", userId: "usr_1", expiresAt: "2099-01-01T00:00:00.000Z" },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The destination cannot ride the URL: an authorization server echoes back
  // only `code` and `state`, so it has to be carried by the state record.
  it.each(PROVIDERS)("returns a %s sign-in to the page it started from", async (provider, mock) => {
    mock();
    const kv = makeFakeKV();
    const env = makeEnv(kv);
    const app = makeApp();

    const start = await app.fetch(
      new Request(`http://localhost/auth/${provider}?next=%2Fp%2Facme%2Fweb%3Ftab%3D1`),
      env,
    );
    const state = stateFrom(start);
    expect(start.headers.get("Location")).not.toContain("next");
    expect(kv.store.get(`oauth_state:${state}`)).toBe(
      JSON.stringify({ next: "/p/acme/web?tab=1" }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/${provider}/callback?code=ok&state=${state}`, {
        headers: { Cookie: `stratum_oauth_state=${state}` },
      }),
      env,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/p/acme/web?tab=1");
  });

  it.each(PROVIDERS)("sends a %s sign-in that asked for nothing home", async (provider, mock) => {
    mock();
    const kv = makeFakeKV();
    const env = makeEnv(kv);
    const app = makeApp();

    const state = stateFrom(await app.fetch(new Request(`http://localhost/auth/${provider}`), env));
    expect(kv.store.get(`oauth_state:${state}`)).toBe("1");

    const res = await app.fetch(
      new Request(`http://localhost/auth/${provider}/callback?code=ok&state=${state}`, {
        headers: { Cookie: `stratum_oauth_state=${state}` },
      }),
      env,
    );

    expect(res.headers.get("Location")).toBe("/");
  });

  // An open redirect out of the sign-in flow is a credible phishing primitive:
  // the victim lands on the attacker's page having just authenticated for real.
  describe.each(PROVIDERS)("%s", (provider, mock) => {
    it.each(OFF_ORIGIN)("never redirects off-origin for next=%s", async (next) => {
      mock();
      const kv = makeFakeKV();
      const env = makeEnv(kv);
      const app = makeApp();

      const start = await app.fetch(
        new Request(`http://localhost/auth/${provider}?next=${encodeURIComponent(next)}`),
        env,
      );
      const state = stateFrom(start);
      expect(kv.store.get(`oauth_state:${state}`)).toBe("1");

      const res = await app.fetch(
        new Request(`http://localhost/auth/${provider}/callback?code=ok&state=${state}`, {
          headers: { Cookie: `stratum_oauth_state=${state}` },
        }),
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/");
    });
  });
});
