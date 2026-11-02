import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createImportJob, getImportProgress, updateImportStatus } from "../src/storage/imports";
import type { ImportStatus } from "../src/types";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(function (this: unknown) {
    return logger;
  }),
};

function jobParams(overrides: Record<string, unknown> = {}) {
  return {
    id: "imp_1",
    projectId: "prj_1",
    namespace: "@acme",
    slug: "widgets",
    sourceUrl: "https://github.com/acme/widgets",
    branch: "main",
    ...overrides,
  };
}

/**
 * Regression cover for #304. The status CHECK constraint in migration 010
 * omitted 'syncing' and 'checking' while `ImportStatus` and the queue consumer
 * both used 'syncing', so the consumer's status write failed with SQLite error
 * 19 on every sync and the row silently kept its previous status. Nothing
 * caught it because no test ever wrote those statuses against the real schema.
 */
describe("import status persistence against the real schema", () => {
  const ALL_STATUSES: ImportStatus[] = [
    "queued",
    "cloning",
    "processing",
    "completed",
    "failed",
    "cancelled",
    "cancelling",
    "syncing",
    "checking",
  ];

  for (const status of ALL_STATUSES) {
    it(`persists the '${status}' status`, async () => {
      const { db, raw } = makeSqliteD1();
      await createImportJob(db, jobParams(), logger);

      const updated = await updateImportStatus(db, "@acme", "widgets", status, logger);
      expect(updated.success).toBe(true);

      const read = await getImportProgress(db, "@acme", "widgets", logger);
      expect(read.success && read.data?.status).toBe(status);
      raw.close();
    });
  }

  // The specific write at src/queue/import-queue.ts that was failing.
  it("records 'syncing' when the consumer enters its sync phase", async () => {
    const { db, raw } = makeSqliteD1();
    await createImportJob(db, jobParams(), logger);

    const result = await updateImportStatus(
      db,
      "@acme",
      "widgets",
      "syncing",
      logger,
      "Syncing repository",
    );

    expect(result.success).toBe(true);
    const read = await getImportProgress(db, "@acme", "widgets", logger);
    expect(read.success && read.data?.status).toBe("syncing");
    raw.close();
  });
});

describe("migration 043 schema shape", () => {
  it("indexes (status, updated_at) so the stall sweep does not scan", () => {
    const { raw } = makeSqliteD1();
    const indexes = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='import_jobs' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;

    expect(indexes.map((i) => i.name)).toContain("idx_import_jobs_status_updated_at");
    raw.close();
  });

  it("keeps every index the rebuild was responsible for recreating", () => {
    const { raw } = makeSqliteD1();
    const names = (
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='import_jobs' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as Array<{ name: string }>
    ).map((i) => i.name);

    for (const expected of [
      "idx_import_jobs_ns_slug",
      "idx_import_jobs_status",
      "idx_import_jobs_completed_at",
      "idx_import_jobs_project_id",
      "idx_import_jobs_version",
    ]) {
      expect(names).toContain(expected);
    }
    raw.close();
  });
});

/**
 * These apply the migrations by hand, stopping before 043, so the upgrade is
 * genuinely exercised against pre-043 data. `makeSqliteD1` applies every
 * migration at construction, which would make the assertions vacuous.
 */
describe("migration 043 upgrade path", () => {
  const migrationSql = import.meta.glob("../migrations/*.sql", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  function sortedMigrations(): Array<[string, string]> {
    return Object.entries(migrationSql)
      .map(([path, sql]) => [path.split("/").pop() ?? path, sql] as [string, string])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  function dbAtPre043(): DatabaseSync {
    const raw = new DatabaseSync(":memory:");
    for (const [name, sql] of sortedMigrations()) {
      if (name.startsWith("043")) continue;
      raw.exec(sql);
    }
    return raw;
  }

  function apply043(raw: DatabaseSync): void {
    const entry = sortedMigrations().find(([name]) => name.startsWith("043"));
    if (!entry) throw new Error("migration 043 not found");
    raw.exec(entry[1]);
  }

  // Proves the bug the migration exists to fix, so the test fails loudly if
  // anyone reintroduces the narrow constraint.
  it("rejects 'syncing' before the migration and accepts it after", () => {
    const raw = dbAtPre043();
    const insertSyncing = () =>
      raw
        .prepare(
          `INSERT INTO import_jobs (id, project_id, namespace, slug, status, source_url, branch)
           VALUES ('imp_s','prj_1','@acme','widgets','syncing','https://x/y','main')`,
        )
        .run();

    expect(insertSyncing).toThrow(/CHECK constraint failed/);

    apply043(raw);
    expect(insertSyncing).not.toThrow();
    raw.close();
  });

  it("carries existing job rows through the rebuild, including depth 0", () => {
    const raw = dbAtPre043();
    raw
      .prepare(
        `INSERT INTO import_jobs (id, project_id, namespace, slug, status, source_url, branch, depth)
         VALUES ('imp_kept','prj_1','@acme','widgets','processing','https://x/y','main',0)`,
      )
      .run();

    apply043(raw);

    const rows = raw.prepare("SELECT id, status, depth FROM import_jobs").all() as Array<{
      id: string;
      status: string;
      depth: number | null;
    }>;
    expect(rows).toEqual([{ id: "imp_kept", status: "processing", depth: 0 }]);
    raw.close();
  });

  // The rebuild drops import_jobs, which fires ON DELETE SET NULL across
  // failed_imports.import_id (foreign keys are enforced in both node:sqlite and
  // D1, and defer_foreign_keys does not suppress delete actions). The migration
  // snapshots and restores the linkage; without it every historical failure
  // record is orphaned from the job it describes.
  it("preserves failed_imports linkage across the rebuild", () => {
    const raw = dbAtPre043();
    raw
      .prepare(
        `INSERT INTO import_jobs (id, project_id, namespace, slug, status, source_url, branch)
         VALUES ('imp_kept','prj_1','@acme','widgets','failed','https://x/y','main')`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO failed_imports (import_id, namespace, slug, error_type, error_message)
         VALUES ('imp_kept','@acme','widgets','CLONE_FAILED','boom')`,
      )
      .run();

    apply043(raw);

    const rows = raw.prepare("SELECT import_id FROM failed_imports").all() as Array<{
      import_id: string | null;
    }>;
    expect(rows[0]?.import_id).toBe("imp_kept");
    raw.close();
  });

  // A row written outside the storage layer takes the CURRENT_TIMESTAMP
  // default, which is 'YYYY-MM-DD HH:MM:SS'. Mixed with the ISO strings the
  // storage layer writes, TEXT range comparisons break in both directions
  // ('T' 0x54 sorts after ' ' 0x20), which is what stopped stall detection from
  // ever matching. The rebuild normalises the column so one format is possible.
  it("normalises legacy SQLite-format timestamps to ISO", () => {
    const raw = dbAtPre043();
    raw
      .prepare(
        `INSERT INTO import_jobs (id, project_id, namespace, slug, status, source_url, branch,
                                  started_at, updated_at, completed_at)
         VALUES ('imp_legacy','prj_1','@acme','widgets','failed','https://x/y','main',
                 datetime('now', '-2 days'), datetime('now', '-1 days'), datetime('now', '-1 days'))`,
      )
      .run();

    const before = raw.prepare("SELECT updated_at FROM import_jobs").get() as {
      updated_at: string;
    };
    expect(before.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    apply043(raw);

    const after = raw
      .prepare("SELECT started_at, updated_at, completed_at FROM import_jobs")
      .get() as { started_at: string; updated_at: string; completed_at: string };
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    expect(after.started_at).toMatch(iso);
    expect(after.updated_at).toMatch(iso);
    expect(after.completed_at).toMatch(iso);
    raw.close();
  });

  it("leaves a NULL completed_at alone while normalising the others", () => {
    const raw = dbAtPre043();
    raw
      .prepare(
        `INSERT INTO import_jobs (id, project_id, namespace, slug, status, source_url, branch, updated_at)
         VALUES ('imp_running','prj_1','@acme','widgets','processing','https://x/y','main',
                 datetime('now', '-10 minutes'))`,
      )
      .run();

    apply043(raw);

    const row = raw.prepare("SELECT updated_at, completed_at FROM import_jobs").get() as {
      updated_at: string;
      completed_at: string | null;
    };
    expect(row.completed_at).toBeNull();
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    raw.close();
  });

  it("leaves no scratch table behind", () => {
    const raw = dbAtPre043();
    apply043(raw);

    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);

    expect(tables).not.toContain("import_jobs_fk_backup");
    expect(tables).not.toContain("import_jobs_new");
    expect(tables).toContain("import_jobs");
    raw.close();
  });
});
