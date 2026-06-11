import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadPolicy } from "../src/evaluation/policy-loader";
import type { EvalPolicy } from "../src/evaluation/types";
import { checkMergeProtection } from "../src/merge/protection";
import { readFileFromRepo } from "../src/storage/git-ops";
import type { Change } from "../src/types";
import type { Logger } from "../src/utils/logger";

vi.mock("../src/storage/git-ops", () => ({
  readFileFromRepo: vi.fn(),
}));

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

const change: Change = {
  id: "chg_1",
  project: "my-project",
  workspace: "ws-1",
  status: "accepted",
  createdAt: "2026-01-01T00:00:00.000Z",
};

interface EvalRunRow {
  id: string;
  change_id: string;
  evaluator_type: string;
  score: number;
  passed: number;
  reason: string;
  issues: string | null;
  ran_at: string;
}

/** Stub D1 answering the eval_runs and change_reviews queries protection issues. */
function makeProtectionD1(opts: { runs?: EvalRunRow[]; approvals?: number }): D1Database {
  function makeStmt(sql: string, bindings: unknown[]) {
    const upper = sql.trim().toUpperCase();
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      first: async <T>() => {
        if (upper.includes("COUNT(*)")) return { approvals: opts.approvals ?? 0 } as T;
        return null;
      },
      all: async <T>() => {
        const results = (opts.runs ?? []).filter((r) => r.change_id === bindings[0]);
        return { results: results as T[], success: true, meta: {} };
      },
    };
  }
  return { prepare: (sql: string) => makeStmt(sql, []) } as unknown as D1Database;
}

function makeRun(overrides: Partial<EvalRunRow>): EvalRunRow {
  return {
    id: "run_1",
    change_id: "chg_1",
    evaluator_type: "diff",
    score: 1,
    passed: 1,
    reason: "ok",
    issues: null,
    ran_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("checkMergeProtection", () => {
  it("allows merges when the policy has no merge rules", async () => {
    const db = makeProtectionD1({});
    const policy: EvalPolicy = { evaluators: [] };

    const result = await checkMergeProtection(db, mockLogger, change, policy);
    expect(result.success && result.data.allowed).toBe(true);
  });

  it("blocks when a required evaluator has not run", async () => {
    const db = makeProtectionD1({ runs: [] });
    const policy: EvalPolicy = { evaluators: [], merge: { requiredEvaluators: ["secret_scan"] } };

    const result = await checkMergeProtection(db, mockLogger, change, policy);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.allowed).toBe(false);
    expect(result.data.reasons[0]).toContain("'secret_scan' has not run");
  });

  it("blocks when the latest run of a required evaluator failed", async () => {
    const db = makeProtectionD1({
      runs: [
        makeRun({ id: "run_1", evaluator_type: "diff", passed: 1, ran_at: "2026-01-01T00:00:00Z" }),
        makeRun({ id: "run_2", evaluator_type: "diff", passed: 0, ran_at: "2026-01-02T00:00:00Z" }),
      ],
    });
    const policy: EvalPolicy = { evaluators: [], merge: { requiredEvaluators: ["diff"] } };

    const result = await checkMergeProtection(db, mockLogger, change, policy);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.allowed).toBe(false);
    expect(result.data.reasons[0]).toContain("'diff' failed");
  });

  it("uses the latest run per evaluator: a passing re-run unblocks", async () => {
    const db = makeProtectionD1({
      runs: [
        makeRun({ id: "run_1", evaluator_type: "diff", passed: 0, ran_at: "2026-01-01T00:00:00Z" }),
        makeRun({ id: "run_2", evaluator_type: "diff", passed: 1, ran_at: "2026-01-02T00:00:00Z" }),
      ],
    });
    const policy: EvalPolicy = { evaluators: [], merge: { requiredEvaluators: ["diff"] } };

    const result = await checkMergeProtection(db, mockLogger, change, policy);
    expect(result.success && result.data.allowed).toBe(true);
  });

  it("blocks when approvals are below the required count", async () => {
    const db = makeProtectionD1({ approvals: 1 });
    const policy: EvalPolicy = { evaluators: [], merge: { requiredApprovals: 2 } };

    const result = await checkMergeProtection(db, mockLogger, change, policy);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.allowed).toBe(false);
    expect(result.data.reasons[0]).toBe("Requires 2 approvals, has 1");
  });

  it("allows when approvals meet the required count", async () => {
    const db = makeProtectionD1({ approvals: 2 });
    const policy: EvalPolicy = { evaluators: [], merge: { requiredApprovals: 2 } };

    const result = await checkMergeProtection(db, mockLogger, change, policy);
    expect(result.success && result.data.allowed).toBe(true);
  });

  it("collects every blocking reason", async () => {
    const db = makeProtectionD1({ runs: [], approvals: 0 });
    const policy: EvalPolicy = {
      evaluators: [],
      merge: { requiredApprovals: 1, requiredEvaluators: ["secret_scan", "diff"] },
    };

    const result = await checkMergeProtection(db, mockLogger, change, policy);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.reasons).toHaveLength(3);
  });
});

describe("policy loader merge rules", () => {
  beforeEach(() => {
    vi.mocked(readFileFromRepo).mockReset();
  });

  it("parses well-formed merge protection from policy.yaml", async () => {
    vi.mocked(readFileFromRepo).mockResolvedValueOnce({
      success: true,
      data: [
        "evaluators:",
        "  - type: diff",
        "merge:",
        "  requiredApprovals: 2",
        "  requiredEvaluators: [secret_scan, diff]",
        "  allowForce: false",
      ].join("\n"),
    });

    const policy = await loadPolicy("remote", "token", mockLogger);
    expect(policy.merge).toEqual({
      requiredApprovals: 2,
      requiredEvaluators: ["secret_scan", "diff"],
      allowForce: false,
    });
  });

  it("drops malformed merge fields", async () => {
    vi.mocked(readFileFromRepo).mockResolvedValueOnce({
      success: true,
      data: [
        "evaluators:",
        "  - type: diff",
        "merge:",
        "  requiredApprovals: -3",
        "  requiredEvaluators: [1, 2]",
        "  allowForce: maybe",
      ].join("\n"),
    });

    const policy = await loadPolicy("remote", "token", mockLogger);
    expect(policy.merge).toBeUndefined();
  });

  it("returns the default policy without merge rules when no config exists", async () => {
    vi.mocked(readFileFromRepo).mockResolvedValue({
      success: false,
      error: new Error("not found") as never,
    });

    const policy = await loadPolicy("remote", "token", mockLogger);
    expect(policy.merge).toBeUndefined();
    expect(policy.evaluators).toEqual([{ type: "diff" }]);
  });
});
