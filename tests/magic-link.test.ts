import { beforeEach, describe, expect, it, vi } from "vitest";
import { emailAuthRouter } from "../src/routes/email-auth";
import type { Env } from "../src/types";

function makeEnv(): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as KVNamespace,
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
  });

  describe("GET / (login form)", () => {
    it("should show login form", async () => {
      const res = await emailAuthRouter.fetch(request("/"), env);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("Sign in to Stratum");
      expect(text).toContain('name="email"');
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
      formData.append("email", "test@example.com");

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
      formData.append("email", "test@example.com");

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
      formData.append("email", "test@example.com");

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
          to: "test@example.com",
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
        formData.append("email", "test@example.com");
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
      formData.append("email", "test@example.com");
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
      (env.STATE.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await emailAuthRouter.fetch(request("/verify?token=invalid-token"), env);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("error=link_expired");
    });
  });
});
