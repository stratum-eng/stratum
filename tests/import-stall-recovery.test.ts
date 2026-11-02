import { describe, expect, it, vi } from "vitest";
import {
  STALLED_THRESHOLD_MS,
  createImportJob,
  getImportById,
  recoverStalledImport,
} from "../src/storage/imports";
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

async function seed(
  db: D1Database,
  raw: ReturnType<typeof makeSqliteD1>["raw"],
  status: ImportStatus,
  minutesSinceUpdate: number,
) {
  await createImportJob(
    db,
    {
      id: "imp_1",
      projectId: "prj_1",
      namespace: "@acme",
      slug: "widgets",
      sourceUrl: "https://github.com/acme/widgets",
      branch: "main",
    },
    logger,
  );
  // ISO-8601, matching what the storage layer writes — see the note in
  // tests/import-sweep.test.ts.
  const updatedAt = new Date(Date.now() - minutesSinceUpdate * 60_000).toISOString();
  raw
    .prepare("UPDATE import_jobs SET status = ?, updated_at = ? WHERE id = 'imp_1'")
    .run(status, updatedAt);
}

/**
 * The on-demand half of #304. `recoverStalledImport` always matched
 * 'cancelling' in SQL, but the progress route's guard listed only the active
 * statuses, so a wedged cancel was never handed to it — the case that produced
 * a CANCELLING badge lasting months.
 */
describe("recoverStalledImport", () => {
  it("recovers a stale 'cancelling' job to 'cancelled'", async () => {
    const { db, raw } = makeSqliteD1();
    await seed(db, raw, "cancelling", 60);

    const result = await recoverStalledImport(db, "@acme", "widgets", STALLED_THRESHOLD_MS, logger);

    expect(result.success && result.data).toBe(true);
    const job = await getImportById(db, "imp_1", logger);
    expect(job.success && job.data?.status).toBe("cancelled");
    raw.close();
  });

  it("recovers a stale 'syncing' job to 'failed'", async () => {
    const { db, raw } = makeSqliteD1();
    await seed(db, raw, "syncing", 60);

    const result = await recoverStalledImport(db, "@acme", "widgets", STALLED_THRESHOLD_MS, logger);

    expect(result.success && result.data).toBe(true);
    const job = await getImportById(db, "imp_1", logger);
    expect(job.success && job.data?.status).toBe("failed");
    raw.close();
  });

  it("leaves a job that is still progressing alone", async () => {
    const { db, raw } = makeSqliteD1();
    await seed(db, raw, "cancelling", 1);

    const result = await recoverStalledImport(db, "@acme", "widgets", STALLED_THRESHOLD_MS, logger);

    expect(result.success && result.data).toBe(false);
    const job = await getImportById(db, "imp_1", logger);
    expect(job.success && job.data?.status).toBe("cancelling");
    raw.close();
  });

  // The function selects the stalest matching row but used to write back via
  // namespace+slug, which `updateImportProgress` resolves to the NEWEST row for
  // the project. Since a project owns one row per sync, that combination failed
  // a healthy in-flight job and left the wedged one untouched — the opposite of
  // the intent.
  it("recovers the stalled row and leaves a newer healthy job alone", async () => {
    const { db, raw } = makeSqliteD1();
    for (const id of ["imp_wedged", "imp_live"]) {
      await createImportJob(
        db,
        {
          id,
          projectId: "prj_1",
          namespace: "@acme",
          slug: "widgets",
          sourceUrl: "https://github.com/acme/widgets",
          branch: "main",
        },
        logger,
      );
    }

    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    raw
      .prepare(
        "UPDATE import_jobs SET status = 'cancelling', updated_at = ?, started_at = ? WHERE id = 'imp_wedged'",
      )
      .run(stale, "2020-01-01T00:00:00.000Z");
    raw
      .prepare(
        "UPDATE import_jobs SET status = 'processing', updated_at = ?, started_at = ? WHERE id = 'imp_live'",
      )
      .run(new Date().toISOString(), new Date().toISOString());

    const result = await recoverStalledImport(db, "@acme", "widgets", STALLED_THRESHOLD_MS, logger);

    expect(result.success && result.data).toBe(true);
    const wedged = await getImportById(db, "imp_wedged", logger);
    const live = await getImportById(db, "imp_live", logger);
    expect(wedged.success && wedged.data?.status).toBe("cancelled");
    expect(live.success && live.data?.status).toBe("processing");
    raw.close();
  });

  it("does nothing for a job already in a terminal state", async () => {
    const { db, raw } = makeSqliteD1();
    await seed(db, raw, "failed", 500);

    const result = await recoverStalledImport(db, "@acme", "widgets", STALLED_THRESHOLD_MS, logger);

    expect(result.success && result.data).toBe(false);
    raw.close();
  });
});
