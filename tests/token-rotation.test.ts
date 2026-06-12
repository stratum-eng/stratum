import { describe, expect, it, vi } from "vitest";
import { getUserByToken, rotateUserToken } from "../src/storage/users";
import { hashToken } from "../src/utils/crypto";
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

interface UserRow {
  id: string;
  email: string;
  username: string;
  token_hash: string;
  github_id: string | null;
  github_username: string | null;
  created_at: string;
}

function makeUsersD1(rows: UserRow[]): D1Database {
  function makeStmt(sql: string, bindings: unknown[]) {
    const upper = sql.trim().toUpperCase();
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => {
        if (upper.startsWith("UPDATE USERS SET TOKEN_HASH")) {
          const row = rows.find((r) => r.id === bindings[1]);
          if (!row) return { success: true, meta: { changes: 0 } };
          row.token_hash = bindings[0] as string;
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      },
      first: async <T>() => {
        if (upper.includes("WHERE TOKEN_HASH = ?")) {
          return (rows.find((r) => r.token_hash === bindings[0]) ?? null) as T | null;
        }
        if (upper.includes("WHERE ID = ?")) {
          return (rows.find((r) => r.id === bindings[0]) ?? null) as T | null;
        }
        return null;
      },
    };
  }
  return { prepare: (sql: string) => makeStmt(sql, []) } as unknown as D1Database;
}

describe("rotateUserToken", () => {
  it("invalidates the old key and makes the new one resolvable", async () => {
    const oldPlaintext = "stratum_user_oldoldoldoldoldoldoldold";
    const rows: UserRow[] = [
      {
        id: "usr_1",
        email: "a@example.com",
        username: "a",
        token_hash: await hashToken(oldPlaintext),
        github_id: null,
        github_username: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    const db = makeUsersD1(rows);

    const before = await getUserByToken(db, oldPlaintext, mockLogger);
    expect(before.success).toBe(true);

    const rotated = await rotateUserToken(db, "usr_1", mockLogger);
    expect(rotated.success).toBe(true);
    if (!rotated.success) return;
    expect(rotated.data).toMatch(/^stratum_user_[0-9a-f]{32}$/);
    expect(rotated.data).not.toBe(oldPlaintext);

    const oldLookup = await getUserByToken(db, oldPlaintext, mockLogger);
    expect(oldLookup.success).toBe(false);

    const newLookup = await getUserByToken(db, rotated.data, mockLogger);
    expect(newLookup.success).toBe(true);
    if (!newLookup.success) return;
    expect(newLookup.data.id).toBe("usr_1");
  });

  it("returns NOT_FOUND for unknown users", async () => {
    const db = makeUsersD1([]);
    const result = await rotateUserToken(db, "usr_ghost", mockLogger);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });
});
