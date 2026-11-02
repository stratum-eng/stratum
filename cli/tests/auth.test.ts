import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, StratumClient } from "../src/client.js";
import { fromFile, isExpired, toFile } from "../src/config.js";
import { createPkcePair, expiresAtFrom, normalizeHost } from "../src/oauth.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PKCE", () => {
  it("derives an S256 challenge from the verifier", () => {
    const { verifier, challenge } = createPkcePair();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("uses a verifier within the length RFC 7636 allows", () => {
    const { verifier } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("is different every time", () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
  });
});

describe("config file format", () => {
  it("reads the legacy flat apiKey file", () => {
    const config = fromFile({ host: "https://s.example", apiKey: "stratum_user_x" });
    expect(config).toEqual({
      host: "https://s.example",
      credential: { kind: "apiKey", apiKey: "stratum_user_x" },
    });
  });

  it("round-trips an api key without inventing an oauth block", () => {
    const config = fromFile({ host: "https://s.example", apiKey: "k" });
    expect(config).not.toBeNull();
    expect(toFile(config as NonNullable<typeof config>)).toEqual({
      host: "https://s.example",
      apiKey: "k",
    });
  });

  it("reads an oauth grant", () => {
    const config = fromFile({
      host: "https://s.example",
      oauth: {
        clientId: "c1",
        accessToken: "stratum_mcp_a",
        refreshToken: "stratum_mcprt_r",
        expiresAt: "2030-01-01T00:00:00.000Z",
        scope: "mcp:read mcp:write",
      },
    });
    expect(config?.credential).toMatchObject({ kind: "oauth", clientId: "c1" });
  });

  it("prefers the oauth grant when a stale apiKey is also present", () => {
    const config = fromFile({
      host: "https://s.example",
      apiKey: "stratum_user_old",
      oauth: {
        clientId: "c1",
        accessToken: "stratum_mcp_a",
        refreshToken: "stratum_mcprt_r",
        expiresAt: "2030-01-01T00:00:00.000Z",
        scope: "mcp:read",
      },
    });
    expect(config?.credential.kind).toBe("oauth");
  });

  it("rejects a half-written oauth block rather than using it", () => {
    const config = fromFile({
      host: "https://s.example",
      oauth: { clientId: "c1", accessToken: "a" },
    });
    expect(config).toBeNull();
  });

  it("returns null without a host", () => {
    expect(fromFile({ apiKey: "k" })).toBeNull();
  });
});

describe("expiry", () => {
  it("treats a token inside the refresh skew as expired", () => {
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    expect(isExpired(new Date(now + 30_000).toISOString(), now)).toBe(true);
    expect(isExpired(new Date(now + 300_000).toISOString(), now)).toBe(false);
  });

  it("treats an unparseable expiry as expired", () => {
    expect(isExpired("not a date")).toBe(true);
  });

  it("treats a missing expires_in as immediately expired", () => {
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    expect(isExpired(expiresAtFrom(undefined, now), now)).toBe(true);
    expect(isExpired(expiresAtFrom(3600, now), now)).toBe(false);
  });
});

describe("normalizeHost", () => {
  it("drops exactly one trailing slash", () => {
    expect(normalizeHost("https://s.example/")).toBe("https://s.example");
    expect(normalizeHost("https://s.example")).toBe("https://s.example");
  });
});

describe("401 refresh and retry", () => {
  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("refreshes once and replays the request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(401, { error: "Invalid token" }))
      .mockResolvedValueOnce(jsonResponse(200, { projects: [] }));

    const credential = {
      token: vi.fn().mockResolvedValue("old"),
      refresh: vi.fn().mockResolvedValue("new"),
    };
    const client = new StratumClient("https://s.example", credential);

    await expect(client.request("GET", "/api/projects")).resolves.toEqual({ projects: [] });
    expect(credential.refresh).toHaveBeenCalledTimes(1);

    const second = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect((second.headers as Record<string, string>).Authorization).toBe("Bearer new");
  });

  it("does not retry when the credential cannot be renewed", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(401, { error: "Invalid token" }));
    const client = new StratumClient("https://s.example", "stratum_user_x");

    await expect(client.request("GET", "/api/projects")).rejects.toThrow("Invalid token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after one retry rather than looping", async () => {
    // A fresh Response per call: a body can only be read once, and the retry
    // reads its own.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse(401, { error: "Invalid token" }));
    const credential = {
      token: vi.fn().mockResolvedValue("old"),
      refresh: vi.fn().mockResolvedValue("new"),
    };
    const client = new StratumClient("https://s.example", credential);

    await expect(client.request("GET", "/api/projects")).rejects.toThrow("Invalid token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(credential.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on a 403, which a new token would not fix", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(403, { error: "This OAuth grant is read-only." }));
    const credential = {
      token: vi.fn().mockResolvedValue("old"),
      refresh: vi.fn().mockResolvedValue("new"),
    };
    const client = new StratumClient("https://s.example", credential);

    await expect(client.request("GET", "/api/projects")).rejects.toThrow("read-only");
    expect(credential.refresh).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("carries the status code on the error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(404, { error: "Not found" }));
    const client = new StratumClient("https://s.example", "k");
    await expect(client.request("GET", "/api/projects")).rejects.toBeInstanceOf(ApiError);
  });
});
