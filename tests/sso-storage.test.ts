import { describe, expect, it, vi } from "vitest";
import {
  PUBLIC_EMAIL_DOMAINS,
  deleteSsoConnection,
  findVerifiedDomainConflicts,
  getSsoConnectionById,
  getSsoConnectionByOrgId,
  getSsoConnectionByOrgSlug,
  getSsoConnectionByVerifiedDomain,
  normalizeEmailDomains,
  reenableUsersForConnectionRemoval,
  rotateScimToken,
  setSsoConnectionEnabled,
  setSsoDomainsVerified,
  upsertSsoConnection,
} from "../src/storage/sso";
import { SSO_SECRET_SALT, decryptToken, encryptToken, hashToken } from "../src/utils/crypto";
import type { Logger } from "../src/utils/logger";
import { makeSqliteD1, makeThrowingD1 } from "./helpers/sqlite-d1";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

type Raw = ReturnType<typeof makeSqliteD1>["raw"];

function seedUser(raw: Raw, id: string): void {
  raw
    .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
    .run(id, `${id}@example.com`, id.replace(/_/g, "-"), `hash_${id}`);
}

function seedOrg(raw: Raw, id: string, slug: string, ownerId: string): void {
  raw
    .prepare("INSERT INTO orgs (id, name, slug, owner_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, slug, slug, ownerId, new Date().toISOString());
}

async function seedConnection(
  db: D1Database,
  orgId: string,
  emailDomains: string[] = ["corp.example.com"],
) {
  const result = await upsertSsoConnection(db, mockLogger, {
    orgId,
    issuer: "https://idp.example.com",
    clientId: "client-123",
    clientSecretCiphertext: "ciphertext",
    authorizationEndpoint: "https://idp.example.com/authorize",
    tokenEndpoint: "https://idp.example.com/token",
    jwksUri: "https://idp.example.com/jwks",
    emailDomains,
  });
  if (!result.success) throw new Error("seedConnection failed");
  return result.data.connection;
}

function setup() {
  const { db, raw } = makeSqliteD1();
  seedUser(raw, "usr_owner");
  seedOrg(raw, "org_1", "acme", "usr_owner");
  return { db, raw };
}

describe("normalizeEmailDomains", () => {
  it("lowercases, trims, and dedupes", () => {
    const result = normalizeEmailDomains([" Corp.Example.COM ", "corp.example.com", "b.example"]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(["corp.example.com", "b.example"]);
  });

  it("rejects an empty list", () => {
    const result = normalizeEmailDomains([]);
    expect(result.success).toBe(false);
  });

  it("rejects malformed domains", () => {
    for (const bad of ["no-dot", "-x.example.com", "a..b", "corp example.com"]) {
      const result = normalizeEmailDomains([bad]);
      expect(result.success, `'${bad}' must be rejected`).toBe(false);
    }
  });

  it("caps domains at 240 octets (room for the `_stratum-sso.` DoH prefix)", () => {
    const base = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}`;
    const at240 = `${base}.${"d".repeat(48)}`;
    const at241 = `${base}.${"d".repeat(49)}`;
    expect(at240.length).toBe(240);
    expect(normalizeEmailDomains([at240]).success).toBe(true);
    expect(normalizeEmailDomains([at241]).success).toBe(false);
  });

  it("rejects a domain with a label over 63 octets", () => {
    const result = normalizeEmailDomains([`${"a".repeat(64)}.example.com`]);
    expect(result.success).toBe(false);
  });

  it("rejects every deny-listed public email domain", () => {
    for (const domain of PUBLIC_EMAIL_DOMAINS) {
      const result = normalizeEmailDomains([domain]);
      expect(result.success, `'${domain}' must be deny-listed`).toBe(false);
      if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("upsertSsoConnection", () => {
  it("creates a connection with a verification token, disabled and unverified", async () => {
    const { db } = setup();
    const connection = await seedConnection(db, "org_1");

    expect(connection.enabled).toBe(false);
    expect(connection.domainsVerifiedAt).toBeNull();
    expect(connection.domainVerificationToken).toMatch(/^[0-9a-f]{32}$/);
    expect(connection.scimTokenHash).toBeNull();

    const fetched = await getSsoConnectionByOrgId(db, mockLogger, "org_1");
    expect(fetched.success).toBe(true);
    if (fetched.success) expect(fetched.data.id).toBe(connection.id);
  });

  it("replace keeps verification and enabled state when domains are unchanged", async () => {
    const { db } = setup();
    const created = await seedConnection(db, "org_1");
    await setSsoDomainsVerified(db, mockLogger, created.id, created.emailDomains);
    await setSsoConnectionEnabled(db, mockLogger, created.id, true);

    const replaced = await upsertSsoConnection(db, mockLogger, {
      orgId: "org_1",
      issuer: "https://other-idp.example.com",
      clientId: "client-456",
      clientSecretCiphertext: "new-ciphertext",
      authorizationEndpoint: "https://other-idp.example.com/authorize",
      tokenEndpoint: "https://other-idp.example.com/token",
      jwksUri: "https://other-idp.example.com/jwks",
      emailDomains: ["corp.example.com"],
    });
    expect(replaced.success).toBe(true);
    if (!replaced.success) return;
    expect(replaced.data.created).toBe(false);
    expect(replaced.data.connection.id).toBe(created.id);
    expect(replaced.data.connection.domainsVerifiedAt).not.toBeNull();
    expect(replaced.data.connection.enabled).toBe(true);
    expect(replaced.data.connection.domainVerificationToken).toBe(created.domainVerificationToken);
  });

  it("editing email domains clears verification, disables, and keeps the token", async () => {
    const { db } = setup();
    const created = await seedConnection(db, "org_1");
    await setSsoDomainsVerified(db, mockLogger, created.id, created.emailDomains);
    await setSsoConnectionEnabled(db, mockLogger, created.id, true);

    const replaced = await upsertSsoConnection(db, mockLogger, {
      orgId: "org_1",
      issuer: created.issuer,
      clientId: created.clientId,
      clientSecretCiphertext: created.clientSecretCiphertext,
      authorizationEndpoint: created.authorizationEndpoint,
      tokenEndpoint: created.tokenEndpoint,
      jwksUri: created.jwksUri,
      emailDomains: ["new-domain.example.com"],
    });
    expect(replaced.success).toBe(true);
    if (!replaced.success) return;
    expect(replaced.data.connection.domainsVerifiedAt).toBeNull();
    expect(replaced.data.connection.enabled).toBe(false);
    expect(replaced.data.connection.domainVerificationToken).toBe(created.domainVerificationToken);

    const fetched = await getSsoConnectionById(db, mockLogger, created.id);
    expect(fetched.success).toBe(true);
    if (fetched.success) {
      expect(fetched.data.domainsVerifiedAt).toBeNull();
      expect(fetched.data.enabled).toBe(false);
    }
  });

  it("replace regenerates a verification token for a pre-042 row with NULL token", async () => {
    const { db, raw } = setup();
    const created = await seedConnection(db, "org_1");
    raw
      .prepare("UPDATE org_sso_connections SET domain_verification_token = NULL WHERE id = ?")
      .run(created.id);

    const replaced = await upsertSsoConnection(db, mockLogger, {
      orgId: "org_1",
      issuer: created.issuer,
      clientId: created.clientId,
      clientSecretCiphertext: created.clientSecretCiphertext,
      authorizationEndpoint: created.authorizationEndpoint,
      tokenEndpoint: created.tokenEndpoint,
      jwksUri: created.jwksUri,
      emailDomains: ["corp.example.com"],
    });
    expect(replaced.success).toBe(true);
    if (!replaced.success) return;
    expect(replaced.data.connection.domainVerificationToken).toMatch(/^[0-9a-f]{32}$/);

    const row = raw
      .prepare("SELECT domain_verification_token FROM org_sso_connections WHERE id = ?")
      .get(created.id) as { domain_verification_token: string | null };
    expect(row.domain_verification_token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns STORAGE_ERROR when the database fails", async () => {
    const result = await upsertSsoConnection(makeThrowingD1(), mockLogger, {
      orgId: "org_1",
      issuer: "https://idp.example.com",
      clientId: "c",
      clientSecretCiphertext: "ct",
      authorizationEndpoint: "https://idp.example.com/a",
      tokenEndpoint: "https://idp.example.com/t",
      jwksUri: "https://idp.example.com/j",
      emailDomains: ["corp.example.com"],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("STORAGE_ERROR");
  });
});

describe("connection resolution", () => {
  it("resolves by org slug via join", async () => {
    const { db } = setup();
    const connection = await seedConnection(db, "org_1");
    const bySlug = await getSsoConnectionByOrgSlug(db, mockLogger, "acme");
    expect(bySlug.success).toBe(true);
    if (bySlug.success) expect(bySlug.data.id).toBe(connection.id);

    const missing = await getSsoConnectionByOrgSlug(db, mockLogger, "no-such-org");
    expect(missing.success).toBe(false);
    if (!missing.success) expect(missing.error.code).toBe("NOT_FOUND");
  });

  it("resolves by verified email domain only when verified (and enabled by default)", async () => {
    const { db } = setup();
    const connection = await seedConnection(db, "org_1");

    // Unverified: never resolvable by domain.
    let byDomain = await getSsoConnectionByVerifiedDomain(db, mockLogger, "corp.example.com");
    expect(byDomain.success).toBe(false);

    await setSsoDomainsVerified(db, mockLogger, connection.id, connection.emailDomains);

    // Verified but disabled: hidden from enabled-only callers…
    byDomain = await getSsoConnectionByVerifiedDomain(db, mockLogger, "corp.example.com");
    expect(byDomain.success).toBe(false);

    // …but visible when the caller does not require enabled.
    byDomain = await getSsoConnectionByVerifiedDomain(db, mockLogger, "CORP.example.com", {
      requireEnabled: false,
    });
    expect(byDomain.success).toBe(true);

    await setSsoConnectionEnabled(db, mockLogger, connection.id, true);
    byDomain = await getSsoConnectionByVerifiedDomain(db, mockLogger, "corp.example.com");
    expect(byDomain.success).toBe(true);
    if (byDomain.success) expect(byDomain.data.id).toBe(connection.id);
  });
});

describe("malformed stored email_domains", () => {
  it("parses to an empty domain list instead of crashing", async () => {
    const { db, raw } = setup();
    const created = await seedConnection(db, "org_1");
    raw
      .prepare("UPDATE org_sso_connections SET email_domains = 'not-json' WHERE id = ?")
      .run(created.id);

    const fetched = await getSsoConnectionById(db, mockLogger, created.id);
    expect(fetched.success).toBe(true);
    if (fetched.success) expect(fetched.data.emailDomains).toEqual([]);
  });
});

describe("findVerifiedDomainConflicts", () => {
  it("reports domains verified by another connection and ignores its own", async () => {
    const { db, raw } = setup();
    seedUser(raw, "usr_other");
    seedOrg(raw, "org_2", "other", "usr_other");

    const first = await seedConnection(db, "org_1", ["corp.example.com"]);
    await setSsoDomainsVerified(db, mockLogger, first.id, first.emailDomains);
    const second = await seedConnection(db, "org_2", ["corp.example.com", "unique.example.com"]);

    const conflicts = await findVerifiedDomainConflicts(
      db,
      mockLogger,
      second.emailDomains,
      second.id,
    );
    expect(conflicts.success).toBe(true);
    if (conflicts.success) expect(conflicts.data).toEqual(["corp.example.com"]);

    // The first connection checking its own domains sees no conflict.
    const own = await findVerifiedDomainConflicts(db, mockLogger, first.emailDomains, first.id);
    expect(own.success).toBe(true);
    if (own.success) expect(own.data).toEqual([]);
  });
});

describe("setSsoDomainsVerified", () => {
  it("refuses to stamp when the stored domain list is not the one checked", async () => {
    const { db, raw } = setup();
    const connection = await seedConnection(db, "org_1");

    const result = await setSsoDomainsVerified(db, mockLogger, connection.id, [
      "never-checked.example.com",
    ]);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("CONFLICT");

    const row = raw
      .prepare("SELECT domains_verified_at FROM org_sso_connections WHERE id = ?")
      .get(connection.id) as { domains_verified_at: string | null };
    expect(row.domains_verified_at).toBeNull();
  });

  it("returns NOT_FOUND for a missing connection", async () => {
    const { db } = setup();
    const result = await setSsoDomainsVerified(db, mockLogger, "ssoc_missing", [
      "corp.example.com",
    ]);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("NOT_FOUND");
  });
});

describe("setSsoConnectionEnabled", () => {
  it("refuses to enable an unverified connection (SQL guard)", async () => {
    const { db } = setup();
    const connection = await seedConnection(db, "org_1");
    const result = await setSsoConnectionEnabled(db, mockLogger, connection.id, true);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("enables once verified and disables again", async () => {
    const { db } = setup();
    const connection = await seedConnection(db, "org_1");
    await setSsoDomainsVerified(db, mockLogger, connection.id, connection.emailDomains);

    expect((await setSsoConnectionEnabled(db, mockLogger, connection.id, true)).success).toBe(true);
    let fetched = await getSsoConnectionById(db, mockLogger, connection.id);
    if (fetched.success) expect(fetched.data.enabled).toBe(true);

    expect((await setSsoConnectionEnabled(db, mockLogger, connection.id, false)).success).toBe(
      true,
    );
    fetched = await getSsoConnectionById(db, mockLogger, connection.id);
    if (fetched.success) expect(fetched.data.enabled).toBe(false);
  });

  it("returns NOT_FOUND for a missing connection", async () => {
    const { db } = setup();
    const result = await setSsoConnectionEnabled(db, mockLogger, "ssoc_missing", true);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("NOT_FOUND");
  });
});

describe("rotateScimToken", () => {
  it("returns a stratum_scim_ token and stores only its hash", async () => {
    const { db, raw } = setup();
    const connection = await seedConnection(db, "org_1");

    const result = await rotateScimToken(db, mockLogger, connection.id);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const plaintext = result.data;
    expect(plaintext).toMatch(/^stratum_scim_[0-9a-f]{32}$/);

    const row = raw
      .prepare("SELECT scim_token_hash FROM org_sso_connections WHERE id = ?")
      .get(connection.id) as { scim_token_hash: string };
    expect(row.scim_token_hash).toBe(await hashToken(plaintext));
    expect(row.scim_token_hash).not.toContain(plaintext);
  });

  it("rotation replaces the previous hash", async () => {
    const { db, raw } = setup();
    const connection = await seedConnection(db, "org_1");
    await rotateScimToken(db, mockLogger, connection.id);
    const before = raw
      .prepare("SELECT scim_token_hash FROM org_sso_connections WHERE id = ?")
      .get(connection.id) as { scim_token_hash: string };
    await rotateScimToken(db, mockLogger, connection.id);
    const after = raw
      .prepare("SELECT scim_token_hash FROM org_sso_connections WHERE id = ?")
      .get(connection.id) as { scim_token_hash: string };
    expect(after.scim_token_hash).not.toBe(before.scim_token_hash);
  });
});

describe("deleteSsoConnection", () => {
  it("deletes the connection and its scim_members rows atomically", async () => {
    const { db, raw } = setup();
    seedUser(raw, "usr_a");
    seedUser(raw, "usr_b");
    const connection = await seedConnection(db, "org_1");
    raw
      .prepare(
        "INSERT INTO scim_members (connection_id, user_id, active, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(connection.id, "usr_a", 0, new Date().toISOString());
    raw
      .prepare(
        "INSERT INTO scim_members (connection_id, user_id, active, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(connection.id, "usr_b", 1, new Date().toISOString());

    raw
      .prepare("UPDATE users SET disabled_at = ? WHERE id = 'usr_a'")
      .run("2026-02-01T00:00:00.000Z");

    const result = await deleteSsoConnection(db, mockLogger, connection.id);
    expect(result.success).toBe(true);
    // The re-enable runs in the same batch, so its RETURNING ids come back.
    if (result.success) expect(result.data).toEqual(["usr_a"]);
    const usrA = raw.prepare("SELECT disabled_at FROM users WHERE id = 'usr_a'").get() as {
      disabled_at: string | null;
    };
    expect(usrA.disabled_at).toBeNull();

    expect(raw.prepare("SELECT COUNT(*) AS n FROM scim_members").get()).toEqual({ n: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM org_sso_connections").get()).toEqual({ n: 0 });
  });

  it("keeps a user another connection still deactivates disabled", async () => {
    const { db, raw } = setup();
    seedUser(raw, "usr_shared");
    seedOrg(raw, "org_2", "globex", "usr_owner");
    const first = await seedConnection(db, "org_1", ["corp.example.com"]);
    const second = await seedConnection(db, "org_2", ["globex.example.com"]);
    for (const connectionId of [first.id, second.id]) {
      raw
        .prepare(
          "INSERT INTO scim_members (connection_id, user_id, active, created_at) VALUES (?, ?, 0, ?)",
        )
        .run(connectionId, "usr_shared", new Date().toISOString());
    }
    raw
      .prepare("UPDATE users SET disabled_at = ? WHERE id = 'usr_shared'")
      .run("2026-02-01T00:00:00.000Z");

    const result = await deleteSsoConnection(db, mockLogger, first.id);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual([]);
    const row = raw.prepare("SELECT disabled_at FROM users WHERE id = 'usr_shared'").get() as {
      disabled_at: string | null;
    };
    expect(row.disabled_at).not.toBeNull();
  });

  it("rolls the re-enable back when the delete fails, keeping every vote", async () => {
    const { db, raw } = setup();
    seedUser(raw, "usr_a");
    const connection = await seedConnection(db, "org_1");
    raw
      .prepare(
        "INSERT INTO scim_members (connection_id, user_id, active, created_at) VALUES (?, ?, 0, ?)",
      )
      .run(connection.id, "usr_a", new Date().toISOString());
    raw
      .prepare("UPDATE users SET disabled_at = ? WHERE id = 'usr_a'")
      .run("2026-02-01T00:00:00.000Z");
    raw.exec(
      "CREATE TRIGGER fail_conn_delete BEFORE DELETE ON org_sso_connections " +
        "BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );

    const result = await deleteSsoConnection(db, mockLogger, connection.id);
    expect(result.success).toBe(false);
    // One transaction: neither the re-enable nor the scim_members delete stuck.
    const row = raw.prepare("SELECT disabled_at FROM users WHERE id = 'usr_a'").get() as {
      disabled_at: string | null;
    };
    expect(row.disabled_at).not.toBeNull();
    expect(raw.prepare("SELECT COUNT(*) AS n FROM scim_members").get()).toEqual({ n: 1 });
  });
});

describe("reenableUsersForConnectionRemoval", () => {
  function addScimMember(raw: Raw, connectionId: string, userId: string, active: number): void {
    raw
      .prepare(
        "INSERT INTO scim_members (connection_id, user_id, active, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(connectionId, userId, active, new Date().toISOString());
  }

  function disableUserRow(raw: Raw, userId: string): void {
    raw
      .prepare("UPDATE users SET disabled_at = ? WHERE id = ?")
      .run("2026-02-01T00:00:00.000Z", userId);
  }

  function disabledAtOf(raw: Raw, userId: string): string | null {
    const row = raw.prepare("SELECT disabled_at FROM users WHERE id = ?").get(userId) as {
      disabled_at: string | null;
    };
    return row.disabled_at;
  }

  it("re-enables exactly the users this connection deactivated", async () => {
    const { db, raw } = setup();
    seedUser(raw, "usr_a");
    seedUser(raw, "usr_b");
    const connection = await seedConnection(db, "org_1");
    addScimMember(raw, connection.id, "usr_a", 0);
    disableUserRow(raw, "usr_a");
    // usr_b is managed but holds no deactivation vote here; a stray
    // disabled_at must not be cleared by an active=1 row.
    addScimMember(raw, connection.id, "usr_b", 1);
    disableUserRow(raw, "usr_b");

    const result = await reenableUsersForConnectionRemoval(db, mockLogger, connection.id);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(["usr_a"]);
    expect(disabledAtOf(raw, "usr_a")).toBeNull();
    expect(disabledAtOf(raw, "usr_b")).not.toBeNull();
  });

  it("cross-connection guard: another connection's standing deactivation keeps disabled_at", async () => {
    const { db, raw } = setup();
    seedUser(raw, "usr_shared");
    seedOrg(raw, "org_2", "globex", "usr_owner");
    const first = await seedConnection(db, "org_1", ["corp.example.com"]);
    const second = await seedConnection(db, "org_2", ["globex.example.com"]);
    addScimMember(raw, first.id, "usr_shared", 0);
    addScimMember(raw, second.id, "usr_shared", 0);
    disableUserRow(raw, "usr_shared");

    // Removing connection A must not resurrect the account B still deactivates.
    const result = await reenableUsersForConnectionRemoval(db, mockLogger, first.id);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual([]);
    expect(disabledAtOf(raw, "usr_shared")).not.toBeNull();
  });

  it("excludeUserId leaves the excluded (being-erased) user untouched", async () => {
    const { db, raw } = setup();
    seedUser(raw, "usr_erased");
    seedUser(raw, "usr_kept");
    const connection = await seedConnection(db, "org_1");
    addScimMember(raw, connection.id, "usr_erased", 0);
    addScimMember(raw, connection.id, "usr_kept", 0);
    disableUserRow(raw, "usr_erased");
    disableUserRow(raw, "usr_kept");

    const result = await reenableUsersForConnectionRemoval(db, mockLogger, connection.id, {
      excludeUserId: "usr_erased",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(["usr_kept"]);
    expect(disabledAtOf(raw, "usr_erased")).not.toBeNull();
    expect(disabledAtOf(raw, "usr_kept")).toBeNull();
  });

  it("returns STORAGE_ERROR when the database fails", async () => {
    const result = await reenableUsersForConnectionRemoval(makeThrowingD1(), mockLogger, "ssoc_x");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("STORAGE_ERROR");
  });
});

describe("client secret encryption (SSO salt)", () => {
  it("round-trips under the SSO salt and never under the GitHub-default salt", async () => {
    const secret = "sso-env-secret";
    const ciphertext = await encryptToken("idp-client-secret", secret, SSO_SECRET_SALT);
    expect(await decryptToken(ciphertext, secret, SSO_SECRET_SALT)).toBe("idp-client-secret");
    expect(await decryptToken(ciphertext, secret)).toBeNull();
  });
});
