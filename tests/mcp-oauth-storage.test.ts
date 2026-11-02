/**
 * Issue #349: the OAuth 2.1 authorization server's storage layer.
 *
 * Driven against REAL SQLite with every migration applied, for the same reason
 * `api-tokens.test.ts` is: the behaviour that matters here is decided by the
 * schema and the SQL — the CHECK constraint pinning `code_challenge_method` to
 * S256, the UNIQUE constraints on the token hashes, the conditional UPDATEs
 * that make code redemption and refresh rotation single-use, and the foreign
 * keys the account-deletion cascade has to satisfy. A statement-matching stub
 * would evaluate none of them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_TOKEN_TTL_MS,
  LAST_USED_DEBOUNCE_MS,
  MAX_REDIRECT_URIS,
  REFRESH_GRANT_MAX_MS,
  claimAuthorizationCode,
  deleteOAuthDataForUser,
  getClient,
  isAllowedRedirectUri,
  isValidCodeChallenge,
  issueAuthorizationCode,
  issueTokens,
  listGrantsForUser,
  narrowOAuthScope,
  parseScope,
  readAuthorizationCode,
  redirectUriMatches,
  registerClient,
  resolveOAuthAccessToken,
  revokeGrantForUser,
  revokeGrantsForClientUser,
  revokeToken,
  rotateRefreshToken,
  sweepExpiredAuthorizationCodes,
  touchOAuthTokenLastUsed,
  verifyClientSecret,
  verifyPkce,
} from "../src/storage/oauth";
import { hashToken } from "../src/utils/crypto";
import type { Logger } from "../src/utils/logger";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

/** A real PKCE pair: S256("verifier…") base64url-encoded. Computed at setup
 * rather than hard-coded so the test cannot drift from the implementation's
 * encoding. */
const VERIFIER = "a".repeat(64);
let CHALLENGE: string;

let db: D1Database;
let raw: ReturnType<typeof makeSqliteD1>["raw"];

async function seedUser(id = "usr_1"): Promise<void> {
  await db
    .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
    .bind(id, `${id}@test`, id, await hashToken(`legacy-${id}`))
    .run();
}

async function seedClient(overrides: Partial<{ authMethod: string }> = {}) {
  const result = await registerClient(db, logger, {
    clientName: "Test Editor",
    redirectUris: ["http://127.0.0.1:9000/callback"],
    ...(overrides.authMethod ? { tokenEndpointAuthMethod: overrides.authMethod } : {}),
  });
  if (!result.success) throw new Error("client registration failed in setup");
  return result.data;
}

beforeEach(async () => {
  const made = makeSqliteD1();
  db = made.db;
  raw = made.raw;
  vi.clearAllMocks();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER));
  CHALLENGE = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
});

describe("scope handling", () => {
  it("defaults to read when nothing is requested", () => {
    const result = parseScope(undefined);
    expect(result.success && result.data).toBe("mcp:read");
  });

  it("records the read authority that mcp:write implies", () => {
    const result = parseScope("mcp:write");
    expect(result.success && result.data).toBe("mcp:read mcp:write");
  });

  it("rejects an unknown scope rather than silently dropping it", () => {
    const result = parseScope("mcp:read admin:everything");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("INVALID_SCOPE");
  });

  it("narrows anything without mcp:write to read-only", () => {
    expect(narrowOAuthScope("mcp:read mcp:write")).toBe("read_write");
    expect(narrowOAuthScope("mcp:read")).toBe("read");
    // A malformed row must DOWNGRADE, never escalate.
    expect(narrowOAuthScope("")).toBe("read");
    expect(narrowOAuthScope("garbage")).toBe("read");
    expect(narrowOAuthScope("mcp:writeish")).toBe("read");
  });
});

describe("redirect URI matching", () => {
  const registered = ["http://localhost:9876/callback", "https://editor.example/cb"];

  it("matches a registered URI exactly", () => {
    expect(redirectUriMatches(registered, "http://localhost:9876/callback")).toBe(true);
    expect(redirectUriMatches(registered, "https://editor.example/cb")).toBe(true);
  });

  it("lets a loopback redirect use any port, as RFC 8252 §7.3 requires", () => {
    expect(redirectUriMatches(registered, "http://localhost:41234/callback")).toBe(true);
    expect(redirectUriMatches(registered, "http://localhost/callback")).toBe(true);
    expect(redirectUriMatches(["http://127.0.0.1:1/cb"], "http://127.0.0.1:65000/cb")).toBe(true);
    expect(redirectUriMatches(["http://[::1]:1/cb"], "http://[::1]:2/cb")).toBe(true);
  });

  it("relaxes only the port: host, path, query and scheme still have to be identical", () => {
    // `localhost` and `127.0.0.1` are both loopback, but they are not each other.
    expect(redirectUriMatches(registered, "http://127.0.0.1:9876/callback")).toBe(false);
    expect(redirectUriMatches(registered, "http://localhost:9876/callback/")).toBe(false);
    expect(redirectUriMatches(registered, "http://localhost:9876/other")).toBe(false);
    expect(redirectUriMatches(registered, "http://localhost:9876/callback?x=1")).toBe(false);
    expect(redirectUriMatches(["http://localhost:1/cb?x=1"], "http://localhost:2/cb?x=2")).toBe(
      false,
    );
    expect(redirectUriMatches(registered, "https://localhost:9876/callback")).toBe(false);
    // An https registration never gets the port exception.
    expect(redirectUriMatches(registered, "https://editor.example:8443/cb")).toBe(false);
  });

  it("never admits a URI the registration policy would have refused", () => {
    expect(redirectUriMatches(registered, "http://localhost:1/callback#frag")).toBe(false);
    expect(redirectUriMatches(registered, "http://user:pw@localhost:1/callback")).toBe(false);
    expect(redirectUriMatches(registered, "not a url")).toBe(false);
    expect(redirectUriMatches([], "http://localhost:1/callback")).toBe(false);
  });
});

describe("redirect URI policy", () => {
  it("accepts https and plaintext http on loopback, by IP literal or by name", () => {
    expect(isAllowedRedirectUri("https://editor.example/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:1234/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://[::1]:1234/cb")).toBe(true);
    // Claude Code registers exactly this shape and cannot be told otherwise.
    expect(isAllowedRedirectUri("http://localhost:1234/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost/cb")).toBe(true);
  });

  it("rejects plaintext http on any resolvable host that is not loopback", () => {
    expect(isAllowedRedirectUri("http://editor.example/cb")).toBe(false);
    expect(isAllowedRedirectUri("http://localhost.example/cb")).toBe(false);
    expect(isAllowedRedirectUri("http://127.0.0.2/cb")).toBe(false);
    expect(isAllowedRedirectUri("http://10.0.0.1:1234/cb")).toBe(false);
  });

  it("rejects fragments, embedded credentials, and non-http schemes", () => {
    expect(isAllowedRedirectUri("https://editor.example/cb#frag")).toBe(false);
    expect(isAllowedRedirectUri("https://user:pw@editor.example/cb")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAllowedRedirectUri("not a url")).toBe(false);
  });
});

describe("registerClient", () => {
  it("stores only a hash of a confidential client's secret", async () => {
    const registered = await seedClient({ authMethod: "client_secret_post" });
    expect(registered.clientSecret).toMatch(/^stratum_mcpcs_[0-9a-f]{32}$/);
    const stored = raw.prepare("SELECT client_secret_hash FROM oauth_clients").get() as {
      client_secret_hash: string;
    };
    expect(stored.client_secret_hash).toBe(await hashToken(registered.clientSecret as string));
    expect(stored.client_secret_hash).not.toBe(registered.clientSecret);
  });

  it("issues no secret to a public client", async () => {
    const registered = await seedClient();
    expect(registered.clientSecret).toBeUndefined();
    expect(registered.client.tokenEndpointAuthMethod).toBe("none");
  });

  it("refuses a redirect URI that is not registrable", async () => {
    const result = await registerClient(db, logger, {
      clientName: "Sketchy",
      redirectUris: ["http://evil.example/cb"],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("INVALID_REDIRECT_URI");
  });

  it("bounds the redirect list and the client name", async () => {
    const tooMany = await registerClient(db, logger, {
      clientName: "Greedy",
      redirectUris: Array.from(
        { length: MAX_REDIRECT_URIS + 1 },
        (_, i) => `https://e.example/${i}`,
      ),
    });
    expect(tooMany.success).toBe(false);

    const noName = await registerClient(db, logger, {
      clientName: "   ",
      redirectUris: ["https://e.example/cb"],
    });
    expect(noName.success).toBe(false);
  });
});

describe("verifyClientSecret", () => {
  it("requires a public client to present nothing", async () => {
    const { client } = await seedClient();
    expect(await verifyClientSecret(client, undefined)).toBe(true);
    // A public client cannot pick a mechanism to be judged by.
    expect(await verifyClientSecret(client, "anything")).toBe(false);
  });

  it("checks a confidential client's secret", async () => {
    const registered = await seedClient({ authMethod: "client_secret_post" });
    const loaded = await getClient(db, logger, registered.client.id);
    expect(loaded.success).toBe(true);
    if (!loaded.success) return;
    expect(await verifyClientSecret(loaded.data, registered.clientSecret)).toBe(true);
    expect(
      await verifyClientSecret(loaded.data, "stratum_mcpcs_00000000000000000000000000000000"),
    ).toBe(false);
    expect(await verifyClientSecret(loaded.data, undefined)).toBe(false);
  });
});

describe("PKCE", () => {
  it("verifies a real S256 pair", async () => {
    expect(await verifyPkce(VERIFIER, CHALLENGE)).toBe(true);
  });

  it("rejects the wrong verifier", async () => {
    expect(await verifyPkce("b".repeat(64), CHALLENGE)).toBe(false);
  });

  it("rejects a degenerate verifier outside RFC 7636's length bounds", async () => {
    // Without this, a one-character verifier is a brute-forceable challenge.
    expect(await verifyPkce("a", CHALLENGE)).toBe(false);
    expect(await verifyPkce("a".repeat(200), CHALLENGE)).toBe(false);
    expect(await verifyPkce("", CHALLENGE)).toBe(false);
  });

  it("recognises a well-formed challenge and rejects a malformed one", () => {
    expect(isValidCodeChallenge(CHALLENGE)).toBe(true);
    expect(isValidCodeChallenge("too-short")).toBe(false);
    expect(isValidCodeChallenge(`${CHALLENGE}extra`)).toBe(false);
  });
});

describe("authorization codes", () => {
  async function issue(userId = "usr_1") {
    const { client } = await seedClient();
    const code = await issueAuthorizationCode(db, logger, {
      clientId: client.id,
      userId,
      redirectUri: "http://127.0.0.1:9000/callback",
      scope: "mcp:read mcp:write",
      codeChallenge: CHALLENGE,
      resource: null,
    });
    if (!code.success) throw new Error("issue failed");
    return { client, code: code.data.code };
  }

  it("stores only the hash of the code", async () => {
    await seedUser();
    const { code } = await issue();
    const stored = raw.prepare("SELECT code_hash FROM oauth_auth_codes").get() as {
      code_hash: string;
    };
    expect(stored.code_hash).toBe(await hashToken(code));
    expect(stored.code_hash).not.toBe(code);
  });

  it("reads a code without consuming it, so a failed validation leaves it usable", async () => {
    await seedUser();
    const { code } = await issue();

    const read = await readAuthorizationCode(db, logger, code);
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(read.data.scope).toBe("mcp:read mcp:write");
    expect(read.data.alreadyConsumed).toBe(false);

    // Reading is idempotent: an attacker whose redemption fails validation must
    // not have burned the code for the client that can redeem it.
    const again = await readAuthorizationCode(db, logger, code);
    expect(again.success && again.data.alreadyConsumed).toBe(false);
    expect((await claimAuthorizationCode(db, logger, code)).success).toBe(true);
  });

  it("claims exactly once, and reports a second claim as a replay", async () => {
    await seedUser();
    const { code } = await issue();

    expect((await claimAuthorizationCode(db, logger, code)).success).toBe(true);

    const second = await claimAuthorizationCode(db, logger, code);
    expect(second.success).toBe(false);
    // Distinguished from `not_found` on purpose: a replay means the code leaked,
    // and the caller revokes every token issued from it.
    if (!second.success) expect(second.error).toBe("replayed");

    // And a subsequent read reports the consumption, which is how the route
    // knows whose grants to revoke.
    const read = await readAuthorizationCode(db, logger, code);
    expect(read.success && read.data.alreadyConsumed).toBe(true);
  });

  it("lets only one of two concurrent claims win", async () => {
    await seedUser();
    const { code } = await issue();
    const [a, b] = await Promise.all([
      claimAuthorizationCode(db, logger, code),
      claimAuthorizationCode(db, logger, code),
    ]);
    expect([a.success, b.success].filter(Boolean)).toHaveLength(1);
  });

  it("reports an unknown code as not found", async () => {
    const result = await readAuthorizationCode(db, logger, "stratum_mcpac_deadbeef");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe("not_found");
  });

  it("reports an expired code as expired, outranking consumption", async () => {
    await seedUser();
    const { code } = await issue();
    raw
      .prepare("UPDATE oauth_auth_codes SET expires_at = ?")
      .run(new Date(Date.now() - 1000).toISOString());

    const result = await readAuthorizationCode(db, logger, code);
    expect(result.success).toBe(false);
    // Not "replayed": revoking a user's grants over a code nobody could have
    // redeemed anyway would be a denial of service, not a defence.
    if (!result.success) expect(result.error).toBe("expired");
    const row = raw.prepare("SELECT consumed_at FROM oauth_auth_codes").get() as {
      consumed_at: string | null;
    };
    expect(row.consumed_at).toBeNull();
  });

  it("cannot store a non-S256 challenge method", async () => {
    await seedUser();
    const { client } = await seedClient();
    // The CHECK constraint is the backstop behind the route's validation: a
    // `plain` challenge protects nothing and must be unrepresentable.
    expect(() =>
      raw
        .prepare(
          `INSERT INTO oauth_auth_codes
             (code_hash, client_id, user_id, redirect_uri, scope, code_challenge,
              code_challenge_method, expires_at, created_at)
           VALUES ('h', ?, 'usr_1', 'http://127.0.0.1:9000/callback', 'mcp:read', 'c',
                   'plain', '2030-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run(client.id),
    ).toThrow();
  });
});

describe("tokens", () => {
  async function grant(userId = "usr_1") {
    const { client } = await seedClient();
    const tokens = await issueTokens(db, logger, {
      clientId: client.id,
      userId,
      scope: "mcp:read mcp:write",
    });
    if (!tokens.success) throw new Error("issue failed");
    return { clientId: client.id, ...tokens.data };
  }

  it("stores only hashes, and resolves an access token to its user", async () => {
    await seedUser();
    const issued = await grant();
    expect(issued.accessToken).toMatch(/^stratum_mcp_[0-9a-f]{32}$/);
    expect(issued.refreshToken).toMatch(/^stratum_mcprt_[0-9a-f]{32}$/);
    expect(issued.expiresIn).toBe(Math.floor(ACCESS_TOKEN_TTL_MS / 1000));

    const stored = raw
      .prepare("SELECT access_token_hash, refresh_token_hash FROM oauth_tokens")
      .get() as { access_token_hash: string; refresh_token_hash: string };
    expect(stored.access_token_hash).toBe(await hashToken(issued.accessToken));
    expect(stored.refresh_token_hash).toBe(await hashToken(issued.refreshToken));

    const resolved = await resolveOAuthAccessToken(db, issued.accessToken, logger);
    expect(resolved.success).toBe(true);
    if (!resolved.success) return;
    expect(resolved.data.user.id).toBe("usr_1");
    expect(resolved.data.scope).toBe("read_write");
    expect(resolved.data.clientId).toBe(issued.clientId);
  });

  it("does not resolve a refresh token as an access token", async () => {
    await seedUser();
    const issued = await grant();
    const resolved = await resolveOAuthAccessToken(db, issued.refreshToken, logger);
    expect(resolved.success).toBe(false);
  });

  it("fails closed on a revoked, expired, or deleting-owner grant", async () => {
    await seedUser();

    const revokedGrant = await grant();
    raw.prepare("UPDATE oauth_tokens SET revoked_at = ?").run(new Date().toISOString());
    expect((await resolveOAuthAccessToken(db, revokedGrant.accessToken, logger)).success).toBe(
      false,
    );

    raw.prepare("DELETE FROM oauth_tokens").run();
    const expiredGrant = await grant();
    raw
      .prepare("UPDATE oauth_tokens SET access_expires_at = ?")
      .run(new Date(Date.now() - 1000).toISOString());
    expect((await resolveOAuthAccessToken(db, expiredGrant.accessToken, logger)).success).toBe(
      false,
    );

    raw.prepare("DELETE FROM oauth_tokens").run();
    const liveGrant = await grant();
    raw
      .prepare("UPDATE users SET deleting_at = ? WHERE id = 'usr_1'")
      .run(new Date().toISOString());
    // An account the deletion cascade is erasing must not authenticate through
    // a credential the cascade has not reached yet.
    expect((await resolveOAuthAccessToken(db, liveGrant.accessToken, logger)).success).toBe(false);
  });

  it("fails closed for a SCIM-disabled owner, and resolves again once re-enabled (#253)", async () => {
    await seedUser();
    const live = await grant();
    raw
      .prepare("UPDATE users SET disabled_at = ? WHERE id = 'usr_1'")
      .run(new Date().toISOString());
    expect((await resolveOAuthAccessToken(db, live.accessToken, logger)).success).toBe(false);

    // Disablement is reversible: the same grant works after re-enable.
    raw.prepare("UPDATE users SET disabled_at = NULL WHERE id = 'usr_1'").run();
    expect((await resolveOAuthAccessToken(db, live.accessToken, logger)).success).toBe(true);
  });

  it("rotates a refresh token, retiring the old pair", async () => {
    await seedUser();
    const issued = await grant();

    const rotated = await rotateRefreshToken(db, logger, {
      refreshToken: issued.refreshToken,
      clientId: issued.clientId,
    });
    expect(rotated.success).toBe(true);
    if (!rotated.success) return;
    expect(rotated.data.accessToken).not.toBe(issued.accessToken);
    expect(rotated.data.refreshToken).not.toBe(issued.refreshToken);
    // The grant keeps ONE row across rotations, so revoking it stays one update.
    const count = raw.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").get() as { n: number };
    expect(Number(count.n)).toBe(1);

    // The retired access token is dead, and the new one works.
    expect((await resolveOAuthAccessToken(db, issued.accessToken, logger)).success).toBe(false);
    expect((await resolveOAuthAccessToken(db, rotated.data.accessToken, logger)).success).toBe(
      true,
    );

    // Presenting the retired REFRESH token is a separate matter: it is a reuse
    // signal, and it takes the whole grant down with it. That consequence is
    // covered in "refresh-token reuse detection" below; here we assert only
    // that the rotation itself fails.
    expect(
      (
        await rotateRefreshToken(db, logger, {
          refreshToken: issued.refreshToken,
          clientId: issued.clientId,
        })
      ).success,
    ).toBe(false);
  });

  it("refuses to rotate a refresh token for a different client", async () => {
    await seedUser();
    const issued = await grant();
    const other = await seedClient();
    // Without this bind, any registered client could redeem a leaked refresh
    // token and be handed a working access token for someone else's account.
    const rotated = await rotateRefreshToken(db, logger, {
      refreshToken: issued.refreshToken,
      clientId: other.client.id,
    });
    expect(rotated.success).toBe(false);
  });

  it("revokes the whole grant from either half of the pair", async () => {
    await seedUser();
    for (const half of ["accessToken", "refreshToken"] as const) {
      raw.prepare("DELETE FROM oauth_tokens").run();
      const issued = await grant();
      await revokeToken(db, logger, { token: issued[half] });
      expect((await resolveOAuthAccessToken(db, issued.accessToken, logger)).success).toBe(false);
      expect(
        (
          await rotateRefreshToken(db, logger, {
            refreshToken: issued.refreshToken,
            clientId: issued.clientId,
          })
        ).success,
      ).toBe(false);
    }
  });

  it("confines a client-authenticated revocation to that client's grants", async () => {
    await seedUser();
    const mine = await grant();
    const other = await seedClient();
    const result = await revokeToken(db, logger, {
      token: mine.accessToken,
      clientId: other.client.id,
    });
    expect(result.success && result.data.revoked).toBe(false);
    expect((await resolveOAuthAccessToken(db, mine.accessToken, logger)).success).toBe(true);
  });
});

describe("refresh-token reuse detection", () => {
  async function grant(userId = "usr_1") {
    const { client } = await seedClient();
    const tokens = await issueTokens(db, logger, {
      clientId: client.id,
      userId,
      scope: "mcp:read mcp:write",
    });
    if (!tokens.success) throw new Error("issue failed");
    return { clientId: client.id, ...tokens.data };
  }

  it("revokes the whole grant when a RETIRED refresh token is presented", async () => {
    await seedUser();
    const issued = await grant();

    const rotated = await rotateRefreshToken(db, logger, {
      refreshToken: issued.refreshToken,
      clientId: issued.clientId,
    });
    expect(rotated.success).toBe(true);
    if (!rotated.success) return;

    // The rotated-away token is now a compromise signal, not merely an unknown
    // string: two parties hold it and only one is the rightful client
    // (OAuth 2.1 §4.3.1, RFC 9700 §4.14).
    const reused = await rotateRefreshToken(db, logger, {
      refreshToken: issued.refreshToken,
      clientId: issued.clientId,
    });
    expect(reused.success).toBe(false);

    // So the CURRENT pair — which the thief may also hold — dies too.
    expect((await resolveOAuthAccessToken(db, rotated.data.accessToken, logger)).success).toBe(
      false,
    );
    expect(
      (
        await rotateRefreshToken(db, logger, {
          refreshToken: rotated.data.refreshToken,
          clientId: issued.clientId,
        })
      ).success,
    ).toBe(false);
  });

  it("caps the sliding refresh window at the grant's absolute lifetime", async () => {
    await seedUser();
    const issued = await grant();

    // A grant first issued long ago. Without the cap, this rotation would push
    // its expiry another 30 days out and the grant would never end.
    const longAgo = new Date(Date.now() - REFRESH_GRANT_MAX_MS + 60_000).toISOString();
    raw.prepare("UPDATE oauth_tokens SET created_at = ?").run(longAgo);

    const rotated = await rotateRefreshToken(db, logger, {
      refreshToken: issued.refreshToken,
      clientId: issued.clientId,
    });
    expect(rotated.success).toBe(true);

    const row = raw.prepare("SELECT refresh_expires_at FROM oauth_tokens").get() as {
      refresh_expires_at: string;
    };
    // Clamped to created_at + the absolute max, roughly a minute from now,
    // rather than the full sliding window.
    const remaining = Date.parse(row.refresh_expires_at) - Date.now();
    expect(remaining).toBeLessThan(5 * 60_000);
    expect(remaining).toBeGreaterThan(0);
  });

  it("still slides normally for a young grant", async () => {
    await seedUser();
    const issued = await grant();
    const rotated = await rotateRefreshToken(db, logger, {
      refreshToken: issued.refreshToken,
      clientId: issued.clientId,
    });
    expect(rotated.success).toBe(true);
    const row = raw.prepare("SELECT refresh_expires_at FROM oauth_tokens").get() as {
      refresh_expires_at: string;
    };
    const remaining = Date.parse(row.refresh_expires_at) - Date.now();
    expect(remaining).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
  });
});

describe("revokeGrantsForClientUser", () => {
  it("kills every live grant for one client/user pair and no others", async () => {
    await seedUser("usr_1");
    await seedUser("usr_2");
    const { client } = await seedClient();
    const other = await seedClient();

    const mineFirst = await issueTokens(db, logger, {
      clientId: client.id,
      userId: "usr_1",
      scope: "mcp:read",
    });
    const mineSecond = await issueTokens(db, logger, {
      clientId: client.id,
      userId: "usr_1",
      scope: "mcp:read",
    });
    const sameClientOtherUser = await issueTokens(db, logger, {
      clientId: client.id,
      userId: "usr_2",
      scope: "mcp:read",
    });
    const otherClientSameUser = await issueTokens(db, logger, {
      clientId: other.client.id,
      userId: "usr_1",
      scope: "mcp:read",
    });
    if (
      !mineFirst.success ||
      !mineSecond.success ||
      !sameClientOtherUser.success ||
      !otherClientSameUser.success
    ) {
      throw new Error("setup failed");
    }

    await revokeGrantsForClientUser(db, logger, { clientId: client.id, userId: "usr_1" });

    // Every grant this client holds for this user — the code-replay response
    // has to cover the ones already issued, not just the one being redeemed.
    for (const dead of [mineFirst, mineSecond]) {
      expect((await resolveOAuthAccessToken(db, dead.data.accessToken, logger)).success).toBe(
        false,
      );
    }
    // And nothing beyond that pair.
    expect(
      (await resolveOAuthAccessToken(db, sameClientOtherUser.data.accessToken, logger)).success,
    ).toBe(true);
    expect(
      (await resolveOAuthAccessToken(db, otherClientSameUser.data.accessToken, logger)).success,
    ).toBe(true);
  });
});

describe("touchOAuthTokenLastUsed", () => {
  async function seedGrant(): Promise<string> {
    await seedUser();
    const { client } = await seedClient();
    const tokens = await issueTokens(db, logger, {
      clientId: client.id,
      userId: "usr_1",
      scope: "mcp:read",
    });
    if (!tokens.success) throw new Error("issue failed");
    const row = raw.prepare("SELECT id FROM oauth_tokens").get() as { id: string };
    return row.id;
  }

  function storedLastUsed(): string | null {
    return (
      raw.prepare("SELECT last_used_at FROM oauth_tokens").get() as {
        last_used_at: string | null;
      }
    ).last_used_at;
  }

  it("writes when there is no previous value", async () => {
    const grantId = await seedGrant();
    await touchOAuthTokenLastUsed(db, logger, { grantId });
    expect(storedLastUsed()).not.toBeNull();
  });

  it("skips the write inside the debounce window", async () => {
    const grantId = await seedGrant();
    const recent = new Date(Date.now() - 60_000).toISOString();
    raw.prepare("UPDATE oauth_tokens SET last_used_at = ?").run(recent);

    // Without the debounce every authenticated MCP call carries a D1 write.
    await touchOAuthTokenLastUsed(db, logger, { grantId, lastUsedAt: recent });
    expect(storedLastUsed()).toBe(recent);
  });

  it("writes once the debounce window has passed", async () => {
    const grantId = await seedGrant();
    const stale = new Date(Date.now() - LAST_USED_DEBOUNCE_MS - 60_000).toISOString();
    raw.prepare("UPDATE oauth_tokens SET last_used_at = ?").run(stale);

    await touchOAuthTokenLastUsed(db, logger, { grantId, lastUsedAt: stale });
    expect(storedLastUsed()).not.toBe(stale);
  });

  it("writes when the previous value is unparseable, repairing the row", async () => {
    const grantId = await seedGrant();
    raw.prepare("UPDATE oauth_tokens SET last_used_at = ?").run("not-a-date");
    // Freezing the row forever would be the alternative, and it is worse.
    await touchOAuthTokenLastUsed(db, logger, { grantId, lastUsedAt: "not-a-date" });
    expect(storedLastUsed()).not.toBe("not-a-date");
  });
});

describe("grants a user can see and revoke", () => {
  it("lists live grants and hides revoked ones", async () => {
    await seedUser();
    const { client } = await seedClient();
    const issued = await issueTokens(db, logger, {
      clientId: client.id,
      userId: "usr_1",
      scope: "mcp:read",
    });
    expect(issued.success).toBe(true);

    const listed = await listGrantsForUser(db, logger, "usr_1");
    expect(listed.success).toBe(true);
    if (!listed.success) return;
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]?.clientName).toBe("Test Editor");

    await revokeGrantForUser(db, logger, { grantId: listed.data[0]?.id ?? "", userId: "usr_1" });
    const after = await listGrantsForUser(db, logger, "usr_1");
    expect(after.success && after.data).toHaveLength(0);
  });

  it("keeps a grant listed while only its access token has lapsed", async () => {
    await seedUser();
    const { client } = await seedClient();
    await issueTokens(db, logger, { clientId: client.id, userId: "usr_1", scope: "mcp:read" });
    // The refresh token outlives the access token by design; a grant that is
    // still refreshable is still connected.
    raw
      .prepare("UPDATE oauth_tokens SET access_expires_at = ?")
      .run(new Date(Date.now() - 1000).toISOString());
    const listed = await listGrantsForUser(db, logger, "usr_1");
    expect(listed.success && listed.data).toHaveLength(1);
  });

  it("will not revoke another account's grant", async () => {
    await seedUser("usr_1");
    await seedUser("usr_2");
    const { client } = await seedClient();
    await issueTokens(db, logger, { clientId: client.id, userId: "usr_1", scope: "mcp:read" });
    const listed = await listGrantsForUser(db, logger, "usr_1");
    if (!listed.success) throw new Error("listing failed");

    const attempt = await revokeGrantForUser(db, logger, {
      grantId: listed.data[0]?.id ?? "",
      userId: "usr_2",
    });
    expect(attempt.success && attempt.data.revoked).toBe(false);
    expect((await listGrantsForUser(db, logger, "usr_1")).success).toBe(true);
  });
});

describe("account deletion", () => {
  it("clears the rows that would otherwise block the users delete", async () => {
    await seedUser();
    const { client } = await seedClient();
    await issueTokens(db, logger, { clientId: client.id, userId: "usr_1", scope: "mcp:read" });
    await issueAuthorizationCode(db, logger, {
      clientId: client.id,
      userId: "usr_1",
      redirectUri: "http://127.0.0.1:9000/callback",
      scope: "mcp:read",
      codeChallenge: CHALLENGE,
      resource: null,
    });

    await deleteOAuthDataForUser(db, "usr_1");

    // Both tables carry a user_id REFERENCES users(id); a row left behind makes
    // the cascade's final DELETE throw and erasure never completes.
    expect(
      Number((raw.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").get() as { n: number }).n),
    ).toBe(0);
    expect(
      Number((raw.prepare("SELECT COUNT(*) AS n FROM oauth_auth_codes").get() as { n: number }).n),
    ).toBe(0);
    expect(() => raw.prepare("DELETE FROM users WHERE id = 'usr_1'").run()).not.toThrow();
  });
});

describe("code correlation and sweep (#355)", () => {
  async function mint(clientId: string) {
    const issued = await issueAuthorizationCode(db, logger, {
      clientId,
      userId: "usr_1",
      redirectUri: "http://127.0.0.1:9000/callback",
      scope: "mcp:read",
      codeChallenge: CHALLENGE,
      resource: null,
    });
    if (!issued.success) throw new Error("issue failed");
    return issued.data;
  }

  it("returns a code id that the redemption lookup reports back", async () => {
    await seedUser();
    const { client } = await seedClient();
    const issued = await mint(client.id);
    // Twelve hex digits of the hash: enough to join two log lines, useless for
    // redeeming the code, which needs the plaintext.
    expect(issued.codeId).toMatch(/^[0-9a-f]{12}$/);
    const read = await readAuthorizationCode(db, logger, issued.code);
    expect(read.success).toBe(true);
    if (read.success) expect(read.data.codeId).toBe(issued.codeId);
    expect(logger.info).toHaveBeenCalledWith(
      "Authorization code issued",
      expect.objectContaining({ codeId: issued.codeId }),
    );
  });

  it("sweeps expired codes and counts the ones nobody redeemed", async () => {
    await seedUser();
    const { client } = await seedClient();
    const unredeemed = await mint(client.id);
    const redeemed = await mint(client.id);
    const live = await mint(client.id);
    await claimAuthorizationCode(db, logger, redeemed.code);
    raw
      .prepare("UPDATE oauth_auth_codes SET expires_at = ? WHERE code_hash IN (?, ?)")
      .run(
        new Date(Date.now() - 1000).toISOString(),
        await hashToken(unredeemed.code),
        await hashToken(redeemed.code),
      );

    const result = await sweepExpiredAuthorizationCodes(db, logger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        deleted: 2,
        unredeemed: 1,
        unredeemedByClient: { [client.id]: 1 },
      });
    }
    // The signal: consent happened, delivery did not.
    expect(logger.warn).toHaveBeenCalledWith(
      "Authorization codes expired unredeemed",
      expect.objectContaining({ unredeemed: 1 }),
    );
    // Only the live code remains, and it still redeems.
    const remaining = raw.prepare("SELECT COUNT(*) AS n FROM oauth_auth_codes").get() as {
      n: number;
    };
    expect(remaining.n).toBe(1);
    expect((await readAuthorizationCode(db, logger, live.code)).success).toBe(true);
  });

  it("is a no-op on a table with nothing expired", async () => {
    await seedUser();
    const { client } = await seedClient();
    await mint(client.id);
    const result = await sweepExpiredAuthorizationCodes(db, logger);
    expect(result.success && result.data.deleted).toBe(0);
  });
});
