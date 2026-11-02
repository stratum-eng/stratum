import { describe, expect, it } from "vitest";
import { BACKUP_EXCLUDED_TABLES, BACKUP_TABLES } from "../src/storage/d1-backup";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

/**
 * Backup-coverage drift guard. `BACKUP_TABLES` is a hand-maintained allow-list,
 * so a new table holding user data could be added in a migration and silently
 * left out of every backup. This derives the real table set from migrations/
 * (the schema source of truth) and asserts every table is either backed up or
 * explicitly excluded — forcing that decision at PR time, not after data loss.
 *
 * The set comes from the schema the migrations actually build, not from a regex
 * over their text: a table rebuild (migration 043) creates a scratch table and a
 * `_new` table that it drops and renames away before finishing, and neither
 * exists at runtime to be backed up.
 */
function tablesDefinedInMigrations(): Set<string> {
  const { raw } = makeSqliteD1();
  try {
    const rows = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name.toLowerCase()));
  } finally {
    raw.close();
  }
}

describe("backup coverage", () => {
  const migrationTables = tablesDefinedInMigrations();
  const backed = new Set(BACKUP_TABLES);
  const excluded = new Set(BACKUP_EXCLUDED_TABLES);

  it("has migration tables to check", () => {
    expect(migrationTables.size).toBeGreaterThan(0);
  });

  it("classifies every migration table as backed-up or explicitly excluded", () => {
    const unclassified = [...migrationTables]
      .filter((t) => !backed.has(t) && !excluded.has(t))
      .sort();
    // If this fails, a new table was added without deciding its backup fate:
    // add it to BACKUP_TABLES (in FK order) or to BACKUP_EXCLUDED_TABLES (with a reason).
    expect(unclassified).toEqual([]);
  });

  it("never lists a table as both backed-up and excluded", () => {
    const overlap = [...backed].filter((t) => excluded.has(t)).sort();
    expect(overlap).toEqual([]);
  });

  it("references only real tables (no typos or dropped tables)", () => {
    const phantomBacked = [...backed].filter((t) => !migrationTables.has(t)).sort();
    const phantomExcluded = [...excluded].filter((t) => !migrationTables.has(t)).sort();
    expect(phantomBacked).toEqual([]);
    expect(phantomExcluded).toEqual([]);
  });
});
