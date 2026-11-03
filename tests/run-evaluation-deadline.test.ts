import { afterEach, describe, expect, it, vi } from "vitest";
import type { Evaluator } from "../src/evaluation/types";
import {
  DEFAULT_EVALUATOR_DEADLINE_MS,
  EVALUATOR_DEADLINE_GRACE_MS,
  evaluatorDeadlineMs,
  runEvaluation,
} from "../src/services/change-flow";
import type { Logger } from "../src/utils/logger";

const logger: Logger = {
  trace: vi.fn(),
  fatal: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

const passes: Evaluator = {
  evaluate: async () => ({ success: true, data: { score: 1, passed: true, reason: "ok" } }),
};
const hangs: Evaluator = { evaluate: () => new Promise(() => {}) };

describe("runEvaluation per-evaluator deadlines (#412)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails a hanging evaluator closed at its own deadline and keeps every other verdict", async () => {
    vi.useFakeTimers();
    const pending = runEvaluation(
      [
        { type: "secret_scan", evaluator: passes },
        { type: "webhook", evaluator: hangs, deadlineMs: 4_000 },
      ],
      "diff",
      { evaluators: [] },
      logger,
    );

    await vi.advanceTimersByTimeAsync(4_000);
    const { evalRuns, evalResult } = await pending;

    expect(evalRuns).toEqual([
      { evaluatorType: "secret_scan", result: { score: 1, passed: true, reason: "ok" } },
      {
        evaluatorType: "webhook",
        result: {
          score: 0,
          passed: false,
          reason: "webhook evaluator did not finish within 4000ms",
        },
      },
    ]);
    expect(evalResult.passed).toBe(false);
  });

  it("falls back to the default deadline when none is given", async () => {
    vi.useFakeTimers();
    const pending = runEvaluation(
      [{ type: "diff", evaluator: hangs }],
      "diff",
      { evaluators: [] },
      logger,
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_EVALUATOR_DEADLINE_MS);
    const { evalResult } = await pending;
    expect(evalResult.passed).toBe(false);
  });

  it("sits each deadline past the evaluator's own timeout", () => {
    expect(evaluatorDeadlineMs({ type: "llm", timeoutMs: 5_000 })).toBe(
      5_000 + EVALUATOR_DEADLINE_GRACE_MS,
    );
    expect(evaluatorDeadlineMs({ type: "webhook", url: "https://x", timeoutMs: 2_000 })).toBe(
      2_000 + EVALUATOR_DEADLINE_GRACE_MS,
    );
    expect(evaluatorDeadlineMs({ type: "sandbox", totalBudgetMs: 60_000 })).toBe(
      60_000 + EVALUATOR_DEADLINE_GRACE_MS,
    );
    expect(evaluatorDeadlineMs({ type: "diff" })).toBe(DEFAULT_EVALUATOR_DEADLINE_MS);
  });
});
