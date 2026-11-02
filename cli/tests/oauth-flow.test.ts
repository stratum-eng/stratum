import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionExpiredError,
  assertSecureHost,
  discover,
  expiresAtFrom,
  listenForCallback,
  refreshTokens,
} from "../src/oauth.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const validMetadata = {
  issuer: "https://s.example",
  authorization_endpoint: "https://s.example/oauth/authorize",
  token_endpoint: "https://s.example/oauth/token",
  registration_endpoint: "https://s.example/oauth/register",
  revocation_endpoint: "https://s.example/oauth/revoke",
};

describe("transport security", () => {
  it("accepts https", () => {
    expect(assertSecureHost("https://s.example").origin).toBe("https://s.example");
  });

  it("accepts plaintext loopback, where there is no wire to sniff", () => {
    expect(() => assertSecureHost("http://127.0.0.1:8787")).not.toThrow();
    expect(() => assertSecureHost("http://localhost:8787")).not.toThrow();
  });

  it("refuses plaintext to a remote host", () => {
    expect(() => assertSecureHost("http://s.example")).toThrow(/plaintext/);
  });

  it("refuses a malformed host", () => {
    expect(() => assertSecureHost("not a url")).toThrow(/not a valid URL/);
  });
});

describe("discovery document validation", () => {
  it("accepts a well-formed same-origin document", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(validMetadata));
    await expect(discover("https://s.example")).resolves.toMatchObject({
      token_endpoint: "https://s.example/oauth/token",
    });
  });

  it("refuses a token endpoint on another origin", async () => {
    // The credential-exfiltration case: this endpoint receives the auth code,
    // the PKCE verifier and the refresh token.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ ...validMetadata, token_endpoint: "https://evil.example/oauth/token" }),
    );
    await expect(discover("https://s.example")).rejects.toThrow(/off-origin/);
  });

  it("refuses an off-origin authorization endpoint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ ...validMetadata, authorization_endpoint: "https://evil.example/go" }),
    );
    await expect(discover("https://s.example")).rejects.toThrow(/off-origin/);
  });

  it("refuses a document claiming a different issuer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ ...validMetadata, issuer: "https://evil.example" }),
    );
    await expect(discover("https://s.example")).rejects.toThrow(/claims issuer/);
  });

  it("reports a helpful error when the host answers HTML, not a JSON parse error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<!doctype html><title>Login</title>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    const failure = await discover("https://s.example").catch((err: Error) => err);
    expect((failure as Error).message).toMatch(/does not advertise OAuth/);
    // Not a raw parser error naming a stray "<", which tells the user nothing.
    expect((failure as Error).message).not.toMatch(/Unexpected token/);
  });

  it("names --key when the host has no OAuth at all", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "nope" }, 404));
    await expect(discover("https://s.example")).rejects.toThrow(/--key/);
  });
});

describe("loopback callback listener", () => {
  // `Connection: close` keeps undici from holding a keep-alive socket open past
  // server.close(), which surfaces as a spurious parser error after the test.
  async function get(port: number, path: string): Promise<number> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { Connection: "close" },
    });
    await response.arrayBuffer();
    return response.status;
  }

  it("accepts a matching state and yields the code", async () => {
    const listener = await listenForCallback("st4te");
    try {
      await get(listener.port, "/callback?code=abc&state=st4te");
      await expect(listener.code).resolves.toEqual({ code: "abc" });
    } finally {
      listener.close();
    }
  });

  it("ignores a stray request instead of aborting the login", async () => {
    // Any page the user has open can hit a loopback port. Treating that as fatal
    // would let any of them cancel a login in progress.
    const listener = await listenForCallback("st4te");
    try {
      expect(await get(listener.port, "/callback?code=evil&state=wrong")).toBe(400);
      expect(await get(listener.port, "/callback")).toBe(400);
      expect(await get(listener.port, "/somewhere-else")).toBe(404);

      // Still listening: the real callback still completes.
      await get(listener.port, "/callback?code=real&state=st4te");
      await expect(listener.code).resolves.toEqual({ code: "real" });
    } finally {
      listener.close();
    }
  });

  it("keeps listening after a matching state with no code", async () => {
    const listener = await listenForCallback("st4te");
    try {
      expect(await get(listener.port, "/callback?state=st4te")).toBe(400);
      await get(listener.port, "/callback?code=real&state=st4te");
      await expect(listener.code).resolves.toEqual({ code: "real" });
    } finally {
      listener.close();
    }
  });

  it("surfaces an explicit denial", async () => {
    const listener = await listenForCallback("st4te");
    try {
      // Attach the handler BEFORE the request lands: the rejection happens while
      // `get` is in flight, and an unobserved rejection trips Node's handler.
      const rejected = expect(listener.code).rejects.toThrow(/access_denied/);
      await get(listener.port, "/callback?error=access_denied&state=st4te");
      await rejected;
    } finally {
      listener.close();
    }
  });

  it("does not let a mismatched state deliver a denial either", async () => {
    const listener = await listenForCallback("st4te");
    try {
      expect(await get(listener.port, "/callback?error=access_denied&state=wrong")).toBe(400);
      await get(listener.port, "/callback?code=real&state=st4te");
      await expect(listener.code).resolves.toEqual({ code: "real" });
    } finally {
      listener.close();
    }
  });

  it("binds loopback only", async () => {
    const listener = await listenForCallback("st4te");
    try {
      expect(listener.port).toBeGreaterThan(0);
    } finally {
      listener.close();
    }
  });
});

describe("expiry arithmetic", () => {
  it("treats a missing expires_in as already expired", () => {
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    expect(expiresAtFrom(undefined, now)).toBe(new Date(now).toISOString());
  });
});

describe("token response validation", () => {
  it("keeps a junk expires_in from throwing after the token is already rotated", () => {
    // This runs after the server has retired the presented refresh token, so a
    // throw here loses the rotated one and silently ends the session.
    for (const junk of ["not-a-number", {}, [], null, Number.NaN, 1e18, -5]) {
      expect(() => expiresAtFrom(junk)).not.toThrow();
    }
    expect(expiresAtFrom("not-a-number", 0)).toBe(new Date(0).toISOString());
  });

  it("honours a sane expires_in", () => {
    expect(expiresAtFrom(3600, 0)).toBe(new Date(3_600_000).toISOString());
  });

  it("clamps an absurd expires_in instead of producing an invalid date", () => {
    expect(() => new Date(expiresAtFrom(1e18, 0)).toISOString()).not.toThrow();
  });
});

describe("loopback binding", () => {
  it("binds 127.0.0.1, not every interface", async () => {
    const listener = await listenForCallback("st4te");
    try {
      expect(listener.address).toBe("127.0.0.1");
    } finally {
      listener.close();
    }
  });
});

describe("refresh failure classification", () => {
  const metadata = {
    issuer: "https://s.example",
    authorization_endpoint: "https://s.example/oauth/authorize",
    token_endpoint: "https://s.example/oauth/token",
  };
  const params = { clientId: "c1", refreshToken: "stratum_mcprt_r", metadata };

  function tokenEndpoint(body: unknown, status: number): void {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(body, status));
  }

  it("treats invalid_grant as an expired session", async () => {
    tokenEndpoint({ error: "invalid_grant" }, 400);
    await expect(refreshTokens("https://s.example", params)).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it("treats invalid_client as an expired session", async () => {
    tokenEndpoint({ error: "invalid_client" }, 401);
    await expect(refreshTokens("https://s.example", params)).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it("does NOT tell the user to log in again after a transient 503", async () => {
    // Re-authenticating cannot fix a server fault, and "session expired" sends
    // the user to do exactly that.
    tokenEndpoint({ error: "temporarily_unavailable" }, 503);
    const failure = await refreshTokens("https://s.example", params).catch((err: Error) => err);
    expect(failure).not.toBeInstanceOf(SessionExpiredError);
    expect((failure as Error).message).toMatch(/could not refresh/);
  });

  it("does NOT tell the user to log in again after a 429", async () => {
    tokenEndpoint({ error: "slow_down" }, 429);
    const failure = await refreshTokens("https://s.example", params).catch((err: Error) => err);
    expect(failure).not.toBeInstanceOf(SessionExpiredError);
  });

  it("rejects a non-string access_token rather than sending `Bearer 12345`", async () => {
    tokenEndpoint({ access_token: 12345, refresh_token: 678, expires_in: 3600 }, 200);
    await expect(refreshTokens("https://s.example", params)).rejects.toThrow(/could not refresh/);
  });

  it("accepts a well-formed rotation", async () => {
    tokenEndpoint(
      { access_token: "stratum_mcp_new", refresh_token: "stratum_mcprt_new", expires_in: 3600 },
      200,
    );
    await expect(refreshTokens("https://s.example", params)).resolves.toMatchObject({
      accessToken: "stratum_mcp_new",
      refreshToken: "stratum_mcprt_new",
    });
  });
});
