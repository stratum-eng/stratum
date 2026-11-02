import { describe, expect, it, vi } from "vitest";
import {
  cleanupOldImports,
  createImportJob,
  getImportById,
  getLatestImportDepth,
} from "../src/storage/imports";
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

async function seedFinished(
  db: D1Database,
  raw: ReturnType<typeof makeSqliteD1>["raw"],
  id: string,
  daysAgo: number,
) {
  await createImportJob(
    db,
    {
      id,
      projectId: "prj_1",
      namespace: "@acme",
      slug: id,
      sourceUrl: "https://github.com/acme/widgets",
      branch: "main",
    },
    logger,
  );
  // ISO-8601: cleanupOldImports binds an ISO cutoff, and the two timestamp
  // formats do not compare correctly against each other.
  const completedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  raw
    .prepare("UPDATE import_jobs SET status = 'completed', completed_at = ? WHERE id = ?")
    .run(completedAt, id);
}

/**
 * `cleanupOldImports` existed but had no caller anywhere in src/, so nothing
 * pruned import_jobs. The stall sweep pushes jobs into a terminal state far
 * faster than before, which makes that gap matter — it is now wired into the
 * daily housekeeping cron.
 */
describe("cleanupOldImports", () => {
  it("removes jobs that finished before the retention cutoff", async () => {
    const { db, raw } = makeSqliteD1();
    // Two old jobs on one project: the older is prunable, the newest is the
    // project's depth record and must survive.
    await seedFinished(db, raw, "imp_old", 45);
    await seedFinished(db, raw, "imp_older", 60);
    raw
      .prepare("UPDATE import_jobs SET slug = 'shared', started_at = ? WHERE id = 'imp_old'")
      .run(new Date(Date.now() - 45 * 86_400_000).toISOString());
    raw
      .prepare("UPDATE import_jobs SET slug = 'shared', started_at = ? WHERE id = 'imp_older'")
      .run(new Date(Date.now() - 60 * 86_400_000).toISOString());

    const result = await cleanupOldImports(db, 30, logger);

    expect(result.success && result.data).toBe(1);
    const gone = await getImportById(db, "imp_older", logger);
    expect(gone.success && gone.data).toBeNull();
    raw.close();
  });

  // Retention must not undo what the delete route deliberately protects.
  // The scenario raised in review: a full-history import that finished long ago,
  // followed by a newer job. Retention deletes the older row, so the question is
  // whether the depth survives. It does, because every sync carries the depth
  // forward onto the row it creates (see getLatestImportDepth's callers), and
  // the row retention protects is the same row that reader selects.
  it("keeps the depth reachable when an older full-history import is pruned", async () => {
    const { db, raw } = makeSqliteD1();
    const day = 24 * 60 * 60 * 1000;

    for (const [id, startedDaysAgo, depth] of [
      ["imp_full", 60, 0],
      ["imp_recent_sync", 40, 0],
    ] as const) {
      await createImportJob(
        db,
        {
          id,
          projectId: "prj_1",
          namespace: "@acme",
          slug: "widgets",
          sourceUrl: "https://github.com/acme/widgets",
          branch: "main",
          depth,
        },
        logger,
      );
      raw
        .prepare(
          "UPDATE import_jobs SET status='completed', started_at=?, completed_at=? WHERE id=?",
        )
        .run(
          new Date(Date.now() - startedDaysAgo * day).toISOString(),
          new Date(Date.now() - startedDaysAgo * day).toISOString(),
          id,
        );
    }

    expect(await getLatestImportDepth(db, "@acme", "widgets", logger)).toBe(0);

    const result = await cleanupOldImports(db, 30, logger);

    // The older row is prunable; the newest is protected and still carries depth 0.
    expect(result.success && result.data).toBe(1);
    expect((await getImportById(db, "imp_full", logger)).success).toBe(true);
    expect(await getLatestImportDepth(db, "@acme", "widgets", logger)).toBe(0);
    raw.close();
  });

  it("prunes only within a project, never across projects", async () => {
    const { db, raw } = makeSqliteD1();
    for (const slug of ["alpha", "beta"]) {
      for (const [id, daysAgo] of [
        [`${slug}_old`, 90],
        [`${slug}_new`, 45],
      ] as const) {
        await createImportJob(
          db,
          {
            id,
            projectId: "prj_1",
            namespace: "@acme",
            slug,
            sourceUrl: "https://github.com/acme/x",
            branch: "main",
            depth: 0,
          },
          logger,
        );
        const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
        raw
          .prepare(
            "UPDATE import_jobs SET status='completed', started_at=?, completed_at=? WHERE id=?",
          )
          .run(at, at, id);
      }
    }

    const result = await cleanupOldImports(db, 30, logger);

    // One pruned per project, each project keeping its own newest row.
    expect(result.success && result.data).toBe(2);
    for (const slug of ["alpha", "beta"]) {
      expect((await getImportById(db, `${slug}_old`, logger)).success).toBe(true);
      const kept = await getImportById(db, `${slug}_new`, logger);
      expect(kept.success && kept.data?.id).toBe(`${slug}_new`);
      expect(await getLatestImportDepth(db, "@acme", slug, logger)).toBe(0);
    }
    raw.close();
  });

  it("always keeps the newest job so clone depth survives", async () => {
    const { db, raw } = makeSqliteD1();
    await seedFinished(db, raw, "imp_only", 400);
    raw.prepare("UPDATE import_jobs SET depth = 0 WHERE id = 'imp_only'").run();

    const result = await cleanupOldImports(db, 30, logger);

    expect(result.success && result.data).toBe(0);
    expect(await getLatestImportDepth(db, "@acme", "imp_only", logger)).toBe(0);
    raw.close();
  });

  it("keeps jobs that finished inside the retention window", async () => {
    const { db, raw } = makeSqliteD1();
    await seedFinished(db, raw, "imp_recent", 5);

    const result = await cleanupOldImports(db, 30, logger);

    expect(result.success && result.data).toBe(0);
    const kept = await getImportById(db, "imp_recent", logger);
    expect(kept.success && kept.data?.id).toBe("imp_recent");
    raw.close();
  });

  // completed_at is NULL while a job is still running; retention must never
  // reap an import that has not finished, however old the row is.
  it("never removes a job that has not completed", async () => {
    const { db, raw } = makeSqliteD1();
    await createImportJob(
      db,
      {
        id: "imp_running",
        projectId: "prj_1",
        namespace: "@acme",
        slug: "widgets",
        sourceUrl: "https://github.com/acme/widgets",
        branch: "main",
      },
      logger,
    );
    raw
      .prepare("UPDATE import_jobs SET started_at = datetime('now', '-400 days') WHERE id = ?")
      .run("imp_running");

    const result = await cleanupOldImports(db, 30, logger);

    expect(result.success && result.data).toBe(0);
    const kept = await getImportById(db, "imp_running", logger);
    expect(kept.success && kept.data?.id).toBe("imp_running");
    raw.close();
  });
});
