import { describe, expect, it, vi } from "vitest";
import { recordAudit } from "../src/storage/audit";
import {
  DELETED_USER_SENTINEL,
  deleteAccountCascade,
  eraseUserFromAuditLog,
} from "../src/storage/deletion";
import type { Env } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeKvStub } from "./helpers/deletion-stubs";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

/**
 * Right-to-erasure for audit_log subject and detail (#425), against the REAL
 * schema and the REAL triggers from migrations 055 + 061 (node:sqlite runs
 * them), so the allowed rewrite and every refused edit are both exercised by
 * the database rather than asserted about a stub.
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

const GONE = "usr_gone";
const GONE_EMAIL = "gone@example.com";

function seedUser(raw: Raw, id: string, email: string, deleting = false): void {
  raw
    .prepare(
      "INSERT INTO users (id, email, username, token_hash, deleting_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(id, email, id.replace(/_/g, "-"), `hash_${id}`, deleting ? "2026-11-01T00:00:00Z" : null);
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    STATE: makeKvStub(50).kv,
    ARTIFACTS: { delete: async () => true } as unknown as Env["ARTIFACTS"],
  } as Env;
}

/** Every audit_log cell, as text, so "appears anywhere" is one search. */
function allCells(raw: Raw): string[] {
  const rows = raw.prepare("SELECT * FROM audit_log").all() as Record<string, unknown>[];
  return rows.flatMap((row) => Object.values(row).map((value) => String(value ?? "")));
}

async function seedTrail(db: D1Database): Promise<void> {
  // The shapes the issue names: the user as subject (rows written before the
  // subject change), as a detail key, inside an array, and by email.
  await recordAudit(db, mockLogger, {
    action: "scim.user.deactivated",
    actorType: "system",
    subject: GONE,
    orgId: "org_a",
    detail: { via: "scim", connectionId: "conn_1", agentIds: [] },
  });
  await recordAudit(db, mockLogger, {
    action: "org.member.added",
    actorType: "user",
    actorId: "usr_admin",
    subject: "org_a",
    orgId: "org_a",
    detail: { userId: GONE, role: "member" },
  });
  await recordAudit(db, mockLogger, {
    action: "sso.connection.deleted",
    actorType: "system",
    subject: "org_a",
    orgId: "org_a",
    detail: { reenabledUserIds: ["usr_other", GONE], ownerId: GONE, email: GONE_EMAIL },
  });
  await recordAudit(db, mockLogger, {
    action: "token.rotated",
    actorType: "user",
    actorId: GONE,
    subject: GONE_EMAIL,
    detail: { note: `not ${GONE} as a whole token`, nested: { owner: { id: GONE } } },
  });
  // A bystander's row must come through byte-identical.
  await recordAudit(db, mockLogger, {
    action: "org.member.added",
    actorType: "user",
    actorId: "usr_admin",
    subject: "org_a",
    orgId: "org_a",
    detail: { userId: "usr_other", role: "member" },
  });
}

describe("account deletion erases the user from every audit_log column (#425)", () => {
  it("leaves no row containing the user's id or email as a value", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, GONE, GONE_EMAIL);
    seedUser(raw, "usr_other", "other@example.com");
    seedUser(raw, "usr_admin", "admin@example.com");
    await seedTrail(db);
    const bystanderBefore = raw
      .prepare("SELECT * FROM audit_log WHERE detail LIKE '%usr_other%' AND action = ?")
      .get("org.member.added");

    const result = await deleteAccountCascade(makeEnv(db), GONE, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.residuals).toEqual([]);

    // Free text that merely mentions the id is not a JSON token for it, so it
    // survives; every structured reference is gone.
    const cells = allCells(raw).filter((cell) => !cell.includes("as a whole token"));
    for (const cell of cells) {
      expect(cell).not.toContain(GONE);
      expect(cell).not.toContain(GONE_EMAIL);
    }
    const sso = raw
      .prepare("SELECT detail FROM audit_log WHERE action = 'sso.connection.deleted'")
      .get() as { detail: string };
    expect(JSON.parse(sso.detail)).toEqual({
      reenabledUserIds: ["usr_other", DELETED_USER_SENTINEL],
      ownerId: DELETED_USER_SENTINEL,
      email: DELETED_USER_SENTINEL,
    });
    const rotated = raw
      .prepare("SELECT actor_id, subject, detail FROM audit_log WHERE action = 'token.rotated'")
      .get() as { actor_id: string; subject: string; detail: string };
    expect(rotated.actor_id).toBe(DELETED_USER_SENTINEL);
    expect(rotated.subject).toBe(DELETED_USER_SENTINEL);
    expect(JSON.parse(rotated.detail).nested.owner.id).toBe(DELETED_USER_SENTINEL);
    expect(
      raw
        .prepare("SELECT * FROM audit_log WHERE detail LIKE '%usr_other%' AND action = ?")
        .get("org.member.added"),
    ).toEqual(bystanderBefore);
    // The trail is anonymized, not shortened.
    const count = raw.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number };
    expect(count.n).toBeGreaterThanOrEqual(5);
  });

  it("is idempotent on a re-drive", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, GONE, GONE_EMAIL, true);
    await seedTrail(db);
    expect((await eraseUserFromAuditLog(db, GONE, mockLogger)).success).toBe(true);
    const once = raw.prepare("SELECT * FROM audit_log ORDER BY id").all();
    expect((await eraseUserFromAuditLog(db, GONE, mockLogger)).success).toBe(true);
    expect(raw.prepare("SELECT * FROM audit_log ORDER BY id").all()).toEqual(once);
  });
});

describe("the append-only trigger after migration 061", () => {
  async function seeded(deleting: boolean) {
    const made = makeSqliteD1();
    seedUser(made.raw, GONE, GONE_EMAIL, deleting);
    seedUser(made.raw, "usr_live", "live@example.com");
    await recordAudit(made.db, mockLogger, {
      action: "org.member.added",
      actorType: "user",
      actorId: "usr_admin",
      subject: GONE,
      orgId: "org_a",
      detail: { userId: GONE, email: GONE_EMAIL, role: "member" },
    });
    return made;
  }

  const eraseDetail = (value: string) =>
    `UPDATE audit_log SET detail = replace(detail, json_quote('${value}'), json_quote('${DELETED_USER_SENTINEL}'))`;

  it("refuses subject/detail erasure for an account that is not being deleted", async () => {
    const { raw } = await seeded(false);
    for (const sql of [
      `UPDATE audit_log SET subject = '${DELETED_USER_SENTINEL}'`,
      eraseDetail(GONE),
      eraseDetail(GONE_EMAIL),
    ]) {
      expect(() => raw.prepare(sql).run(), sql).toThrow(/append-only/);
    }
  });

  it("allows the exact rewrite once the account is marked deleting", async () => {
    const { raw } = await seeded(true);
    raw.prepare(`UPDATE audit_log SET subject = '${DELETED_USER_SENTINEL}'`).run();
    raw.prepare(eraseDetail(GONE)).run();
    raw.prepare(eraseDetail(GONE_EMAIL)).run();
    const row = raw.prepare("SELECT subject, detail FROM audit_log").get() as {
      subject: string;
      detail: string;
    };
    expect(row.subject).toBe(DELETED_USER_SENTINEL);
    expect(JSON.parse(row.detail)).toEqual({
      userId: DELETED_USER_SENTINEL,
      email: DELETED_USER_SENTINEL,
      role: "member",
    });
  });

  it("still refuses every other edit, even of a deleting user's row", async () => {
    const { raw } = await seeded(true);
    for (const sql of [
      // Erasing a live account's identifiers, or arbitrary values.
      eraseDetail("usr_live"),
      eraseDetail("member"),
      // Rewriting to anything but the sentinel.
      "UPDATE audit_log SET subject = 'usr_someone_else'",
      `UPDATE audit_log SET detail = replace(detail, json_quote('${GONE}'), json_quote('usr_live'))`,
      // Bundling an erasure with an edit.
      `UPDATE audit_log SET subject = '${DELETED_USER_SENTINEL}', action = 'x'`,
      `UPDATE audit_log SET subject = '${DELETED_USER_SENTINEL}', detail = '{}'`,
      `UPDATE audit_log SET detail = replace(replace(detail, json_quote('${GONE}'), json_quote('${DELETED_USER_SENTINEL}')), 'member', 'admin')`,
      // Replacing a fragment instead of a whole token.
      `UPDATE audit_log SET detail = replace(detail, '${GONE}', 'x')`,
      // Wholesale replacement and NULLs.
      "UPDATE audit_log SET detail = '{}'",
      "UPDATE audit_log SET subject = NULL",
      "UPDATE audit_log SET detail = NULL",
      "UPDATE audit_log SET org_id = 'org_b'",
      "UPDATE audit_log SET created_at = '2000-01-01T00:00:00.000Z'",
    ]) {
      expect(() => raw.prepare(sql).run(), sql).toThrow(/append-only/);
    }
    expect(() => raw.prepare("DELETE FROM audit_log").run()).toThrow(/append-only/);
    const row = raw.prepare("SELECT subject, detail FROM audit_log").get() as {
      subject: string;
      detail: string;
    };
    expect(row.subject).toBe(GONE);
    expect(JSON.parse(row.detail)).toEqual({ userId: GONE, email: GONE_EMAIL, role: "member" });
  });

  it("refuses to un-erase a row back to the user's id", async () => {
    const { raw } = await seeded(true);
    raw.prepare(`UPDATE audit_log SET subject = '${DELETED_USER_SENTINEL}'`).run();
    expect(() => raw.prepare(`UPDATE audit_log SET subject = '${GONE}'`).run()).toThrow(
      /append-only/,
    );
  });
});
