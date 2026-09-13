import { beforeEach, describe, expect, it, vi } from "vitest";
import { listEvalRuns, recordEvalRuns } from "../src/storage/eval-runs";
import type { Logger } from "../src/utils/logger";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

interface StoredRow {
  id: string;
  change_id: string;
  evaluator_type: string;
  score: number;
  passed: number;
  reason: string;
  issues: string | null;
  ran_at: string;
  round_id: string | null;
}

function makeD1(): { db: D1Database; rows: StoredRow[] } {
  const rows: StoredRow[] = [];

  function makeStmt(sql: string, bindings: unknown[]) {
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => {
        if (sql.trim().toUpperCase().startsWith("INSERT INTO EVAL_RUNS")) {
          rows.push({
            id: bindings[0] as string,
            change_id: bindings[1] as string,
            evaluator_type: bindings[2] as string,
            score: bindings[3] as number,
            passed: bindings[4] as number,
            reason: bindings[5] as string,
            issues: bindings[6] as string | null,
            ran_at: bindings[7] as string,
            round_id: (bindings[8] as string | null) ?? null,
          });
        }
        return { success: true, meta: {} };
      },
      all: async <T>() => {
        const changeId = bindings[0] as string;
        return {
          results: rows.filter((row) => row.change_id === changeId) as T[],
          success: true,
          meta: {},
        };
      },
    };
  }

  const db = {
    prepare: (sql: string) => makeStmt(sql, []),
    batch: async (
      statements: Array<{
        run: () => Promise<{ success: boolean; meta: Record<string, unknown> }>;
      }>,
    ) => {
      return Promise.all(statements.map((stmt) => stmt.run()));
    },
  } as unknown as D1Database;

  return { db, rows };
}

describe("eval run storage", () => {
  let db: D1Database;
  /** The stub's backing rows, for seeding shapes `recordEvalRuns` cannot write. */
  let rows: StoredRow[];

  beforeEach(() => {
    ({ db, rows } = makeD1());
  });

  it("records and lists per-evaluator results with issues", async () => {
    const recordResult = await recordEvalRuns(db, mockLogger, "chg_abc123", [
      {
        evaluatorType: "secret_scan",
        result: {
          score: 0,
          passed: false,
          reason: "Secret detected",
          issues: ["AWS Access Key: line 4"],
        },
      },
      {
        evaluatorType: "diff",
        result: { score: 1, passed: true, reason: "Diff passed" },
      },
    ]);

    expect(recordResult.success).toBe(true);

    const runsResult = await listEvalRuns(db, mockLogger, "chg_abc123");
    expect(runsResult.success).toBe(true);
    if (runsResult.success) {
      expect(runsResult.data).toHaveLength(2);
      expect(runsResult.data[0]).toMatchObject({
        evaluatorType: "secret_scan",
        passed: false,
        issues: ["AWS Access Key: line 4"],
      });
      expect(runsResult.data[1]).toMatchObject({ evaluatorType: "diff", passed: true });
    }
  });

  it("#336: stamps one round id across a batch, and a distinct one per pass", async () => {
    const pass = () =>
      recordEvalRuns(db, mockLogger, "chg_abc123", [
        { evaluatorType: "webhook", result: { score: 1, passed: true, reason: "a" } },
        { evaluatorType: "webhook", result: { score: 0, passed: false, reason: "b" } },
      ]);

    const first = await pass();
    const second = await pass();
    expect(first.success && second.success).toBe(true);
    if (!first.success || !second.success) return;

    // Within a pass: one round, so the merge gate folds both receivers together.
    const firstRounds = new Set(first.data.map((r) => r.roundId));
    expect(firstRounds.size).toBe(1);

    // Across passes: different rounds, even when both land in the same
    // millisecond — which is the case these two back-to-back calls are likely to
    // produce, and exactly what equal `ranAt` could not distinguish.
    const secondRounds = new Set(second.data.map((r) => r.roundId));
    expect(secondRounds.size).toBe(1);
    expect([...firstRounds][0]).not.toBe([...secondRounds][0]);

    // Both keys carry a full ISO 8601 instant as a fixed-width prefix, which is
    // what makes the gate's "newest round" a plain string max. Between two
    // rounds in the SAME millisecond the prefixes tie and the random suffix
    // decides, so their relative order is stable but arbitrary — asserting the
    // later pass sorts higher would be a coin flip, and these two back-to-back
    // calls usually do land in one millisecond.
    for (const key of [...firstRounds, ...secondRounds]) {
      expect(key as string).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#evr_[0-9a-f]{32}$/,
      );
    }

    const listed = await listEvalRuns(db, mockLogger, "chg_abc123");
    expect(listed.success).toBe(true);
    if (!listed.success) return;
    expect(new Set(listed.data.map((r) => r.roundId)).size).toBe(2);
  });

  it("reads a pre-migration-048 row as having no round", async () => {
    // Seeded directly, because `recordEvalRuns` cannot produce these shapes: it
    // always writes a round. Both reach the gate in a mixed history — the column
    // present but NULL, and, on a database where migration 048 has not run, the
    // key absent from `SELECT *` entirely. Neither may read as a round.
    const legacy = {
      change_id: "chg_legacy",
      evaluator_type: "diff",
      score: 1,
      passed: 1,
      reason: "ok",
      issues: null,
      ran_at: "2026-01-01T00:00:00.000Z",
    };
    rows.push({ ...legacy, id: "evl_null_column", round_id: null });
    // The pre-migration database: no such column, so no such key on the row.
    rows.push({ ...legacy, id: "evl_no_column" } as StoredRow);

    const listed = await listEvalRuns(db, mockLogger, "chg_legacy");
    expect(listed.success).toBe(true);
    if (!listed.success) return;
    expect(listed.data).toHaveLength(2);
    expect(listed.data.map((run) => run.roundId)).toEqual([undefined, undefined]);
    // Omitted rather than present-and-undefined, so `roundId ?? ranAt` in the
    // merge gate falls back instead of comparing against the string "undefined".
    for (const run of listed.data) {
      expect(Object.hasOwn(run, "roundId")).toBe(false);
    }
  });
});
