import { describe, expect, it, vi } from "vitest";
import {
  SandboxEvaluator,
  type SandboxRepoAccess,
  installCommandFor,
} from "../src/evaluation/sandbox-evaluator";
import type { EvalPolicy } from "../src/evaluation/types";
import { buildEvaluators } from "../src/services/change-flow";
import type { Env, SandboxBinding, SandboxInstance } from "../src/types";
import { AppError } from "../src/utils/errors";
import type { Logger } from "../src/utils/logger";
import { err, ok } from "../src/utils/result";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

const repo: SandboxRepoAccess = {
  remote: "https://artifacts.example/ws.git",
  token: "read-token",
  ref: "a".repeat(40),
};

/** A realistic workspace tree: sources the diff never touched, manifest, lockfile. */
const FULL_TREE = new Map<string, string>([
  ["package.json", JSON.stringify({ name: "app", scripts: { test: "vitest run" } })],
  ["package-lock.json", JSON.stringify({ lockfileVersion: 3 })],
  ["src/index.ts", "export { add } from './math';"],
  ["src/math.ts", "export const add = (a: number, b: number) => a + b;"],
  ["tests/math.test.ts", "import { add } from '../src/math';"],
]);

function makeReadFiles(files: Map<string, string> = FULL_TREE) {
  return vi.fn().mockResolvedValue(ok(files));
}

interface RunCall {
  command: string;
  opts?: { timeout?: number };
}

function makeMockSandbox(opts: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  createThrows?: boolean;
  runThrows?: boolean;
  /** Per-command results; falls back to the flat exitCode/stdout/stderr. */
  runResults?: Record<string, { exitCode: number; stdout?: string; stderr?: string }>;
}): { binding: SandboxBinding; instance: SandboxInstance; runCalls: RunCall[] } {
  const runCalls: RunCall[] = [];
  const instance: SandboxInstance = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockImplementation(async (command: string, runOpts?: { timeout?: number }) => {
      runCalls.push({ command, opts: runOpts });
      if (opts.runThrows) throw new Error("Timeout");
      const specific = opts.runResults?.[command];
      if (specific) {
        return {
          exitCode: specific.exitCode,
          stdout: specific.stdout ?? "",
          stderr: specific.stderr ?? "",
        };
      }
      return { exitCode: opts.exitCode ?? 0, stdout: opts.stdout ?? "", stderr: opts.stderr ?? "" };
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
  };

  const binding: SandboxBinding = {
    create: opts.createThrows
      ? vi.fn().mockRejectedValue(new Error("Sandbox unavailable"))
      : vi.fn().mockResolvedValue(instance),
  };

  return { binding, instance, runCalls };
}

function makePolicy(overrides: Partial<EvalPolicy> = {}): EvalPolicy {
  return {
    evaluators: [{ type: "sandbox" }],
    minScore: 0.7,
    ...overrides,
  };
}

describe("SandboxEvaluator — workspace tree materialization", () => {
  it("reads the workspace tree at the pinned evaluated commit", async () => {
    const { binding } = makeMockSandbox({ exitCode: 0 });
    const readFiles = makeReadFiles();
    const evaluator = new SandboxEvaluator(binding, repo, readFiles);

    await evaluator.evaluate("ignored diff", makePolicy(), mockLogger);

    expect(readFiles).toHaveBeenCalledWith(repo.remote, repo.token, mockLogger, repo.ref);
  });

  it("writes EVERY file of the tree into the sandbox, not just changed ones", async () => {
    const { binding, instance } = makeMockSandbox({ exitCode: 0 });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles());

    await evaluator.evaluate("diff --git a/src/math.ts b/src/math.ts", makePolicy(), mockLogger);

    expect(instance.writeFile).toHaveBeenCalledTimes(FULL_TREE.size);
    for (const [path, content] of FULL_TREE) {
      expect(instance.writeFile).toHaveBeenCalledWith(path, content);
    }
  });

  it("passes ref: undefined through when no commit is pinned", async () => {
    const { binding } = makeMockSandbox({ exitCode: 0 });
    const readFiles = makeReadFiles();
    const unpinned: SandboxRepoAccess = { remote: repo.remote, token: repo.token };
    const evaluator = new SandboxEvaluator(binding, unpinned, readFiles);

    await evaluator.evaluate("", makePolicy(), mockLogger);

    expect(readFiles).toHaveBeenCalledWith(repo.remote, repo.token, mockLogger, undefined);
  });

  it("fails (err) with a clear reason when the tree cannot be read, without creating a sandbox", async () => {
    const { binding } = makeMockSandbox({ exitCode: 0 });
    const readFiles = vi
      .fn()
      .mockResolvedValue(err(new AppError("clone exploded", "GIT_ERROR", 502)));
    const evaluator = new SandboxEvaluator(binding, repo, readFiles);

    const result = await evaluator.evaluate("", makePolicy(), mockLogger);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("Could not read workspace tree");
      expect(result.error.message).toContain("clone exploded");
    }
    expect(binding.create).not.toHaveBeenCalled();
  });
});

describe("SandboxEvaluator — dependency install", () => {
  it("runs `npm ci` before the test command when package.json + lockfile exist", async () => {
    const { binding, runCalls } = makeMockSandbox({ exitCode: 0 });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles());

    await evaluator.evaluate("", makePolicy(), mockLogger);

    expect(runCalls.map((c) => c.command)).toEqual(["npm ci --no-audit --no-fund", "npm test"]);
  });

  it("runs `npm install` when package.json exists without a lockfile", async () => {
    const tree = new Map(FULL_TREE);
    tree.delete("package-lock.json");
    const { binding, runCalls } = makeMockSandbox({ exitCode: 0 });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles(tree));

    await evaluator.evaluate("", makePolicy(), mockLogger);

    expect(runCalls.map((c) => c.command)).toEqual([
      "npm install --no-audit --no-fund",
      "npm test",
    ]);
  });

  it("skips the install step entirely when there is no package.json", async () => {
    const tree = new Map([["main.py", "print('hi')"]]);
    const { binding, runCalls } = makeMockSandbox({ exitCode: 0 });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles(tree));

    await evaluator.evaluate("", makePolicy(), mockLogger);

    expect(runCalls.map((c) => c.command)).toEqual(["npm test"]);
  });

  it("uses the install timeout (default 120s) for install and timeoutMs for the command", async () => {
    const { binding, runCalls } = makeMockSandbox({ exitCode: 0 });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles());
    const policy = makePolicy({
      evaluators: [{ type: "sandbox", command: "npm test", timeoutMs: 30_000 }],
    });

    await evaluator.evaluate("", policy, mockLogger);

    expect(runCalls[0]).toEqual({
      command: "npm ci --no-audit --no-fund",
      opts: { timeout: 120_000 },
    });
    expect(runCalls[1]).toEqual({ command: "npm test", opts: { timeout: 30_000 } });
  });

  it("honors a configured installTimeoutMs", async () => {
    const { binding, runCalls } = makeMockSandbox({ exitCode: 0 });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles());
    const policy = makePolicy({
      evaluators: [{ type: "sandbox", installTimeoutMs: 300_000 }],
    });

    await evaluator.evaluate("", policy, mockLogger);

    expect(runCalls[0]?.opts).toEqual({ timeout: 300_000 });
  });

  it("install failure → score 0, failed, reason names the install command, test never runs", async () => {
    const { binding, runCalls } = makeMockSandbox({
      exitCode: 0,
      runResults: {
        "npm ci --no-audit --no-fund": {
          exitCode: 1,
          stderr: "ERESOLVE unable to resolve dependency tree",
        },
      },
    });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles());

    const result = await evaluator.evaluate("", makePolicy(), mockLogger);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(0);
      expect(result.data.passed).toBe(false);
      expect(result.data.reason).toContain(
        "Dependency install (npm ci --no-audit --no-fund) failed",
      );
      expect(result.data.reason).toContain("ERESOLVE");
      expect(result.data.costs?.[0]?.kind).toBe("sandbox_ms");
    }
    expect(runCalls.map((c) => c.command)).toEqual(["npm ci --no-audit --no-fund"]);
  });
});

describe("installCommandFor", () => {
  it("maps manifest/lockfile presence to the right command", () => {
    expect(installCommandFor(new Map())).toBeNull();
    expect(installCommandFor(new Map([["package.json", "{}"]]))).toBe(
      "npm install --no-audit --no-fund",
    );
    expect(
      installCommandFor(
        new Map([
          ["package.json", "{}"],
          ["package-lock.json", "{}"],
        ]),
      ),
    ).toBe("npm ci --no-audit --no-fund");
    expect(installCommandFor(new Map([["package-lock.json", "{}"]]))).toBeNull();
  });

  it("treats npm-shrinkwrap.json as a lockfile", () => {
    // `npm ci` accepts either lockfile name. A shrinkwrap-only project is just
    // as pinned as a package-lock one, so it must not fall back to the
    // unpinned `npm install`.
    expect(
      installCommandFor(
        new Map([
          ["package.json", "{}"],
          ["npm-shrinkwrap.json", "{}"],
        ]),
      ),
    ).toBe("npm ci --no-audit --no-fund");
    // Both present is still a frozen install (npm prefers the shrinkwrap).
    expect(
      installCommandFor(
        new Map([
          ["package.json", "{}"],
          ["npm-shrinkwrap.json", "{}"],
          ["package-lock.json", "{}"],
        ]),
      ),
    ).toBe("npm ci --no-audit --no-fund");
    // A lockfile alone is still not an npm project.
    expect(installCommandFor(new Map([["npm-shrinkwrap.json", "{}"]]))).toBeNull();
  });
});

describe("SandboxEvaluator — exit code behaviour", () => {
  it("exit code 0 → score 1.0, passed: true", async () => {
    const { binding } = makeMockSandbox({ exitCode: 0, stdout: "ok" });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles());
    const result = await evaluator.evaluate("", makePolicy(), mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(1.0);
      expect(result.data.passed).toBe(true);
    }
  });

  it("exit code 1 with no parseable output → score 0.0, passed: false", async () => {
    const { binding } = makeMockSandbox({
      exitCode: 0,
      runResults: { "npm test": { exitCode: 1, stdout: "something broke" } },
    });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles());
    const result = await evaluator.evaluate("", makePolicy(), mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(0.0);
      expect(result.data.passed).toBe(false);
    }
  });
});

describe("SandboxEvaluator — test output parsing", () => {
  const treeWithoutManifest = new Map([["src/app.ts", "export {};"]]);

  function evaluatorWithTestOutput(exitCode: number, stdout: string) {
    const { binding } = makeMockSandbox({ exitCode, stdout });
    return new SandboxEvaluator(binding, repo, makeReadFiles(treeWithoutManifest));
  }

  it('"5 passed, 0 failed" → score 1.0', async () => {
    const result = await evaluatorWithTestOutput(0, "5 passed, 0 failed").evaluate(
      "",
      makePolicy(),
      mockLogger,
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(1.0);
    }
  });

  it('"3 passed, 2 failed" → score 0.6, passed: false (minScore 0.7)', async () => {
    const result = await evaluatorWithTestOutput(1, "3 passed, 2 failed").evaluate(
      "",
      makePolicy({ minScore: 0.7 }),
      mockLogger,
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBeCloseTo(0.6);
      expect(result.data.passed).toBe(false);
    }
  });

  it('"0 passed, 5 failed" → score 0.0', async () => {
    const result = await evaluatorWithTestOutput(1, "0 passed, 5 failed").evaluate(
      "",
      makePolicy(),
      mockLogger,
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(0.0);
      expect(result.data.passed).toBe(false);
    }
  });

  it('"5 passed, 1 failed" → score ~0.833, passed: true (minScore 0.7)', async () => {
    const result = await evaluatorWithTestOutput(1, "5 passed, 1 failed").evaluate(
      "",
      makePolicy({ minScore: 0.7 }),
      mockLogger,
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBeCloseTo(5 / 6);
      expect(result.data.passed).toBe(true);
    }
  });

  it('"0 passed" alone (zero total) → unparseable, score 0.0', async () => {
    const result = await evaluatorWithTestOutput(1, "0 passed").evaluate(
      "",
      makePolicy(),
      mockLogger,
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(0.0);
      expect(result.data.passed).toBe(false);
    }
  });

  it('"5 passed" alone (no failed count) → score 1.0', async () => {
    const result = await evaluatorWithTestOutput(1, "5 passed").evaluate(
      "",
      makePolicy(),
      mockLogger,
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(1.0);
    }
  });

  it("exit code 0 with no parseable output → score 1.0", async () => {
    const result = await evaluatorWithTestOutput(0, "All done.").evaluate(
      "",
      makePolicy(),
      mockLogger,
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(1.0);
    }
  });
});

describe("SandboxEvaluator — error handling", () => {
  it("sandbox.create() throws → returns err without rethrowing", async () => {
    const { binding } = makeMockSandbox({ createThrows: true });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles());
    const result = await evaluator.evaluate("", makePolicy(), mockLogger);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("Sandbox unavailable");
    }
  });

  it("run() throws (timeout) → returns err without rethrowing", async () => {
    const { binding } = makeMockSandbox({ runThrows: true });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles());
    const result = await evaluator.evaluate("", makePolicy(), mockLogger);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("Timeout");
    }
  });

  it("readFiles rejecting (non-Error) is contained and surfaced as err", async () => {
    const { binding } = makeMockSandbox({ exitCode: 0 });
    const readFiles = vi.fn().mockRejectedValue("string failure");
    const evaluator = new SandboxEvaluator(binding, repo, readFiles);
    const result = await evaluator.evaluate("", makePolicy(), mockLogger);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("string failure");
    }
    expect(binding.create).not.toHaveBeenCalled();
  });
});

describe("SandboxEvaluator — destroy lifecycle", () => {
  it("destroy() is called after successful run", async () => {
    const { binding, instance } = makeMockSandbox({ exitCode: 0 });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles());

    await evaluator.evaluate("", makePolicy(), mockLogger);

    expect(instance.destroy).toHaveBeenCalledOnce();
  });

  it("destroy() is called even when run() throws", async () => {
    const { binding, instance } = makeMockSandbox({ runThrows: true });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles());

    await evaluator.evaluate("", makePolicy(), mockLogger);

    expect(instance.destroy).toHaveBeenCalledOnce();
  });

  it("destroy() is called when the install step fails", async () => {
    const { binding, instance } = makeMockSandbox({
      exitCode: 0,
      runResults: { "npm ci --no-audit --no-fund": { exitCode: 1, stderr: "boom" } },
    });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles());

    await evaluator.evaluate("", makePolicy(), mockLogger);

    expect(instance.destroy).toHaveBeenCalledOnce();
  });
});

describe("SandboxEvaluator — feature flag / no-op", () => {
  it("returns passed: true, score: 1.0 when no sandbox evaluator in policy, without repo reads", async () => {
    const { binding } = makeMockSandbox({ exitCode: 0 });
    const readFiles = makeReadFiles();
    const evaluator = new SandboxEvaluator(binding, repo, readFiles);
    const policy: EvalPolicy = {
      evaluators: [{ type: "diff" }],
      minScore: 0.7,
    };
    const result = await evaluator.evaluate("", policy, mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(1.0);
      expect(result.data.passed).toBe(true);
    }
    expect(binding.create).not.toHaveBeenCalled();
    expect(readFiles).not.toHaveBeenCalled();
  });
});

describe("SandboxEvaluator — reason field", () => {
  it("reason is first 500 chars of stdout + stderr combined", async () => {
    const longOutput = "x".repeat(600);
    const { binding } = makeMockSandbox({ exitCode: 0, stdout: longOutput });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles());
    const result = await evaluator.evaluate("", makePolicy(), mockLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason.length).toBeLessThanOrEqual(500);
    }
  });

  it("reports sandbox_ms cost covering install + test run", async () => {
    vi.useFakeTimers();
    try {
      const instance: SandboxInstance = {
        writeFile: vi.fn().mockResolvedValue(undefined),
        run: vi.fn().mockImplementation(async () => {
          // Each step (install, then the test command) takes 1000ms.
          vi.advanceTimersByTime(1000);
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
        destroy: vi.fn().mockResolvedValue(undefined),
      };
      const binding: SandboxBinding = { create: vi.fn().mockResolvedValue(instance) };
      const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles());

      const result = await evaluator.evaluate("", makePolicy(), mockLogger);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.costs).toHaveLength(1);
        expect(result.data.costs?.[0]?.kind).toBe("sandbox_ms");
        expect(result.data.costs?.[0]?.quantity).toBe(2000);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("buildEvaluators — sandbox wiring", () => {
  const sandboxPolicy: EvalPolicy = { evaluators: [{ type: "sandbox" }] };

  function findSandbox(evaluators: ReturnType<typeof buildEvaluators>) {
    const entry = evaluators.find((e) => e.type === "sandbox");
    expect(entry).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    return entry!.evaluator;
  }

  it("no SANDBOX binding → fails closed with an actionable wrangler.toml reason", async () => {
    const evaluators = buildEvaluators({} as Env, sandboxPolicy, "proj", mockLogger, repo);
    const result = await findSandbox(evaluators).evaluate("", sandboxPolicy, mockLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.passed).toBe(false);
    expect(result.data.score).toBe(0);
    expect(result.data.reason).toContain("SANDBOX binding is not configured");
    expect(result.data.reason).toContain("[[sandboxes]] in wrangler.toml");
  });

  it("SANDBOX binding without workspace repo access → fails closed", async () => {
    const { binding } = makeMockSandbox({ exitCode: 0 });
    const evaluators = buildEvaluators(
      { SANDBOX: binding } as Env,
      sandboxPolicy,
      "proj",
      mockLogger,
    );
    const result = await findSandbox(evaluators).evaluate("", sandboxPolicy, mockLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.passed).toBe(false);
    expect(result.data.reason).toContain("workspace repository access was not provided");
    expect(binding.create).not.toHaveBeenCalled();
  });

  it("SANDBOX binding + workspace repo access → a real SandboxEvaluator", () => {
    const { binding } = makeMockSandbox({ exitCode: 0 });
    const evaluators = buildEvaluators(
      { SANDBOX: binding } as Env,
      sandboxPolicy,
      "proj",
      mockLogger,
      repo,
    );
    expect(findSandbox(evaluators)).toBeInstanceOf(SandboxEvaluator);
  });
});
