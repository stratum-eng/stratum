/// <reference types="vite/client" />
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkMergeProtection } from "../src/merge/protection";
import {
  addComment,
  countApprovals,
  getComment,
  listComments,
  setCommentResolved,
  submitReview,
} from "../src/storage/change-reviews";
import type { Change } from "../src/types";
import type { Logger } from "../src/utils/logger";

/**
 * Line-comment + comment-only-review storage semantics (#192), exercised
 * against the REAL migrated schema: every migration is applied to an
 * in-memory SQLite database (the engine family D1 is built on) and a thin D1
 * adapter runs the production SQL — including the widened verdict CHECK and
 * the ON CONFLICT DO NOTHING path — for real.
 */

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
} as unknown as Logger;

const migrationModules = import.meta.glob("../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const migrations = Object.entries(migrationModules)
  .map(([path, sql]) => [path.split("/").pop() ?? path, sql] as const)
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** Adapt node:sqlite to the D1Database subset the storage layer uses. */
function d1FromSqlite(db: DatabaseSync): D1Database {
  const makeStmt = (sql: string, binds: unknown[]) => ({
    bind: (...args: unknown[]) => makeStmt(sql, args),
    run: async () => {
      const result = db.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
    first: async <T>() => (db.prepare(sql).get(...binds) ?? null) as T | null,
    all: async <T>() => ({
      results: db.prepare(sql).all(...binds) as T[],
      success: true,
      meta: {},
    }),
  });
  return { prepare: (sql: string) => makeStmt(sql, []) } as unknown as D1Database;
}

const openDbs: DatabaseSync[] = [];

function migratedDb(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  for (const [, sql] of migrations) raw.exec(sql);
  openDbs.push(raw);
  return { db: d1FromSqlite(raw), raw };
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

describe("migration 036", () => {
  it("adds the anchor/thread columns to change_comments", () => {
    const { raw } = migratedDb();
    const columns = (raw.prepare("PRAGMA table_info(change_comments)").all() as { name: string }[])
      .map((c) => c.name)
      .sort();
    expect(columns).toEqual(
      [
        "id",
        "change_id",
        "author_type",
        "author_id",
        "body",
        "created_at",
        "file",
        "line",
        "side",
        "commit_sha",
        "parent_comment_id",
        "resolved",
      ].sort(),
    );
  });

  it("widens the change_reviews verdict CHECK to allow 'comment' but nothing else", () => {
    const { raw } = migratedDb();
    const insert = raw.prepare(
      "INSERT INTO change_reviews (id, change_id, reviewer_id, verdict, comment, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
    );
    expect(() => insert.run("rev_1", "chg_1", "user_1", "comment", "2026-01-01")).not.toThrow();
    expect(() => insert.run("rev_2", "chg_1", "user_2", "bogus", "2026-01-01")).toThrow();
    // The upsert key survives the table rebuild.
    expect(() => insert.run("rev_3", "chg_1", "user_1", "approve", "2026-01-01")).toThrow(
      /UNIQUE/i,
    );
  });

  it("rejects an out-of-range side on change_comments", () => {
    const { raw } = migratedDb();
    expect(() =>
      raw
        .prepare(
          "INSERT INTO change_comments (id, change_id, author_type, author_id, body, created_at, side) VALUES ('c1','chg_1','user','u1','x','2026-01-01','left')",
        )
        .run(),
    ).toThrow();
  });
});

describe("anchored comments", () => {
  it("round-trips a line anchor through add/list", async () => {
    const { db } = migratedDb();
    const added = await addComment(db, mockLogger, {
      changeId: "chg_1",
      authorType: "user",
      authorId: "user_1",
      body: "This loop is off by one",
      file: "src/x.ts",
      line: 42,
      side: "new",
      commitSha: "abc123",
    });
    expect(added.success).toBe(true);

    const listed = await listComments(db, mockLogger, "chg_1");
    expect(listed.success).toBe(true);
    if (!listed.success) return;
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({
      file: "src/x.ts",
      line: 42,
      side: "new",
      commitSha: "abc123",
      resolved: false,
    });
    expect(listed.data[0]?.parentCommentId).toBeUndefined();
  });

  it("keeps change-level comments valid with all anchors absent", async () => {
    const { db } = migratedDb();
    await addComment(db, mockLogger, {
      changeId: "chg_1",
      authorType: "agent",
      authorId: "agent_1",
      body: "Plain discussion",
    });
    const listed = await listComments(db, mockLogger, "chg_1");
    expect(listed.success).toBe(true);
    if (!listed.success) return;
    expect(listed.data[0]?.file).toBeUndefined();
    expect(listed.data[0]?.line).toBeUndefined();
    expect(listed.data[0]?.side).toBeUndefined();
    expect(listed.data[0]?.resolved).toBe(false);
  });

  it("lists replies with parent_comment_id so threads are reconstructable", async () => {
    const { db } = migratedDb();
    const root = await addComment(db, mockLogger, {
      changeId: "chg_1",
      authorType: "user",
      authorId: "user_1",
      body: "Root",
      file: "src/x.ts",
      line: 3,
    });
    if (!root.success) throw new Error("root insert failed");
    const reply = await addComment(db, mockLogger, {
      changeId: "chg_1",
      authorType: "user",
      authorId: "user_2",
      body: "Reply",
      file: "src/x.ts",
      line: 3,
      parentCommentId: root.data.id,
    });
    if (!reply.success) throw new Error("reply insert failed");

    const listed = await listComments(db, mockLogger, "chg_1");
    expect(listed.success).toBe(true);
    if (!listed.success) return;
    const listedReply = listed.data.find((c) => c.id === reply.data.id);
    expect(listedReply?.parentCommentId).toBe(root.data.id);
    expect(listedReply?.file).toBe("src/x.ts");
    expect(listedReply?.line).toBe(3);
  });
});

describe("getComment / setCommentResolved", () => {
  it("fetches a comment by id and reports NOT_FOUND for a missing one", async () => {
    const { db } = migratedDb();
    const added = await addComment(db, mockLogger, {
      changeId: "chg_1",
      authorType: "user",
      authorId: "user_1",
      body: "hello",
    });
    if (!added.success) throw new Error("insert failed");

    const found = await getComment(db, mockLogger, added.data.id);
    expect(found.success && found.data.body).toBe("hello");

    const missing = await getComment(db, mockLogger, "cmt_nope");
    expect(missing.success).toBe(false);
    if (!missing.success) expect(missing.error.code).toBe("NOT_FOUND");
  });

  it("resolves and unresolves a comment", async () => {
    const { db } = migratedDb();
    const added = await addComment(db, mockLogger, {
      changeId: "chg_1",
      authorType: "user",
      authorId: "user_1",
      body: "root",
      file: "a.ts",
      line: 1,
    });
    if (!added.success) throw new Error("insert failed");

    const resolve = await setCommentResolved(db, mockLogger, added.data.id, true);
    expect(resolve.success).toBe(true);
    let fetched = await getComment(db, mockLogger, added.data.id);
    expect(fetched.success && fetched.data.resolved).toBe(true);

    const unresolve = await setCommentResolved(db, mockLogger, added.data.id, false);
    expect(unresolve.success).toBe(true);
    fetched = await getComment(db, mockLogger, added.data.id);
    expect(fetched.success && fetched.data.resolved).toBe(false);
  });

  it("reports NOT_FOUND when resolving a missing comment", async () => {
    const { db } = migratedDb();
    const result = await setCommentResolved(db, mockLogger, "cmt_nope", true);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("NOT_FOUND");
  });
});

describe("storage error paths", () => {
  const brokenDb = {
    prepare: () => {
      throw new Error("db down");
    },
  } as unknown as D1Database;

  it("surfaces a DATABASE_ERROR from getComment", async () => {
    const result = await getComment(brokenDb, mockLogger, "cmt_1");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("DATABASE_ERROR");
  });

  it("surfaces a DATABASE_ERROR from setCommentResolved", async () => {
    const result = await setCommentResolved(brokenDb, mockLogger, "cmt_1", true);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("DATABASE_ERROR");
  });

  it("surfaces a DATABASE_ERROR from a failed comment-verdict insert", async () => {
    const result = await submitReview(brokenDb, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "comment",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("DATABASE_ERROR");
  });

  it("surfaces failures from the other storage entry points too", async () => {
    const approve = await submitReview(brokenDb, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "approve",
    });
    expect(approve.success).toBe(false);

    const comments = await listComments(brokenDb, mockLogger, "chg_1");
    expect(comments.success).toBe(false);

    const approvals = await countApprovals(brokenDb, mockLogger, "chg_1");
    expect(approvals.success).toBe(false);
  });

  it("wraps a non-Error throw in a generic DATABASE_ERROR", async () => {
    const weirdDb = {
      prepare: () => {
        // Throwing a non-Error on purpose to hit the fallback message path.
        throw "string failure";
      },
    } as unknown as D1Database;
    const result = await getComment(weirdDb, mockLogger, "cmt_1");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("Failed in getComment");
  });

  it("rejects a reply to a non-existent parent at the schema level", async () => {
    const { db } = migratedDb();
    const result = await addComment(db, mockLogger, {
      changeId: "chg_1",
      authorType: "user",
      authorId: "user_1",
      body: "orphan reply",
      parentCommentId: "cmt_missing",
    });
    // node:sqlite enforces the FK; the storage layer maps it to an error
    // instead of persisting a dangling thread.
    expect(result.success).toBe(false);
  });

  it("falls back to the just-written review when the read-back returns nothing", async () => {
    // Emulates a D1 replica lagging its own write: DO NOTHING succeeded but
    // the SELECT sees no row. The caller still gets the review it submitted.
    const stubDb = {
      prepare: () => ({
        bind: function bind() {
          return this;
        },
        run: async () => ({ success: true, meta: { changes: 1 } }),
        first: async () => null,
      }),
    } as unknown as D1Database;
    const result = await submitReview(stubDb, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "comment",
      comment: "note",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.verdict).toBe("comment");
    expect(result.data.comment).toBe("note");
  });
});

describe("comment-only review verdict", () => {
  it("records 'comment' when the reviewer has no verdict yet", async () => {
    const { db } = migratedDb();
    const result = await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "comment",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.verdict).toBe("comment");

    const count = await countApprovals(db, mockLogger, "chg_1");
    expect(count.success && count.data).toBe(0);
  });

  it("never clobbers an existing approve with a later 'comment'", async () => {
    const { db } = migratedDb();
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "approve",
    });
    const later = await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "comment",
    });
    expect(later.success).toBe(true);
    if (!later.success) return;
    // The returned review is the untouched pre-existing verdict.
    expect(later.data.verdict).toBe("approve");

    const count = await countApprovals(db, mockLogger, "chg_1");
    expect(count.success && count.data).toBe(1);
  });

  it("keeps an existing request_changes verdict untouched too", async () => {
    const { db } = migratedDb();
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "request_changes",
      comment: "needs tests",
    });
    const later = await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "comment",
    });
    expect(later.success).toBe(true);
    if (!later.success) return;
    expect(later.data.verdict).toBe("request_changes");
    expect(later.data.comment).toBe("needs tests");
  });

  it("lets a real verdict replace a prior 'comment' review", async () => {
    const { db } = migratedDb();
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "comment",
    });
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "approve",
    });
    const count = await countApprovals(db, mockLogger, "chg_1");
    expect(count.success && count.data).toBe(1);
  });

  it("does not count toward approvals nor block merge protection", async () => {
    const { db } = migratedDb();
    const change = { id: "chg_1" } as Change;
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "comment",
    });

    const blocked = await checkMergeProtection(db, mockLogger, change, {
      merge: { requiredApprovals: 1 },
      // biome-ignore lint/suspicious/noExplicitAny: minimal policy under test
    } as any);
    expect(blocked.success).toBe(true);
    if (!blocked.success) return;
    // A comment-only review is NOT an approval: the merge stays blocked on
    // the approvals requirement (nothing else about the comment blocks it).
    expect(blocked.data.allowed).toBe(false);
    expect(blocked.data.reasons).toEqual(["Requires 1 approval, has 0"]);

    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_2",
      verdict: "approve",
    });
    const allowed = await checkMergeProtection(db, mockLogger, change, {
      merge: { requiredApprovals: 1 },
      // biome-ignore lint/suspicious/noExplicitAny: minimal policy under test
    } as any);
    expect(allowed.success).toBe(true);
    if (!allowed.success) return;
    // The other reviewer's standing 'comment' verdict does not block.
    expect(allowed.data.allowed).toBe(true);
  });
});
