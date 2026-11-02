/// <reference types="vite/client" />
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/**
 * Migration safety net. D1 migrations are forward-only and are applied straight
 * against staging/production at deploy time, so a syntax error, bad ordering, or
 * schema drift is otherwise caught only in prod. These tests apply every
 * migration from an empty database to a real SQLite engine (node:sqlite) — the
 * engine family D1 is built on. This proves the SQL is well-formed SQLite and
 * the schema is coherent; it approximates but does not perfectly replicate D1's
 * exact dialect.
 *
 * SQL is loaded via Vite's raw glob (not node:fs) so the test type-checks under
 * the Workers tsconfig; node:sqlite is typed by tests/node-sqlite.d.ts.
 */
const migrationModules = import.meta.glob("../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Basename → SQL, sorted byte-wise by filename to mirror wrangler/D1's apply
// order (a scalar filename sort, not locale collation).
const migrations = Object.entries(migrationModules)
  .map(([path, sql]) => [path.split("/").pop() ?? path, sql] as const)
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

// Load-bearing tables that must exist after a full migration run. A missing one
// means the schema is broken (a missing `events` outbox was the #118 incident).
const EXPECTED_CORE_TABLES = [
  "users",
  "sessions",
  "changes",
  "events",
  "issues",
  "orgs",
  "teams",
  "webhooks",
  "audit_log",
  "identities",
  "org_sso_connections",
  "scim_members",
  "oidc_login_states",
];

// 024 was duplicated historically and is already applied to production under
// both names, so it cannot be renamed. We freeze the exact pair (not just the
// number) so a THIRD file reusing 024 — or any other collision — still fails.
const FROZEN_DUPLICATES: [string, string[]][] = [
  ["024", ["024_backup_state.sql", "024_change_workspace_head_sha.sql"]],
];

function applyAllMigrations(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const [, sql] of migrations) db.exec(sql);
  return db;
}

function tableNames(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
    name: string;
  }[];
  return new Set(rows.map((r) => r.name));
}

describe("migrations", () => {
  it("has migration files to check", () => {
    expect(migrations.length).toBeGreaterThan(0);
  });

  it("all filenames follow the NNN_name.sql convention", () => {
    for (const [name] of migrations) {
      expect(name, `${name} must match NNN_name.sql`).toMatch(/^\d{3}_[a-z0-9_]+\.sql$/);
    }
  });

  it("does not reuse a migration number (only the exact frozen 024 pair)", () => {
    const byNumber = new Map<string, string[]>();
    for (const [name] of migrations) {
      const num = name.slice(0, 3);
      byNumber.set(num, [...(byNumber.get(num) ?? []), name].sort());
    }
    const duplicated = [...byNumber]
      .filter(([, names]) => names.length > 1)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    // Asserting the exact filename pair (not just "024") means a third file
    // reusing the 024 slot fails, and any new collision fails too.
    expect(duplicated).toEqual(FROZEN_DUPLICATES);
  });

  it("applies cleanly from an empty database, in order", () => {
    expect(() => {
      const db = applyAllMigrations();
      db.close();
    }).not.toThrow();
  });

  it("produces the load-bearing schema", () => {
    const db = applyAllMigrations();
    const tables = tableNames(db);
    db.close();
    for (const table of EXPECTED_CORE_TABLES) {
      expect(tables, `${table} must exist after all migrations`).toContain(table);
    }
  });
});
