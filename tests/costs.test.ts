import { describe, expect, it, vi } from "vitest";
import { LLMEvaluator } from "../src/evaluation/llm-evaluator";
import { SandboxEvaluator } from "../src/evaluation/sandbox-evaluator";
import type { EvalPolicy } from "../src/evaluation/types";
import { getChangeCostSummary, recordCosts } from "../src/storage/costs";
import type { AiBinding, SandboxBinding } from "../src/types";
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

interface CostRow {
  id: string;
  project: string;
  project_id: string | null;
  change_id: string | null;
  workspace: string | null;
  kind: string;
  quantity: number;
  estimated: number;
  created_at: string;
}

function makeCostsD1(): { db: D1Database; rows: CostRow[] } {
  const rows: CostRow[] = [];

  function makeStmt(sql: string, bindings: unknown[]) {
    const upper = sql.trim().toUpperCase();
    const stmt = {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => {
        if (upper.startsWith("INSERT INTO COST_RECORDS")) {
          rows.push({
            id: bindings[0] as string,
            project: bindings[1] as string,
            project_id: bindings[2] as string | null,
            change_id: bindings[3] as string | null,
            workspace: bindings[4] as string | null,
            kind: bindings[5] as string,
            quantity: bindings[6] as number,
            estimated: bindings[7] as number,
            created_at: bindings[8] as string,
          });
        }
        return { success: true, meta: {} };
      },
      all: async <T>() => {
        const scoped = rows.filter((r) => r.change_id === bindings[0]);
        const byKind = new Map<string, { total: number; any_estimated: number }>();
        for (const row of scoped) {
          const entry = byKind.get(row.kind) ?? { total: 0, any_estimated: 0 };
          entry.total += row.quantity;
          entry.any_estimated = Math.max(entry.any_estimated, row.estimated);
          byKind.set(row.kind, entry);
        }
        const results = [...byKind.entries()].map(([kind, entry]) => ({ kind, ...entry }));
        return { results: results as T[], success: true, meta: {} };
      },
    };
    return stmt;
  }

  const db = {
    prepare: (sql: string) => makeStmt(sql, []),
    batch: async (statements: Array<{ run(): Promise<unknown> }>) =>
      Promise.all(statements.map((stmt) => stmt.run())),
  } as unknown as D1Database;
  return { db, rows };
}

describe("cost storage", () => {
  it("records samples and aggregates per change by kind", async () => {
    const { db } = makeCostsD1();
    await recordCosts(db, mockLogger, { project: "p", changeId: "chg_1", workspace: "ws" }, [
      { kind: "git_ops", quantity: 2 },
      { kind: "llm_tokens", quantity: 1200, estimated: true },
      { kind: "sandbox_ms", quantity: 4500 },
    ]);
    await recordCosts(db, mockLogger, { project: "p", changeId: "chg_1" }, [
      { kind: "git_ops", quantity: 1 },
    ]);
    await recordCosts(db, mockLogger, { project: "p", changeId: "chg_other" }, [
      { kind: "git_ops", quantity: 9 },
    ]);

    const summary = await getChangeCostSummary(db, mockLogger, "chg_1");
    expect(summary.success).toBe(true);
    if (!summary.success) return;
    const byKind = Object.fromEntries(summary.data.map((e) => [e.kind, e]));
    expect(byKind.git_ops?.total).toBe(3);
    expect(byKind.llm_tokens?.total).toBe(1200);
    expect(byKind.llm_tokens?.estimated).toBe(true);
    expect(byKind.sandbox_ms?.total).toBe(4500);
    expect(byKind.sandbox_ms?.estimated).toBe(false);
  });

  it("is a no-op for an empty sample list", async () => {
    const { db, rows } = makeCostsD1();
    const result = await recordCosts(db, mockLogger, { project: "p" }, []);
    expect(result.success).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it("returns an error result when the database fails, without throwing", async () => {
    const badDb = {
      prepare: () => {
        throw new Error("D1 down");
      },
    } as unknown as D1Database;
    const result = await recordCosts(badDb, mockLogger, { project: "p" }, [
      { kind: "git_ops", quantity: 1 },
    ]);
    expect(result.success).toBe(false);
  });
});

describe("evaluator cost reporting", () => {
  it("LLM evaluator reports estimated token usage", async () => {
    const ai: AiBinding = {
      run: vi.fn().mockResolvedValue({
        response: JSON.stringify({ score: 0.9, passed: true, reason: "looks good" }),
      }),
    };
    const policy: EvalPolicy = { evaluators: [{ type: "llm" }] };

    const result = await new LLMEvaluator(ai).evaluate("diff content", policy, mockLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.costs).toHaveLength(1);
    const cost = result.data.costs?.[0];
    expect(cost?.kind).toBe("llm_tokens");
    expect(cost?.estimated).toBe(true);
    expect(cost?.quantity).toBeGreaterThan(0);
  });

  it("LLM evaluator reports tokens even when the response fails to parse", async () => {
    const ai: AiBinding = {
      run: vi.fn().mockResolvedValue({ response: "not json at all" }),
    };
    const policy: EvalPolicy = { evaluators: [{ type: "llm" }] };

    const result = await new LLMEvaluator(ai).evaluate("diff", policy, mockLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.costs?.[0]?.kind).toBe("llm_tokens");
  });

  it("sandbox evaluator reports run duration", async () => {
    const sandbox: SandboxBinding = {
      create: vi.fn().mockResolvedValue({
        writeFile: vi.fn(),
        run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" }),
        destroy: vi.fn(),
      }),
    };
    const policy: EvalPolicy = { evaluators: [{ type: "sandbox", command: "npm test" }] };

    const result = await new SandboxEvaluator(sandbox).evaluate("diff", policy, mockLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.costs?.[0]?.kind).toBe("sandbox_ms");
    expect(result.data.costs?.[0]?.quantity).toBeGreaterThanOrEqual(0);
  });
});
