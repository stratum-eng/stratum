/**
 * The closed-beta gate, exercised end-to-end across the SSO paths.
 *
 * `tests/beta-gate.test.ts` covers the gate helpers and `tests/oauth-signup.test.ts`
 * covers the username form — but that suite mocks `src/beta/gate` wholesale, so
 * neither answers the question an operator actually asks: with BETA_GATE on, can
 * a GitHub or Google identity reach an account without a redeemable code?
 *
 * These tests run the real gate against a stubbed referral service and drive the
 * whole flow (callback → parked identity → form POST), asserting on the one thing
 * that matters: whether `createUser` was called. Storage is mocked, everything
 * else is production code.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authRouter } from "../src/routes/auth";
import { COMPLETE_SIGNUP_PATH, oauthSignupRouter } from "../src/routes/oauth-signup";
import type { Env, User } from "../src/types";
import { makeFakeKV } from "./helpers/fake-kv";

// The shared `@name` namespace check has its own tests; here every name is free.
vi.mock("../src/storage/project-namespace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage/project-namespace")>()),
  usernameNamespaceTaken: vi.fn(async () => ({ success: true, data: false })),
}));

vi.mock("../src/storage/users", () => ({
  createUser: vi.fn(),
  // Read by the analytics capture on a completed signup.
  getUser: vi.fn(async () => ({ success: false, error: new Error("not found") })),
  getUserByEmail: vi.fn(),
  getUserByUsername: vi.fn(),
  linkGitHub: vi.fn(),
  signInGitHubUser: vi.fn(),
}));

// No passkeys: this suite exercises primary sign-in, not the second factor
// (#256), and its DB is a stub the passkey lookup cannot read.
vi.mock("../src/storage/webauthn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage/webauthn")>()),
  countPasskeys: vi.fn(async () => ({ success: true, data: 0 })),
}));
vi.mock("../src/storage/sessions", () => ({
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("../src/storage/audit", () => ({
  recordAudit: vi.fn().mockResolvedValue({ success: true, data: undefined }),
}));

// No linked (issuer, subject) identity: Google sign-in falls through to the
// verified-email match these tests exercise (#253).
vi.mock("../src/storage/identities", async () => {
  const { NotFoundError } = await import("../src/utils/errors");
  return {
    getIdentityByIssuerSubject: vi.fn(async () => ({
      success: false,
      error: new NotFoundError("Identity", "none"),
    })),
    upsertIdentity: vi.fn(async () => ({ success: true, data: undefined })),
  };
});

import { createSession, getSession } from "../src/storage/sessions";
import {
  createUser,
  getUserByEmail,
  getUserByUsername,
  linkGitHub,
  signInGitHubUser,
} from "../src/storage/users";

const notFound = { success: false as const, error: new Error("not found") as never };

const CREATED_USER: User = {
  id: "usr_new",
  email: "octo@example.com",
  username: "chosen",
  tokenHash: "h",
  createdAt: "",
};

const fetchMock = vi.fn();
/** Every code the stubbed referral service will call redeemable. */
let validCodes = new Set<string>();
/** Bodies posted to /api/referral/admit, so a redemption can be asserted. */
let admissions: Record<string, unknown>[] = [];

/**
 * Only the two routers under test, mounted where production mounts them. The
 * complete-form path matters: the pending-signup cookie is scoped to `/auth`,
 * so a form mounted anywhere else would never receive it.
 */
function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/auth", authRouter);
  app.route(COMPLETE_SIGNUP_PATH, oauthSignupRouter);
  return app;
}

/** The gate is ON: both switches set, pointed at the stubbed service. */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    STATE: makeFakeKV(),
    DB: {} as D1Database,
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret",
    OAUTH_REDIRECT_URI: "https://app.example.com/auth/github/callback",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    GOOGLE_REDIRECT_URI: "https://app.example.com/auth/google/callback",
    BETA_GATE: "1",
    REFERRAL_SERVICE_URL: "https://referral.example.com",
    REFERRAL_SERVICE_SECRET: "s3cret",
    ...overrides,
  } as Env;
}

type KV = ReturnType<typeof makeFakeKV>;

/** The provider APIs, plus the referral service the real gate calls. */
function stubUpstreams(email = "octo@example.com") {
  fetchMock.mockImplementation(async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "gh-token" }), { status: 200 });
    }
    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify({ id: 12345, login: "Octo_Cat" }), { status: 200 });
    }
    if (url === "https://api.github.com/user/emails") {
      return new Response(JSON.stringify([{ email, primary: true, verified: true }]), {
        status: 200,
      });
    }
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "google-token" }), { status: 200 });
    }
    if (url.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
      return new Response(JSON.stringify({ sub: "g-1", email, email_verified: true }), {
        status: 200,
      });
    }
    if (url === "https://referral.example.com/api/referral/validate") {
      const body = JSON.parse(String(init?.body)) as { code: string };
      return new Response(
        JSON.stringify({ valid: validCodes.has(body.code), referrerUserId: "usr_ref" }),
        { status: 200 },
      );
    }
    if (url === "https://referral.example.com/api/referral/admit") {
      admissions.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ codes: ["A", "B", "C", "D", "E"] }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

/** Run a provider callback for a first-time identity; returns the parked token. */
async function park(
  app: Hono<{ Bindings: Env }>,
  env: Env,
  provider: "github" | "google",
): Promise<string> {
  (env.STATE as KV).store.set("oauth_state:goodstate", "1");
  const res = await app.fetch(
    new Request(`http://localhost/auth/${provider}/callback?code=ok&state=goodstate`, {
      headers: { Cookie: "stratum_oauth_state=goodstate" },
    }),
    env,
  );
  expect(res.headers.get("Location")).toBe(COMPLETE_SIGNUP_PATH);
  const token = (res.headers as unknown as { getSetCookie(): string[] })
    .getSetCookie()
    .find((line) => line.startsWith("stratum_pending_signup="))
    ?.split(";")[0]
    ?.split("=")[1];
  if (!token) throw new Error("callback parked no identity");
  return token;
}

/**
 * Submit the username form for a parked identity. The `Origin` header is not
 * decoration: no session exists yet, so the POST guards itself with an explicit
 * same-origin check and refuses without it.
 */
function complete(
  app: Hono<{ Bindings: Env }>,
  env: Env,
  token: string,
  fields: Record<string, string>,
) {
  return app.fetch(
    new Request(`http://localhost${COMPLETE_SIGNUP_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "http://localhost",
        Cookie: `stratum_pending_signup=${token}`,
      },
      body: new URLSearchParams(fields),
    }),
    env,
  );
}

describe("closed-beta gate: SSO signup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    validCodes = new Set(["GOODCODE1"]);
    admissions = [];
    stubUpstreams();
    vi.mocked(getUserByEmail).mockResolvedValue(notFound);
    vi.mocked(getUserByUsername).mockResolvedValue(notFound);
    vi.mocked(getSession).mockResolvedValue(notFound);
    vi.mocked(signInGitHubUser).mockResolvedValue({ success: true, data: null });
    vi.mocked(linkGitHub).mockResolvedValue({ success: true, data: undefined });
    vi.mocked(createUser).mockResolvedValue({
      success: true,
      data: { user: CREATED_USER, plaintext: "stratum_user_x" },
    });
    vi.mocked(createSession).mockResolvedValue({
      success: true,
      data: { id: "sess_1", userId: "usr_new", expiresAt: "2099-01-01T00:00:00.000Z" },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const provider of ["github", "google"] as const) {
    describe(provider, () => {
      it("creates no account when the form omits an invite code", async () => {
        const app = makeApp();
        const env = makeEnv();
        const token = await park(app, env, provider);

        const res = await complete(app, env, token, { username: "chosen" });

        expect(res.headers.get("Location")).toBe(
          `${COMPLETE_SIGNUP_PATH}?error=invite_required&username=chosen`,
        );
        expect(createUser).not.toHaveBeenCalled();
        expect(createSession).not.toHaveBeenCalled();
      });

      it("creates no account for a code the service will not redeem", async () => {
        const app = makeApp();
        const env = makeEnv();
        const token = await park(app, env, provider);

        const res = await complete(app, env, token, {
          username: "chosen",
          inviteCode: "NOTACODE1",
        });

        expect(res.headers.get("Location")).toBe(
          `${COMPLETE_SIGNUP_PATH}?error=invalid_invite&username=chosen`,
        );
        expect(createUser).not.toHaveBeenCalled();
      });

      it("creates no account when the referral service is unreachable (fails closed)", async () => {
        const app = makeApp();
        const env = makeEnv();
        const token = await park(app, env, provider);
        fetchMock.mockImplementation(async (input: string | Request) => {
          const url = typeof input === "string" ? input : input.url;
          if (url.includes("/api/referral/")) throw new Error("service down");
          throw new Error(`Unexpected fetch: ${url}`);
        });

        const res = await complete(app, env, token, {
          username: "chosen",
          inviteCode: "GOODCODE1",
        });

        expect(res.headers.get("Location")).toBe(
          `${COMPLETE_SIGNUP_PATH}?error=invalid_invite&username=chosen`,
        );
        expect(createUser).not.toHaveBeenCalled();
      });

      it("admits a redeemable code, and records the redemption", async () => {
        const app = makeApp();
        const env = makeEnv();
        const token = await park(app, env, provider);

        const res = await complete(app, env, token, {
          username: "chosen",
          inviteCode: " goodcode1 ",
        });

        expect(res.status).toBe(302);
        expect(res.headers.get("Location")).toBe("/");
        expect(createUser).toHaveBeenCalledWith(
          env.DB,
          "octo@example.com",
          expect.anything(),
          "chosen",
        );
        expect(admissions).toEqual([
          {
            userId: "usr_new",
            email: "octo@example.com",
            code: "GOODCODE1",
            source: `${provider}_oauth`,
          },
        ]);
      });
    });
  }

  it("never creates an account straight from the GitHub callback", async () => {
    const app = makeApp();
    const env = makeEnv();

    await park(app, env, "github");

    // The callback resolves the identity and stops. Account creation for every
    // signup method lives behind the one gated form.
    expect(signInGitHubUser).toHaveBeenCalledOnce();
    expect(createUser).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("still signs an existing account in without a code (a sign-in, not a signup)", async () => {
    const app = makeApp();
    const env = makeEnv();
    vi.mocked(signInGitHubUser).mockResolvedValue({
      success: true,
      data: { ...CREATED_USER, id: "usr_existing" },
    });
    (env.STATE as KV).store.set("oauth_state:goodstate", "1");

    const res = await app.fetch(
      new Request("http://localhost/auth/github/callback?code=ok&state=goodstate", {
        headers: { Cookie: "stratum_oauth_state=goodstate" },
      }),
      env,
    );

    expect(res.headers.get("Location")).toBe("/");
    expect(createUser).not.toHaveBeenCalled();
  });

  it("asks no invite code once the gate is switched off", async () => {
    const app = makeApp();
    const env = makeEnv({ BETA_GATE: "0" });
    const token = await park(app, env, "github");

    const res = await complete(app, env, token, { username: "chosen" });

    expect(res.headers.get("Location")).toBe("/");
    expect(createUser).toHaveBeenCalled();
    expect(admissions).toEqual([]);
  });
});
