import { describe, expect, it, vi } from "vitest";
import {
  createImportJob,
  deleteImportJobById,
  getImportById,
  getImportProgress,
  getLatestImportDepth,
  updateImportProgressById,
} from "../src/storage/imports";
import type { ImportStatus } from "../src/types";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

/** Mirrors the delete route's allow-list. */
const DELETABLE: readonly ImportStatus[] = ["failed", "cancelled"];

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

function jobParams(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId: "prj_1",
    namespace: "@acme",
    slug: "widgets",
    sourceUrl: "https://github.com/acme/widgets",
    branch: "main",
    ...overrides,
  };
}

/**
 * A project accumulates one import_jobs row per sync — there is no unique
 * constraint on (namespace, slug) — so anything that has already selected a
 * specific row must write back by primary key. These cover the id-scoped
 * primitives the stall sweep and the delete action are built on.
 */
describe("updateImportProgressById", () => {
  it("updates the selected row, not the newest one for the project", async () => {
    const { db, raw } = makeSqliteD1();
    await createImportJob(db, jobParams("imp_old"), logger);
    await createImportJob(db, jobParams("imp_new"), logger);

    // Make imp_new unambiguously the newest by started_at, which is what
    // getImportProgress (and therefore updateImportProgress) resolves to.
    raw
      .prepare("UPDATE import_jobs SET started_at = '2020-01-01T00:00:00Z' WHERE id = 'imp_old'")
      .run();

    const old = await getImportById(db, "imp_old", logger);
    expect(old.success && old.data).toBeTruthy();
    const version = old.success && old.data ? old.data.version : -1;

    const result = await updateImportProgressById(
      db,
      "imp_old",
      version,
      { status: "cancelled" },
      logger,
    );

    expect(result.success && result.data.updated).toBe(true);

    const reloadedOld = await getImportById(db, "imp_old", logger);
    const reloadedNew = await getImportById(db, "imp_new", logger);
    expect(reloadedOld.success && reloadedOld.data?.status).toBe("cancelled");
    // The whole point: the newest row must be untouched.
    expect(reloadedNew.success && reloadedNew.data?.status).toBe("queued");
    raw.close();
  });

  it("reports a version mismatch as a conflict rather than an error", async () => {
    const { db, raw } = makeSqliteD1();
    await createImportJob(db, jobParams("imp_1"), logger);

    const stale = await getImportById(db, "imp_1", logger);
    const staleVersion = stale.success && stale.data ? stale.data.version : -1;

    // Someone else advances the row first.
    const first = await updateImportProgressById(
      db,
      "imp_1",
      staleVersion,
      { status: "processing" },
      logger,
    );
    expect(first.success && first.data.updated).toBe(true);

    const second = await updateImportProgressById(
      db,
      "imp_1",
      staleVersion,
      { status: "failed" },
      logger,
    );

    expect(second.success).toBe(true);
    expect(second.success && second.data.updated).toBe(false);
    expect(second.success && !second.data.updated && second.data.reason).toBe("version-conflict");

    const final = await getImportById(db, "imp_1", logger);
    expect(final.success && final.data?.status).toBe("processing");
    raw.close();
  });

  it("reports a missing job as not-found rather than an error", async () => {
    const { db, raw } = makeSqliteD1();
    const result = await updateImportProgressById(db, "nope", 1, { status: "failed" }, logger);

    expect(result.success).toBe(true);
    expect(result.success && result.data.updated).toBe(false);
    expect(result.success && !result.data.updated && result.data.reason).toBe("not-found");
    raw.close();
  });

  it("bumps the version so a second write with the same expectation cannot land", async () => {
    const { db, raw } = makeSqliteD1();
    await createImportJob(db, jobParams("imp_1"), logger);
    const before = await getImportById(db, "imp_1", logger);
    const version = before.success && before.data ? before.data.version : -1;

    await updateImportProgressById(db, "imp_1", version, { status: "processing" }, logger);

    const after = await getImportById(db, "imp_1", logger);
    expect(after.success && after.data ? after.data.version : -1).toBe(version + 1);
    raw.close();
  });

  it("appends errors without discarding existing ones", async () => {
    const { db, raw } = makeSqliteD1();
    await createImportJob(db, jobParams("imp_1"), logger);
    const v0 = await getImportById(db, "imp_1", logger);

    await updateImportProgressById(
      db,
      "imp_1",
      v0.success && v0.data ? v0.data.version : -1,
      {
        status: "failed",
        errors: [{ file: "_import", error: "stalled", timestamp: new Date().toISOString() }],
      },
      logger,
    );

    const after = await getImportById(db, "imp_1", logger);
    expect(after.success && after.data?.errors).toHaveLength(1);
    expect(after.success && after.data?.errors[0]?.error).toBe("stalled");
    raw.close();
  });
});

describe("deleteImportJobById", () => {
  /** Puts a seeded job into a state the delete allow-list accepts. */
  function markTerminal(raw: ReturnType<typeof makeSqliteD1>["raw"], id: string) {
    raw.prepare("UPDATE import_jobs SET status = 'failed' WHERE id = ?").run(id);
  }

  it("removes exactly the named row and leaves siblings intact", async () => {
    const { db, raw } = makeSqliteD1();
    await createImportJob(db, jobParams("imp_1"), logger);
    await createImportJob(db, jobParams("imp_2"), logger);
    markTerminal(raw, "imp_1");
    markTerminal(raw, "imp_2");

    const deleted = await deleteImportJobById(db, "imp_1", DELETABLE, logger);
    expect(deleted.success && deleted.data).toBe(true);

    expect((await getImportById(db, "imp_1", logger)).success).toBe(true);
    const gone = await getImportById(db, "imp_1", logger);
    expect(gone.success && gone.data).toBeNull();

    const kept = await getImportById(db, "imp_2", logger);
    expect(kept.success && kept.data?.id).toBe("imp_2");
    raw.close();
  });

  it("returns false when the row is already gone, so a double submit is inert", async () => {
    const { db, raw } = makeSqliteD1();
    await createImportJob(db, jobParams("imp_1"), logger);
    markTerminal(raw, "imp_1");

    expect((await deleteImportJobById(db, "imp_1", DELETABLE, logger)).success).toBe(true);
    const second = await deleteImportJobById(db, "imp_1", DELETABLE, logger);
    expect(second.success && second.data).toBe(false);
    raw.close();
  });

  // Deleting a single finished job must not strip the depth history that the
  // next sync reads; that is what a namespace+slug-wide delete would do.
  it("preserves the clone depth recorded by a sibling job", async () => {
    const { db, raw } = makeSqliteD1();
    await createImportJob(db, jobParams("imp_full", { depth: 0 }), logger);
    await createImportJob(db, jobParams("imp_failed"), logger);
    markTerminal(raw, "imp_failed");
    raw
      .prepare("UPDATE import_jobs SET started_at = '2020-01-01T00:00:00Z' WHERE id = 'imp_failed'")
      .run();

    await deleteImportJobById(db, "imp_failed", DELETABLE, logger);

    expect(await getLatestImportDepth(db, "@acme", "widgets", logger)).toBe(0);
    const remaining = await getImportProgress(db, "@acme", "widgets", logger);
    expect(remaining.success && remaining.data?.id).toBe("imp_full");
    raw.close();
  });

  // The status is enforced in the DELETE itself, so a retry that re-queues the
  // job between the route's status check and this call cannot orphan a live
  // import.
  it("refuses to delete a job whose status left the allow-list", async () => {
    const { db, raw } = makeSqliteD1();
    await createImportJob(db, jobParams("imp_1"), logger);
    raw.prepare("UPDATE import_jobs SET status = 'cloning' WHERE id = 'imp_1'").run();

    const result = await deleteImportJobById(db, "imp_1", DELETABLE, logger);

    expect(result.success && result.data).toBe(false);
    const kept = await getImportById(db, "imp_1", logger);
    expect(kept.success && kept.data?.id).toBe("imp_1");
    raw.close();
  });
});
