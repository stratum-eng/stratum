import { beforeEach, describe, expect, it, vi } from "vitest";
import { diffTouchesProtectedConfig, loadPolicy } from "../src/evaluation/policy-loader";
import type { EvalPolicy } from "../src/evaluation/types";
import { checkMergeProtection, requiredEvaluatorReasons } from "../src/merge/protection";
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
  /** Written since migration 048. Omitted here to stand for a legacy row. */
  round_id?: string;
}

/** Stub D1 answering the eval_runs and change_reviews queries protection issues. */
function makeProtectionD1(opts: {
  runs?: EvalRunRow[];
  approvals?: number;
  /** Reviewer ids that approved. When set, the COUNT honors the excludeUserId
   * bind (the `reviewer_id != ?` filter) so self-approval exclusion is exercised. */
  approvers?: string[];
}): D1Database {
  function makeStmt(sql: string, bindings: unknown[]) {
    const upper = sql.trim().toUpperCase();
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      first: async <T>() => {
        if (upper.includes("COUNT(*)")) {
          if (opts.approvers) {
            const excluded = upper.includes("REVIEWER_ID !=") ? bindings[1] : undefined;
            const approvals = opts.approvers.filter((id) => id !== excluded).length;
            return { approvals } as T;
          }
          return { approvals: opts.approvals ?? 0 } as T;
        }
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

  it("blocks (fail closed) when the policy file is malformed", async () => {
    const db = makeProtectionD1({});
    const policy: EvalPolicy = {
      evaluators: [{ type: "diff" }],
      configError: "Policy file .stratum/policy.yaml is present but invalid (bad); merges blocked.",
    };

    const result = await checkMergeProtection(db, mockLogger, change, policy);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.allowed).toBe(false);
    expect(result.data.reasons[0]).toMatch(/invalid/i);
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

  it("#336: a passing duplicate in the same round can't mask a failing sibling", async () => {
    // Two webhook receivers, one round. Both rows carry the batch's single
    // `ran_at`, and both say `webhook` — so a last-write-wins read of the type
    // saw only whichever row came second and let the gate open on a receiver
    // that had rejected the change.
    const db = makeProtectionD1({
      runs: [
        makeRun({
          id: "run_1",
          evaluator_type: "webhook",
          passed: 0,
          ran_at: "2026-01-02T00:00:00.000Z",
        }),
        makeRun({
          id: "run_2",
          evaluator_type: "webhook",
          passed: 1,
          ran_at: "2026-01-02T00:00:00.000Z",
        }),
      ],
    });
    const policy: EvalPolicy = { evaluators: [], merge: { requiredEvaluators: ["webhook"] } };

    const result = await checkMergeProtection(db, mockLogger, change, policy);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.allowed).toBe(false);
    expect(result.data.reasons[0]).toContain("'webhook' failed");
  });

  it("#336: two rounds sharing a ran_at are not folded — the newer round decides", async () => {
    // Two evaluation passes that landed in the same millisecond: the earlier one
    // had a receiver fail, the later one passed both. Grouping by `ran_at` read
    // them as one round and ANDed the superseded failure in, leaving the change
    // blocked until someone re-evaluated again; `round_id` keeps them apart.
    const sameMs = "2026-01-02T00:00:00.000Z";
    const db = makeProtectionD1({
      runs: [
        makeRun({
          id: "run_1",
          evaluator_type: "webhook",
          passed: 0,
          ran_at: sameMs,
          round_id: `${sameMs}#evr_aaa`,
        }),
        makeRun({
          id: "run_2",
          evaluator_type: "webhook",
          passed: 1,
          ran_at: sameMs,
          round_id: `${sameMs}#evr_bbb`,
        }),
        makeRun({
          id: "run_3",
          evaluator_type: "webhook",
          passed: 1,
          ran_at: sameMs,
          round_id: `${sameMs}#evr_bbb`,
        }),
      ],
    });
    const policy: EvalPolicy = { evaluators: [], merge: { requiredEvaluators: ["webhook"] } };

    const result = await checkMergeProtection(db, mockLogger, change, policy);
    expect(result.success && result.data.allowed).toBe(true);
  });

  it("#336: within one round a failing receiver still blocks, round id or not", async () => {
    const sameMs = "2026-01-02T00:00:00.000Z";
    const db = makeProtectionD1({
      runs: [
        makeRun({
          id: "run_1",
          evaluator_type: "webhook",
          passed: 0,
          ran_at: sameMs,
          round_id: `${sameMs}#evr_aaa`,
        }),
        makeRun({
          id: "run_2",
          evaluator_type: "webhook",
          passed: 1,
          ran_at: sameMs,
          round_id: `${sameMs}#evr_aaa`,
        }),
      ],
    });
    const policy: EvalPolicy = { evaluators: [], merge: { requiredEvaluators: ["webhook"] } };

    const result = await checkMergeProtection(db, mockLogger, change, policy);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.allowed).toBe(false);
    expect(result.data.reasons[0]).toContain("'webhook' failed");
  });

  it("#336: a round id beats a legacy row at the same instant, and loses to a later one", async () => {
    // Mixed rows across migration 048: ordering must stay consistent, since the
    // fallback key is the bare timestamp and a round id carries it as a prefix.
    const db = makeProtectionD1({
      runs: [
        // Legacy failing row, no round.
        makeRun({
          id: "run_1",
          evaluator_type: "diff",
          passed: 0,
          ran_at: "2026-01-01T00:00:00.000Z",
        }),
        // Same instant, but written after the migration: this is the newer round.
        makeRun({
          id: "run_2",
          evaluator_type: "diff",
          passed: 1,
          ran_at: "2026-01-01T00:00:00.000Z",
          round_id: "2026-01-01T00:00:00.000Z#evr_aaa",
        }),
      ],
    });
    const policy: EvalPolicy = { evaluators: [], merge: { requiredEvaluators: ["diff"] } };

    const result = await checkMergeProtection(db, mockLogger, change, policy);
    expect(result.success && result.data.allowed).toBe(true);
  });

  it("#336: folding duplicates does not resurrect a failure an earlier round left", async () => {
    // The AND fold is scoped to the newest round: two receivers that both pass
    // on re-evaluation clear a failure from the round before, which a fold
    // across all rows would block forever.
    const db = makeProtectionD1({
      runs: [
        makeRun({
          id: "run_1",
          evaluator_type: "webhook",
          passed: 0,
          ran_at: "2026-01-01T00:00:00.000Z",
        }),
        makeRun({
          id: "run_2",
          evaluator_type: "webhook",
          passed: 1,
          ran_at: "2026-01-02T00:00:00.000Z",
        }),
        makeRun({
          id: "run_3",
          evaluator_type: "webhook",
          passed: 1,
          ran_at: "2026-01-02T00:00:00.000Z",
        }),
      ],
    });
    const policy: EvalPolicy = { evaluators: [], merge: { requiredEvaluators: ["webhook"] } };

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

  it("requires a human approval for a change that edits the protection config, even with no merge block", async () => {
    const db = makeProtectionD1({ approvals: 0 });
    const policyChange: Change = { ...change, touchesProtectedConfig: true };
    // No merge block at all — a policy-file edit must still be gated.
    const policy: EvalPolicy = { evaluators: [] };

    const result = await checkMergeProtection(db, mockLogger, policyChange, policy);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.allowed).toBe(false);
    expect(result.data.reasons[0]).toBe("Requires 1 approval, has 0");
  });

  it("does not count the author's own approval toward requiredApprovals", async () => {
    // The author (alice) is the only approver — a self-approval must not satisfy
    // requiredApprovals: 1.
    const db = makeProtectionD1({ approvers: ["alice"] });
    const authored: Change = { ...change, createdByUserId: "alice" };
    const policy: EvalPolicy = { evaluators: [], merge: { requiredApprovals: 1 } };

    const result = await checkMergeProtection(db, mockLogger, authored, policy);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.allowed).toBe(false);
    expect(result.data.reasons[0]).toBe("Requires 1 approval, has 0");
  });

  it("allows a protection-config change once it has an approval", async () => {
    const db = makeProtectionD1({ approvals: 1 });
    const policyChange: Change = { ...change, touchesProtectedConfig: true };
    const policy: EvalPolicy = { evaluators: [] };

    const result = await checkMergeProtection(db, mockLogger, policyChange, policy);
    expect(result.success && result.data.allowed).toBe(true);
  });

  it("does not gate a normal change that leaves the protection config untouched", async () => {
    const db = makeProtectionD1({ approvals: 0 });
    const policy: EvalPolicy = { evaluators: [] };

    const result = await checkMergeProtection(db, mockLogger, change, policy);
    expect(result.success && result.data.allowed).toBe(true);
  });

  it("counts a non-author approval toward requiredApprovals", async () => {
    // bob (not the author) approves — that satisfies requiredApprovals: 1.
    const db = makeProtectionD1({ approvers: ["alice", "bob"] });
    const authored: Change = { ...change, createdByUserId: "alice" };
    const policy: EvalPolicy = { evaluators: [], merge: { requiredApprovals: 1 } };

    const result = await checkMergeProtection(db, mockLogger, authored, policy);
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

describe("diffTouchesProtectedConfig", () => {
  it("detects an edit to .stratum/policy.yaml", () => {
    const diff = [
      "diff --git a/.stratum/policy.yaml b/.stratum/policy.yaml",
      "--- a/.stratum/policy.yaml",
      "+++ b/.stratum/policy.yaml",
      "@@ -1,1 +1,1 @@",
      "-requiredApprovals: 1",
      "+requiredApprovals: 0",
    ].join("\n");
    expect(diffTouchesProtectedConfig(diff)).toBe(true);
  });

  it("detects an edit to stratum.config.json", () => {
    const diff = "diff --git a/stratum.config.json b/stratum.config.json\n+{}";
    expect(diffTouchesProtectedConfig(diff)).toBe(true);
  });

  it("ignores a diff that only touches ordinary source files", () => {
    const diff = "diff --git a/src/index.ts b/src/index.ts\n+const x = 1;";
    expect(diffTouchesProtectedConfig(diff)).toBe(false);
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

describe("requiredEvaluatorReasons", () => {
  it("folds duplicate evaluator types with AND so a passing duplicate cannot mask a failure", () => {
    // A policy may list the same type twice (e.g. two diff evaluators with
    // different forbiddenPatterns). Whichever order the runs land in, one
    // failure must keep the required type failed.
    const failFirst = requiredEvaluatorReasons(
      [
        { evaluatorType: "diff", result: { passed: false } },
        { evaluatorType: "diff", result: { passed: true } },
      ],
      ["diff"],
    );
    expect(failFirst).toEqual(["Required evaluator 'diff' failed"]);

    const failSecond = requiredEvaluatorReasons(
      [
        { evaluatorType: "diff", result: { passed: true } },
        { evaluatorType: "diff", result: { passed: false } },
      ],
      ["diff"],
    );
    expect(failSecond).toEqual(["Required evaluator 'diff' failed"]);

    const bothPass = requiredEvaluatorReasons(
      [
        { evaluatorType: "diff", result: { passed: true } },
        { evaluatorType: "diff", result: { passed: true } },
      ],
      ["diff"],
    );
    expect(bothPass).toEqual([]);
  });

  it("reports a required evaluator that never ran", () => {
    expect(requiredEvaluatorReasons([], ["sandbox"])).toEqual([
      "Required evaluator 'sandbox' has not run",
    ]);
  });
});
