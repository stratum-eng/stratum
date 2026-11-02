/// <reference types="vite/client" />
import { describe, expect, it, vi } from "vitest";
import * as auditModule from "../src/storage/audit";
import {
  decodeAuditCursor,
  encodeAuditCursor,
  listAuditLog,
  queryAuditLog,
  recordAudit,
  resolveAuditScope,
} from "../src/storage/audit";
import { DELETED_USER_SENTINEL, anonymizeUserContributions } from "../src/storage/deletion";
import type { Env } from "../src/types";
import { isAdminRequest } from "../src/utils/admin";
import type { Logger } from "../src/utils/logger";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

vi.mock("../src/storage/users", () => ({
  getUser: vi.fn(),
}));

import { getUser } from "../src/storage/users";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

/** Insert a row with a fixed timestamp, bypassing recordAudit's clock. */
function seedRow(
  raw: ReturnType<typeof makeSqliteD1>["raw"],
  row: { id: string; action?: string; orgId?: string | null; createdAt: string },
): void {
  raw
    .prepare(
      "INSERT INTO audit_log (id, action, actor_type, actor_id, subject, detail, created_at, org_id) VALUES (?, ?, 'user', 'usr_1', NULL, '{}', ?, ?)",
    )
    .run(row.id, row.action ?? "token.rotated", row.createdAt, row.orgId ?? null);
}

describe("audit storage", () => {
  it("records and lists entries with parsed detail", async () => {
    const { db } = makeSqliteD1();
    await recordAudit(db, mockLogger, {
      action: "token.rotated",
      actorType: "user",
      actorId: "usr_1",
    });
    await recordAudit(db, mockLogger, {
      action: "webhook.created",
      actorType: "user",
      actorId: "usr_2",
      subject: "wh_1",
      detail: { project: "p", url: "https://example.com" },
    });

    const all = await listAuditLog(db, mockLogger);
    expect(all.success).toBe(true);
    if (!all.success) return;
    expect(all.data).toHaveLength(2);
    const webhookEntry = all.data.find((e) => e.action === "webhook.created");
    expect(webhookEntry?.subject).toBe("wh_1");
    expect(webhookEntry?.detail).toEqual({ project: "p", url: "https://example.com" });
  });

  it("filters by action and actor", async () => {
    const { db } = makeSqliteD1();
    await recordAudit(db, mockLogger, { action: "token.rotated", actorType: "user", actorId: "a" });
    await recordAudit(db, mockLogger, { action: "agent.created", actorType: "user", actorId: "a" });
    await recordAudit(db, mockLogger, { action: "token.rotated", actorType: "user", actorId: "b" });

    const byAction = await listAuditLog(db, mockLogger, { action: "token.rotated" });
    expect(byAction.success && byAction.data).toHaveLength(2);

    const byBoth = await listAuditLog(db, mockLogger, { action: "token.rotated", actorId: "b" });
    expect(byBoth.success && byBoth.data).toHaveLength(1);
  });

  it("never throws when the database fails", async () => {
    const badDb = {
      prepare: () => {
        throw new Error("down");
      },
    } as unknown as D1Database;
    const result = await recordAudit(badDb, mockLogger, {
      action: "token.rotated",
      actorType: "user",
    });
    expect(result.success).toBe(false);
  });
});

describe("audit org scoping (#255)", () => {
  it("derives the org from an org-owned project and records the project id", async () => {
    const { db, raw } = makeSqliteD1();
    await recordAudit(db, mockLogger, {
      action: "webhook.created",
      actorType: "user",
      actorId: "usr_1",
      project: { id: "prj_org", ownerType: "org", ownerId: "org_1" },
    });
    await recordAudit(db, mockLogger, {
      action: "webhook.created",
      actorType: "user",
      actorId: "usr_1",
      project: { id: "prj_mine", ownerType: "user", ownerId: "usr_1" },
    });

    const rows = raw
      .prepare("SELECT org_id, project_id FROM audit_log ORDER BY project_id")
      .all() as { org_id: string | null; project_id: string | null }[];
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ org_id: "org_1", project_id: "prj_org" });
    // A user-owned project belongs to no org: instance admins only.
    expect(rows).toContainEqual({ org_id: null, project_id: "prj_mine" });
  });

  it("lets an explicit orgId win over the project's owner", () => {
    expect(
      resolveAuditScope({
        orgId: "org_explicit",
        project: { id: "prj_1", ownerType: "org", ownerId: "org_other" },
      }),
    ).toEqual({ orgId: "org_explicit", projectId: "prj_1" });
    expect(
      resolveAuditScope({ project: { id: "prj_2", ownerType: "agent", ownerId: "agt_1" } }),
    ).toEqual({ orgId: null, projectId: "prj_2" });
    expect(resolveAuditScope({})).toEqual({ orgId: null, projectId: null });
  });

  it("filters reads to one org and surfaces orgId/projectId on entries", async () => {
    const { db } = makeSqliteD1();
    await recordAudit(db, mockLogger, { action: "org.created", actorType: "user", orgId: "org_a" });
    await recordAudit(db, mockLogger, { action: "org.created", actorType: "user", orgId: "org_b" });
    await recordAudit(db, mockLogger, { action: "token.rotated", actorType: "user" });

    const page = await queryAuditLog(db, mockLogger, { orgId: "org_a" });
    expect(page.success).toBe(true);
    if (!page.success) return;
    expect(page.data.entries).toHaveLength(1);
    expect(page.data.entries[0]?.orgId).toBe("org_a");
    expect(page.data.nextCursor).toBeUndefined();
  });
});

describe("audit pagination (#255)", () => {
  it("walks every row exactly once with keyset cursors, ties broken by id", async () => {
    const { db, raw } = makeSqliteD1();
    // Two rows share a timestamp: the cursor must still not skip or repeat.
    const stamps = [
      "2026-10-01T00:00:00.000Z",
      "2026-10-02T00:00:00.000Z",
      "2026-10-02T00:00:00.000Z",
      "2026-10-03T00:00:00.000Z",
      "2026-10-04T00:00:00.000Z",
    ];
    stamps.forEach((createdAt, i) => {
      seedRow(raw, { id: `aud_${i}`, orgId: "org_a", createdAt });
    });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await queryAuditLog(db, mockLogger, {
        orgId: "org_a",
        limit: 2,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      if (!page.success) throw page.error;
      seen.push(...page.data.entries.map((e) => e.id));
      cursor = page.data.nextCursor;
      pages++;
    } while (cursor !== undefined && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toEqual(["aud_4", "aud_3", "aud_2", "aud_1", "aud_0"]);
  });

  it("applies since (inclusive) and until (exclusive)", async () => {
    const { db, raw } = makeSqliteD1();
    seedRow(raw, { id: "aud_old", orgId: "org_a", createdAt: "2026-01-01T00:00:00.000Z" });
    seedRow(raw, { id: "aud_mid", orgId: "org_a", createdAt: "2026-02-01T00:00:00.000Z" });
    seedRow(raw, { id: "aud_new", orgId: "org_a", createdAt: "2026-03-01T00:00:00.000Z" });

    const page = await queryAuditLog(db, mockLogger, {
      orgId: "org_a",
      since: "2026-02-01T00:00:00.000Z",
      until: "2026-03-01T00:00:00.000Z",
    });
    expect(page.success && page.data.entries.map((e) => e.id)).toEqual(["aud_mid"]);
  });

  it("rejects a cursor it did not mint", async () => {
    const { db } = makeSqliteD1();
    const page = await queryAuditLog(db, mockLogger, { cursor: "not-a-cursor" });
    expect(page.success).toBe(false);
    if (!page.success) expect(page.error.code).toBe("VALIDATION_ERROR");
    expect(decodeAuditCursor("not-a-cursor")).toBeNull();
    const round = encodeAuditCursor({ createdAt: "2026-01-01T00:00:00.000Z", id: "aud_x" });
    expect(decodeAuditCursor(round)).toEqual({
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "aud_x",
    });
  });
});

const sourceFiles = import.meta.glob("../src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("audit log immutability (#255)", () => {
  it("the storage module exposes no update or delete operation", () => {
    const mutating = Object.keys(auditModule).filter((name) =>
      /delete|remove|update|purge|clear|truncate|edit/i.test(name),
    );
    expect(mutating).toEqual([]);
  });

  it("no source file issues an UPDATE or DELETE against audit_log", () => {
    expect(Object.keys(sourceFiles).length).toBeGreaterThan(50);
    const offenders = Object.entries(sourceFiles)
      .filter(([, sql]) => /\b(UPDATE\s+audit_log|DELETE\s+FROM\s+audit_log)\b/i.test(sql))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("the database refuses DELETE on audit_log", async () => {
    const { db, raw } = makeSqliteD1();
    await recordAudit(db, mockLogger, { action: "token.rotated", actorType: "user", actorId: "u" });
    expect(() => raw.prepare("DELETE FROM audit_log").run()).toThrow(/append-only/);
    const count = raw.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("the database refuses edits to any column", async () => {
    const { db, raw } = makeSqliteD1();
    await recordAudit(db, mockLogger, {
      action: "token.rotated",
      actorType: "user",
      actorId: "usr_1",
      orgId: "org_a",
    });
    for (const sql of [
      "UPDATE audit_log SET action = 'token.created'",
      "UPDATE audit_log SET detail = '{\"forged\":true}'",
      "UPDATE audit_log SET created_at = '2000-01-01T00:00:00.000Z'",
      "UPDATE audit_log SET org_id = 'org_b'",
      "UPDATE audit_log SET actor_id = 'usr_someone_else'",
      // Anonymizing is allowed only on its own, never bundled with an edit.
      `UPDATE audit_log SET actor_id = '${DELETED_USER_SENTINEL}', action = 'x'`,
    ]) {
      expect(() => raw.prepare(sql).run(), sql).toThrow(/append-only/);
    }
  });

  it("still allows right-to-erasure anonymization of actor_id, and only once", async () => {
    const { db, raw } = makeSqliteD1();
    await recordAudit(db, mockLogger, {
      action: "token.rotated",
      actorType: "user",
      actorId: "usr_gone",
      orgId: "org_a",
      detail: { k: "v" },
    });
    const before = raw.prepare("SELECT * FROM audit_log").get() as Record<string, unknown>;

    const result = await anonymizeUserContributions(db, "usr_gone", mockLogger);
    expect(result.success).toBe(true);

    const after = raw.prepare("SELECT * FROM audit_log").get() as Record<string, unknown>;
    expect(after).toEqual({ ...before, actor_id: DELETED_USER_SENTINEL });
    // Un-anonymizing is an edit like any other.
    expect(() => raw.prepare("UPDATE audit_log SET actor_id = 'usr_gone'").run()).toThrow(
      /append-only/,
    );
  });
});

describe("isAdminRequest", () => {
  const baseEnv = { DB: {} as D1Database } as Env;

  it("accepts a matching admin API key", async () => {
    const env = { ...baseEnv, ADMIN_API_KEY: "sekret" } as Env;
    expect(await isAdminRequest(env, { adminApiKeyHeader: "sekret" }, mockLogger)).toBe(true);
    expect(await isAdminRequest(env, { adminApiKeyHeader: "wrong" }, mockLogger)).toBe(false);
  });

  it("accepts the configured admin user by email", async () => {
    const env = { ...baseEnv, ADMIN_EMAIL: "admin@example.com" } as Env;
    vi.mocked(getUser).mockResolvedValueOnce({
      success: true,
      data: {
        id: "usr_admin",
        email: "admin@example.com",
        username: "admin",
        tokenHash: "h",
        createdAt: "",
      },
    });
    expect(await isAdminRequest(env, { userId: "usr_admin" }, mockLogger)).toBe(true);

    vi.mocked(getUser).mockResolvedValueOnce({
      success: true,
      data: {
        id: "usr_other",
        email: "other@example.com",
        username: "other",
        tokenHash: "h",
        createdAt: "",
      },
    });
    expect(await isAdminRequest(env, { userId: "usr_other" }, mockLogger)).toBe(false);
  });

  it("fails closed when no admin secrets are configured", async () => {
    expect(
      await isAdminRequest(baseEnv, { adminApiKeyHeader: "x", userId: "usr_1" }, mockLogger),
    ).toBe(false);
  });
});
