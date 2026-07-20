import { describe, expect, it, vi } from "vitest";
import { markChangeMerged } from "../src/storage/changes";
import { NotFoundError } from "../src/utils/errors";
import type { Logger } from "../src/utils/logger";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

/**
 * Fake D1 modelling a single change's status, so the CAS
 * `UPDATE ... WHERE id = ? AND status != 'merged'` reports meta.changes exactly
 * as real D1 would: 1 on the first transition, 0 once already merged.
 */
function makeStatusD1(initialStatus: string | null) {
  const state = { status: initialStatus };
  function makeStmt(sql: string, bindings: unknown[]) {
    const upper = sql.trim().toUpperCase();
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      first: async () => {
        if (upper.startsWith("SELECT ID FROM CHANGES")) {
          return state.status === null ? null : { id: bindings[0] };
        }
        return null;
      },
      run: async () => {
        if (upper.startsWith("UPDATE CHANGES SET STATUS = 'MERGED'")) {
          // WHERE id = ? AND status != 'merged'
          const changed = state.status !== "merged" ? 1 : 0;
          if (changed) state.status = "merged";
          return { success: true, meta: { changes: changed } };
        }
        return { success: true, meta: { changes: 0 } };
      },
      all: async () => ({ results: [], success: true, meta: {} }),
    };
  }
  return {
    state,
    db: { prepare: (sql: string) => makeStmt(sql, []) } as unknown as D1Database,
  };
}

describe("markChangeMerged (CAS)", () => {
  it("transitions an unmerged change and reports transitioned: true", async () => {
    const { db, state } = makeStatusD1("approved");
    const result = await markChangeMerged(db, logger, "chg_1", {
      mergedAt: "2026-07-20T00:00:00Z",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.transitioned).toBe(true);
    expect(state.status).toBe("merged");
  });

  it("reports transitioned: false when the change is already merged (a concurrent merger won)", async () => {
    const { db } = makeStatusD1("merged");
    const result = await markChangeMerged(db, logger, "chg_1");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.transitioned).toBe(false);
  });

  it("only the first of two racing transitions reports transitioned: true", async () => {
    const { db } = makeStatusD1("approved");
    const first = await markChangeMerged(db, logger, "chg_1");
    const second = await markChangeMerged(db, logger, "chg_1");
    expect(first.success && first.data.transitioned).toBe(true);
    expect(second.success && second.data.transitioned).toBe(false);
  });

  it("returns NotFound for a missing change", async () => {
    const { db } = makeStatusD1(null);
    const result = await markChangeMerged(db, logger, "chg_missing");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(NotFoundError);
  });
});
