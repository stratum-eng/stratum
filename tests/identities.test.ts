import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteIdentitiesForUser,
  getIdentityByIssuerSubject,
  upsertIdentity,
} from "../src/storage/identities";
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

const GITHUB_ISSUER = "https://github.com";
const GOOGLE_ISSUER = "https://accounts.google.com";

beforeEach(() => {
  // The shared mockLogger persists across tests; without a reset, the
  // re-point warn assertion could pass on a stale call from an earlier test.
  vi.clearAllMocks();
});

function seedUser(raw: ReturnType<typeof makeSqliteD1>["raw"], id: string): void {
  raw
    .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
    .run(id, `${id}@example.com`, id.replace(/_/g, "-"), `hash_${id}`);
}

function identityRows(
  raw: ReturnType<typeof makeSqliteD1>["raw"],
): { user_id: string; issuer: string; subject: string }[] {
  return raw
    .prepare("SELECT user_id, issuer, subject FROM identities ORDER BY issuer, subject")
    .all() as { user_id: string; issuer: string; subject: string }[];
}

describe("migration 049 schema", () => {
  it("adds the users disabled/github-drift columns", () => {
    const { raw } = makeSqliteD1();
    const columns = (raw.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toContain("disabled_at");
    expect(columns).toContain("github_refresh_token");
    expect(columns).toContain("github_token_expires_at");
  });

  it("rejects a provider outside the CHECK list", () => {
    const { raw } = makeSqliteD1();
    seedUser(raw, "usr_1");
    expect(() =>
      raw
        .prepare(
          "INSERT INTO identities (id, user_id, provider, issuer, subject, email) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("idn_1", "usr_1", "saml", "https://idp.example.com", "sub-1", "a@example.com"),
    ).toThrow();
  });

  it("rejects empty issuer/subject at the schema level", () => {
    const { raw } = makeSqliteD1();
    seedUser(raw, "usr_1");
    expect(() =>
      raw
        .prepare(
          "INSERT INTO identities (id, user_id, provider, issuer, subject, email) VALUES ('idn_x', 'usr_1', 'oidc', 'https://idp.example.com', '', 'a@example.com')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("enforces UNIQUE(issuer, subject) at the schema level", () => {
    const { raw } = makeSqliteD1();
    seedUser(raw, "usr_1");
    seedUser(raw, "usr_2");
    const insert = raw.prepare(
      "INSERT INTO identities (id, user_id, provider, issuer, subject, email) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("idn_1", "usr_1", "github", GITHUB_ISSUER, "12345", "a@example.com");
    expect(() =>
      insert.run("idn_2", "usr_2", "github", GITHUB_ISSUER, "12345", "b@example.com"),
    ).toThrow();
  });

  it("enforces one SSO connection per org (org_id UNIQUE)", () => {
    const { raw } = makeSqliteD1();
    seedUser(raw, "usr_1");
    raw
      .prepare("INSERT INTO orgs (id, name, slug, owner_id) VALUES (?, ?, ?, ?)")
      .run("org_1", "Acme", "acme", "usr_1");
    const insert = raw.prepare(
      `INSERT INTO org_sso_connections
         (id, org_id, issuer, client_id, client_secret_ciphertext, authorization_endpoint,
          token_endpoint, jwks_uri, email_domains, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const bind = (id: string) => [
      id,
      "org_1",
      "https://idp.example.com",
      "client",
      "ciphertext",
      "https://idp.example.com/authorize",
      "https://idp.example.com/token",
      "https://idp.example.com/jwks",
      '["acme.com"]',
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ];
    insert.run(...bind("conn_1"));
    expect(() => insert.run(...bind("conn_2"))).toThrow();
  });
});

describe("upsertIdentity", () => {
  it("creates an identity and finds it by (issuer, subject)", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");

    const upserted = await upsertIdentity(db, mockLogger, {
      userId: "usr_1",
      provider: "github",
      issuer: GITHUB_ISSUER,
      subject: "12345",
      email: "usr_1@example.com",
    });
    expect(upserted.success).toBe(true);
    if (!upserted.success) return;
    expect(upserted.data.userId).toBe("usr_1");
    expect(upserted.data.connectionId).toBeNull();

    const found = await getIdentityByIssuerSubject(db, mockLogger, GITHUB_ISSUER, "12345");
    expect(found.success).toBe(true);
    expect(found.success && found.data.id).toBe(upserted.data.id);
  });

  it("keeps the stored id/created_at when re-upserting the same (issuer, subject)", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");

    const first = await upsertIdentity(db, mockLogger, {
      userId: "usr_1",
      provider: "google",
      issuer: GOOGLE_ISSUER,
      subject: "g-sub",
      email: "old@example.com",
    });
    const second = await upsertIdentity(db, mockLogger, {
      userId: "usr_1",
      provider: "google",
      issuer: GOOGLE_ISSUER,
      subject: "g-sub",
      email: "new@example.com",
    });
    expect(first.success && second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(second.data.id).toBe(first.data.id);
    expect(second.data.createdAt).toBe(first.data.createdAt);
    expect(second.data.email).toBe("new@example.com");
    expect(identityRows(raw).length).toBe(1);
  });

  it("replaces the user's previous subject at the same issuer (one per (user_id, issuer))", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");

    await upsertIdentity(db, mockLogger, {
      userId: "usr_1",
      provider: "oidc",
      issuer: "https://idp.example.com",
      subject: "old-sub",
      email: "usr_1@example.com",
      connectionId: "conn_1",
    });
    const rotated = await upsertIdentity(db, mockLogger, {
      userId: "usr_1",
      provider: "oidc",
      issuer: "https://idp.example.com",
      subject: "new-sub",
      email: "usr_1@example.com",
      connectionId: "conn_1",
    });
    expect(rotated.success).toBe(true);

    expect(identityRows(raw)).toEqual([
      { user_id: "usr_1", issuer: "https://idp.example.com", subject: "new-sub" },
    ]);
    const gone = await getIdentityByIssuerSubject(
      db,
      mockLogger,
      "https://idp.example.com",
      "old-sub",
    );
    expect(gone.success).toBe(false);
  });

  it("allows one user to hold identities from multiple issuers", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");

    await upsertIdentity(db, mockLogger, {
      userId: "usr_1",
      provider: "github",
      issuer: GITHUB_ISSUER,
      subject: "12345",
      email: "usr_1@example.com",
    });
    await upsertIdentity(db, mockLogger, {
      userId: "usr_1",
      provider: "google",
      issuer: GOOGLE_ISSUER,
      subject: "g-sub",
      email: "usr_1@example.com",
    });

    expect(identityRows(raw).length).toBe(2);
  });

  it("re-points an existing (issuer, subject) row at the upserting user", async () => {
    // The IdP owns the (issuer, subject) pair: if it now asserts the pair for a
    // different Stratum user, the old link must not survive as a duplicate.
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");
    seedUser(raw, "usr_2");

    await upsertIdentity(db, mockLogger, {
      userId: "usr_1",
      provider: "github",
      issuer: GITHUB_ISSUER,
      subject: "12345",
      email: "usr_1@example.com",
    });
    const moved = await upsertIdentity(db, mockLogger, {
      userId: "usr_2",
      provider: "github",
      issuer: GITHUB_ISSUER,
      subject: "12345",
      email: "usr_2@example.com",
    });
    expect(moved.success && moved.data.userId).toBe("usr_2");
    expect(identityRows(raw)).toEqual([
      { user_id: "usr_2", issuer: GITHUB_ISSUER, subject: "12345" },
    ]);
  });

  it("resets created_at when the pair moves to a different user", async () => {
    // The new owner's "linked at" must not predate their link: the previous
    // owner's created_at would be forensic noise after a re-point.
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");
    seedUser(raw, "usr_2");

    raw
      .prepare(
        "INSERT INTO identities (id, user_id, provider, issuer, subject, email, created_at) VALUES (?, ?, 'github', ?, ?, ?, ?)",
      )
      .run(
        "idn_old",
        "usr_1",
        GITHUB_ISSUER,
        "12345",
        "usr_1@example.com",
        "2020-01-01T00:00:00.000Z",
      );
    const moved = await upsertIdentity(db, mockLogger, {
      userId: "usr_2",
      provider: "github",
      issuer: GITHUB_ISSUER,
      subject: "12345",
      email: "usr_2@example.com",
    });

    expect(moved.success && moved.data.createdAt).not.toBe("2020-01-01T00:00:00.000Z");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Identity re-pointed from another user",
      expect.objectContaining({ previousUserId: "usr_1", userId: "usr_2" }),
    );
  });

  it("rejects empty and oversized issuer/subject/email", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");
    const base = {
      userId: "usr_1",
      provider: "oidc" as const,
      issuer: "https://idp.example.com",
      subject: "sub-1",
      email: "usr_1@example.com",
    };

    for (const overrides of [
      { subject: "" },
      { subject: "   " },
      { issuer: "" },
      { email: "" },
      { subject: "s".repeat(1025) },
    ]) {
      const result = await upsertIdentity(db, mockLogger, { ...base, ...overrides });
      expect(result.success).toBe(false);
      expect(!result.success && result.error.code).toBe("VALIDATION_ERROR");
    }
    expect(identityRows(raw)).toEqual([]);
  });

  it("stores the email lowercased and trimmed", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");
    const result = await upsertIdentity(db, mockLogger, {
      userId: "usr_1",
      provider: "oidc",
      issuer: "https://idp.example.com",
      subject: "sub-1",
      email: "  John.Doe@Corp.example.com ",
    });
    expect(result.success && result.data.email).toBe("john.doe@corp.example.com");
    const stored = raw.prepare("SELECT email FROM identities").get() as { email: string };
    expect(stored.email).toBe("john.doe@corp.example.com");
  });

  it("returns a STORAGE_ERROR (not NotFound) on a database failure", async () => {
    const result = await upsertIdentity(makeThrowingD1(), mockLogger, {
      userId: "usr_1",
      provider: "github",
      issuer: GITHUB_ISSUER,
      subject: "12345",
      email: "usr_1@example.com",
    });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.code).toBe("STORAGE_ERROR");
  });
});

describe("getIdentityByIssuerSubject", () => {
  it("returns NotFound for an unknown pair", async () => {
    const { db } = makeSqliteD1();
    const result = await getIdentityByIssuerSubject(db, mockLogger, GITHUB_ISSUER, "nope");
    expect(result.success).toBe(false);
    expect(!result.success && result.error.code).toBe("NOT_FOUND");
  });

  it("fails closed with STORAGE_ERROR on a database failure", async () => {
    // NotFound falls through to email-matching/JIT in the SSO resolution chain;
    // an infra error must be distinguishable so the login can 500 instead.
    const result = await getIdentityByIssuerSubject(
      makeThrowingD1(),
      mockLogger,
      GITHUB_ISSUER,
      "12345",
    );
    expect(result.success).toBe(false);
    expect(!result.success && result.error.code).toBe("STORAGE_ERROR");
  });
});

describe("deleteIdentitiesForUser", () => {
  it("removes every identity for the user and only that user", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");
    seedUser(raw, "usr_2");

    await upsertIdentity(db, mockLogger, {
      userId: "usr_1",
      provider: "github",
      issuer: GITHUB_ISSUER,
      subject: "111",
      email: "usr_1@example.com",
    });
    await upsertIdentity(db, mockLogger, {
      userId: "usr_1",
      provider: "google",
      issuer: GOOGLE_ISSUER,
      subject: "g-1",
      email: "usr_1@example.com",
    });
    await upsertIdentity(db, mockLogger, {
      userId: "usr_2",
      provider: "github",
      issuer: GITHUB_ISSUER,
      subject: "222",
      email: "usr_2@example.com",
    });

    const result = await deleteIdentitiesForUser(db, mockLogger, "usr_1");
    expect(result.success && result.data).toBe(2);
    expect(identityRows(raw)).toEqual([
      { user_id: "usr_2", issuer: GITHUB_ISSUER, subject: "222" },
    ]);
  });

  it("returns err on a database failure", async () => {
    const result = await deleteIdentitiesForUser(makeThrowingD1(), mockLogger, "usr_1");
    expect(result.success).toBe(false);
  });
});
