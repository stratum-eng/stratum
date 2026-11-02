import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkDomainTxtRecord,
  verificationRecordName,
  verificationTxtValue,
} from "../src/services/domain-verification";
import {
  discoverOidcConfiguration,
  validateIssuer,
  validateOidcUrl,
} from "../src/services/oidc-discovery";
import type { Logger } from "../src/utils/logger";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

const ISSUER = "https://idp.example.com";

function discoveryDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("validateOidcUrl — SSRF host rules", () => {
  const reject = (url: string) => expect(validateOidcUrl(url, "issuer")).not.toBeNull();
  const accept = (url: string) => expect(validateOidcUrl(url, "issuer")).toBeNull();

  it("accepts a public https URL", () => {
    accept("https://idp.example.com");
    accept("https://login.okta.example.io/oauth2/default");
  });

  it("rejects http://", () => {
    reject("http://idp.example.com");
  });

  it("rejects non-URL garbage", () => {
    reject("not a url");
  });

  it("rejects embedded credentials", () => {
    reject("https://user:pass@idp.example.com");
    reject("https://user@idp.example.com");
  });

  it("rejects IPv4 and IPv6 literals", () => {
    reject("https://127.0.0.1");
    reject("https://10.0.0.5/issuer");
    reject("https://[::1]");
    reject("https://[fd00::1]/x");
  });

  it("rejects localhost and private/reserved names", () => {
    reject("https://localhost");
    reject("https://foo.localhost");
    reject("https://printer.local");
    reject("https://vault.internal");
    reject("https://router.home.arpa");
  });

  it("rejects single-label hostnames (bare internal names)", () => {
    reject("https://metadata");
  });

  it("rejects trailing-dot forms of blocked hosts (FQDN-dot bypass)", () => {
    reject("https://localhost./x");
    reject("https://metadata./x");
    reject("https://foo.internal./x");
  });
});

describe("validateIssuer", () => {
  it("rejects the reserved GitHub and Google issuers (any casing / trailing slash)", () => {
    expect(validateIssuer("https://github.com")).not.toBeNull();
    expect(validateIssuer("https://github.com/")).not.toBeNull();
    expect(validateIssuer("https://accounts.google.com")).not.toBeNull();
    expect(validateIssuer("https://ACCOUNTS.GOOGLE.COM")).not.toBeNull();
  });

  it("rejects an issuer with a query or fragment", () => {
    expect(validateIssuer("https://idp.example.com?x=1")).not.toBeNull();
    expect(validateIssuer("https://idp.example.com#frag")).not.toBeNull();
  });

  it("accepts a normal corporate issuer", () => {
    expect(validateIssuer("https://idp.example.com/oauth2/default")).toBeNull();
  });
});

describe("discoverOidcConfiguration", () => {
  it("returns the three endpoints on a valid document", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(discoveryDoc()));
    vi.stubGlobal("fetch", fetchMock);

    const result = await discoverOidcConfiguration(ISSUER, mockLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: `${ISSUER}/token`,
      jwksUri: `${ISSUER}/jwks`,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${ISSUER}/.well-known/openid-configuration`,
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("normalizes a trailing-slash issuer: discovery succeeds and the returned issuer is canonical", async () => {
    // The compliant stub advertises the canonical (no-trailing-slash) issuer;
    // the admin typed one with a slash. The normalized form must drive the
    // discovery URL, the RFC 8414 equality check, AND the returned issuer.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(discoveryDoc()));
    vi.stubGlobal("fetch", fetchMock);

    const result = await discoverOidcConfiguration(`${ISSUER}/`, mockLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.issuer).toBe(ISSUER);
    expect(fetchMock).toHaveBeenCalledWith(
      `${ISSUER}/.well-known/openid-configuration`,
      expect.anything(),
    );
  });

  it("rejects invalid issuers without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const issuer of [
      "http://idp.example.com",
      "https://127.0.0.1",
      "https://localhost",
      "https://github.com",
      "https://accounts.google.com",
    ]) {
      const result = await discoverOidcConfiguration(issuer, mockLogger);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a document whose issuer does not exactly match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(discoveryDoc({ issuer: "https://evil.example.com" }))),
    );
    const result = await discoverOidcConfiguration(ISSUER, mockLogger);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/issuer does not match/);
  });

  it("rejects a document missing any of the three endpoints", async () => {
    for (const missing of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
      const doc = discoveryDoc();
      delete doc[missing];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(doc)));
      const result = await discoverOidcConfiguration(ISSUER, mockLogger);
      expect(result.success, `missing ${missing} must fail`).toBe(false);
      if (!result.success) expect(result.error.message).toContain(missing);
    }
  });

  it("rejects a discovered endpoint pointing at a private host", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(discoveryDoc({ token_endpoint: "https://169.254.169.254/token" })),
        ),
    );
    const result = await discoverOidcConfiguration(ISSUER, mockLogger);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a non-JSON content type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(discoveryDoc()), {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      ),
    );
    const result = await discoverOidcConfiguration(ISSUER, mockLogger);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/application\/json/);
  });

  it("rejects an oversized document", async () => {
    const doc = discoveryDoc({ padding: "x".repeat(70 * 1024) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(doc)));
    const result = await discoverOidcConfiguration(ISSUER, mockLogger);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/size limit/);
  });

  it("maps a failed fetch to an external-service error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const result = await discoverOidcConfiguration(ISSUER, mockLogger);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("EXTERNAL_SERVICE_ERROR");
  });

  it("maps a non-OK discovery status to an external-service error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, { status: 404 })));
    const result = await discoverOidcConfiguration(ISSUER, mockLogger);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("EXTERNAL_SERVICE_ERROR");
  });
});

describe("checkDomainTxtRecord (DNS-over-HTTPS)", () => {
  const TOKEN = "abc123def456";

  function dohResponse(answers: Array<{ type: number; data: string }>): Response {
    return new Response(JSON.stringify({ Status: 0, Answer: answers }), {
      status: 200,
      headers: { "Content-Type": "application/dns-json" },
    });
  }

  it("builds the expected record name and value", () => {
    expect(verificationRecordName("corp.example.com")).toBe("_stratum-sso.corp.example.com");
    expect(verificationTxtValue(TOKEN)).toBe(`stratum-sso-verify=${TOKEN}`);
  });

  it("finds a matching quoted TXT record", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(dohResponse([{ type: 16, data: `"stratum-sso-verify=${TOKEN}"` }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkDomainTxtRecord("corp.example.com", TOKEN, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(true);
    const requestedUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(requestedUrl).toContain("cloudflare-dns.com/dns-query");
    expect(requestedUrl).toContain(encodeURIComponent("_stratum-sso.corp.example.com"));
  });

  it("reports false when no TXT record matches the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(dohResponse([{ type: 16, data: '"stratum-sso-verify=WRONG"' }])),
    );
    const result = await checkDomainTxtRecord("corp.example.com", TOKEN, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(false);
  });

  it("reports false on an authoritative NXDOMAIN (Status 3, no Answer)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ Status: 3 }), {
          status: 200,
          headers: { "Content-Type": "application/dns-json" },
        }),
      ),
    );
    const result = await checkDomainTxtRecord("corp.example.com", TOKEN, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(false);
  });

  it("surfaces a non-authoritative DNS status (Status 2, SERVFAIL) as retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ Status: 2 }), {
          status: 200,
          headers: { "Content-Type": "application/dns-json" },
        }),
      ),
    );
    const result = await checkDomainTxtRecord("corp.example.com", TOKEN, mockLogger);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("EXTERNAL_SERVICE_ERROR");
  });

  it("rejects a TXT record that merely contains the expected value", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          dohResponse([{ type: 16, data: `"prefix stratum-sso-verify=${TOKEN} suffix"` }]),
        ),
    );
    const result = await checkDomainTxtRecord("corp.example.com", TOKEN, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(false);
  });

  it("ignores non-TXT answers even when the data matches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(dohResponse([{ type: 5, data: `stratum-sso-verify=${TOKEN}` }])),
    );
    const result = await checkDomainTxtRecord("corp.example.com", TOKEN, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(false);
  });

  it("surfaces a lookup failure as an error (not 'unverified')", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("doh unreachable")));
    const result = await checkDomainTxtRecord("corp.example.com", TOKEN, mockLogger);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("EXTERNAL_SERVICE_ERROR");
  });
});
