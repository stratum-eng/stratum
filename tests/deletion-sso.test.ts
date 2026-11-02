import { describe, expect, it, vi } from "vitest";
import { deleteAccountCascade } from "../src/storage/deletion";
import type { Env } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeKvStub } from "./helpers/deletion-stubs";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

/**
 * Zero-orphan coverage for the SSO/SCIM tables (migration 049) in the deletion
 * cascades, against the REAL schema (FK enforcement on) so a wrong delete
 * order fails here instead of in production.
 */

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

function seedOrg(raw: Raw, id: string, ownerId: string, members: [string, string][]): void {
  raw
    .prepare("INSERT INTO orgs (id, name, slug, owner_id) VALUES (?, ?, ?, ?)")
    .run(id, id, id.replace(/_/g, "-"), ownerId);
  for (const [userId, role] of members) {
    raw
      .prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)")
      .run(id, userId, role);
  }
}

function seedConnection(raw: Raw, id: string, orgId: string): void {
  raw
    .prepare(
      `INSERT INTO org_sso_connections
         (id, org_id, issuer, client_id, client_secret_ciphertext, authorization_endpoint,
          token_endpoint, jwks_uri, email_domains, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      orgId,
      "https://idp.example.com",
      "client",
      "ciphertext",
      "https://idp.example.com/authorize",
      "https://idp.example.com/token",
      "https://idp.example.com/jwks",
      '["example.com"]',
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
}

function seedIdentity(
  raw: Raw,
  id: string,
  userId: string,
  subject: string,
  connectionId?: string,
): void {
  raw
    .prepare(
      "INSERT INTO identities (id, user_id, provider, issuer, subject, email, connection_id) VALUES (?, ?, 'oidc', 'https://idp.example.com', ?, ?, ?)",
    )
    .run(id, userId, subject, `${userId}@example.com`, connectionId ?? null);
}

function seedScimMember(raw: Raw, connectionId: string, userId: string, active = 1): void {
  raw
    .prepare("INSERT INTO scim_members (connection_id, user_id, active) VALUES (?, ?, ?)")
    .run(connectionId, userId, active);
}

function countWhere(raw: Raw, table: string, column: string, value: string): number {
  const row = raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as {
    n: number;
  };
  return row.n;
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    STATE: makeKvStub(50).kv,
    ARTIFACTS: { delete: async () => true } as unknown as Env["ARTIFACTS"],
  } as Env;
}

describe("deleteAccountCascade — SSO/SCIM tables", () => {
  it("removes the user's identities and scim_members rows, leaving other users' intact", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");
    seedUser(raw, "usr_2");
    seedOrg(raw, "org_1", "usr_2", [
      ["usr_1", "member"],
      ["usr_2", "admin"],
    ]);
    seedConnection(raw, "conn_1", "org_1");
    seedIdentity(raw, "idn_1", "usr_1", "sub-1");
    seedIdentity(raw, "idn_2", "usr_2", "sub-2");
    seedScimMember(raw, "conn_1", "usr_1");
    seedScimMember(raw, "conn_1", "usr_2");

    const result = await deleteAccountCascade(makeEnv(db), "usr_1", mockLogger);
    expect(result.success).toBe(true);
    expect(result.success && result.data.residuals).toEqual([]);

    // Zero orphans for the erased user, users row gone last.
    expect(countWhere(raw, "identities", "user_id", "usr_1")).toBe(0);
    expect(countWhere(raw, "scim_members", "user_id", "usr_1")).toBe(0);
    expect(countWhere(raw, "users", "id", "usr_1")).toBe(0);

    // The surviving user's rows and the org's connection are untouched.
    expect(countWhere(raw, "identities", "user_id", "usr_2")).toBe(1);
    expect(countWhere(raw, "scim_members", "user_id", "usr_2")).toBe(1);
    expect(countWhere(raw, "org_sso_connections", "id", "conn_1")).toBe(1);
  });

  it("deletes the empty sole-owner org's connection and ALL its scim_members rows", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");
    // usr_2 was adopted by the connection but is no longer an org member — the
    // connection-scoped delete must still remove that mapping.
    seedUser(raw, "usr_2");
    seedOrg(raw, "org_1", "usr_1", [["usr_1", "admin"]]);
    seedConnection(raw, "conn_1", "org_1");
    seedScimMember(raw, "conn_1", "usr_1");
    seedScimMember(raw, "conn_1", "usr_2");
    // usr_2 was JIT-provisioned by the connection: their identity's soft
    // connection_id reference must be nulled, not left dangling.
    seedIdentity(raw, "idn_2", "usr_2", "sub-2", "conn_1");

    const result = await deleteAccountCascade(makeEnv(db), "usr_1", mockLogger);
    expect(result.success).toBe(true);
    expect(result.success && result.data.residuals).toEqual([]);

    expect(countWhere(raw, "orgs", "id", "org_1")).toBe(0);
    expect(countWhere(raw, "org_sso_connections", "org_id", "org_1")).toBe(0);
    expect(countWhere(raw, "scim_members", "connection_id", "conn_1")).toBe(0);
    expect(countWhere(raw, "users", "id", "usr_1")).toBe(0);
    // The other mapped user is not erased — only the mapping is; their identity
    // survives with the dead connection reference cleared.
    expect(countWhere(raw, "users", "id", "usr_2")).toBe(1);
    const survivor = raw
      .prepare("SELECT connection_id FROM identities WHERE id = 'idn_2'")
      .get() as { connection_id: string | null };
    expect(survivor.connection_id).toBeNull();
  });

  it("re-enables SCIM-disabled users before deleting the empty org's connection", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");
    // usr_2 is not an org member: the connection deactivated them via SCIM and
    // disabled their account. Org erasure must give the account back, not
    // strand it disabled with the connection gone.
    seedUser(raw, "usr_2");
    raw
      .prepare("UPDATE users SET disabled_at = ? WHERE id = 'usr_2'")
      .run("2026-02-01T00:00:00.000Z");
    seedOrg(raw, "org_1", "usr_1", [["usr_1", "admin"]]);
    seedConnection(raw, "conn_1", "org_1");
    seedScimMember(raw, "conn_1", "usr_2", 0);

    const result = await deleteAccountCascade(makeEnv(db), "usr_1", mockLogger);
    expect(result.success).toBe(true);
    expect(result.success && result.data.residuals).toEqual([]);

    // usr_2 still exists and is re-enabled; the mapping and connection are gone.
    expect(countWhere(raw, "users", "id", "usr_2")).toBe(1);
    const survivor = raw.prepare("SELECT disabled_at FROM users WHERE id = 'usr_2'").get() as {
      disabled_at: string | null;
    };
    expect(survivor.disabled_at).toBeNull();
    expect(countWhere(raw, "scim_members", "connection_id", "conn_1")).toBe(0);
    expect(countWhere(raw, "org_sso_connections", "org_id", "org_1")).toBe(0);

    // ONE summary audit for the batch re-enable, not a per-user fan-out.
    const audits = raw
      .prepare("SELECT action, actor_type, detail FROM audit_log WHERE subject = 'org_1'")
      .all() as Array<{ action: string; actor_type: string; detail: string }>;
    const summary = audits.find((row) => row.action === "sso.connection.deleted");
    expect(summary).toBeDefined();
    expect(summary?.actor_type).toBe("system");
    const detail = JSON.parse(summary?.detail ?? "{}") as {
      via: string;
      orgId: string;
      connectionId: string;
      reenabledUserIds: string[];
    };
    expect(detail.via).toBe("org.deleted");
    expect(detail.orgId).toBe("org_1");
    expect(detail.connectionId).toBe("conn_1");
    expect(detail.reenabledUserIds).toEqual(["usr_2"]);
  });

  it("keeps the connection, its votes, and the org when the re-enable fails, so a re-drive can retry", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");
    seedUser(raw, "usr_2");
    raw
      .prepare("UPDATE users SET disabled_at = ? WHERE id = 'usr_2'")
      .run("2026-02-01T00:00:00.000Z");
    seedOrg(raw, "org_1", "usr_1", [["usr_1", "admin"]]);
    seedConnection(raw, "conn_1", "org_1");
    seedScimMember(raw, "conn_1", "usr_2", 0);
    // Make the set-based re-enable UPDATE fail for real.
    raw.exec(
      "CREATE TRIGGER fail_reenable BEFORE UPDATE OF disabled_at ON users " +
        "WHEN NEW.disabled_at IS NULL BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );

    const result = await deleteAccountCascade(makeEnv(db), "usr_1", mockLogger);
    expect(result.success).toBe(true);
    expect(result.success && result.data.residuals).toContain("org:org_1:scim-reenable-batch");

    // Nothing that a retry needs is gone: usr_2 is still disabled, and the
    // active=0 vote, the connection, and the org all survive for the re-drive.
    expect(countWhere(raw, "scim_members", "connection_id", "conn_1")).toBe(1);
    expect(countWhere(raw, "org_sso_connections", "org_id", "org_1")).toBe(1);
    expect(countWhere(raw, "orgs", "id", "org_1")).toBe(1);

    // Once the fault clears, the re-drive finishes the rollback.
    raw.exec("DROP TRIGGER fail_reenable");
    const retry = await deleteAccountCascade(makeEnv(db), "usr_1", mockLogger);
    expect(retry.success && retry.data.residuals).toEqual([]);
    const survivor = raw.prepare("SELECT disabled_at FROM users WHERE id = 'usr_2'").get() as {
      disabled_at: string | null;
    };
    expect(survivor.disabled_at).toBeNull();
    expect(countWhere(raw, "org_sso_connections", "org_id", "org_1")).toBe(0);
  });

  it("keeps the connection when the org survives via successor promotion", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");
    seedUser(raw, "usr_2");
    seedOrg(raw, "org_1", "usr_1", [
      ["usr_1", "admin"],
      ["usr_2", "admin"],
    ]);
    seedConnection(raw, "conn_1", "org_1");
    seedScimMember(raw, "conn_1", "usr_1");
    seedScimMember(raw, "conn_1", "usr_2");

    const result = await deleteAccountCascade(makeEnv(db), "usr_1", mockLogger);
    expect(result.success).toBe(true);
    expect(result.success && result.data.residuals).toEqual([]);

    const org = raw.prepare("SELECT owner_id FROM orgs WHERE id = 'org_1'").get() as {
      owner_id: string;
    };
    expect(org.owner_id).toBe("usr_2");
    expect(countWhere(raw, "org_sso_connections", "org_id", "org_1")).toBe(1);
    expect(countWhere(raw, "scim_members", "user_id", "usr_2")).toBe(1);
    // The erased user's mapping is gone even though the connection remains.
    expect(countWhere(raw, "scim_members", "user_id", "usr_1")).toBe(0);
  });
});
