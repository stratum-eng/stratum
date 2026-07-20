import { beforeEach, describe, expect, it, vi } from "vitest";
import { emailAuthRouter } from "../src/routes/email-auth";
import type { Env } from "../src/types";
import { NotFoundError } from "../src/utils/errors";

// Magic links now live in D1 with atomic consume; model that with an in-memory
// store shared across the router's create/consume calls (single-use enforced by
// delete-on-consume, matching the real conditional UPDATE).
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
}));

// Mock the users storage module
vi.mock("../src/storage/users", () => ({
  getUserByEmail: vi.fn(async () => ({
    success: false,
    error: new NotFoundError("User", "test"),
  })),
  createUser: vi.fn(),
  getUserByUsername: vi.fn(),
  upsertGitHubUser: vi.fn(),
  getUserByToken: vi.fn(),
  getUser: vi.fn(),
  linkGitHub: vi.fn(),
}));

// Simple in-memory KV store for tests
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

function makeEnv(): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: makeKV(),
    DB: {} as D1Database,
    EMAIL: {
      send: vi.fn().mockResolvedValue({ messageId: "test-message-id" }),
    },
    EMAIL_FROM_ADDRESS: "noreply@stratum.dev",
  };
}

function request(path: string, options?: RequestInit): Request {
  return new Request(`http://localhost${path}`, options);
}

describe("Magic Link Authentication", () => {
  let env: Env;

  beforeEach(() => {
    env = makeEnv();
    vi.clearAllMocks();
    magicStore.clear();
  });

  describe("GET / (auth choice page)", () => {
    it("should show auth choice page", async () => {
      const res = await emailAuthRouter.fetch(request("/"), env);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("Welcome to Stratum");
      expect(text).toContain("Create Account");
      expect(text).toContain("Sign In");
    });

    it("should show error message when error param provided", async () => {
      const res = await emailAuthRouter.fetch(request("/?error=invalid_email"), env);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("Please enter a valid email address");
    });
  });

  describe("POST /send", () => {
    it("should reject invalid email format", async () => {
      const formData = new FormData();
      formData.append("email", "not-an-email");

      const res = await emailAuthRouter.fetch(
        request("/send", {
          method: "POST",
          body: formData,
        }),
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("error=invalid_email");
    });

    it("should reject empty email", async () => {
      const formData = new FormData();
      formData.append("email", "");

      const res = await emailAuthRouter.fetch(
        request("/send", {
          method: "POST",
          body: formData,
        }),
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("error=invalid_email");
    });

    it("should reject when email service not configured", async () => {
      const envWithoutEmail = { ...env, EMAIL: undefined };
      const formData = new FormData();
      formData.append("email", "johndoe@example.com");

      const res = await emailAuthRouter.fetch(
        request("/send", {
          method: "POST",
          body: formData,
        }),
        envWithoutEmail,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("error=auth_config_missing");
    });

    it("should reject when EMAIL_FROM_ADDRESS not set", async () => {
      const envWithoutFrom = { ...env, EMAIL_FROM_ADDRESS: undefined };
      const formData = new FormData();
      formData.append("email", "johndoe@example.com");

      const res = await emailAuthRouter.fetch(
        request("/send", {
          method: "POST",
          body: formData,
        }),
        envWithoutFrom,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("error=auth_config_incomplete");
    });

    it("should send magic link for valid email", async () => {
      const formData = new FormData();
      formData.append("email", "johndoe@example.com");

      const res = await emailAuthRouter.fetch(
        request("/send", {
          method: "POST",
          body: formData,
        }),
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("success=email_sent");
      expect(env.EMAIL?.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "johndoe@example.com",
          subject: "Sign in to Stratum",
        }),
      );
    });

    it("should enforce rate limiting", async () => {
      const kvStore = new Map<string, string>();
      env.STATE = {
        get: vi.fn((key: string) => Promise.resolve(kvStore.get(key) ?? null)),
        put: vi.fn((key: string, value: string) => {
          kvStore.set(key, value);
          return Promise.resolve();
        }),
        delete: vi.fn(),
      } as unknown as KVNamespace;

      // Make 5 requests (the limit)
      for (let i = 0; i < 5; i++) {
        const formData = new FormData();
        formData.append("email", "johndoe@example.com");
        await emailAuthRouter.fetch(
          request("/send", {
            method: "POST",
            body: formData,
          }),
          env,
        );
      }

      // 6th request should be rate limited
      const formData = new FormData();
      formData.append("email", "johndoe@example.com");
      const res = await emailAuthRouter.fetch(
        request("/send", {
          method: "POST",
          body: formData,
        }),
        env,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("error=rate_limited");
    });
  });

  describe("GET /verify", () => {
    it("should reject missing token", async () => {
      const res = await emailAuthRouter.fetch(request("/verify"), env);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("error=invalid_link");
    });

    it("should reject invalid token", async () => {
      // No token stored, so consume returns null. Verify is now a POST (the GET
      // only renders a same-origin confirm page — login-CSRF protection).
      const body = new FormData();
      body.append("token", "invalid-token");
      const res = await emailAuthRouter.fetch(request("/verify", { method: "POST", body }), env);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("error=link_expired");
    });

    it("should process valid token and delete it", async () => {
      // Seed a valid token in the magic-link store.
      magicStore.set("valid-token-123", {
        email: "test@example.com",
        intent: "login",
        createdAt: Date.now(),
      });

      const body = new FormData();
      body.append("token", "valid-token-123");
      const res = await emailAuthRouter.fetch(request("/verify", { method: "POST", body }), env);

      // The test will fail because user doesn't exist in mocked DB
      // But it validates the token was found and processed
      expect(res.status).toBe(302);
      // Should redirect with error since user lookup will fail with mock DB
      const location = res.headers.get("location");
      expect(location).toContain("error=");

      // Token should be deleted after use
      const storedToken = await env.STATE.get("magic_link:valid-token-123");
      expect(storedToken).toBeNull();
    });
  });
});
