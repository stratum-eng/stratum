import { describe, expect, it, vi } from "vitest";
import { SecretScanEvaluator } from "../src/evaluation/secret-scanner";
import type { EvalPolicy } from "../src/evaluation/types";
import type { Logger } from "../src/utils/logger";

const evaluator = new SecretScanEvaluator();
const policy: EvalPolicy = { evaluators: [], requireAll: true, minScore: 0.7 };

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

function makeDiff(addedLines: string[], removedLines: string[] = []): string {
  const header = [
    "diff --git a/src/index.ts b/src/index.ts",
    "--- a/src/index.ts",
    "+++ b/src/index.ts",
  ];
  const removed = removedLines.map((l) => `-${l}`);
  const added = addedLines.map((l) => `+${l}`);
  return [...header, ...removed, ...added].join("\n");
}

describe("SecretScanEvaluator", () => {
  it("passes a clean diff with no secrets", async () => {
    const diff = makeDiff(["const x = 1;", "export default x;"]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
      expect(result.data.score).toBe(1);
      expect(result.data.reason).toBe("No secrets detected");
      expect(result.data.issues).toBeUndefined();
    }
  });

  it("detects AWS access key in added line", async () => {
    const diff = makeDiff(['const key = "AKIAIOSFODNN7EXAMPLE";']);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.score).toBe(0);
      expect(result.data.reason).toContain("AWS Access Key");
      expect(result.data.issues?.length).toBeGreaterThan(0);
      expect(result.data.issues?.[0]).toContain("AWS Access Key");
    }
  });

  it("detects GitHub classic token in added line", async () => {
    const diff = makeDiff([`const token = "ghp_${"a".repeat(36)}";`]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.reason).toContain("GitHub Token (Classic)");
    }
  });

  it("detects GitHub app token in added line", async () => {
    const diff = makeDiff([`const token = "ghs_${"a".repeat(36)}";`]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.reason).toContain("GitHub App Token");
    }
  });

  it("detects GitHub refresh token in added line", async () => {
    const diff = makeDiff([`const token = "ghr_${"a".repeat(76)}";`]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.reason).toContain("GitHub Refresh Token");
    }
  });

  it("detects Stratum user token in added line", async () => {
    const diff = makeDiff([`const token = "stratum_user_${"a".repeat(32)}";`]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.reason).toContain("Stratum User Token");
    }
  });

  it("detects Stratum agent token in added line", async () => {
    const diff = makeDiff([`const token = "stratum_agent_${"a".repeat(32)}";`]);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.reason).toContain("Stratum Agent Token");
    }
  });

  it("does not scan removed lines (starting with -)", async () => {
    const diff = makeDiff(["const safe = true;"], ['const key = "AKIAIOSFODNN7EXAMPLE";']);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
    }
  });

  it("does not false-positive on +++ header lines", async () => {
    const diff = [
      "diff --git a/src/index.ts b/src/index.ts",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "+const x = 1;",
    ].join("\n");
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
    }
  });

  it("reports issue with correct line number", async () => {
    const diff = makeDiff(["const safe = true;", 'const key = "AKIAIOSFODNN7EXAMPLE";']);
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.issues?.[0]).toMatch(/line \d+/);
    }
  });

  it("ignores policy configuration — always runs", async () => {
    const diff = makeDiff(['const key = "AKIAIOSFODNN7EXAMPLE";']);
    const resultWithNull = await evaluator.evaluate(diff, policy, mockLogger);
    const resultWithPolicy = await evaluator.evaluate(
      diff,
      { evaluators: [], requireAll: false },
      mockLogger,
    );
    expect(resultWithNull.success).toBe(true);
    expect(resultWithPolicy.success).toBe(true);
    if (resultWithNull.success && resultWithPolicy.success) {
      expect(resultWithNull.data.passed).toBe(false);
      expect(resultWithPolicy.data.passed).toBe(false);
    }
  });
});
