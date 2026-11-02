/**
 * `setUserDisplayName` and `renameUser` against a D1 stand-in that behaves
 * like the users table: `UPDATE` reports changed rows, and the UNIQUE index on
 * username rejects a collision the way D1 does, with a constraint error.
 */
import { describe, expect, it, vi } from "vitest";
import { claimNamespace } from "../src/storage/project-namespace";
import { getUser, renameUser, setUserDisplayName } from "../src/storage/users";
import type { Logger } from "../src/utils/logger";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

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
  display_name: string | null;
  token_hash: string;
  github_id: string | null;
  github_username: string | null;
  created_at: string;
  deleting_at: string | null;
  telemetry_opt_out: number;
}

const row = (id: string, username: string): UserRow => ({
  id,
  email: `${username}@example.com`,
  username,
  display_name: null,
  token_hash: `hash-${id}`,
  github_id: null,
  github_username: null,
  created_at: "2026-01-01T00:00:00.000Z",
  deleting_at: null,
  telemetry_opt_out: 0,
});

/** A users table in memory that answers the SQL prefixes the storage layer issues and enforces the UNIQUE username. */
function makeUsersD1(rows: UserRow[]): D1Database {
  function makeStmt(sql: string, bindings: unknown[]) {
    const upper = sql.trim().toUpperCase();
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => {
        const target = rows.find((r) => r.id === bindings[1]);
        if (upper.startsWith("UPDATE USERS SET DISPLAY_NAME")) {
          if (!target) return { success: true, meta: { changes: 0 } };
          target.display_name = bindings[0] as string | null;
          return { success: true, meta: { changes: 1 } };
        }
        if (upper.startsWith("UPDATE USERS SET USERNAME")) {
          if (rows.some((r) => r.username === bindings[0] && r.id !== bindings[1])) {
            throw new Error("D1_ERROR: UNIQUE constraint failed: users.username");
          }
          if (!target) return { success: true, meta: { changes: 0 } };
          target.username = bindings[0] as string;
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      },
      first: async <T>() =>
        upper.includes("WHERE ID = ?")
          ? ((rows.find((r) => r.id === bindings[0]) ?? null) as T | null)
          : null,
    };
  }
  return { prepare: (sql: string) => makeStmt(sql, []) } as unknown as D1Database;
}

describe("setUserDisplayName", () => {
  it("stores a name and surfaces it on the user", async () => {
    const db = makeUsersD1([row("usr_1", "alice")]);
    const saved = await setUserDisplayName(db, "usr_1", "Alice Liddell", mockLogger);
    expect(saved.success).toBe(true);
    const user = await getUser(db, "usr_1", mockLogger);
    expect(user.success && user.data.displayName).toBe("Alice Liddell");
  });

  it("clears the name with null, so the header falls back to the username", async () => {
    const alice = row("usr_1", "alice");
    alice.display_name = "Alice";
    const db = makeUsersD1([alice]);
    await setUserDisplayName(db, "usr_1", null, mockLogger);
    const user = await getUser(db, "usr_1", mockLogger);
    expect(user.success && "displayName" in user.data).toBe(false);
  });

  it("reports a storage failure as a Result, not a throw", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error("D1 down");
          },
        }),
      }),
    } as unknown as D1Database;
    const saved = await setUserDisplayName(db, "usr_1", "x", mockLogger);
    expect(saved.success).toBe(false);
    expect(!saved.success && saved.error.statusCode).toBe(500);
  });
});

describe("renameUser", () => {
  it("renames and normalises the new name", async () => {
    const db = makeUsersD1([row("usr_1", "alice")]);
    const renamed = await renameUser(db, "usr_1", "Alice-Two", mockLogger);
    expect(renamed.success && renamed.data).toBe("alice-two");
    const user = await getUser(db, "usr_1", mockLogger);
    expect(user.success && user.data.username).toBe("alice-two");
  });

  it("rejects an invalid name before touching the database", async () => {
    const alice = row("usr_1", "alice");
    const renamed = await renameUser(makeUsersD1([alice]), "usr_1", "-nope-", mockLogger);
    expect(renamed.success).toBe(false);
    expect(!renamed.success && renamed.error.statusCode).toBe(400);
    expect(alice.username).toBe("alice");
  });

  it("reports a taken name as a 409, not a storage error", async () => {
    const db = makeUsersD1([row("usr_1", "alice"), row("usr_2", "bob")]);
    const renamed = await renameUser(db, "usr_1", "bob", mockLogger);
    expect(renamed.success).toBe(false);
    expect(!renamed.success && renamed.error.statusCode).toBe(409);
    expect(!renamed.success && renamed.error.message).toContain("taken");
  });

  it("reports an unknown user as a 404", async () => {
    const renamed = await renameUser(makeUsersD1([]), "usr_9", "carol", mockLogger);
    expect(renamed.success).toBe(false);
    expect(!renamed.success && renamed.error.statusCode).toBe(404);
  });
});

/**
 * The rename's refusal lives inside its UPDATE (`NOT EXISTS` over
 * namespace_claims), so it needs the real schema: a stub cannot tell whether
 * the subquery is right.
 */
describe("renameUser against namespace claims", () => {
  function seedUser(db: D1Database, raw: ReturnType<typeof makeSqliteD1>["raw"]) {
    raw
      .prepare(
        "INSERT INTO users (id, email, username, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("usr_1", "alice@example.com", "alice", "hash-1", "2026-01-01T00:00:00.000Z");
    return db;
  }

  it("renames while the account holds no claim", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(db, raw);
    const renamed = await renameUser(db, "usr_1", "alice-two", mockLogger);
    expect(renamed.success && renamed.data).toBe("alice-two");
    const user = await getUser(db, "usr_1", mockLogger);
    expect(user.success && user.data.username).toBe("alice-two");
  });

  it("refuses with a 403, in the same statement, once a claim exists", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(db, raw);
    const claimed = await claimNamespace(
      db,
      { ownerId: "usr_1", namespace: "@alice", slug: "proj" },
      mockLogger,
    );
    expect(claimed.success).toBe(true);
    const renamed = await renameUser(db, "usr_1", "alice-two", mockLogger);
    expect(renamed.success).toBe(false);
    expect(!renamed.success && renamed.error.statusCode).toBe(403);
    const user = await getUser(db, "usr_1", mockLogger);
    expect(user.success && user.data.username).toBe("alice");
  });

  it("does not count another account's claims", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(db, raw);
    await claimNamespace(db, { ownerId: "usr_2", namespace: "@bob", slug: "proj" }, mockLogger);
    const renamed = await renameUser(db, "usr_1", "alice-two", mockLogger);
    expect(renamed.success && renamed.data).toBe("alice-two");
  });

  it("still tells an unknown user apart from a claimed one", async () => {
    const { db } = makeSqliteD1();
    const renamed = await renameUser(db, "usr_9", "carol", mockLogger);
    expect(!renamed.success && renamed.error.statusCode).toBe(404);
  });
});
