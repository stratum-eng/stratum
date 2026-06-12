import { describe, expect, it, vi } from "vitest";
import { listAuditLog, recordAudit } from "../src/storage/audit";
import type { Env } from "../src/types";
import { isAdminRequest } from "../src/utils/admin";
import type { Logger } from "../src/utils/logger";

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

interface AuditRow {
  id: string;
  action: string;
  actor_type: string;
  actor_id: string | null;
  subject: string | null;
  detail: string;
  created_at: string;
}

function makeAuditD1(): { db: D1Database; rows: AuditRow[] } {
  const rows: AuditRow[] = [];
  function makeStmt(sql: string, bindings: unknown[]) {
    const upper = sql.trim().toUpperCase();
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => {
        if (upper.startsWith("INSERT INTO AUDIT_LOG")) {
          rows.push({
            id: bindings[0] as string,
            action: bindings[1] as string,
            actor_type: bindings[2] as string,
            actor_id: bindings[3] as string | null,
            subject: bindings[4] as string | null,
            detail: bindings[5] as string,
            created_at: bindings[6] as string,
          });
        }
        return { success: true, meta: {} };
      },
      all: async <T>() => {
        let results = [...rows];
        let bindIndex = 0;
        if (upper.includes("ACTION = ?")) {
          const action = bindings[bindIndex++];
          results = results.filter((r) => r.action === action);
        }
        if (upper.includes("ACTOR_ID = ?")) {
          const actor = bindings[bindIndex++];
          results = results.filter((r) => r.actor_id === actor);
        }
        const limit = bindings[bindIndex] as number;
        results = results.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
        return { results: results as T[], success: true, meta: {} };
      },
    };
  }
  const db = { prepare: (sql: string) => makeStmt(sql, []) } as unknown as D1Database;
  return { db, rows };
}

describe("audit storage", () => {
  it("records and lists entries with parsed detail", async () => {
    const { db } = makeAuditD1();
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
    const { db } = makeAuditD1();
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
