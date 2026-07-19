import { describe, expect, it } from "vitest";
import {
  type CommitMetricInput,
  getCommitMetrics,
  recordCommitMetrics,
} from "../src/storage/metrics";
import type { Logger } from "../src/utils/logger";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
} as unknown as Logger;

interface StoredRow {
  outcome: string;
  total_ms: number;
  token_mint_ms: number | null;
  project_clone_ms: number | null;
  workspace_fetch_ms: number | null;
  merge_ms: number | null;
  push_ms: number | null;
  ref_advance_ms: number | null;
  d1_update_ms: number | null;
  provenance_ms: number | null;
  recorded_seq: number;
}

/** Minimal stateful D1 stub for the commit_metrics table. */
function makeCommitMetricsD1(opts: { failAll?: boolean } = {}): {
  db: D1Database;
  rows: StoredRow[];
} {
  const rows: StoredRow[] = [];
  let seq = 0;

  function makeStmt(sql: string, bindings: unknown[]) {
    const upper = sql.trim().toUpperCase();
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => {
        if (upper.startsWith("INSERT INTO COMMIT_METRICS")) {
          // Column order: project, project_id, change_id, outcome, conflict_mode,
          // concurrency_n, then the phase spans and total_ms.
          rows.push({
            outcome: bindings[3] as string,
            token_mint_ms: bindings[6] as number | null,
            project_clone_ms: bindings[7] as number | null,
            workspace_fetch_ms: bindings[8] as number | null,
            merge_ms: bindings[9] as number | null,
            push_ms: bindings[10] as number | null,
            ref_advance_ms: bindings[11] as number | null,
            d1_update_ms: bindings[12] as number | null,
            provenance_ms: bindings[13] as number | null,
            total_ms: bindings[14] as number,
            recorded_seq: seq++,
          });
        }
        return { success: true, meta: {} };
      },
      first: async () => null,
      all: async <T>() => {
        if (opts.failAll) throw new Error("simulated D1 read failure");
        const limit = (bindings[0] as number) ?? rows.length;
        const results = [...rows].sort((a, b) => b.recorded_seq - a.recorded_seq).slice(0, limit);
        return { results: results as unknown as T[], success: true, meta: {} };
      },
    };
  }

  const db = { prepare: (sql: string) => makeStmt(sql, []) } as unknown as D1Database;
  return { db, rows };
}

const ffMetric: CommitMetricInput = {
  project: "acme/web",
  changeId: "chg_1",
  outcome: "fast_forward",
  conflictMode: "none",
  concurrencyN: 25,
  phases: { tokenMintMs: 5, workspaceFetchMs: 40, pushMs: 60, refAdvanceMs: 2 },
  totalMs: 110,
};

describe("recordCommitMetrics", () => {
  it("writes exactly one row per merge", async () => {
    const { db, rows } = makeCommitMetricsD1();
    const res = await recordCommitMetrics(db, ffMetric, noopLogger);
    expect(res.success).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("fast_forward");
    expect(rows[0]?.project_clone_ms).toBeNull(); // skipped on fast-forward
    expect(rows[0]?.push_ms).toBe(60);
    expect(rows[0]?.total_ms).toBe(110);
  });

  it("returns an err Result (never throws) when the insert fails", async () => {
    const throwingDb = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error("boom");
          },
        }),
      }),
    } as unknown as D1Database;
    const res = await recordCommitMetrics(throwingDb, ffMetric, noopLogger);
    expect(res.success).toBe(false);
  });
});

describe("getCommitMetrics", () => {
  it("aggregates outcome counts and per-phase percentiles", async () => {
    const { db } = makeCommitMetricsD1();
    // 3 fast-forwards with push spans 10,20,30 and one cold fallback with a clone.
    await recordCommitMetrics(
      db,
      { ...ffMetric, changeId: "a", phases: { pushMs: 10 }, totalMs: 10 },
      noopLogger,
    );
    await recordCommitMetrics(
      db,
      { ...ffMetric, changeId: "b", phases: { pushMs: 20 }, totalMs: 20 },
      noopLogger,
    );
    await recordCommitMetrics(
      db,
      { ...ffMetric, changeId: "c", phases: { pushMs: 30 }, totalMs: 30 },
      noopLogger,
    );
    await recordCommitMetrics(
      db,
      {
        ...ffMetric,
        changeId: "d",
        outcome: "cold_fallback",
        phases: { projectCloneMs: 500, pushMs: 40 },
        totalMs: 600,
      },
      noopLogger,
    );

    const res = await getCommitMetrics(db, noopLogger);
    expect(res.success).toBe(true);
    if (!res.success) return;
    const s = res.data;
    expect(s.count).toBe(4);
    expect(s.outcomes.fast_forward).toBe(3);
    expect(s.outcomes.cold_fallback).toBe(1);
    // push present on all 4 rows.
    expect(s.phases.pushMs.count).toBe(4);
    // nearest-rank p50 of [10,20,30,40] -> index ceil(0.5*4)-1 = 1 -> 20
    expect(s.phases.pushMs.p50).toBe(20);
    expect(s.phases.pushMs.p95).toBe(40);
    // project clone only on the cold fallback.
    expect(s.phases.projectCloneMs.count).toBe(1);
    expect(s.phases.projectCloneMs.avg).toBe(500);
  });

  it("returns an err Result when the read fails", async () => {
    const { db } = makeCommitMetricsD1({ failAll: true });
    const res = await getCommitMetrics(db, noopLogger);
    expect(res.success).toBe(false);
  });
});
