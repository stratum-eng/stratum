import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authRouter } from "../src/routes/auth";
import { emailAuthRouter } from "../src/routes/email-auth";
import { recordAudit } from "../src/storage/audit";
import type { UpsertIdentityInput } from "../src/storage/identities";
import { upsertIdentity } from "../src/storage/identities";
import type { Env, User } from "../src/types";
import { NotFoundError } from "../src/utils/errors";
import type { Logger } from "../src/utils/logger";
import { makeMagicLinkLimiters } from "./helpers/magic-link-limiter";

// ============================================================================
// Mocks
// ============================================================================

const mockUsers = new Map<string, User>();
let mockUserIdCounter = 0;

// The shared `@name` namespace check has its own tests; here every name is free.
vi.mock("../src/storage/project-namespace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage/project-namespace")>()),
  usernameNamespaceTaken: vi.fn(async () => ({ success: true, data: false })),
}));

vi.mock("../src/storage/users", () => {
  // Use a function to get the mockUsers map lazily to avoid issues with test isolation
  const getMockUsers = () => {
    try {
      return mockUsers;
    } catch {
      // If mockUsers is not defined (other test files), return an empty map
      return new Map<string, User>();
    }
  };

  const _getMockUserIdCounter = () => {
    try {
      return mockUserIdCounter;
    } catch {
      return 0;
    }
  };

  const incrementMockUserIdCounter = () => {
    try {
      mockUserIdCounter++;
      return mockUserIdCounter;
    } catch {
      return 1;
    }
  };

  return {
    createUser: vi.fn(async (_db, email: string, _logger, preferredUsername?: string) => {
      const users = getMockUsers();
      const existingByEmail = users.get(`email:${email}`);
      if (existingByEmail) {
        throw new Error("UNIQUE constraint failed: users.email");
      }

      const username =
        preferredUsername || (email.split("@")[0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const existingByUsername = users.get(`username:${username}`);
      if (existingByUsername) {
        throw new Error("UNIQUE constraint failed: users.username");
      }

      const counter = incrementMockUserIdCounter();
      const user: User = {
        id: `usr_${counter.toString(36)}`,
        email,
        username,
        tokenHash: `hash_${counter}`,
        createdAt: new Date().toISOString(),
      };

      users.set(`email:${email}`, user);
      users.set(`username:${username}`, user);
      users.set(`id:${user.id}`, user);

      return {
        success: true,
        data: {
          user,
          plaintext: `stratum_user_${counter}`,
        },
      };
    }),

    getUserByEmail: vi.fn(async (_db, email: string) => {
      const users = getMockUsers();
      const user = users.get(`email:${email}`);
      if (!user) {
        return { success: false, error: new NotFoundError("User", email) };
      }
      return { success: true, data: user };
    }),

    getUserByGitHubId: vi.fn(async (_db, githubId: string) => {
      const users = getMockUsers();
      for (const user of users.values()) {
        if (user.githubId === githubId) {
          return { success: true, data: user };
        }
      }
      return { success: false, error: new NotFoundError("User", githubId) };
    }),

    getUserByUsername: vi.fn(async (_db, username: string) => {
      const users = getMockUsers();
      const user = users.get(`username:${username.toLowerCase()}`);
      if (!user) {
        return { success: false, error: new NotFoundError("User", username) };
      }
      return { success: true, data: user };
    }),

    // Mirrors production: matches, links — and creates nothing. A GitHub
    // identity with no account comes back as null so the callback parks it for
    // the (invite-gated) username form.
    signInGitHubUser: vi.fn(async (_db, opts, _logger) => {
      const users = getMockUsers();
      // Check if user exists by GitHub ID first
      for (const user of users.values()) {
        if (user.githubId === opts.githubId) {
          return { success: true, data: user };
        }
      }

      // Check if user exists by email
      const existingByEmail = users.get(`email:${opts.email}`);
      if (existingByEmail) {
        // Never link onto a frozen account; return it unlinked so the callback
        // refuses the sign-in.
        if (existingByEmail.disabledAt || existingByEmail.deletingAt) {
          return { success: true, data: existingByEmail };
        }
        // Link GitHub to existing user
        existingByEmail.githubId = opts.githubId;
        existingByEmail.githubUsername = opts.username;
        return { success: true, data: existingByEmail };
      }

      return { success: true, data: null };
    }),
    getUserByToken: vi.fn(),
    getUser: vi.fn(),
    linkGitHub: vi.fn(),
  };
});

// Magic links moved to D1 with atomic consume; model with an in-memory store.
const { magicStore } = vi.hoisted(() => ({ magicStore: new Map<string, unknown>() }));
vi.mock("../src/storage/magic-links", () => ({
  createMagicLink: vi.fn(async (_db: unknown, token: string, payload: unknown) => {
    magicStore.set(token, payload);
    return { success: true, data: undefined };
  }),
  consumeMagicLink: vi.fn(async (_db: unknown, token: string) => {
    if (!magicStore.has(token)) return { success: true, data: null };
    const payload = magicStore.get(token);
    magicStore.delete(token);
    return { success: true, data: payload };
  }),
  // Read without consuming; agent-signup approval peeks before spending a link.
  peekMagicLink: vi.fn(async (_db: unknown, token: string) => ({
    success: true,
    data: magicStore.get(token) ?? null,
  })),
}));

// No passkeys: this suite exercises primary sign-in, not the second factor
// (#256), and its DB is a stub the passkey lookup cannot read.
vi.mock("../src/storage/webauthn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage/webauthn")>()),
  countPasskeys: vi.fn(async () => ({ success: true, data: 0 })),
}));
vi.mock("../src/storage/sessions", () => ({
  createSession: vi.fn(async (_db, userId: string, _logger, _rememberMe = true) => {
    const sessionId = `sess_${crypto.randomUUID().replace(/-/g, "")}`;
    return {
      success: true,
      data: {
        id: sessionId,
        userId,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
    };
  }),
  deleteSession: vi.fn(),
  getSession: vi.fn(),
  getUserSessions: vi.fn(),
  deleteAllUserSessions: vi.fn(),
  refreshSession: vi.fn(),
}));

// Audit is mocked so the disabled-account tests can assert that a refused
// login records NO session.created row.
vi.mock("../src/storage/audit", () => ({
  recordAudit: vi.fn(async () => ({ success: true, data: undefined })),
}));

// Identities are forward-provisioning for SSO: default to "nothing linked yet"
// with successful persistence; tests assert on the upsert calls.
vi.mock("../src/storage/identities", () => ({
  upsertIdentity: vi.fn(async (_db: unknown, _logger: unknown, input: UpsertIdentityInput) => ({
    success: true,
    data: {
      id: "idn_test",
      createdAt: new Date().toISOString(),
      ...input,
      connectionId: input.connectionId ?? null,
    },
  })),
  getIdentityByIssuerSubject: vi.fn(
    async (_db: unknown, _logger: unknown, issuer: string, subject: string) => ({
      success: false,
      error: new NotFoundError("Identity", `${issuer}#${subject}`),
    }),
  ),
}));

// ============================================================================
// Test Helpers
// ============================================================================

function makeKV(): KVNamespace {
  const store = new Map<string, string>();

  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async ({ prefix }: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: "",
    }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

/**
 * A fresh limiter namespace per env, so each test starts from empty counters
 * the way a fresh KV store used to.
 */
function makeLimiterNamespace(): NonNullable<Env["MAGIC_LINK_LIMITER"]> {
  return makeMagicLinkLimiters().namespace;
}

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: makeKV(),
    MAGIC_LINK_LIMITER: makeLimiterNamespace(),
    DB: {} as D1Database,
    EMAIL: {
      send: vi.fn().mockResolvedValue({ messageId: "test-message-id" }),
    },
    EMAIL_FROM_ADDRESS: "noreply@stratum.dev",
    GITHUB_CLIENT_ID: "test-github-client-id",
    GITHUB_CLIENT_SECRET: "test-github-client-secret",
    OAUTH_REDIRECT_URI: "http://localhost:8788/auth/github/callback",
    ...overrides,
  };
}

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/auth/email", emailAuthRouter);
  app.route("/auth", authRouter);
  return app;
}

function request(path: string, options?: RequestInit): Request {
  return new Request(`http://localhost${path}`, options);
}

function createFormData(data: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(data)) {
    formData.append(key, value);
  }
  return formData;
}

// Magic-link verification is now a same-origin POST (the GET only renders a
// confirm page — login-CSRF protection), so consume/login goes through here.
// A real browser sends Origin on the form POST; default to same-origin so the
// endpoint's CSRF guard admits it. Pass a foreign origin to exercise rejection.
function verifyReq(token: string, origin: string | null = "http://localhost"): Request {
  return request("/auth/email/verify", {
    method: "POST",
    body: createFormData({ token }),
    ...(origin ? { headers: { Origin: origin } } : {}),
  });
}

async function extractMagicLinkToken(_env: Env): Promise<string | null> {
  const first = magicStore.keys().next();
  return first.done ? null : (first.value as string);
}

async function getMagicLinkData(_env: Env, token: string): Promise<unknown> {
  return magicStore.get(token) ?? null;
}

// ============================================================================
// Tests
// ============================================================================

describe("Auth Signup/Login Integration Tests", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
    magicStore.clear();
    mockUsers.clear();
    mockUserIdCounter = 0;
  });

  // ============================================================================
  // Username Validation Tests
  // ============================================================================

  describe("Username Validation", () => {
    it("accepts valid simple lowercase username", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("alice");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("alice");
      }
    });

    it("accepts username with numbers", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("alice123");
      expect(result.success).toBe(true);
    });

    it("accepts username with hyphens", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("alice-smith");
      expect(result.success).toBe(true);
    });

    it("accepts username at minimum length", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("abc");
      expect(result.success).toBe(true);
    });

    it("accepts username at maximum length", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const longUsername = "a".repeat(39);
      const result = validateUsername(longUsername);
      expect(result.success).toBe(true);
    });

    it("normalizes uppercase to lowercase", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("AliceSmith");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("alicesmith");
      }
    });

    it("trims whitespace", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("  alice  ");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("alice");
      }
    });

    it("rejects username too short", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("ab");
      expect(result.success).toBe(false);
    });

    it("rejects username too long", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const tooLong = "a".repeat(40);
      const result = validateUsername(tooLong);
      expect(result.success).toBe(false);
    });

    it("rejects username starting with number", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("1alice");
      expect(result.success).toBe(false);
    });

    it("rejects username starting with hyphen", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("-alice");
      expect(result.success).toBe(false);
    });

    it("rejects username ending with hyphen", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("alice-");
      expect(result.success).toBe(false);
    });

    it("rejects username with consecutive hyphens", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("alice--smith");
      expect(result.success).toBe(false);
    });

    it("rejects username with underscores", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("alice_smith");
      expect(result.success).toBe(false);
    });

    it("rejects username with spaces", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("alice smith");
      expect(result.success).toBe(false);
    });

    it("rejects username with special characters", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("alice@smith");
      expect(result.success).toBe(false);
    });

    it("rejects numbers-only username", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("12345");
      expect(result.success).toBe(false);
    });

    it("rejects reserved username 'api'", async () => {
      const { validateUsername, isReservedUsername } = await import(
        "../src/utils/username-validation"
      );
      const result = validateUsername("api");
      expect(result.success).toBe(false);
      expect(isReservedUsername("api")).toBe(true);
    });

    it("rejects reserved username 'admin'", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("admin");
      expect(result.success).toBe(false);
    });

    it("rejects reserved username 'www'", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("www");
      expect(result.success).toBe(false);
    });

    it("rejects reserved username 'test'", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("test");
      expect(result.success).toBe(false);
    });

    it("rejects reserved usernames case-insensitively", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      expect(validateUsername("API").success).toBe(false);
      expect(validateUsername("Admin").success).toBe(false);
      expect(validateUsername("WWW").success).toBe(false);
    });

    it("accepts username containing reserved word as substring", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("myapi");
      expect(result.success).toBe(true);
    });

    it("accepts username with reserved word plus suffix", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("apiuser");
      expect(result.success).toBe(true);
    });

    it("rejects null username", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername(null);
      expect(result.success).toBe(false);
    });

    it("rejects undefined username", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername(undefined);
      expect(result.success).toBe(false);
    });

    it("rejects empty string username", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("");
      expect(result.success).toBe(false);
    });

    it("rejects whitespace-only username", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("   ");
      expect(result.success).toBe(false);
    });

    it("returns multiple errors for severely invalid username", async () => {
      const { validateUsername } = await import("../src/utils/username-validation");
      const result = validateUsername("--123@#$");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.length).toBeGreaterThan(1);
      }
    });

    it("isValidUsername type guard returns true for valid usernames", async () => {
      const { isValidUsername } = await import("../src/utils/username-validation");
      expect(isValidUsername("alice")).toBe(true);
      expect(isValidUsername("alice123")).toBe(true);
      expect(isValidUsername("alice-smith")).toBe(true);
    });

    it("isValidUsername type guard returns false for invalid usernames", async () => {
      const { isValidUsername } = await import("../src/utils/username-validation");
      expect(isValidUsername("ab")).toBe(false);
      expect(isValidUsername("1alice")).toBe(false);
      expect(isValidUsername("api")).toBe(false);
      expect(isValidUsername(123)).toBe(false);
    });
  });

  // ============================================================================
  // Signup Flow Tests
  // ============================================================================

  describe("Signup Flow", () => {
    describe("POST /auth/email/send-signup", () => {
      it("successful signup sends magic link with correct data", async () => {
        const formData = createFormData({
          email: "newuser@example.com",
          username: "newuser",
        });

        const res = await app.fetch(
          request("/auth/email/send-signup", {
            method: "POST",
            body: formData,
          }),
          env,
        );

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("success=email_sent");

        // Verify email was sent
        expect(env.EMAIL?.send).toHaveBeenCalledWith(
          expect.objectContaining({
            to: "newuser@example.com",
            from: { email: "noreply@stratum.dev", name: "Stratum" },
            subject: "Sign in to Stratum",
          }),
        );

        // Verify magic link token was created with correct data
        const token = await extractMagicLinkToken(env);
        expect(token).not.toBeNull();
        if (!token) throw new Error("Token should not be null");

        const tokenData = await getMagicLinkData(env, token);
        expect(tokenData).toMatchObject({
          email: "newuser@example.com",
          username: "newuser",
          intent: "signup",
          rememberMe: false,
        });
        expect((tokenData as Record<string, unknown>).createdAt).toBeDefined();
      });

      it("signup fails if email already exists", async () => {
        const { createUser } = await import("../src/storage/users");
        await createUser(env.DB, "existing@example.com", {} as unknown as Logger, "existinguser");

        const formData = createFormData({
          email: "existing@example.com",
          username: "newusername",
        });

        const res = await app.fetch(
          request("/auth/email/send-signup", {
            method: "POST",
            body: formData,
          }),
          env,
        );

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("error=email_exists");
        expect(env.EMAIL?.send).not.toHaveBeenCalled();
      });

      it("signup fails if username is taken", async () => {
        const { createUser } = await import("../src/storage/users");
        await createUser(env.DB, "user1@example.com", {} as unknown as Logger, "takenusername");

        const formData = createFormData({
          email: "newemail@example.com",
          username: "takenusername",
        });

        const res = await app.fetch(
          request("/auth/email/send-signup", {
            method: "POST",
            body: formData,
          }),
          env,
        );

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("error=username_taken");
        expect(env.EMAIL?.send).not.toHaveBeenCalled();
      });

      it("reports a failed namespace lookup as a failure, not as a taken name", async () => {
        const { usernameNamespaceTaken } = await import("../src/storage/project-namespace");
        vi.mocked(usernameNamespaceTaken).mockResolvedValueOnce({
          success: false,
          error: new Error("kv down") as never,
        });

        const res = await app.fetch(
          request("/auth/email/send-signup", {
            method: "POST",
            body: createFormData({ email: "newemail@example.com", username: "freshname" }),
          }),
          env,
        );

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("error=signup_failed");
        expect(env.EMAIL?.send).not.toHaveBeenCalled();
      });

      it("signup fails with invalid username format", async () => {
        const formData = createFormData({
          email: "newuser@example.com",
          username: "ab",
        });

        const res = await app.fetch(
          request("/auth/email/send-signup", {
            method: "POST",
            body: formData,
          }),
          env,
        );

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("error=invalid_username");
        expect(env.EMAIL?.send).not.toHaveBeenCalled();
      });

      it("signup fails with invalid email format", async () => {
        const formData = createFormData({
          email: "not-an-email",
          username: "validuser",
        });

        const res = await app.fetch(
          request("/auth/email/send-signup", {
            method: "POST",
            body: formData,
          }),
          env,
        );

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("error=invalid_email");
      });

      it("signup fails with reserved username", async () => {
        const formData = createFormData({
          email: "newuser@example.com",
          username: "admin",
        });

        const res = await app.fetch(
          request("/auth/email/send-signup", {
            method: "POST",
            body: formData,
          }),
          env,
        );

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("error=invalid_username");
      });

      it("rate limiting works on signup endpoint", async () => {
        const email = "ratelimit@example.com";

        for (let i = 0; i < 5; i++) {
          const formData = createFormData({
            email,
            username: `user${i}`,
          });

          const res = await app.fetch(
            request("/auth/email/send-signup", {
              method: "POST",
              body: formData,
            }),
            env,
          );

          expect(res.status).toBe(302);
          expect(res.headers.get("location")).toContain("success=email_sent");
        }

        const formData = createFormData({
          email,
          username: "user6",
        });

        const res = await app.fetch(
          request("/auth/email/send-signup", {
            method: "POST",
            body: formData,
          }),
          env,
        );

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("error=rate_limited");
      });

      /**
       * Fail-open is the documented storage-error policy: a reservation that
       * cannot be *attempted* admits the request, because failing closed would
       * turn a transient storage fault into a total login outage.
       *
       * Note what this does not cover. A reservation that succeeds and reports
       * the cap is a real answer, so an exhausted bucket still blocks — the KV
       * counters this replaces admitted there too, but only because a throw on
       * the second read reset the first read's count as well.
       */
      it("fails open when either counter's storage throws", async () => {
        // Each case varies the OTHER dimension, so the healthy counter can
        // never be the one that refuses and the assertion is about the faulty
        // one alone.
        const cases = [
          {
            faulty: "email:",
            email: () => "failopen@example.com",
            ip: (i: number) => `203.0.113.${i}`,
          },
          {
            faulty: "ip:",
            email: (i: number) => `failopen${i}@example.com`,
            ip: () => "203.0.113.40",
          },
        ];

        for (const { faulty, email, ip } of cases) {
          const env = makeEnv();
          const healthy = makeLimiterNamespace();
          env.MAGIC_LINK_LIMITER = {
            idFromName: (name: string) => healthy.idFromName(name),
            get: (id: { toString(): string }) =>
              id.toString().startsWith(faulty)
                ? {
                    reserve: () => Promise.reject(new Error("storage unavailable")),
                    refund: () => Promise.reject(new Error("storage unavailable")),
                  }
                : healthy.get(id as DurableObjectId),
          } as unknown as NonNullable<Env["MAGIC_LINK_LIMITER"]>;

          // Well past both caps: nothing may refuse while a counter is faulty.
          for (let i = 0; i < 25; i++) {
            const res = await app.fetch(
              request("/auth/email/send-signup", {
                method: "POST",
                headers: { "CF-Connecting-IP": ip(i) },
                body: createFormData({ email: email(i), username: `failopen${i}` }),
              }),
              env,
            );
            expect(res.status).toBe(302);
            expect(res.headers.get("location")).not.toContain("error=rate_limited");
          }
        }
      });

      // The per-email bucket keys on a digest of the address. It has to be
      // collision-resistant, not merely opaque: the old 32-bit string hash let
      // an attacker construct a different address landing in a chosen victim's
      // bucket ("cg1@acme.com" for "ceo@acme.com", found in a few thousand
      // tries) and spend the victim's five sends from a distinct source IP, so
      // neither cap noticed. No mail is sent for the collider, which need not
      // even be a real account.
      it("does not let a colliding address consume another address's budget", async () => {
        const victim = "ceo@acme.com";
        const collider = "cg1@acme.com";

        // Burn the collider's five sends, each from its own IP so the per-IP
        // cap plays no part in the outcome.
        for (let i = 0; i < 5; i++) {
          const res = await app.fetch(
            request("/auth/email/send-login", {
              method: "POST",
              headers: { "CF-Connecting-IP": `203.0.113.${20 + i}` },
              body: createFormData({ email: collider }),
            }),
            env,
          );
          expect(res.headers.get("location")).not.toContain("error=rate_limited");
        }

        // The victim's own bucket must be untouched.
        const res = await app.fetch(
          request("/auth/email/send-login", {
            method: "POST",
            headers: { "CF-Connecting-IP": "203.0.113.30" },
            body: createFormData({ email: victim }),
          }),
          env,
        );
        expect(res.headers.get("location")).not.toContain("error=rate_limited");
      });

      it("rate limits per source IP across many different emails (anti mail-bomb)", async () => {
        const ip = "203.0.113.7";
        // 20 distinct emails from one IP each pass the per-email limit but exhaust
        // the per-IP budget (MAGIC_LINK_IP_RATE_LIMIT = 20).
        for (let i = 0; i < 20; i++) {
          const res = await app.fetch(
            request("/auth/email/send-signup", {
              method: "POST",
              headers: { "CF-Connecting-IP": ip },
              body: createFormData({ email: `victim${i}@example.com`, username: `victim${i}` }),
            }),
            env,
          );
          expect(res.headers.get("location")).toContain("success=email_sent");
        }

        // The 21st send from the same IP — a brand-new email — is blocked.
        const blocked = await app.fetch(
          request("/auth/email/send-signup", {
            method: "POST",
            headers: { "CF-Connecting-IP": ip },
            body: createFormData({ email: "victim20@example.com", username: "victim20" }),
          }),
          env,
        );
        expect(blocked.headers.get("location")).toContain("error=rate_limited");

        // A different IP is unaffected.
        const otherIp = await app.fetch(
          request("/auth/email/send-signup", {
            method: "POST",
            headers: { "CF-Connecting-IP": "198.51.100.9" },
            body: createFormData({ email: "victim21@example.com", username: "victim21" }),
          }),
          env,
        );
        expect(otherIp.headers.get("location")).toContain("success=email_sent");
      });

      it("fails when email service not configured", async () => {
        const envWithoutEmail = makeEnv({ EMAIL: undefined });

        const formData = createFormData({
          email: "newuser@example.com",
          username: "newuser",
        });

        const res = await app.fetch(
          request("/auth/email/send-signup", {
            method: "POST",
            body: formData,
          }),
          envWithoutEmail,
        );

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("error=auth_config_missing");
      });

      it("fails when EMAIL_FROM_ADDRESS not set", async () => {
        const envWithoutFrom = makeEnv({ EMAIL_FROM_ADDRESS: undefined });

        const formData = createFormData({
          email: "newuser@example.com",
          username: "newuser",
        });

        const res = await app.fetch(
          request("/auth/email/send-signup", {
            method: "POST",
            body: formData,
          }),
          envWithoutFrom,
        );

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("error=auth_config_incomplete");
      });

      it("includes rememberMe in magic link data when true", async () => {
        const formData = createFormData({
          email: "rememberme@example.com",
          username: "rememberuser",
          rememberMe: "true",
        });

        await app.fetch(
          request("/auth/email/send-signup", {
            method: "POST",
            body: formData,
          }),
          env,
        );

        const token = await extractMagicLinkToken(env);
        expect(token).not.toBeNull();
        if (!token) throw new Error("Token should not be null");
        const tokenData = (await getMagicLinkData(env, token)) as { rememberMe: boolean };
        expect(tokenData.rememberMe).toBe(true);
      });
    });
  });

  // ============================================================================
  // Login Flow Tests
  // ============================================================================

  describe("Login Flow", () => {
    describe("POST /auth/email/send-login", () => {
      it("successful login sends magic link for existing user", async () => {
        const { createUser } = await import("../src/storage/users");
        await createUser(env.DB, "existing@example.com", {} as unknown as Logger, "existinguser");

        const formData = createFormData({
          email: "existing@example.com",
        });

        const res = await app.fetch(
          request("/auth/email/send-login", {
            method: "POST",
            body: formData,
          }),
          env,
        );

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("success=login_link_sent");

        expect(env.EMAIL?.send).toHaveBeenCalledWith(
          expect.objectContaining({
            to: "existing@example.com",
            subject: "Sign in to Stratum",
          }),
        );

        const token = await extractMagicLinkToken(env);
        expect(token).not.toBeNull();
        if (!token) throw new Error("Token should not be null");

        const tokenData = await getMagicLinkData(env, token);
        expect(tokenData).toMatchObject({
          email: "existing@example.com",
          intent: "login",
          rememberMe: false,
        });
      });

      it("does NOT reveal whether the email exists (enumeration-safe uniform response)", async () => {
        const formData = createFormData({
          email: "nonexistent@example.com",
        });

        const res = await app.fetch(
          request("/auth/email/send-login", {
            method: "POST",
            body: formData,
          }),
          env,
        );

        // Same success response an existing account gets — no email_not_found —
        // but no link is minted or sent for the missing account.
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("success=login_link_sent");
        expect(res.headers.get("location")).not.toContain("email_not_found");
        expect(env.EMAIL?.send).not.toHaveBeenCalled();
        expect(await extractMagicLinkToken(env)).toBeNull();
      });

      it("rate limiting works on login endpoint", async () => {
        const { createUser } = await import("../src/storage/users");
        await createUser(env.DB, "loginuser@example.com", {} as unknown as Logger, "loginuser");

        const email = "loginuser@example.com";

        for (let i = 0; i < 5; i++) {
          const formData = createFormData({ email });

          const res = await app.fetch(
            request("/auth/email/send-login", {
              method: "POST",
              body: formData,
            }),
            env,
          );

          expect(res.status).toBe(302);
          expect(res.headers.get("location")).toContain("success=login_link_sent");
        }

        const formData = createFormData({ email });

        const res = await app.fetch(
          request("/auth/email/send-login", {
            method: "POST",
            body: formData,
          }),
          env,
        );

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("error=rate_limited");
      });

      it("fails when email service not configured", async () => {
        const envWithoutEmail = makeEnv({ EMAIL: undefined });

        const formData = createFormData({
          email: "user@example.com",
        });

        const res = await app.fetch(
          request("/auth/email/send-login", {
            method: "POST",
            body: formData,
          }),
          envWithoutEmail,
        );

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("error=auth_config_missing");
      });

      it("fails with invalid email format", async () => {
        const formData = createFormData({
          email: "not-an-email",
        });

        const res = await app.fetch(
          request("/auth/email/send-login", {
            method: "POST",
            body: formData,
          }),
          env,
        );

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("error=invalid_email");
      });
    });
  });

  // ============================================================================
  // Magic Link Verification Tests
  // ============================================================================

  describe("Magic Link Verification", () => {
    describe("GET /auth/email/verify", () => {
      it("signup intent creates user and redirects to the dashboard", async () => {
        const token = "valid-signup-token-123";
        const tokenData = {
          email: "signupuser@example.com",
          username: "signupuser",
          intent: "signup",
          createdAt: Date.now(),
          rememberMe: true,
        };

        magicStore.set(token, tokenData);

        const res = await app.fetch(verifyReq(token), env);

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/");

        // Verify user was created
        const { getUserByEmail } = await import("../src/storage/users");
        const userResult = await getUserByEmail(
          env.DB,
          "signupuser@example.com",
          {} as unknown as Logger,
        );
        expect(userResult.success).toBe(true);
        if (userResult.success) {
          expect(userResult.data.username).toBe("signupuser");
        }

        // Verify token was deleted
        expect(magicStore.has(token)).toBe(false);

        // Verify session cookie was set
        const setCookieHeader = res.headers.get("set-cookie");
        expect(setCookieHeader).toContain("stratum_session");
      });

      it("login intent creates session and redirects to home", async () => {
        const { createUser } = await import("../src/storage/users");
        await createUser(env.DB, "loginuser@example.com", {} as unknown as Logger, "loginuser");

        const token = "valid-login-token-456";
        const tokenData = {
          email: "loginuser@example.com",
          intent: "login",
          createdAt: Date.now(),
          rememberMe: true,
        };

        magicStore.set(token, tokenData);

        const res = await app.fetch(verifyReq(token), env);

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/");

        // Verify token was deleted
        expect(magicStore.has(token)).toBe(false);

        // Verify session cookie was set
        const setCookieHeader = res.headers.get("set-cookie");
        expect(setCookieHeader).toContain("stratum_session");
      });

      it("rejects a cross-site (foreign Origin) verify POST and preserves the token (login CSRF)", async () => {
        const { createUser } = await import("../src/storage/users");
        await createUser(env.DB, "victim@example.com", {} as unknown as Logger, "victimuser");
        const token = "valid-login-token-csrf";
        magicStore.set(token, {
          email: "victim@example.com",
          intent: "login",
          createdAt: Date.now(),
          rememberMe: false,
        });

        // An attacker's auto-submitting form on another origin must be rejected
        // BEFORE the token is consumed — otherwise it logs the victim into the
        // attacker's account.
        const attack = await app.fetch(verifyReq(token, "https://evil.example"), env);
        expect(attack.status).toBe(403);
        expect(attack.headers.get("set-cookie")).toBeNull();
        // Token untouched, so the real same-origin flow still works.
        expect(magicStore.has(token)).toBe(true);

        const legit = await app.fetch(verifyReq(token), env);
        expect(legit.status).toBe(302);
        expect(magicStore.has(token)).toBe(false);
      });

      it("rejects missing token", async () => {
        const res = await app.fetch(request("/auth/email/verify"), env);

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("error=invalid_link");
      });

      it("rejects invalid token", async () => {
        const res = await app.fetch(verifyReq("invalid-token"), env);

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("error=link_expired");
      });

      it("GET renders a confirm page and does NOT consume the token (login-CSRF guard)", async () => {
        const token = "get-should-not-consume";
        magicStore.set(token, {
          email: "x@example.com",
          intent: "login",
          createdAt: Date.now(),
        });

        const res = await app.fetch(request(`/auth/email/verify?token=${token}`), env);

        // A raw GET must not log anyone in: 200 confirm page, no session, token intact.
        expect(res.status).toBe(200);
        expect(res.headers.get("set-cookie")).toBeNull();
        const html = await res.text();
        expect(html).toContain('method="POST"');
        expect(html).toContain(token);
        expect(magicStore.has(token)).toBe(true);
      });

      it("rejects expired token", async () => {
        const token = "expired-token-789";
        const tokenData = {
          email: "expired@example.com",
          intent: "signup",
          username: "expireduser",
          createdAt: Date.now() - 16 * 60 * 1000, // 16 minutes ago
          rememberMe: true,
        };

        // Simulate an expired/absent token: never persisted, so the atomic
        // consume finds nothing and reports the link expired.
        void tokenData;

        const res = await app.fetch(verifyReq(token), env);

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("error=link_expired");
      });

      it("rejects reused token", async () => {
        const { createUser } = await import("../src/storage/users");
        await createUser(env.DB, "reuse@example.com", {} as unknown as Logger, "reuseuser");

        const token = "reuse-token-abc";
        const tokenData = {
          email: "reuse@example.com",
          intent: "login",
          createdAt: Date.now(),
          rememberMe: true,
        };

        magicStore.set(token, tokenData);

        // First use - should succeed
        const res1 = await app.fetch(verifyReq(token), env);
        expect(res1.status).toBe(302);
        expect(res1.headers.get("location")).toBe("/");

        // Second use - should fail (token deleted)
        const res2 = await app.fetch(verifyReq(token), env);
        expect(res2.status).toBe(302);
        expect(res2.headers.get("location")).toContain("error=link_expired");
      });

      it("handles race condition: username taken between signup request and verification", async () => {
        const token = "race-condition-token";
        const tokenData = {
          email: "race@example.com",
          username: "raceuser",
          intent: "signup",
          createdAt: Date.now(),
          rememberMe: true,
        };

        magicStore.set(token, tokenData);

        // Create a user with the same username before verification
        const { createUser } = await import("../src/storage/users");
        await createUser(env.DB, "other@example.com", {} as unknown as Logger, "raceuser");

        const res = await app.fetch(verifyReq(token), env);

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("error=username_taken");
      });

      it("handles race condition: email exists between signup request and verification", async () => {
        const token = "race-email-token";
        const tokenData = {
          email: "raceemail@example.com",
          username: "raceemailuser",
          intent: "signup",
          createdAt: Date.now(),
          rememberMe: true,
        };

        magicStore.set(token, tokenData);

        // Create a user with the same email before verification
        const { createUser } = await import("../src/storage/users");
        await createUser(env.DB, "raceemail@example.com", {} as unknown as Logger, "otheruser");

        const res = await app.fetch(verifyReq(token), env);

        expect(res.status).toBe(302);
        // Should redirect to home since user now exists (treats as login)
        expect(res.headers.get("location")).toBe("/");
      });

      it("handles unknown intent gracefully", async () => {
        const token = "unknown-intent-token";
        const tokenData = {
          email: "unknown@example.com",
          intent: "unknown",
          createdAt: Date.now(),
          rememberMe: true,
        };

        magicStore.set(token, tokenData);

        const res = await app.fetch(verifyReq(token), env);

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("error=invalid_link");
      });
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe("Edge Cases", () => {
    it("normalizes email to lowercase", async () => {
      const formData = createFormData({
        email: "UPPERCASE@EXAMPLE.COM",
        username: "upperuser",
      });

      await app.fetch(
        request("/auth/email/send-signup", {
          method: "POST",
          body: formData,
        }),
        env,
      );

      const token = await extractMagicLinkToken(env);
      expect(token).not.toBeNull();
      if (!token) throw new Error("Token should not be null");
      const tokenData = (await getMagicLinkData(env, token)) as { email: string };
      expect(tokenData.email).toBe("uppercase@example.com");
    });

    it("handles concurrent signup attempts with same username", async () => {
      const results: Response[] = [];

      // Simulate concurrent requests
      const promises = [
        app.fetch(
          request("/auth/email/send-signup", {
            method: "POST",
            body: createFormData({
              email: "user1@example.com",
              username: "concurrentuser",
            }),
          }),
          env,
        ),
        app.fetch(
          request("/auth/email/send-signup", {
            method: "POST",
            body: createFormData({
              email: "user2@example.com",
              username: "concurrentuser",
            }),
          }),
          env,
        ),
      ];

      results.push(...(await Promise.all(promises)));

      // Both should succeed initially (no user exists yet)
      const successCount = results.filter((r) => {
        const location = r.headers.get("location") || "";
        return location.includes("success=email_sent");
      }).length;

      expect(successCount).toBe(2);

      // Two distinct magic-link tokens were stored.
      expect(magicStore.size).toBe(2);
    });

    it("handles email with plus sign", async () => {
      const formData = createFormData({
        email: "user+tag@example.com",
        username: "plustaguser",
      });

      const res = await app.fetch(
        request("/auth/email/send-signup", {
          method: "POST",
          body: formData,
        }),
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("success=email_sent");

      const token = await extractMagicLinkToken(env);
      expect(token).not.toBeNull();
      if (!token) throw new Error("Token should not be null");
      const tokenData = (await getMagicLinkData(env, token)) as { email: string };
      expect(tokenData.email).toBe("user+tag@example.com");
    });

    it("handles long email addresses", async () => {
      const longLocalPart = "a".repeat(50);
      const formData = createFormData({
        email: `${longLocalPart}@example.com`,
        username: "longemailuser",
      });

      const res = await app.fetch(
        request("/auth/email/send-signup", {
          method: "POST",
          body: formData,
        }),
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("success=email_sent");
    });
  });

  // ============================================================================
  // GitHub OAuth Tests
  // ============================================================================

  describe("GitHub OAuth", () => {
    it("redirects to GitHub for OAuth", async () => {
      const res = await app.fetch(request("/auth/github"), env);

      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      expect(location).toContain("github.com/login/oauth/authorize");
      expect(location).toContain("client_id=test-github-client-id");
    });

    it("returns 501 when GitHub OAuth not configured", async () => {
      const envWithoutGitHub = makeEnv({
        GITHUB_CLIENT_ID: undefined,
        GITHUB_CLIENT_SECRET: undefined,
      });

      const res = await app.fetch(request("/auth/github"), envWithoutGitHub);

      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("not configured");
    });

    it("handles GitHub callback with valid code", async () => {
      // Mock GitHub token exchange
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "gh_token_123" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 12345, login: "testuser" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ email: "github@example.com", primary: true, verified: true }],
        });

      // Set up state
      const state = "test-state-123";
      await env.STATE.put(`oauth_state:${state}`, "1", { expirationTtl: 600 });

      const res = await app.fetch(
        request(`/auth/github/callback?code=test-code&state=${state}`, {
          headers: { Cookie: `stratum_oauth_state=${state}` },
        }),
        env,
      );

      expect(res.status).toBe(302);
      // A first-time GitHub identity is asked to choose a username before an
      // account exists (tests/oauth-signup.test.ts covers the rest).
      expect(res.headers.get("location")).toBe("/auth/signup/complete");

      // Restore fetch
      vi.restoreAllMocks();
    });

    function mockGitHubFetch(
      user: { id: number; login: string },
      emails: { email: string; primary: boolean; verified: boolean }[],
    ) {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "gh_token" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => user,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => emails,
        });
    }

    async function githubCallback(state: string, extraQuery = ""): Promise<Response> {
      await env.STATE.put(`oauth_state:${state}`, "1", { expirationTtl: 600 });
      return app.fetch(
        request(`/auth/github/callback?code=test-code&state=${state}${extraQuery}`, {
          headers: { Cookie: `stratum_oauth_state=${state}` },
        }),
        env,
      );
    }

    it("refuses to link or create an account from unverified GitHub emails", async () => {
      mockGitHubFetch({ id: 55555, login: "unverifieduser" }, [
        { email: "unverified@example.com", primary: true, verified: false },
      ]);

      const res = await githubCallback("unverified-email-state");

      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("No verified email");
      const { signInGitHubUser } = await import("../src/storage/users");
      expect(signInGitHubUser).not.toHaveBeenCalled();
      const { createSession } = await import("../src/storage/sessions");
      expect(createSession).not.toHaveBeenCalled();
      expect(res.headers.get("set-cookie") ?? "").not.toContain("stratum_session");

      vi.restoreAllMocks();
    });

    it("signs in an existing github_id-matched user whose emails are all unverified", async () => {
      const { createUser } = await import("../src/storage/users");
      await createUser(env.DB, "linked@example.com", {} as unknown as Logger, "linkeduser");
      const user = mockUsers.get("email:linked@example.com");
      if (!user) throw new Error("seed failed");
      user.githubId = "77777";

      mockGitHubFetch({ id: 77777, login: "linkeduser" }, [
        { email: "unverified@example.com", primary: true, verified: false },
      ]);

      const res = await githubCallback("linked-unverified-state");

      // The GitHub account id — not an email — is the credential here, so the
      // returning user is not locked out by unverified addresses.
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
      expect(res.headers.get("set-cookie")).toContain("stratum_session");
      // The identity row records the account's own email, never the unverified one.
      expect(upsertIdentity).toHaveBeenCalledWith(env.DB, expect.anything(), {
        userId: user.id,
        provider: "github",
        issuer: "https://github.com",
        subject: "77777",
        email: "linked@example.com",
      });

      vi.restoreAllMocks();
    });

    it("persists an identities row on a verified GitHub sign-in", async () => {
      const { createUser } = await import("../src/storage/users");
      await createUser(env.DB, "github@example.com", {} as unknown as Logger, "githubuser");
      mockGitHubFetch({ id: 12345, login: "testuser" }, [
        { email: "github@example.com", primary: true, verified: true },
      ]);

      const res = await githubCallback("identity-row-state");

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
      const created = mockUsers.get("email:github@example.com");
      if (!created) throw new Error("seed failed");
      expect(upsertIdentity).toHaveBeenCalledWith(env.DB, expect.anything(), {
        userId: created.id,
        provider: "github",
        issuer: "https://github.com",
        subject: "12345",
        email: "github@example.com",
      });

      vi.restoreAllMocks();
    });

    it("links with a verified email when the primary email is unverified", async () => {
      mockGitHubFetch({ id: 66666, login: "mixeduser" }, [
        { email: "unverified-primary@example.com", primary: true, verified: false },
        { email: "verified@example.com", primary: false, verified: true },
      ]);

      const res = await githubCallback("mixed-emails-state");

      expect(res.status).toBe(302);
      const { signInGitHubUser } = await import("../src/storage/users");
      expect(signInGitHubUser).toHaveBeenCalledWith(
        env.DB,
        expect.objectContaining({ email: "verified@example.com" }),
        expect.anything(),
      );

      vi.restoreAllMocks();
    });

    it("lowercases a mixed-case verified GitHub email so it matches the stored account", async () => {
      const { createUser } = await import("../src/storage/users");
      await createUser(env.DB, "cased@example.com", {} as unknown as Logger, "caseduser");

      mockGitHubFetch({ id: 44444, login: "caseduser" }, [
        { email: "Cased@Example.com", primary: true, verified: true },
      ]);

      const res = await githubCallback("cased-email-state");

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
      const { signInGitHubUser } = await import("../src/storage/users");
      expect(signInGitHubUser).toHaveBeenCalledWith(
        env.DB,
        expect.objectContaining({ email: "cased@example.com" }),
        expect.anything(),
      );

      vi.restoreAllMocks();
    });

    it("beta gate: a returning github_id-matched user with unverified emails still signs in", async () => {
      const gateEnv = makeEnv({
        ...env,
        BETA_GATE: "1",
        REFERRAL_SERVICE_URL: "http://referral.test",
      });
      const { createUser } = await import("../src/storage/users");
      await createUser(gateEnv.DB, "gated@example.com", {} as unknown as Logger, "gateduser");
      const user = mockUsers.get("email:gated@example.com");
      if (!user) throw new Error("seed failed");
      user.githubId = "66677";

      mockGitHubFetch({ id: 66677, login: "gateduser" }, [
        { email: "unverified@example.com", primary: true, verified: false },
      ]);
      const state = "gate-linked-state";
      await gateEnv.STATE.put(`oauth_state:${state}`, "1", { expirationTtl: 600 });

      const res = await app.fetch(
        request(`/auth/github/callback?code=test-code&state=${state}`, {
          headers: { Cookie: `stratum_oauth_state=${state}` },
        }),
        gateEnv,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
      expect(res.headers.get("set-cookie")).toContain("stratum_session");

      vi.restoreAllMocks();
    });

    it("beta gate: an unmatched user with a verified email is parked for the invite-gated form", async () => {
      const gateEnv = makeEnv({
        ...env,
        BETA_GATE: "1",
        REFERRAL_SERVICE_URL: "http://referral.test",
      });
      mockGitHubFetch({ id: 88811, login: "newgated" }, [
        { email: "brandnew@example.com", primary: true, verified: true },
      ]);
      const state = "gate-new-state";
      await gateEnv.STATE.put(`oauth_state:${state}`, "1", { expirationTtl: 600 });

      const res = await app.fetch(
        request(`/auth/github/callback?code=test-code&state=${state}`, {
          headers: { Cookie: `stratum_oauth_state=${state}` },
        }),
        gateEnv,
      );

      expect(res.status).toBe(302);
      // Nothing is created here; /auth/signup/complete demands the invite code.
      expect(res.headers.get("location")).toBe("/auth/signup/complete");
      expect(res.headers.get("set-cookie") ?? "").not.toContain("stratum_session");
      expect(mockUsers.get("email:brandnew@example.com")).toBeUndefined();

      vi.restoreAllMocks();
    });

    it("drops an off-origin next on the callback (redirects home)", async () => {
      const { createUser } = await import("../src/storage/users");
      await createUser(env.DB, "github@example.com", {} as unknown as Logger, "githubuser");
      mockGitHubFetch({ id: 12345, login: "testuser" }, [
        { email: "github@example.com", primary: true, verified: true },
      ]);

      const res = await githubCallback("next-param-state", "&next=%2F%2Fevil.com");

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");

      vi.restoreAllMocks();
    });

    it("rejects invalid state parameter", async () => {
      const res = await app.fetch(
        request("/auth/github/callback?code=test-code&state=invalid-state"),
        env,
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Invalid or expired state");
    });

    it("rejects a known state when the browser cookie is missing (login CSRF)", async () => {
      const state = "test-state-csrf";
      await env.STATE.put(`oauth_state:${state}`, "1", { expirationTtl: 600 });

      const res = await app.fetch(
        request(`/auth/github/callback?code=test-code&state=${state}`),
        env,
      );

      expect(res.status).toBe(400);
    });

    it("rejects when the cookie state does not match the query state", async () => {
      const state = "test-state-mismatch";
      await env.STATE.put(`oauth_state:${state}`, "1", { expirationTtl: 600 });

      const res = await app.fetch(
        request(`/auth/github/callback?code=test-code&state=${state}`, {
          headers: { Cookie: "stratum_oauth_state=other-state-value" },
        }),
        env,
      );

      expect(res.status).toBe(400);
    });

    it("rejects missing code parameter", async () => {
      const state = "test-state-456";
      await env.STATE.put(`oauth_state:${state}`, "1", { expirationTtl: 600 });

      const res = await app.fetch(
        request(`/auth/github/callback?state=${state}`, {
          headers: { Cookie: `stratum_oauth_state=${state}` },
        }),
        env,
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Missing code");
    });

    it("handles logout via POST (state-changing, CSRF-guarded)", async () => {
      const res = await app.fetch(
        request("/auth/logout", {
          method: "POST",
          headers: { Origin: "http://localhost" },
        }),
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");

      // Verify cookie is deleted
      const setCookieHeader = res.headers.get("set-cookie");
      expect(setCookieHeader).toContain("stratum_session");
    });

    it("does not end the session on GET (bookmarks/prefetchers just go home)", async () => {
      const res = await app.fetch(request("/auth/logout"), env);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
      expect(res.headers.get("set-cookie")).toBeNull();
    });
  });

  // ============================================================================
  // Legacy Magic Link Endpoint Tests
  // ============================================================================

  describe("Legacy Magic Link (POST /auth/email/send)", () => {
    it("sends magic link for new user (signup intent)", async () => {
      const formData = createFormData({
        email: "legacy@example.com",
      });

      const res = await app.fetch(
        request("/auth/email/send", {
          method: "POST",
          body: formData,
        }),
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("success=email_sent");

      const token = await extractMagicLinkToken(env);
      expect(token).not.toBeNull();
      if (!token) throw new Error("Token should not be null");
      const tokenData = (await getMagicLinkData(env, token)) as {
        intent: string;
        username?: string;
      };
      expect(tokenData.intent).toBe("signup");
      expect(tokenData.username).toBeDefined();
    });

    it("sends magic link for existing user (login intent)", async () => {
      const { createUser } = await import("../src/storage/users");
      await createUser(env.DB, "legacyexisting@example.com", {} as unknown as Logger, "legacyuser");

      const formData = createFormData({
        email: "legacyexisting@example.com",
      });

      const res = await app.fetch(
        request("/auth/email/send", {
          method: "POST",
          body: formData,
        }),
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("success=email_sent");

      const token = await extractMagicLinkToken(env);
      expect(token).not.toBeNull();
      if (!token) throw new Error("Token should not be null");
      const tokenData = (await getMagicLinkData(env, token)) as { intent: string };
      expect(tokenData.intent).toBe("login");
    });

    it("enforces rate limiting on legacy endpoint", async () => {
      const email = "legacylimit@example.com";

      for (let i = 0; i < 5; i++) {
        const formData = createFormData({ email });

        const res = await app.fetch(
          request("/auth/email/send", {
            method: "POST",
            body: formData,
          }),
          env,
        );

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("success=email_sent");
      }

      const formData = createFormData({ email });

      const res = await app.fetch(
        request("/auth/email/send", {
          method: "POST",
          body: formData,
        }),
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("error=rate_limited");
    });
  });

  // ============================================================================
  // Disabled account enforcement (disabled_at) — no session mint, no mail,
  // no session.created audit row on any refused login.
  // ============================================================================

  describe("Disabled account enforcement", () => {
    const DISABLED_AT = "2026-08-01T00:00:00.000Z";

    async function seedDisabledUser(email: string, username: string): Promise<User> {
      const { createUser } = await import("../src/storage/users");
      await createUser(env.DB, email, {} as unknown as Logger, username);
      const user = mockUsers.get(`email:${email}`);
      if (!user) throw new Error(`Failed to seed user ${email}`);
      user.disabledAt = DISABLED_AT;
      return user;
    }

    it("send-login answers with the enumeration-safe success but sends no mail", async () => {
      await seedDisabledUser("disabled@example.com", "disableduser");

      const res = await app.fetch(
        request("/auth/email/send-login", {
          method: "POST",
          body: createFormData({ email: "disabled@example.com" }),
        }),
        env,
      );

      expect(res.status).toBe(302);
      // Same response as an unknown address — disabled accounts are not an
      // enumeration oracle.
      expect(res.headers.get("location")).toContain("success=login_link_sent");
      expect(env.EMAIL?.send).not.toHaveBeenCalled();
      expect(await extractMagicLinkToken(env)).toBeNull();
    });

    it("legacy send answers with the uniform success but sends no mail", async () => {
      await seedDisabledUser("disabled-legacy@example.com", "disabledlegacy");

      const res = await app.fetch(
        request("/auth/email/send", {
          method: "POST",
          body: createFormData({ email: "disabled-legacy@example.com" }),
        }),
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("success=email_sent");
      expect(env.EMAIL?.send).not.toHaveBeenCalled();
      expect(await extractMagicLinkToken(env)).toBeNull();
    });

    async function seedDeletingUser(email: string, username: string): Promise<User> {
      const { createUser } = await import("../src/storage/users");
      await createUser(env.DB, email, {} as unknown as Logger, username);
      const user = mockUsers.get(`email:${email}`);
      if (!user) throw new Error(`Failed to seed user ${email}`);
      user.deletingAt = "2026-08-01T00:00:00.000Z";
      return user;
    }

    it("send-login treats a deleting account like a disabled one: uniform success, no mail", async () => {
      await seedDeletingUser("deleting-send@example.com", "deletingsend");

      const res = await app.fetch(
        request("/auth/email/send-login", {
          method: "POST",
          body: createFormData({ email: "deleting-send@example.com" }),
        }),
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("success=login_link_sent");
      expect(env.EMAIL?.send).not.toHaveBeenCalled();
      expect(await extractMagicLinkToken(env)).toBeNull();
    });

    it("legacy send treats a deleting account like a disabled one: uniform success, no mail", async () => {
      await seedDeletingUser("deleting-legacy@example.com", "deletinglegacy");

      const res = await app.fetch(
        request("/auth/email/send", {
          method: "POST",
          body: createFormData({ email: "deleting-legacy@example.com" }),
        }),
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("success=email_sent");
      expect(env.EMAIL?.send).not.toHaveBeenCalled();
      expect(await extractMagicLinkToken(env)).toBeNull();
    });

    it("verify hard-rejects a login link for a disabled account with no session or audit row", async () => {
      await seedDisabledUser("disabled-verify@example.com", "disabledverify");
      // A link minted BEFORE the account was disabled must still be refused.
      magicStore.set("pre-disable-token", {
        email: "disabled-verify@example.com",
        intent: "login",
        createdAt: Date.now(),
        rememberMe: true,
      });

      const res = await app.fetch(verifyReq("pre-disable-token"), env);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("error=account_disabled");
      expect(res.headers.get("set-cookie")).toBeNull();
      const { createSession } = await import("../src/storage/sessions");
      expect(createSession).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it("verify refuses the signup-collides-with-existing-account fallback for a disabled account", async () => {
      await seedDisabledUser("disabled-signup@example.com", "disabledsignup");
      magicStore.set("signup-collision-token", {
        email: "disabled-signup@example.com",
        username: "someoneelse",
        intent: "signup",
        createdAt: Date.now(),
        rememberMe: true,
      });

      const res = await app.fetch(verifyReq("signup-collision-token"), env);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("error=account_disabled");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it("GitHub callback refuses a disabled account before minting a session", async () => {
      const user = await seedDisabledUser("disabled-github@example.com", "disabledgithub");
      user.githubId = "99999";

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "gh_token_disabled" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 99999, login: "disabledgithub" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { email: "disabled-github@example.com", primary: true, verified: true },
          ],
        });

      const state = "disabled-github-state";
      await env.STATE.put(`oauth_state:${state}`, "1", { expirationTtl: 600 });

      const res = await app.fetch(
        request(`/auth/github/callback?code=test-code&state=${state}`, {
          headers: { Cookie: `stratum_oauth_state=${state}` },
        }),
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/auth/login?error=account_disabled");
      expect(res.headers.get("set-cookie") ?? "").not.toContain("stratum_session");
      const { createSession } = await import("../src/storage/sessions");
      expect(createSession).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it("GitHub callback refuses a disabled account matched by email WITHOUT linking github_id", async () => {
      // signInGitHubUser must not link a GitHub id onto the frozen row — that
      // would hand it a working credential at re-enable (the storage-level
      // guard is covered in tests/users-disable.test.ts).
      const user = await seedDisabledUser("disabled-nolink@example.com", "disablednolink");
      expect(user.githubId).toBeUndefined();

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "gh_token_nolink" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 88888, login: "disablednolink" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { email: "disabled-nolink@example.com", primary: true, verified: true },
          ],
        });

      const state = "disabled-nolink-state";
      await env.STATE.put(`oauth_state:${state}`, "1", { expirationTtl: 600 });

      const res = await app.fetch(
        request(`/auth/github/callback?code=test-code&state=${state}`, {
          headers: { Cookie: `stratum_oauth_state=${state}` },
        }),
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/auth/login?error=account_disabled");
      expect(res.headers.get("set-cookie") ?? "").not.toContain("stratum_session");
      expect(user.githubId).toBeUndefined();

      vi.restoreAllMocks();
    });

    it("verify hard-rejects a soft-deleting account the same as a disabled one", async () => {
      const { createUser } = await import("../src/storage/users");
      await createUser(env.DB, "deleting@example.com", {} as unknown as Logger, "deletinguser");
      const user = mockUsers.get("email:deleting@example.com");
      if (!user) throw new Error("seed failed");
      user.deletingAt = "2026-08-01T00:00:00.000Z";
      magicStore.set("deleting-user-token", {
        email: "deleting@example.com",
        intent: "login",
        createdAt: Date.now(),
        rememberMe: true,
      });

      const res = await app.fetch(verifyReq("deleting-user-token"), env);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("error=account_disabled");
      expect(res.headers.get("set-cookie") ?? "").not.toContain("stratum_session");
      expect(recordAudit).not.toHaveBeenCalled();
    });
  });
});
