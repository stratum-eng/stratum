import { describe, expect, it, vi } from "vitest";
import { LLMEvaluator } from "../src/evaluation/llm-evaluator";
import { WorkersAiProvider } from "../src/evaluation/llm-provider";
import type { EvalPolicy } from "../src/evaluation/types";
import type { AiBinding } from "../src/types";
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

function makeMockAi(response: string): AiBinding {
  return {
    run: vi.fn().mockResolvedValue({ response }),
  };
}

function makePolicy(overrides: Partial<EvalPolicy> = {}): EvalPolicy {
  return {
    evaluators: [{ type: "llm" }],
    ...overrides,
  };
}

describe("LLMEvaluator — valid JSON responses", () => {
  it("score 0.9 with threshold 0.7 → passed: true", async () => {
    const ai = makeMockAi(
      JSON.stringify({ score: 0.9, passed: true, reason: "Looks good", issues: [] }),
    );
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const result = await evaluator.evaluate("diff content", makePolicy(), mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(0.9);
      expect(result.data.passed).toBe(true);
      expect(result.data.reason).toBe("Looks good");
    }
  });

  it("score 0.5 with default threshold 0.7 → passed: false", async () => {
    const ai = makeMockAi(
      JSON.stringify({ score: 0.5, passed: true, reason: "Mediocre", issues: [] }),
    );
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const result = await evaluator.evaluate("diff content", makePolicy(), mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(0.5);
      expect(result.data.passed).toBe(false);
    }
  });

  it("score 0.5 with explicit threshold 0.4 → passed: true", async () => {
    const ai = makeMockAi(JSON.stringify({ score: 0.5, passed: true, reason: "OK", issues: [] }));
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const policy = makePolicy({ evaluators: [{ type: "llm", threshold: 0.4 }] });
    const result = await evaluator.evaluate("diff content", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(true);
    }
  });
});

describe("LLMEvaluator — unparseable responses fail closed", () => {
  it("AI returns non-JSON text → score 0, failed, no throw", async () => {
    const ai = makeMockAi("This diff looks fine overall.");
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const result = await evaluator.evaluate("diff content", makePolicy(), mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(0);
      expect(result.data.passed).toBe(false);
      expect(result.data.reason).toContain("failed closed");
      // Raw model output can quote the diff (secrets included) — only metadata.
      expect(result.data.issues?.[0]).toContain("29 chars");
      expect(JSON.stringify(result.data)).not.toContain("This diff looks fine");
    }
  });

  it('"LGTM" prose is not treated as approval — still fails closed at 0', async () => {
    const ai = makeMockAi("LGTM, no issues found.");
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const result = await evaluator.evaluate("diff content", makePolicy(), mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(0);
      expect(result.data.passed).toBe(false);
      expect(result.data.reason).toContain("failed closed");
    }
  });

  it("JSON with wrong field types → fails closed with field reason", async () => {
    const ai = makeMockAi(JSON.stringify({ score: "high", passed: "yes", reason: 42 }));
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const result = await evaluator.evaluate("diff content", makePolicy(), mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(0);
      expect(result.data.passed).toBe(false);
      expect(result.data.reason).toContain("missing score/passed/reason");
    }
  });

  it("fail-closed result still records estimated token costs", async () => {
    const ai = makeMockAi("not json");
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const result = await evaluator.evaluate("diff content", makePolicy(), mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.costs?.[0]?.kind).toBe("llm_tokens");
      expect(result.data.costs?.[0]?.quantity).toBeGreaterThan(0);
      expect(result.data.costs?.[0]?.estimated).toBe(true);
    }
  });
});

describe("LLMEvaluator — error handling", () => {
  it("AI run() throws → returns failed EvalResult without rethrowing", async () => {
    const ai: AiBinding = {
      run: vi.fn().mockRejectedValue(new Error("network failure")),
    };
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const result = await evaluator.evaluate("diff content", makePolicy(), mockLogger);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("network failure");
    }
  });
});

describe("LLMEvaluator — score clamping", () => {
  it("score above 1 is clamped to 1", async () => {
    const ai = makeMockAi(JSON.stringify({ score: 1.5, passed: true, reason: "Great" }));
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const result = await evaluator.evaluate("diff content", makePolicy(), mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(1);
    }
  });

  it("score below 0 is clamped to 0", async () => {
    const ai = makeMockAi(JSON.stringify({ score: -0.2, passed: false, reason: "Terrible" }));
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const result = await evaluator.evaluate("diff content", makePolicy(), mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(0);
      expect(result.data.passed).toBe(false);
    }
  });
});

describe("LLMEvaluator — issues array", () => {
  it("issues array included in result when present in JSON", async () => {
    const issues = ["Missing tests", "Hardcoded secret"];
    const ai = makeMockAi(
      JSON.stringify({ score: 0.4, passed: false, reason: "Problems found", issues }),
    );
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const result = await evaluator.evaluate("diff content", makePolicy(), mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toEqual(issues);
    }
  });

  it("issues omitted from result when not present in JSON", async () => {
    const ai = makeMockAi(JSON.stringify({ score: 0.9, passed: true, reason: "Clean" }));
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const result = await evaluator.evaluate("diff content", makePolicy(), mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toBeUndefined();
    }
  });
});

function sentDiffPortion(ai: AiBinding): string {
  const runMock = ai.run as ReturnType<typeof vi.fn>;
  const calledMessages = (
    runMock.mock.calls[0] as [string, { messages: Array<{ role: string; content: string }> }]
  )[1].messages;
  const userMessage = calledMessages.find((m) => m.role === "user");
  if (!userMessage) throw new Error("user message not found");
  return userMessage.content.split("Diff to review:\n")[1] ?? "";
}

describe("LLMEvaluator — diff truncation", () => {
  it("diff longer than the 24000-char default is truncated before being sent to AI", async () => {
    const ai = makeMockAi(JSON.stringify({ score: 0.9, passed: true, reason: "OK" }));
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const longDiff = "a".repeat(30000);
    await evaluator.evaluate(longDiff, makePolicy(), mockLogger);
    expect(sentDiffPortion(ai).length).toBe(24000);
  });

  it("diff shorter than the window is sent whole", async () => {
    const ai = makeMockAi(JSON.stringify({ score: 0.9, passed: true, reason: "OK" }));
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    await evaluator.evaluate("a".repeat(10000), makePolicy(), mockLogger);
    expect(sentDiffPortion(ai).length).toBe(10000);
  });

  it("policy maxDiffChars overrides the default window", async () => {
    const ai = makeMockAi(JSON.stringify({ score: 0.9, passed: true, reason: "OK" }));
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const policy = makePolicy({ evaluators: [{ type: "llm", maxDiffChars: 2000 }] });
    await evaluator.evaluate("a".repeat(5000), policy, mockLogger);
    expect(sentDiffPortion(ai).length).toBe(2000);
  });

  it("a tiny maxDiffChars is raised to the 1000-char floor, never an empty diff", async () => {
    const ai = makeMockAi(JSON.stringify({ score: 0.9, passed: true, reason: "OK" }));
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const policy = makePolicy({ evaluators: [{ type: "llm", maxDiffChars: 5 }] });
    await evaluator.evaluate("a".repeat(5000), policy, mockLogger);
    expect(sentDiffPortion(ai).length).toBe(1000);
  });

  it("a fractional maxDiffChars is floored to an integer window", async () => {
    const ai = makeMockAi(JSON.stringify({ score: 0.9, passed: true, reason: "OK" }));
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const policy = makePolicy({ evaluators: [{ type: "llm", maxDiffChars: 2000.7 }] });
    await evaluator.evaluate("a".repeat(5000), policy, mockLogger);
    expect(sentDiffPortion(ai).length).toBe(2000);
  });

  it("a fractional value below one still sends a non-empty diff", async () => {
    const ai = makeMockAi(JSON.stringify({ score: 0.9, passed: true, reason: "OK" }));
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const policy = makePolicy({ evaluators: [{ type: "llm", maxDiffChars: 0.5 }] });
    await evaluator.evaluate("a".repeat(5000), policy, mockLogger);
    expect(sentDiffPortion(ai).length).toBe(1000);
  });

  it("policy maxDiffChars is capped at the 100k ceiling", async () => {
    const ai = makeMockAi(JSON.stringify({ score: 0.9, passed: true, reason: "OK" }));
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const policy = makePolicy({ evaluators: [{ type: "llm", maxDiffChars: 5_000_000 }] });
    await evaluator.evaluate("a".repeat(200_000), policy, mockLogger);
    expect(sentDiffPortion(ai).length).toBe(100_000);
  });

  it("a truncated evaluation says so in the result issues", async () => {
    const ai = makeMockAi(JSON.stringify({ score: 0.9, passed: true, reason: "OK" }));
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const result = await evaluator.evaluate("a".repeat(30000), makePolicy(), mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues?.some((i) => i.includes("truncated"))).toBe(true);
    }
  });

  it("an untruncated evaluation carries no truncation note", async () => {
    const ai = makeMockAi(JSON.stringify({ score: 0.9, passed: true, reason: "OK" }));
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const result = await evaluator.evaluate("small diff", makePolicy(), mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toBeUndefined();
    }
  });
});

describe("LLMEvaluator — non-finite scores", () => {
  it("JSON 1e999 parses to Infinity and fails closed instead of clamping to a pass", async () => {
    const ai = makeMockAi('{"score": 1e999, "passed": true, "reason": "great"}');
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const result = await evaluator.evaluate("diff content", makePolicy(), mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(0);
      expect(result.data.passed).toBe(false);
      expect(result.data.reason).toContain("failed closed");
    }
  });
});

describe("LLMEvaluator — model verdict is honored", () => {
  it("passed:false with a high score still fails", async () => {
    const ai = makeMockAi(
      JSON.stringify({ score: 0.9, passed: false, reason: "Looks risky despite score" }),
    );
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const result = await evaluator.evaluate("diff content", makePolicy(), mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(0.9);
      expect(result.data.passed).toBe(false);
    }
  });
});

describe("LLMEvaluator — policy context bound", () => {
  it("an oversize policy fails closed before any model call", async () => {
    const ai = makeMockAi(JSON.stringify({ score: 0.9, passed: true, reason: "OK" }));
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    const policy = makePolicy({
      evaluators: [{ type: "webhook", url: `https://ci.example.com/${"a".repeat(9000)}` }],
    });
    const result = await evaluator.evaluate("diff content", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(0);
      expect(result.data.passed).toBe(false);
      expect(result.data.reason).toContain("policy context");
    }
    expect(ai.run).not.toHaveBeenCalled();
  });
});

describe("LLMEvaluator — prompt", () => {
  it("sends a real reviewer system prompt demanding strict JSON", async () => {
    const ai = makeMockAi(JSON.stringify({ score: 0.9, passed: true, reason: "OK" }));
    const evaluator = new LLMEvaluator(new WorkersAiProvider(ai));
    await evaluator.evaluate("diff content", makePolicy(), mockLogger);
    const runMock = ai.run as ReturnType<typeof vi.fn>;
    const calledMessages = (
      runMock.mock.calls[0] as [string, { messages: Array<{ role: string; content: string }> }]
    )[1].messages;
    const system = calledMessages.find((m) => m.role === "system");
    expect(system?.content).toContain("code reviewer");
    expect(system?.content).toContain("ONLY a JSON object");
  });
});
