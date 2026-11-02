/**
 * SEC-7: response security headers. The UI/API carry a conservative header set
 * and a nonce-based `script-src` CSP (issue #161) — every inline script the UI
 * renders carries the per-request nonce. Git smart-HTTP responses are left
 * untouched.
 */
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { contentSecurityPolicy, generateCspNonce } from "../src/middleware/security-headers";
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
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it("restricts form targets and framing", async () => {
    const res = await app.fetch(new Request("http://localhost/health"), makeEnv());
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-src 'none'");
  });

  it("ships a nonce-based script-src directive (issue #161)", async () => {
    const res = await app.fetch(new Request("http://localhost/health"), makeEnv());
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    // Base64 nonce of 16 random bytes (24 chars with padding).
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/]{22}=='/);
  });

  it("uses a fresh nonce per request", async () => {
    const extract = (csp: string | null) => /'nonce-([^']+)'/.exec(csp ?? "")?.[1];
    const first = await app.fetch(new Request("http://localhost/health"), makeEnv());
    const second = await app.fetch(new Request("http://localhost/health"), makeEnv());
    const a = extract(first.headers.get("Content-Security-Policy"));
    const b = extract(second.headers.get("Content-Security-Policy"));
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("never falls back to 'unsafe-inline' (or 'strict-dynamic'/'unsafe-eval')", async () => {
    const res = await app.fetch(new Request("http://localhost/health"), makeEnv());
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("strict-dynamic");
  });

  it("generateCspNonce returns unique, base64, 128-bit values", () => {
    const a = generateCspNonce();
    const b = generateCspNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(a).not.toBe(b);
  });

  it("contentSecurityPolicy embeds the given nonce and keeps the existing directives", () => {
    const csp = contentSecurityPolicy("abc123==");
    expect(csp).toContain("script-src 'nonce-abc123=='");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-src 'none'");
  });

  it("contentSecurityPolicy can widen or drop form-action for a page that redirects off-origin", () => {
    // The OAuth consent page's form POST is answered with a redirect to the
    // client, and Chromium checks form-action against that redirect too.
    expect(contentSecurityPolicy("n", { formAction: ["https://claude.ai"] })).toContain(
      "form-action 'self' https://claude.ai;",
    );
    expect(contentSecurityPolicy("n", { formAction: null })).not.toContain("form-action");
    // Every other directive survives either way.
    for (const csp of [
      contentSecurityPolicy("n", { formAction: ["https://claude.ai"] }),
      contentSecurityPolicy("n", { formAction: null }),
    ]) {
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("script-src 'nonce-n'");
    }
    // And the default is byte-for-byte what it was.
    expect(contentSecurityPolicy("n")).toBe(
      "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-src 'none'; script-src 'nonce-n'; report-to csp-endpoint; report-uri /csp-report",
    );
  });

  it("names the violation-report endpoint in every policy and declares it to the browser", async () => {
    // A CSP block is invisible to the server unless the browser is told where
    // to report it (#355). Both directives, so browsers with and without the
    // Reporting API report; the header is what makes `report-to` resolvable.
    const res = await app.fetch(new Request("http://localhost/health"), makeEnv());
    expect(res.headers.get("Reporting-Endpoints")).toBe('csp-endpoint="/csp-report"');
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("report-to csp-endpoint");
    expect(csp).toContain("report-uri /csp-report");
  });

  it("applies the same CSP to 500 error responses (error boundary parity)", async () => {
    // GET / renders the dashboard, which throws under the bare test env and hits
    // the error boundary — the 500 must carry the identical hardened policy.
    const res = await app.fetch(new Request("http://localhost/"), makeEnv());
    expect(res.status).toBe(500);
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // The error boundary re-asserts headers on the same context, so the 500's
    // script-src still carries the request's (single) nonce.
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/]{22}=='/);
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
