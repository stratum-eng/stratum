import { describe, expect, it, vi } from "vitest";
import {
  createSession,
  deleteAllUserSessions,
  deleteSession,
  getSession,
  getUserSessions,
  refreshSession,
} from "../src/storage/sessions";
import { hashToken } from "../src/utils/crypto";
import type { Logger } from "../src/utils/logger";

const log = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => log),
} as unknown as Logger;

/** In-memory sessions table keyed by the stored `id` (which should be a hash). */
function makeSessionsD1(): {
  db: D1Database;
  rows: Map<string, { user_id: string; expires_at: string }>;
} {
  const rows = new Map<string, { user_id: string; expires_at: string }>();
  function stmt(sql: string, binds: unknown[] = []) {
    return {
      bind: (...args: unknown[]) => stmt(sql, args),
      run: async () => {
        if (/^INSERT INTO sessions/i.test(sql)) {
          rows.set(binds[0] as string, {
            user_id: binds[1] as string,
            expires_at: binds[2] as string,
          });
        }
        return { success: true, meta: { changes: 1 } };
      },
      first: async <T>() => {
        const m = sql.match(/WHERE id = \?/i);
        if (m) {
          const r = rows.get(binds[0] as string);
          return r ? ({ id: binds[0], user_id: r.user_id, expires_at: r.expires_at } as T) : null;
        }
        return null;
      },
      all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
    };
  }
  return { db: { prepare: (sql: string) => stmt(sql) } as unknown as D1Database, rows };
}

describe("session hashing at rest", () => {
  it("stores the hash of the id (not the raw id) and resolves by the raw cookie", async () => {
    const { db, rows } = makeSessionsD1();
    const created = await createSession(db, "user_1", log);
    expect(created.success).toBe(true);
    if (!created.success) return;

    const rawId = created.data.id;
    // The stored key is the hash, never the raw id that goes in the cookie.
    expect(rows.has(rawId)).toBe(false);
    expect(rows.has(await hashToken(rawId))).toBe(true);

    // getSession resolves the raw cookie id (hashes internally) and returns it.
    const got = await getSession(db, rawId, log);
    expect(got.success && got.data.userId).toBe("user_1");
    expect(got.success && got.data.id).toBe(rawId);

    // Migration behavior: a LEGACY row keyed by the raw plaintext id (as written
    // before hashing-at-rest) must no longer resolve — getSession hashes the
    // incoming id, so the plaintext-keyed row is unreachable.
    const legacyRawId = "sess_legacy_plaintext_0000000000";
    rows.set(legacyRawId, { user_id: "user_legacy", expires_at: "2099-01-01T00:00:00.000Z" });
    const legacyLookup = await getSession(db, legacyRawId, log);
    expect(legacyLookup.success).toBe(false);
  });
});

describe("Session Storage Functions", () => {
  // Note: These are unit tests for the storage functions
  // Integration tests would require a real D1 database

  describe("createSession", () => {
    it("should be defined", () => {
      expect(createSession).toBeDefined();
      expect(typeof createSession).toBe("function");
    });

    it("should accept rememberMe parameter", () => {
      // Verify function signature accepts rememberMe
      const fn = createSession;
      expect(fn.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("refreshSession", () => {
    it("should be defined", () => {
      expect(refreshSession).toBeDefined();
      expect(typeof refreshSession).toBe("function");
    });

    it("should accept rememberMe parameter", () => {
      const fn = refreshSession;
      expect(fn.length).toBe(4);
    });
  });

  describe("deleteAllUserSessions", () => {
    it("should be defined", () => {
      expect(deleteAllUserSessions).toBeDefined();
      expect(typeof deleteAllUserSessions).toBe("function");
    });
  });

  describe("getUserSessions", () => {
    it("should be defined", () => {
      expect(getUserSessions).toBeDefined();
      expect(typeof getUserSessions).toBe("function");
    });
  });

  describe("deleteSession", () => {
    it("should be defined", () => {
      expect(deleteSession).toBeDefined();
      expect(typeof deleteSession).toBe("function");
    });
  });
});

describe("Session Router", () => {
  it("should have session router defined", async () => {
    const { sessionRouter } = await import("../src/routes/sessions");
    expect(sessionRouter).toBeDefined();
  });

  it("should export session router", async () => {
    const { sessionRouter } = await import("../src/routes/sessions");
    expect(sessionRouter).toBeTruthy();
  });
});
