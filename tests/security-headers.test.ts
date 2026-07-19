/**
 * SEC-7: response security headers. The UI/API carry a conservative header set
 * and a non-`script-src` CSP (inline handlers in the server-rendered UI must
 * keep working). Git smart-HTTP responses are left untouched.
 */
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/types";

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
  getUser: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
}));
vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
}));

function makeEnv(): Env {
  return {
    ARTIFACTS: { get: vi.fn(), create: vi.fn() } as unknown as Env["ARTIFACTS"],
    STATE: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    } as unknown as KVNamespace,
    DB: {} as D1Database,
  } as unknown as Env;
}

describe("SEC-7: security headers", () => {
  it("sets the header set on a normal (non-git) response", async () => {
    const res = await app.fetch(new Request("http://localhost/health"), makeEnv());
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it("ships no script-src directive (inline UI handlers must keep working)", async () => {
    const res = await app.fetch(new Request("http://localhost/health"), makeEnv());
    expect(res.headers.get("Content-Security-Policy")).not.toContain("script-src");
  });

  it("sets HSTS only over HTTPS", async () => {
    const httpRes = await app.fetch(new Request("http://localhost/health"), makeEnv());
    expect(httpRes.headers.get("Strict-Transport-Security")).toBeNull();

    const httpsRes = await app.fetch(new Request("https://app.example.com/health"), makeEnv());
    expect(httpsRes.headers.get("Strict-Transport-Security")).toContain("max-age=");
  });

  it("does not add HTML headers to git smart-HTTP responses", async () => {
    const res = await app.fetch(
      new Request("http://localhost/@owner/repo/info/refs?service=git-upload-pack"),
      makeEnv(),
    );
    expect(res.headers.get("X-Frame-Options")).toBeNull();
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });
});
