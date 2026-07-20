import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELETED_USER_SENTINEL,
  anonymizeUserContributions,
  deleteAccountCascade,
} from "../src/storage/deletion";
import type { Env, ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { type ExecutedStatement, makeKvStub } from "./helpers/deletion-stubs";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

/**
 * Stateful-ish D1 stub for the account cascade: records every statement in
 * order and answers SELECTs from `rowsFor`. Ordering assertions rely on
 * `executed`.
 */
function makeAccountD1(
  rowsFor: (sql: string, bindings: unknown[]) => Record<string, unknown>[] = () => [],
): { db: D1Database; executed: ExecutedStatement[] } {
  const executed: ExecutedStatement[] = [];
  function makeStmt(sql: string, bindings: unknown[]) {
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => {
        executed.push({ sql, bindings });
        return { success: true, meta: { changes: 1 } };
      },
      all: async <T>() => {
        executed.push({ sql, bindings });
        return { results: rowsFor(sql, bindings) as T[], success: true, meta: {} };
      },
      first: async <T>() => {
        executed.push({ sql, bindings });
        return (rowsFor(sql, bindings)[0] ?? null) as T | null;
      },
    };
  }
  return { db: { prepare: (sql: string) => makeStmt(sql, []) } as unknown as D1Database, executed };
}

function project(overrides: Partial<ProjectEntry>): ProjectEntry {
  return {
    id: "proj_x",
    name: "x",
    slug: "x",
    namespace: "@alice",
    ownerId: "usr_1",
    ownerType: "user",
    remote: "https://acct.artifacts.cloudflare.net/git/@alice/x.git",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function sqlIndex(executed: ExecutedStatement[], fragment: string): number {
  return executed.findIndex((s) => s.sql.includes(fragment));
}

function makeEnv(db: D1Database, kv: KVNamespace): Env {
  return {
    DB: db,
    STATE: kv,
    ARTIFACTS: { delete: async () => true } as unknown as Env["ARTIFACTS"],
  } as Env;
}

describe("anonymizeUserContributions", () => {
  it("rewrites every identity column to the shared sentinel (no deletes)", async () => {
    const { db, executed } = makeAccountD1();
    const result = await anonymizeUserContributions(db, "usr_1", mockLogger);
    expect(result.success).toBe(true);

    const updates = executed.filter((s) => s.sql.startsWith("UPDATE"));
    expect(updates.length).toBe(7);
    for (const stmt of updates) {
      expect(stmt.sql).toMatch(/^UPDATE \w+ SET \w+ = \? WHERE \w+ = \?$/);
      expect(stmt.bindings).toEqual([DELETED_USER_SENTINEL, "usr_1"]);
    }
    // Never a DELETE against an identity table — contributions stay, author goes.
    expect(executed.some((s) => s.sql.startsWith("DELETE"))).toBe(false);
    const cols = updates.map((s) => s.sql);
    expect(cols).toContain("UPDATE audit_log SET actor_id = ? WHERE actor_id = ?");
    expect(cols).toContain("UPDATE change_reviews SET reviewer_id = ? WHERE reviewer_id = ?");
    expect(cols).toContain("UPDATE webhooks SET created_by = ? WHERE created_by = ?");
  });
});

describe("deleteAccountCascade", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes owned projects BEFORE anonymizing, and the user row LAST", async () => {
    const kv = makeKvStub(50);
    kv.store.set(
      "project:@alice:x",
      JSON.stringify(project({ id: "proj_x", name: "x", slug: "x" })),
    );
    // A project owned by someone else must be left untouched. Distinct name/slug
    // so it doesn't trip the (correct) cross-tenant name-collision guard.
    kv.store.set(
      "project:@bob:y",
      JSON.stringify(
        project({ id: "proj_y", name: "y", slug: "y", namespace: "@bob", ownerId: "usr_2" }),
      ),
    );
    const { db, executed } = makeAccountD1(() => []);
    const result = await deleteAccountCascade(makeEnv(db, kv.kv), "usr_1", mockLogger);
    expect(result.success).toBe(true);

    // Owned project's KV entry was deleted; the other user's was not.
    expect(kv.deletedKeys).toContain("project:@alice:x");
    expect(kv.deletedKeys).not.toContain("project:@bob:y");

    // Ordering: a project-scoped cascade delete precedes the anonymize UPDATE,
    // which precedes the users-row delete.
    const cascadeDelete = sqlIndex(executed, "DELETE FROM provenance");
    const anonymize = sqlIndex(executed, "UPDATE audit_log SET actor_id");
    const userDelete = sqlIndex(executed, "DELETE FROM users WHERE id = ?");
    expect(cascadeDelete).toBeGreaterThanOrEqual(0);
    expect(anonymize).toBeGreaterThan(cascadeDelete);
    expect(userDelete).toBeGreaterThan(anonymize);

    // Memberships + agents + sessions are cleared.
    expect(sqlIndex(executed, "DELETE FROM agents WHERE owner_id = ?")).toBeGreaterThanOrEqual(0);
    expect(sqlIndex(executed, "DELETE FROM org_members WHERE user_id = ?")).toBeGreaterThanOrEqual(
      0,
    );
    expect(sqlIndex(executed, "DELETE FROM team_members WHERE user_id = ?")).toBeGreaterThanOrEqual(
      0,
    );
  });

  it("RETAINS the user row when a project sub-cascade leaves residuals", async () => {
    // A stranded PII row + a deleted user is the worst outcome; erasure must not
    // delete the user until residuals are clear (a re-drive finishes it).
    const kv = makeKvStub(50);
    kv.store.set("project:@alice:x", JSON.stringify(project({ id: "proj_x", slug: "x" })));
    const { db, executed } = makeAccountD1(() => []);
    const failingArtifacts = {
      DB: db,
      STATE: kv.kv,
      ARTIFACTS: {
        delete: async () => {
          throw new Error("artifacts down");
        },
      } as unknown as Env["ARTIFACTS"],
    } as Env;

    const result = await deleteAccountCascade(failingArtifacts, "usr_1", mockLogger);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.residuals.length).toBeGreaterThan(0);
    expect(result.data.residuals).toContain("account:user-row-retained-pending-residuals");
    // The users-row delete must NOT have run while residuals remain.
    expect(executed.some((s) => s.sql.includes("DELETE FROM users WHERE id = ?"))).toBe(false);
  });

  it("promotes the lowest-user_id admin for a sole-owner org", async () => {
    const kv = makeKvStub(50);
    const { db, executed } = makeAccountD1((sql) => {
      if (sql.includes("SELECT id, owner_id FROM orgs WHERE owner_id")) {
        return [{ id: "org_1", owner_id: "usr_1" }];
      }
      if (sql.includes("role = 'admin' AND user_id != ?")) {
        return [{ user_id: "usr_admin_low" }];
      }
      return [];
    });
    const result = await deleteAccountCascade(makeEnv(db, kv.kv), "usr_1", mockLogger);
    expect(result.success).toBe(true);

    const promote = executed.find((s) => s.sql.includes("UPDATE orgs SET owner_id = ?"));
    expect(promote).toBeDefined();
    expect(promote?.bindings).toEqual(["usr_admin_low", "org_1"]);
    // No admin -> member fallback query needed since an admin was found.
    expect(executed.some((s) => s.sql.includes("DELETE FROM orgs WHERE id = ?"))).toBe(false);
  });

  it("promotes a plain member when no other admin remains", async () => {
    const kv = makeKvStub(50);
    const { db, executed } = makeAccountD1((sql) => {
      if (sql.includes("SELECT id, owner_id FROM orgs WHERE owner_id")) {
        return [{ id: "org_1", owner_id: "usr_1" }];
      }
      if (sql.includes("role = 'admin' AND user_id != ?")) return [];
      if (sql.includes("WHERE org_id = ? AND user_id != ?")) {
        return [{ user_id: "usr_member" }];
      }
      return [];
    });
    const result = await deleteAccountCascade(makeEnv(db, kv.kv), "usr_1", mockLogger);
    expect(result.success).toBe(true);

    const promote = executed.find((s) => s.sql.includes("UPDATE orgs SET owner_id = ?"));
    expect(promote?.bindings).toEqual(["usr_member", "org_1"]);
    expect(executed.some((s) => s.sql.includes("DELETE FROM orgs WHERE id = ?"))).toBe(false);
  });

  it("deletes the empty org (and its rows) when no other members remain", async () => {
    const kv = makeKvStub(50);
    const { db, executed } = makeAccountD1((sql) => {
      if (sql.includes("SELECT id, owner_id FROM orgs WHERE owner_id")) {
        return [{ id: "org_1", owner_id: "usr_1" }];
      }
      // No admin, no member.
      return [];
    });
    const result = await deleteAccountCascade(makeEnv(db, kv.kv), "usr_1", mockLogger);
    expect(result.success).toBe(true);

    expect(executed.some((s) => s.sql.includes("UPDATE orgs SET owner_id = ?"))).toBe(false);
    expect(executed.some((s) => s.sql.includes("DELETE FROM orgs WHERE id = ?"))).toBe(true);
    expect(executed.some((s) => s.sql.includes("DELETE FROM teams WHERE org_id = ?"))).toBe(true);
    expect(executed.some((s) => s.sql.includes("DELETE FROM org_members WHERE org_id = ?"))).toBe(
      true,
    );
  });

  it("completes (frees the user uniques) even with an owned org present", async () => {
    const kv = makeKvStub(50);
    const { db, executed } = makeAccountD1((sql) => {
      if (sql.includes("SELECT id, owner_id FROM orgs WHERE owner_id")) {
        return [{ id: "org_1", owner_id: "usr_1" }];
      }
      if (sql.includes("role = 'admin' AND user_id != ?")) return [{ user_id: "usr_2" }];
      return [];
    });
    const result = await deleteAccountCascade(makeEnv(db, kv.kv), "usr_1", mockLogger);
    expect(result.success).toBe(true);
    expect(result.success && result.data.residuals).toEqual([]);
    // The user row is deleted last — this frees email/username/token_hash/github_id.
    expect(executed.some((s) => s.sql.includes("DELETE FROM users WHERE id = ?"))).toBe(true);
  });
});
