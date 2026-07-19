import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompositeEvaluator } from "../src/evaluation/composite-evaluator";
import { DiffEvaluator } from "../src/evaluation/diff-evaluator";
import { loadPolicy } from "../src/evaluation/policy-loader";
import type { EvalPolicy, Evaluator } from "../src/evaluation/types";
import { WebhookEvaluator } from "../src/evaluation/webhook-evaluator";
import { AppError } from "../src/utils/errors";
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

vi.mock("../src/storage/git-ops", () => ({
  readFileFromRepo: vi.fn(),
}));

import { readFileFromRepo } from "../src/storage/git-ops";
const mockReadFileFromRepo = vi.mocked(readFileFromRepo);

function makeDiff(
  opts: {
    files?: Array<{ path: string; addedLines?: number; removedLines?: number }>;
  } = {},
): string {
  const files = opts.files ?? [{ path: "src/index.ts", addedLines: 3, removedLines: 1 }];
  return files
    .map(({ path, addedLines = 1, removedLines = 0 }) => {
      const added = Array.from({ length: addedLines }, (_, i) => `+line${i + 1}`).join("\n");
      const removed = Array.from({ length: removedLines }, (_, i) => `-old${i + 1}`).join("\n");
      const lines = [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        removed,
        added,
      ].filter(Boolean);
      return lines.join("\n");
    })
    .join("\n");
}

function makePolicy(overrides: Partial<EvalPolicy> = {}): EvalPolicy {
  return {
    evaluators: [{ type: "diff" }],
    requireAll: true,
    minScore: 0.7,
    ...overrides,
  };
}

describe("DiffEvaluator", () => {
  const evaluator = new DiffEvaluator();

  it("passes a clean small diff", async () => {
    const diff = makeDiff({ files: [{ path: "src/index.ts", addedLines: 5, removedLines: 2 }] });
    const policy = makePolicy({ evaluators: [{ type: "diff" }] });
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
      expect(result.data.score).toBe(1.0);
    }
  });

  it("fails when lines exceed maxLines", async () => {
    const diff = makeDiff({
      files: [{ path: "src/big.ts", addedLines: 600, removedLines: 0 }],
    });
    const policy = makePolicy({ evaluators: [{ type: "diff", maxLines: 500 }], minScore: 1.0 });
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.score).toBeLessThan(1.0);
      expect(result.data.issues).toBeDefined();
      expect(result.data.issues?.some((i) => i.includes("maxLines"))).toBe(true);
    }
  });

  it("fails when files exceed maxFiles", async () => {
    const files = Array.from({ length: 25 }, (_, i) => ({
      path: `src/file${i}.ts`,
      addedLines: 1,
    }));
    const diff = makeDiff({ files });
    const policy = makePolicy({ evaluators: [{ type: "diff", maxFiles: 20 }], minScore: 1.0 });
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.issues?.some((i) => i.includes("maxFiles"))).toBe(true);
    }
  });

  it("fails when added file matches forbidden pattern", async () => {
    const diff = makeDiff({ files: [{ path: "yarn.lock", addedLines: 2 }] });
    const policy = makePolicy({
      evaluators: [{ type: "diff", forbiddenPatterns: ["*.lock"] }],
      minScore: 1.0,
    });
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.issues?.some((i) => i.includes("forbidden"))).toBe(true);
    }
  });

  it("score decrements by 0.25 per violation — 2 violations yields score 0.5", async () => {
    const files = Array.from({ length: 25 }, (_, i) => ({
      path: `src/file${i}.ts`,
      addedLines: 600,
    }));
    const diff = makeDiff({ files });
    const policy = makePolicy({
      evaluators: [{ type: "diff", maxLines: 500, maxFiles: 20 }],
      minScore: 0.3,
    });
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(0.5);
      expect(result.data.passed).toBe(true);
    }
  });

  it("fails requiredPatterns when no file matches", async () => {
    const diff = makeDiff({ files: [{ path: "src/index.ts", addedLines: 2 }] });
    const policy = makePolicy({
      evaluators: [{ type: "diff", requiredPatterns: ["tests/*"] }],
      minScore: 1.0,
    });
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.issues?.some((i) => i.includes("required pattern"))).toBe(true);
    }
  });

  it("passes requiredPatterns when a file matches", async () => {
    const diff = makeDiff({
      files: [
        { path: "src/index.ts", addedLines: 2 },
        { path: "tests/index.test.ts", addedLines: 1 },
      ],
    });
    const policy = makePolicy({
      evaluators: [{ type: "diff", requiredPatterns: ["tests/*"] }],
    });
    const result = await evaluator.evaluate(diff, policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
    }
  });
});

describe("WebhookEvaluator", () => {
  const evaluator = new WebhookEvaluator();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns result from successful 200 response", async () => {
    const mockResponse = { score: 0.9, passed: true, reason: "Looks good" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      }),
    );

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
    });
    const result = await evaluator.evaluate("diff content", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
      expect(result.data.score).toBe(0.9);
      expect(result.data.reason).toBe("Looks good");
    }
  });

  it("returns failed result on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({}),
      }),
    );

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
    });
    const result = await evaluator.evaluate("diff content", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.score).toBe(0);
      expect(result.data.reason).toContain("422");
    }
  });

  it("SEC-6: rejects a private-host URL without fetching (fail-closed)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "http://169.254.169.254/latest/meta-data" }],
    });
    const result = await evaluator.evaluate("diff content", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.score).toBe(0);
      expect(result.data.reason).toMatch(/not allowed/i);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("SEC-6: passes redirect:manual to fetch and fails a redirect response closed", async () => {
    let capturedInit: RequestInit = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedInit = init;
        // A 3xx followed manually surfaces as an opaque redirect: ok === false.
        return Promise.resolve({ ok: false, status: 302, json: async () => ({}) });
      }),
    );

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
    });
    const result = await evaluator.evaluate("diff content", policy, mockLogger);
    expect(capturedInit.redirect).toBe("manual");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
    }
  });

  it("returns failed result when fetch throws (timeout)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("The operation was aborted")));

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval", timeoutMs: 1 }],
    });
    const result = await evaluator.evaluate("diff content", policy, mockLogger);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("The operation was aborted");
    }
  });

  it("adds X-Stratum-Signature header when secret is configured", async () => {
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedHeaders = init.headers as Record<string, string>;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ score: 1.0, passed: true, reason: "ok" }),
        });
      }),
    );

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval", secret: "mysecret" }],
    });
    await evaluator.evaluate("diff content", policy, mockLogger);

    expect(capturedHeaders["X-Stratum-Signature"]).toBeDefined();
    expect(capturedHeaders["X-Stratum-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe("CompositeEvaluator", () => {
  function makePassingEvaluator(score = 1.0): Evaluator {
    return {
      evaluate: vi.fn().mockResolvedValue({
        success: true,
        data: {
          score,
          passed: true,
          reason: "passed",
        },
      }),
    };
  }

  function makeFailingEvaluator(score = 0.2): Evaluator {
    return {
      evaluate: vi.fn().mockResolvedValue({
        success: true,
        data: {
          score,
          passed: false,
          reason: "failed",
          issues: ["something went wrong"],
        },
      }),
    };
  }

  it("requireAll=true: fails if any evaluator fails", async () => {
    const composite = new CompositeEvaluator([makePassingEvaluator(), makeFailingEvaluator()]);
    const policy = makePolicy({ requireAll: true });
    const result = await composite.evaluateAndAggregate("diff", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
    }
  });

  it("requireAll=true: passes when all evaluators pass", async () => {
    const composite = new CompositeEvaluator([makePassingEvaluator(), makePassingEvaluator()]);
    const policy = makePolicy({ requireAll: true });
    const result = await composite.evaluateAndAggregate("diff", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
    }
  });

  it("requireAll=false: passes if any evaluator passes", async () => {
    const composite = new CompositeEvaluator([makeFailingEvaluator(), makePassingEvaluator()]);
    const policy = makePolicy({ requireAll: false });
    const result = await composite.evaluateAndAggregate("diff", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
    }
  });

  it("requireAll=false: fails if all evaluators fail", async () => {
    const composite = new CompositeEvaluator([makeFailingEvaluator(), makeFailingEvaluator()]);
    const policy = makePolicy({ requireAll: false });
    const result = await composite.evaluateAndAggregate("diff", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
    }
  });

  it("runs all evaluators in parallel (spy on evaluate calls)", async () => {
    const e1 = makePassingEvaluator();
    const e2 = makePassingEvaluator();
    const composite = new CompositeEvaluator([e1, e2]);
    const policy = makePolicy();
    await composite.evaluate("diff", policy, mockLogger);
    expect(e1.evaluate).toHaveBeenCalledOnce();
    expect(e2.evaluate).toHaveBeenCalledOnce();
  });

  it("aggregates scores as average when requireAll=true", async () => {
    const composite = new CompositeEvaluator([
      makePassingEvaluator(0.8),
      makePassingEvaluator(0.6),
    ]);
    const policy = makePolicy({ requireAll: true });
    const result = await composite.evaluateAndAggregate("diff", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBeCloseTo(0.7);
    }
  });

  it("aggregates scores as max when requireAll=false", async () => {
    const composite = new CompositeEvaluator([
      makeFailingEvaluator(0.2),
      makePassingEvaluator(0.9),
    ]);
    const policy = makePolicy({ requireAll: false });
    const result = await composite.evaluateAndAggregate("diff", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(0.9);
    }
  });

  it("collects issues from all evaluators", async () => {
    const e1: Evaluator = {
      evaluate: vi.fn().mockResolvedValue({
        success: true,
        data: {
          score: 0.5,
          passed: false,
          reason: "fail1",
          issues: ["issue A"],
        },
      }),
    };
    const e2: Evaluator = {
      evaluate: vi.fn().mockResolvedValue({
        success: true,
        data: {
          score: 0.5,
          passed: false,
          reason: "fail2",
          issues: ["issue B"],
        },
      }),
    };
    const composite = new CompositeEvaluator([e1, e2]);
    const policy = makePolicy({ requireAll: true });
    const result = await composite.evaluateAndAggregate("diff", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toContain("issue A");
      expect(result.data.issues).toContain("issue B");
    }
  });

  it('reason is "All evaluators passed." when all pass', async () => {
    const composite = new CompositeEvaluator([makePassingEvaluator(), makePassingEvaluator()]);
    const policy = makePolicy({ requireAll: true });
    const result = await composite.evaluateAndAggregate("diff", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBe("All evaluators passed.");
    }
  });
});

describe("loadPolicy", () => {
  beforeEach(() => {
    mockReadFileFromRepo.mockReset();
  });

  it("returns DEFAULT_POLICY when readFileFromRepo returns null", async () => {
    mockReadFileFromRepo.mockResolvedValue({
      success: true,
      data: null as unknown as string,
    });
    const policy = await loadPolicy("https://repo.example.com", "tok", mockLogger);
    expect(policy.evaluators).toEqual([{ type: "diff" }]);
    expect(policy.requireAll).toBe(true);
    expect(policy.minScore).toBe(0.7);
  });

  it("parses valid stratum.config.json", async () => {
    const config = {
      evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
      requireAll: false,
      minScore: 0.5,
    };
    mockReadFileFromRepo
      .mockResolvedValueOnce({
        success: false,
        error: new AppError("missing yaml", "NOT_FOUND", 404),
      })
      .mockResolvedValueOnce({
        success: true,
        data: JSON.stringify(config),
      });
    const policy = await loadPolicy("https://repo.example.com", "tok", mockLogger);
    expect(policy.requireAll).toBe(false);
    expect(policy.minScore).toBe(0.5);
    expect(policy.evaluators[0]?.type).toBe("webhook");
  });

  it("merges parsed config with defaults", async () => {
    const config = { evaluators: [{ type: "diff", maxLines: 100 }] };
    mockReadFileFromRepo
      .mockResolvedValueOnce({
        success: false,
        error: new AppError("missing yaml", "NOT_FOUND", 404),
      })
      .mockResolvedValueOnce({
        success: true,
        data: JSON.stringify(config),
      });
    const policy = await loadPolicy("https://repo.example.com", "tok", mockLogger);
    expect(policy.requireAll).toBe(true);
    expect(policy.minScore).toBe(0.7);
    expect(policy.evaluators[0]).toMatchObject({ type: "diff", maxLines: 100 });
  });

  it("returns DEFAULT_POLICY on invalid JSON", async () => {
    mockReadFileFromRepo
      .mockResolvedValueOnce({
        success: false,
        error: new AppError("missing yaml", "NOT_FOUND", 404),
      })
      .mockResolvedValueOnce({
        success: true,
        data: "not { valid json",
      });
    const policy = await loadPolicy("https://repo.example.com", "tok", mockLogger);
    expect(policy.evaluators).toEqual([{ type: "diff" }]);
  });

  it("returns DEFAULT_POLICY when evaluators is missing", async () => {
    mockReadFileFromRepo
      .mockResolvedValueOnce({
        success: false,
        error: new AppError("missing yaml", "NOT_FOUND", 404),
      })
      .mockResolvedValueOnce({
        success: true,
        data: JSON.stringify({ minScore: 0.5 }),
      });
    const policy = await loadPolicy("https://repo.example.com", "tok", mockLogger);
    expect(policy.evaluators).toEqual([{ type: "diff" }]);
  });

  it("returns DEFAULT_POLICY when readFileFromRepo throws", async () => {
    mockReadFileFromRepo.mockResolvedValue({
      success: false,
      error: new AppError("Network error", "NETWORK_ERROR", 500),
    });
    const policy = await loadPolicy("https://repo.example.com", "tok", mockLogger);
    expect(policy.evaluators).toEqual([{ type: "diff" }]);
  });

  it("parses .stratum/policy.yaml before stratum.config.json", async () => {
    mockReadFileFromRepo.mockImplementation(async (_remote, _token, _path, _logger) => {
      if (_path === ".stratum/policy.yaml") {
        return {
          success: true,
          data: [
            "evaluators:",
            "  - type: diff",
            "    maxLines: 42",
            "requireAll: false",
            "minScore: 0.4",
          ].join("\n"),
        };
      }
      return {
        success: true,
        data: JSON.stringify({
          evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
        }),
      };
    });

    const policy = await loadPolicy("https://repo.example.com", "tok", mockLogger);
    expect(policy.requireAll).toBe(false);
    expect(policy.minScore).toBe(0.4);
    expect(policy.evaluators[0]).toMatchObject({ type: "diff", maxLines: 42 });
    expect(mockReadFileFromRepo).toHaveBeenCalledTimes(1);
  });
});
