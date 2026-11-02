import { describe, expect, it, vi } from "vitest";
import { runImportSweep } from "../src/queue/import-sweep";
import {
  QUEUED_GRACE_MS,
  STALLED_THRESHOLD_MS,
  createImportJob,
  getImportById,
  updateImportStatus,
} from "../src/storage/imports";
import type { Env, ImportStatus } from "../src/types";
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

/**
 * Exercised against a real SQLite engine rather than the namespace:slug Map
 * mock used elsewhere: that mock can only hold one job per project, which is
 * precisely the assumption the sweep must not make.
 */
function setup() {
  const { db, raw } = makeSqliteD1();
  return { db, raw, env: { DB: db } as unknown as Env };
}

/** The status values the sweep binds before its two cutoffs. */
const ACTIVE_STATUS_NAMES = ["cloning", "processing", "syncing", "checking", "cancelling"];

async function seedJob(
  db: D1Database,
  raw: ReturnType<typeof makeSqliteD1>["raw"],
  opts: {
    id: string;
    status: ImportStatus;
    minutesSinceUpdate: number;
    slug?: string;
  },
) {
  await createImportJob(
    db,
    {
      id: opts.id,
      projectId: "prj_1",
      namespace: "@acme",
      slug: opts.slug ?? "widgets",
      sourceUrl: "https://github.com/acme/widgets",
      branch: "main",
    },
    logger,
  );
  // Ages the row in ISO-8601, which is what the storage layer actually writes.
  // Seeding SQLite's `datetime()` format instead would exercise a shape
  // production never produces — and would hide a format mismatch in the
  // sweep's own predicate, since the two sort differently as TEXT.
  const updatedAt = new Date(Date.now() - opts.minutesSinceUpdate * 60_000).toISOString();
  raw
    .prepare("UPDATE import_jobs SET status = ?, updated_at = ? WHERE id = ?")
    .run(opts.status, updatedAt, opts.id);
}

describe("runImportSweep", () => {
  it("moves a wedged 'cancelling' job to 'cancelled'", async () => {
    const { db, raw, env } = setup();
    await seedJob(db, raw, { id: "imp_1", status: "cancelling", minutesSinceUpdate: 60 });

    const result = await runImportSweep(env, logger);

    expect(result).toMatchObject({ scanned: 1, reaped: 1, conflicted: 0, errored: 0 });
    const job = await getImportById(db, "imp_1", logger);
    expect(job.success && job.data?.status).toBe("cancelled");
    expect(job.success && job.data?.completedAt).toBeTruthy();
    raw.close();
  });

  it("moves a stalled active job to 'failed' with an explanatory error", async () => {
    const { db, raw, env } = setup();
    await seedJob(db, raw, { id: "imp_1", status: "processing", minutesSinceUpdate: 60 });

    const result = await runImportSweep(env, logger);

    expect(result.reaped).toBe(1);
    const job = await getImportById(db, "imp_1", logger);
    expect(job.success && job.data?.status).toBe("failed");
    expect(job.success && job.data?.errors[0]?.file).toBe("_import");
    expect(job.success && job.data?.errors[0]?.error).toMatch(/stalled/i);
    raw.close();
  });

  it("reaps a job stuck in 'syncing', which only became storable in migration 043", async () => {
    const { db, raw, env } = setup();
    await seedJob(db, raw, { id: "imp_1", status: "syncing", minutesSinceUpdate: 60 });

    expect((await runImportSweep(env, logger)).reaped).toBe(1);
    const job = await getImportById(db, "imp_1", logger);
    expect(job.success && job.data?.status).toBe("failed");
    raw.close();
  });

  it("leaves a job that is still reporting progress alone", async () => {
    const { db, raw, env } = setup();
    await seedJob(db, raw, { id: "imp_1", status: "processing", minutesSinceUpdate: 1 });

    const result = await runImportSweep(env, logger);

    expect(result).toMatchObject({ scanned: 0, reaped: 0 });
    const job = await getImportById(db, "imp_1", logger);
    expect(job.success && job.data?.status).toBe("processing");
    raw.close();
  });

  it("never touches jobs already in a terminal state", async () => {
    const { db, raw, env } = setup();
    await seedJob(db, raw, { id: "imp_done", status: "completed", minutesSinceUpdate: 500 });
    await seedJob(db, raw, {
      id: "imp_failed",
      status: "failed",
      minutesSinceUpdate: 500,
      slug: "w2",
    });

    expect((await runImportSweep(env, logger)).scanned).toBe(0);
    raw.close();
  });

  // The central correctness requirement: writes are keyed by job id, so a stale
  // row is reaped without disturbing a healthy newer job on the same project.
  it("reaps the stale job and leaves a newer healthy job for the same project untouched", async () => {
    const { db, raw, env } = setup();
    await seedJob(db, raw, { id: "imp_wedged", status: "cancelling", minutesSinceUpdate: 500 });
    await seedJob(db, raw, { id: "imp_live", status: "processing", minutesSinceUpdate: 0 });
    raw
      .prepare("UPDATE import_jobs SET started_at = '2020-01-01T00:00:00Z' WHERE id = 'imp_wedged'")
      .run();

    const result = await runImportSweep(env, logger);

    expect(result).toMatchObject({ scanned: 1, reaped: 1 });
    const wedged = await getImportById(db, "imp_wedged", logger);
    const live = await getImportById(db, "imp_live", logger);
    expect(wedged.success && wedged.data?.status).toBe("cancelled");
    expect(live.success && live.data?.status).toBe("processing");
    raw.close();
  });

  describe("queued jobs", () => {
    it("leaves a recently queued job alone even past the active threshold", async () => {
      const { db, raw, env } = setup();
      // Past the active threshold but well inside the queued grace period, so
      // only the status distinction keeps this job alive.
      const minutes = STALLED_THRESHOLD_MS / 60_000 + 10;
      expect(minutes * 60_000).toBeLessThan(QUEUED_GRACE_MS);
      await seedJob(db, raw, { id: "imp_1", status: "queued", minutesSinceUpdate: minutes });

      expect((await runImportSweep(env, logger)).scanned).toBe(0);
      const job = await getImportById(db, "imp_1", logger);
      expect(job.success && job.data?.status).toBe("queued");
      raw.close();
    });

    it("fails a job that was never picked up, and says so", async () => {
      const { db, raw, env } = setup();
      await seedJob(db, raw, {
        id: "imp_1",
        status: "queued",
        minutesSinceUpdate: QUEUED_GRACE_MS / 60_000 + 30,
      });

      expect((await runImportSweep(env, logger)).reaped).toBe(1);
      const job = await getImportById(db, "imp_1", logger);
      expect(job.success && job.data?.status).toBe("failed");
      expect(job.success && job.data?.errors[0]?.error).toMatch(/never picked up/i);
      raw.close();
    });
  });

  it("bounds the batch so a large backlog drains across runs", async () => {
    const { db, raw, env } = setup();
    for (let i = 0; i < 105; i++) {
      await seedJob(db, raw, {
        id: `imp_${i}`,
        status: "processing",
        minutesSinceUpdate: 60,
        slug: `widgets-${i}`,
      });
    }

    const first = await runImportSweep(env, logger);
    expect(first.scanned).toBe(100);
    expect(first.reaped).toBe(100);

    const second = await runImportSweep(env, logger);
    expect(second.reaped).toBe(5);
    raw.close();
  });

  // Ordering matters under a backlog: with more stale rows than the batch
  // limit, the oldest must drain first rather than being starved by newer ones.
  // Asserting on the reaped rows' final status alone would pass whatever the
  // order was, so this checks the actual sequence the sweep worked in.
  it("processes the oldest jobs first", async () => {
    const { db, raw, env } = setup();
    const ages = [30, 500, 90, 240];
    for (const [index, minutes] of ages.entries()) {
      await seedJob(db, raw, {
        id: `imp_${minutes}`,
        status: "processing",
        minutesSinceUpdate: minutes,
        slug: `w${index}`,
      });
    }

    logger.info.mockClear();
    await runImportSweep(env, logger);

    const reapedOrder = logger.info.mock.calls
      .filter(([message]) => message === "Reaped stalled import")
      .map(([, meta]) => (meta as { importId: string }).importId);

    expect(reapedOrder).toEqual(["imp_500", "imp_240", "imp_90", "imp_30"]);
    raw.close();
  });

  // Regression guard. `updated_at` is written as ISO-8601 by the storage layer,
  // but the sweep originally compared it against `datetime('now', ?)`, which
  // yields 'YYYY-MM-DD HH:MM:SS'. As TEXT, 'T' (0x54) sorts after ' ' (0x20),
  // so the predicate was false for every real row until the UTC date rolled
  // over — the sweep looked correct and reaped nothing for up to a day.
  describe("timestamp format", () => {
    it("reaps a job aged through the storage layer's own writer", async () => {
      const { db, raw, env } = setup();
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
      // Drive the status through the real update path, then age only the clock.
      await updateImportStatus(db, "@acme", "widgets", "cancelling", logger);
      raw
        .prepare("UPDATE import_jobs SET updated_at = ? WHERE id = 'imp_1'")
        .run(new Date(Date.now() - 60 * 60 * 1000).toISOString());

      const result = await runImportSweep(env, logger);

      expect(result.reaped).toBe(1);
      const job = await getImportById(db, "imp_1", logger);
      expect(job.success && job.data?.status).toBe("cancelled");
      raw.close();
    });

    // Behavioural coverage alone is time-of-day dependent: the old comparison
    // happened to work for rows whose UTC date already differed from the
    // cutoff's, so a suite running just after midnight would go green. Pin the
    // contract itself — the cutoff must be an ISO instant, never a
    // `datetime()` modifier like '-300 seconds'.
    it("binds ISO instants as the staleness cutoffs", async () => {
      const bindings: unknown[][] = [];
      const probeEnv = {
        DB: {
          prepare: (sql: string) => ({
            bind: (...args: unknown[]) => {
              if (sql.includes("FROM import_jobs")) bindings.push(args);
              return { all: async () => ({ results: [] }) };
            },
          }),
        },
      } as unknown as Env;

      await runImportSweep(probeEnv, logger);

      const cutoffs = (bindings[0] ?? []).filter(
        (arg): arg is string => typeof arg === "string" && !ACTIVE_STATUS_NAMES.includes(arg),
      );
      expect(cutoffs).toHaveLength(2);
      for (const cutoff of cutoffs) {
        expect(cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      }
    });

    // The sweep relies on every stored timestamp being ISO — mixing formats in
    // one column breaks the range query in both directions. That invariant is
    // established by migration 043 and covered in
    // tests/import-status-persistence.test.ts, not here.
  });

  it("reports a query failure without throwing", async () => {
    const brokenEnv = {
      DB: {
        prepare: () => {
          throw new Error("d1 unavailable");
        },
      },
    } as unknown as Env;

    const result = await runImportSweep(brokenEnv, logger);

    expect(result).toEqual({ scanned: 0, reaped: 0, conflicted: 0, errored: 0 });
  });

  it("counts a row it could not write as errored and still finishes the batch", async () => {
    const { db, raw, env } = setup();
    await seedJob(db, raw, { id: "imp_1", status: "processing", minutesSinceUpdate: 60 });
    await seedJob(db, raw, {
      id: "imp_2",
      status: "processing",
      minutesSinceUpdate: 61,
      slug: "w2",
    });

    let call = 0;
    const realPrepare = db.prepare.bind(db);
    const flaky = {
      ...env,
      DB: {
        ...db,
        prepare: (sql: string) => {
          // Let the SELECT through, then fail the first row's read-back.
          if (sql.includes("SELECT * FROM import_jobs WHERE id")) {
            call++;
            if (call === 1) throw new Error("transient");
          }
          return realPrepare(sql);
        },
      },
    } as unknown as Env;

    const result = await runImportSweep(flaky, logger);

    expect(result.scanned).toBe(2);
    expect(result.errored).toBe(1);
    expect(result.reaped).toBe(1);
    raw.close();
  });
});
