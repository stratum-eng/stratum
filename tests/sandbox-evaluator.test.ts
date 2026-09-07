import git from "isomorphic-git";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INSTALL_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOTAL_BUDGET_MS,
  MAX_PHASE_TIMEOUT_MS,
  MAX_TOTAL_BUDGET_MS,
} from "../src/evaluation/limits";
import {
  BINARY_DECODE_COMMAND,
  type RepoFilesReader,
  SandboxEvaluator,
  type SandboxRepoAccess,
  budgetExceededReason,
  encodeForSandboxWrite,
  installCommandFor,
  startBudget,
} from "../src/evaluation/sandbox-evaluator";
import type { EvalPolicy } from "../src/evaluation/types";
import { buildEvaluators } from "../src/services/change-flow";
import { type NodeFS, readTreeAtCommit } from "../src/storage/git-ops";
import { MemoryFS } from "../src/storage/memory-fs";
import type { Env, ProjectEntry, SandboxBinding, SandboxInstance } from "../src/types";
import { AppError } from "../src/utils/errors";
import type { Logger } from "../src/utils/logger";
import { err, ok } from "../src/utils/result";
import { makeExecutingSandbox } from "./helpers/fake-sandbox";

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
const FULL_TREE_TEXT: [string, string][] = [
  ["package.json", JSON.stringify({ name: "app", scripts: { test: "vitest run" } })],
  ["package-lock.json", JSON.stringify({ lockfileVersion: 3 })],
  ["src/index.ts", "export { add } from './math';"],
  ["src/math.ts", "export const add = (a: number, b: number) => a + b;"],
  ["tests/math.test.ts", "import { add } from '../src/math';"],
];

/** Encodes a path → text map into the raw-bytes contract readRepoFiles returns. */
function encodeTree(entries: readonly (readonly [string, string])[]): Map<string, Uint8Array> {
  return new Map(entries.map(([path, content]) => [path, new TextEncoder().encode(content)]));
}

const FULL_TREE = encodeTree(FULL_TREE_TEXT);

/**
 * A stand-in for the repo read. Hands back raw bytes because that is the
 * contract `readRepoFiles` actually has — a test that fed strings here would
 * pass while the real evaluator corrupted every binary file in the tree.
 */
function makeReadFiles(files: Map<string, Uint8Array> = FULL_TREE) {
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
    // Every file here is valid UTF-8 text, so it round-trips through the
    // sandbox write boundary as the original decoded string, not base64.
    for (const [path, content] of FULL_TREE_TEXT) {
      expect(instance.writeFile).toHaveBeenCalledWith(path, content);
    }
  });

  it("waits for every file write to settle before destroying the sandbox", async () => {
    // The failure this pins: Promise.all rejects on the first failure while its
    // siblings are still in flight, so the `finally` could destroy the sandbox
    // mid-write. Here one write rejects immediately and a sibling resolves
    // slowly; destroy must not run until the slow one has finished.
    const { binding, instance } = makeMockSandbox({ exitCode: 0 });
    let slowWriteFinished = false;
    let destroyedBeforeSlowWriteFinished = false;

    (instance.writeFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (path === "src/math.ts") throw new Error("disk full");
      await new Promise((resolve) => setTimeout(resolve, 20));
      slowWriteFinished = true;
    });
    (instance.destroy as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (!slowWriteFinished) destroyedBeforeSlowWriteFinished = true;
    });

    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles());
    const result = await evaluator.evaluate("ignored diff", makePolicy(), mockLogger);

    expect(destroyedBeforeSlowWriteFinished).toBe(false);
    expect(slowWriteFinished).toBe(true);
    // The write failure still surfaces — settling the batch must not swallow it.
    expect(result.success).toBe(false);
  });

  it("base64-encodes a binary blob and decodes it in-sandbox before install/test run", async () => {
    // 00 80 C0 AF FF is not valid UTF-8 (a stray continuation byte, an
    // overlong encoding, and a byte that's never valid) — a plain TextDecoder
    // would silently replace it with U+FFFD and the original bytes would be
    // gone by the time the sandbox saw them.
    const binaryBytes = new Uint8Array([0x00, 0x80, 0xc0, 0xaf, 0xff]);
    const tree = new Map(FULL_TREE);
    tree.set("assets/logo.png", binaryBytes);
    const { binding, instance, runCalls } = makeMockSandbox({ exitCode: 0 });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles(tree));

    const result = await evaluator.evaluate("", makePolicy(), mockLogger);

    expect(result.success).toBe(true);
    // The sandbox transport only carries strings through writeFile: the binary
    // file must have gone through as base64, not raw/UTF-8-decoded bytes.
    const writeCalls = (instance.writeFile as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      string,
    ][];
    const logoCall = writeCalls.find(([path]) => path === "assets/logo.png");
    expect(logoCall?.[1]).toBe(btoa(String.fromCharCode(...binaryBytes)));
    // A manifest + decode script must have been staged, and the decode command
    // run before the install/test commands.
    expect(writeCalls.some(([path]) => path === ".stratum-binary-manifest.txt")).toBe(true);
    expect(writeCalls.some(([path]) => path === ".stratum-binary-decode.cjs")).toBe(true);
    const commands = runCalls.map((c) => c.command);
    expect(commands[0]).toBe(BINARY_DECODE_COMMAND);
    expect(commands.slice(1)).toEqual(["npm ci --no-audit --no-fund --ignore-scripts", "npm test"]);
  });

  it("never clobbers tracked files sitting at the decode helper paths (#271)", async () => {
    // The helpers are staged into the same workspace as the repo's own files
    // and the decode script deletes both of them when it finishes, so a tree
    // that genuinely tracks a file at either name would have it overwritten
    // and then unlinked — the evaluated tree would silently be missing a file
    // the merge would land. The sandbox here runs the emitted script for real,
    // so this asserts the workspace as the configured command would find it.
    const trackedManifest = "release-notes checked into the repo\n";
    const trackedScript = "module.exports = { theRepoOwnsThisFile: true };\n";
    const binaryBytes = new Uint8Array([0x00, 0x80, 0xc0, 0xaf, 0xff]);
    const tree = new Map(FULL_TREE);
    tree.set(".stratum-binary-manifest.txt", new TextEncoder().encode(trackedManifest));
    tree.set(".stratum-binary-decode.cjs", new TextEncoder().encode(trackedScript));
    tree.set("assets/logo.png", binaryBytes);
    const sandbox = makeExecutingSandbox();
    const binding: SandboxBinding = { create: vi.fn().mockResolvedValue(sandbox.instance) };

    const result = await new SandboxEvaluator(binding, repo, makeReadFiles(tree)).evaluate(
      "",
      makePolicy(),
      mockLogger,
    );

    expect(result.success).toBe(true);
    // Both tracked files survive, byte for byte.
    expect(sandbox.files.get(".stratum-binary-manifest.txt")).toBe(trackedManifest);
    expect(sandbox.files.get(".stratum-binary-decode.cjs")).toBe(trackedScript);
    // The binary still decoded — moving the helpers aside must not cost that.
    expect(Uint8Array.from(sandbox.files.get("assets/logo.png") as Uint8Array)).toEqual(
      binaryBytes,
    );
    // Staged under discriminated names, and cleaned up after themselves.
    expect(sandbox.commands[0]).toBe("node .stratum-binary-decode-1.cjs");
    expect(sandbox.files.has(".stratum-binary-manifest-1.txt")).toBe(false);
    expect(sandbox.files.has(".stratum-binary-decode-1.cjs")).toBe(false);
  });

  it("does not stage a decode manifest/script when the tree has no binary files", async () => {
    const { binding, instance, runCalls } = makeMockSandbox({ exitCode: 0 });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles());

    await evaluator.evaluate("", makePolicy(), mockLogger);

    const writeCalls = (instance.writeFile as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      string,
    ][];
    expect(writeCalls.some(([path]) => path === ".stratum-binary-manifest.txt")).toBe(false);
    expect(runCalls.map((c) => c.command)).not.toContain(BINARY_DECODE_COMMAND);
  });

  it("fails (err) when the in-sandbox binary decode step exits non-zero", async () => {
    const binaryBytes = new Uint8Array([0x00, 0x80, 0xc0, 0xaf, 0xff]);
    const tree = new Map(FULL_TREE);
    tree.set("assets/logo.png", binaryBytes);
    const { binding, runCalls } = makeMockSandbox({
      exitCode: 0,
      runResults: {
        [BINARY_DECODE_COMMAND]: { exitCode: 1, stderr: "ENOENT: no such file" },
      },
    });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles(tree));

    const result = await evaluator.evaluate("", makePolicy(), mockLogger);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("Failed to decode");
      expect(result.error.message).toContain("ENOENT");
    }
    // The decode step failing must stop the run before install/test.
    expect(runCalls.map((c) => c.command)).toEqual([BINARY_DECODE_COMMAND]);
  });

  it("requires `ref` at the type level — a SandboxRepoAccess cannot be built unpinned (#252)", () => {
    // This is a compile-time guarantee, not a runtime assertion: `ref` on
    // SandboxRepoAccess is a required `string`, so the object literal below
    // is a type error and the whole file fails `tsc` if it ever stops being
    // one. That makes the fail-closed pinned-commit read structural rather
    // than resting on every construction site remembering to pass a ref.
    // @ts-expect-error — ref is required; omitting it must not compile.
    const unpinned: SandboxRepoAccess = { remote: repo.remote, token: repo.token };
    expect(unpinned.remote).toBe(repo.remote);
  });

  it("an unreadable blob under the pinned ref produces an error verdict, never a pass (#252)", async () => {
    // Wires the evaluator to the REAL readTreeAtCommit — the fail-closed path
    // `SandboxRepoAccess.ref` being required now guarantees is the only one
    // reachable — against a tree with one dangling blob oid. The regression
    // this guards: a partial tree must never be handed to the sandbox as if
    // it were complete, because that could let a broken/incomplete checkout
    // score a false pass in a merge gate.
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    const dir = "/";
    await git.init({ fs, dir, defaultBranch: "main" });
    const goodBlob = await git.writeBlob({
      fs,
      dir,
      blob: new TextEncoder().encode("still readable"),
    });
    const treeOid = await git.writeTree({
      fs,
      dir,
      tree: [
        { mode: "100644", path: "good.txt", oid: goodBlob, type: "blob" },
        // A dangling oid: listed in the tree but the object does not exist —
        // simulates the unreadable-blob case the fail-closed path must catch.
        {
          mode: "100644",
          path: "missing.txt",
          oid: "0123456789abcdef0123456789abcdef01234567",
          type: "blob",
        },
      ],
    });
    const author = { name: "Test", email: "test@example.com", timestamp: 0, timezoneOffset: 0 };
    const commitSha = await git.writeCommit({
      fs,
      dir,
      commit: { tree: treeOid, parent: [], author, committer: author, message: "broken tree" },
    });

    const pinnedRepo: SandboxRepoAccess = {
      remote: repo.remote,
      token: repo.token,
      ref: commitSha,
    };
    // Bypasses the network clone: reads straight from the local repo built
    // above at the pinned commit, exactly as `readRepoFiles` would once
    // cloned. Exercises the real fail-closed logic, not a mock of it.
    const pinnedReader: RepoFilesReader = (_remote, _token, logger, ref) =>
      readTreeAtCommit(fs, dir, ref, logger);
    const { binding } = makeMockSandbox({ exitCode: 0 });
    const evaluator = new SandboxEvaluator(binding, pinnedRepo, pinnedReader);

    const result = await evaluator.evaluate("ignored diff", makePolicy(), mockLogger);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain("Could not read workspace tree");
    expect(result.error.message).toContain("missing.txt");
    // No verdict was fabricated from the partial tree: no sandbox ever ran.
    expect(binding.create).not.toHaveBeenCalled();
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

    expect(runCalls.map((c) => c.command)).toEqual([
      "npm ci --no-audit --no-fund --ignore-scripts",
      "npm test",
    ]);
  });

  it("runs `npm install` when package.json exists without a lockfile", async () => {
    const tree = new Map(FULL_TREE);
    tree.delete("package-lock.json");
    const { binding, runCalls } = makeMockSandbox({ exitCode: 0 });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles(tree));

    await evaluator.evaluate("", makePolicy(), mockLogger);

    expect(runCalls.map((c) => c.command)).toEqual([
      "npm install --no-audit --no-fund --ignore-scripts",
      "npm test",
    ]);
  });

  it("skips the install step entirely when there is no package.json", async () => {
    const tree = encodeTree([["main.py", "print('hi')"]]);
    const { binding, runCalls } = makeMockSandbox({ exitCode: 0 });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles(tree));

    await evaluator.evaluate("", makePolicy(), mockLogger);

    expect(runCalls.map((c) => c.command)).toEqual(["npm test"]);
  });

  it("uses the install timeout default for install and timeoutMs for the command", async () => {
    const { binding, runCalls } = makeMockSandbox({ exitCode: 0 });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles());
    const policy = makePolicy({
      evaluators: [{ type: "sandbox", command: "npm test", timeoutMs: 30_000 }],
    });

    await evaluator.evaluate("", policy, mockLogger);

    expect(runCalls[0]).toEqual({
      command: "npm ci --no-audit --no-fund --ignore-scripts",
      opts: { timeout: DEFAULT_INSTALL_TIMEOUT_MS },
    });
    expect(runCalls[1]).toEqual({ command: "npm test", opts: { timeout: 30_000 } });
  });

  it("clamps a configured installTimeoutMs down to what the budget has left", async () => {
    // This policy is built directly rather than loaded, which is exactly the
    // case load-time clamping cannot cover: `evaluate` is reachable from a KV
    // policy cache and from callers that never went through `policy-loader`,
    // so the evaluator has to bound the grant itself.
    const { binding, runCalls } = makeMockSandbox({ exitCode: 0 });
    // Frozen clock: the grant is then exactly the budget, with no wall-clock
    // drift between starting the budget and reaching the install.
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles(), () => 1_000);
    const policy = makePolicy({
      evaluators: [{ type: "sandbox", installTimeoutMs: 300_000 }],
    });

    await evaluator.evaluate("", policy, mockLogger);

    expect(runCalls[0]?.opts).toEqual({ timeout: DEFAULT_TOTAL_BUDGET_MS });
  });

  it("install failure → score 0, failed, reason names the install command, test never runs", async () => {
    const { binding, runCalls } = makeMockSandbox({
      exitCode: 0,
      runResults: {
        "npm ci --no-audit --no-fund --ignore-scripts": {
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
        "Dependency install (npm ci --no-audit --no-fund --ignore-scripts) failed",
      );
      expect(result.data.reason).toContain("ERESOLVE");
      expect(result.data.costs?.[0]?.kind).toBe("sandbox_ms");
    }
    expect(runCalls.map((c) => c.command)).toEqual([
      "npm ci --no-audit --no-fund --ignore-scripts",
    ]);
  });
});

describe("installCommandFor", () => {
  it("maps manifest/lockfile presence to the right command", () => {
    expect(installCommandFor(new Map())).toBeNull();
    expect(installCommandFor(encodeTree([["package.json", "{}"]]))).toBe(
      "npm install --no-audit --no-fund --ignore-scripts",
    );
    expect(
      installCommandFor(
        encodeTree([
          ["package.json", "{}"],
          ["package-lock.json", "{}"],
        ]),
      ),
    ).toBe("npm ci --no-audit --no-fund --ignore-scripts");
    expect(installCommandFor(encodeTree([["package-lock.json", "{}"]]))).toBeNull();
  });

  it("treats npm-shrinkwrap.json as a lockfile", () => {
    // `npm ci` accepts either lockfile name. A shrinkwrap-only project is just
    // as pinned as a package-lock one, so it must not fall back to the
    // unpinned `npm install`.
    expect(
      installCommandFor(
        encodeTree([
          ["package.json", "{}"],
          ["npm-shrinkwrap.json", "{}"],
        ]),
      ),
    ).toBe("npm ci --no-audit --no-fund --ignore-scripts");
    // Both present is still a frozen install (npm prefers the shrinkwrap).
    expect(
      installCommandFor(
        encodeTree([
          ["package.json", "{}"],
          ["npm-shrinkwrap.json", "{}"],
          ["package-lock.json", "{}"],
        ]),
      ),
    ).toBe("npm ci --no-audit --no-fund --ignore-scripts");
    // A lockfile alone is still not an npm project.
    expect(installCommandFor(encodeTree([["npm-shrinkwrap.json", "{}"]]))).toBeNull();
  });
});

describe("encodeForSandboxWrite", () => {
  it("round-trips UTF-8 text byte-for-byte, byte-order mark included", () => {
    // A UTF-8 BOM is three real bytes of the blob. `TextDecoder`'s default
    // `ignoreBOM: false` swallows them, so a Windows-authored source file
    // would reach the sandbox three bytes shorter than it is in the repo --
    // silently, since the decode still succeeds and the text path is taken.
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("hi\n")]);
    const encoded = encodeForSandboxWrite(withBom);
    expect(encoded.binary).toBe(false);
    expect(new TextEncoder().encode(encoded.content)).toEqual(withBom);
  });

  it("takes the base64 path for bytes that are not valid UTF-8", () => {
    // A lone 0xff can never appear in well-formed UTF-8, so the strict
    // decoder must reject it rather than substitute U+FFFD.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
    const encoded = encodeForSandboxWrite(bytes);
    expect(encoded.binary).toBe(true);
    expect(Uint8Array.from(atob(encoded.content), (c) => c.charCodeAt(0))).toEqual(bytes);
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
  const treeWithoutManifest = encodeTree([["src/app.ts", "export {};"]]);

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
      runResults: {
        "npm ci --no-audit --no-fund --ignore-scripts": { exitCode: 1, stderr: "boom" },
      },
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
  const project: ProjectEntry = {
    id: "proj_sandbox",
    name: "proj",
    slug: "proj",
    namespace: "@alice",
    ownerId: "user_alice",
    ownerType: "user",
    remote: "https://artifacts.example.com/repos/proj",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  function findSandbox(evaluators: Awaited<ReturnType<typeof buildEvaluators>>) {
    const entry = evaluators.find((e) => e.type === "sandbox");
    expect(entry).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    return entry!.evaluator;
  }

  it("no SANDBOX binding → fails closed with an actionable wrangler.toml reason", async () => {
    const evaluators = await buildEvaluators({} as Env, sandboxPolicy, project, mockLogger, repo);
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
    const evaluators = await buildEvaluators(
      { SANDBOX: binding } as Env,
      sandboxPolicy,
      project,
      mockLogger,
    );
    const result = await findSandbox(evaluators).evaluate("", sandboxPolicy, mockLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.passed).toBe(false);
    expect(result.data.reason).toContain("workspace repository access was not provided");
    expect(binding.create).not.toHaveBeenCalled();
  });

  it("SANDBOX binding + workspace repo access → a real SandboxEvaluator", async () => {
    const { binding } = makeMockSandbox({ exitCode: 0 });
    const evaluators = await buildEvaluators(
      { SANDBOX: binding } as Env,
      sandboxPolicy,
      project,
      mockLogger,
      repo,
    );
    expect(findSandbox(evaluators)).toBeInstanceOf(SandboxEvaluator);
  });
});

describe("sandbox limits", () => {
  it("keeps the per-phase defaults summing inside the total budget", () => {
    // The point of lowering the install default: an unconfigured project must
    // be able to spend its full install AND its full test timeout without the
    // budget truncating either. If a future bump breaks this, truncation
    // silently becomes the norm rather than the exception.
    expect(DEFAULT_INSTALL_TIMEOUT_MS + DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(
      DEFAULT_TOTAL_BUDGET_MS,
    );
  });

  it("keeps the phase ceiling below the total ceiling", () => {
    // Otherwise a policy could grant one phase the entire evaluation's budget.
    expect(MAX_PHASE_TIMEOUT_MS).toBeLessThan(MAX_TOTAL_BUDGET_MS);
  });

  it("keeps the default budget within the configurable ceiling", () => {
    expect(DEFAULT_TOTAL_BUDGET_MS).toBeLessThanOrEqual(MAX_TOTAL_BUDGET_MS);
  });
});

describe("startBudget", () => {
  /** A clock the test advances by hand, so exhaustion needs no real waiting. */
  function fakeClock(start = 0) {
    let current = start;
    return {
      now: () => current,
      advance: (ms: number) => {
        current += ms;
      },
    };
  }

  it("counts down as the clock advances and never reports negative", () => {
    const clock = fakeClock();
    const budget = startBudget(1_000, clock.now);

    expect(budget.remaining()).toBe(1_000);
    clock.advance(400);
    expect(budget.remaining()).toBe(600);
    clock.advance(5_000);
    expect(budget.remaining()).toBe(0);
    expect(budget.expired()).toBe(true);
  });

  it("grants the smaller of the request and what is left", () => {
    const clock = fakeClock();
    const budget = startBudget(1_000, clock.now);

    expect(budget.allow(500)).toBe(500);
    clock.advance(800);
    expect(budget.allow(500)).toBe(200);
  });

  it("never grants a timeout of zero once exhausted", () => {
    // `sandbox.run`'s reading of `timeout: 0` is undocumented and "no timeout"
    // is a plausible one — the exact opposite of an exhausted budget. Callers
    // check `expired()` first, but this floor is what makes that safe to get
    // wrong.
    const clock = fakeClock();
    const budget = startBudget(1_000, clock.now);
    clock.advance(2_000);

    expect(budget.allow(5_000)).toBeGreaterThan(0);
  });

  it("reports the total it started with", () => {
    expect(startBudget(1_234, () => 0).totalMs).toBe(1_234);
  });

  it("falls back to the default for a non-finite total", () => {
    // `Math.max(0, NaN)` is NaN, so a NaN total would make `expired()` always
    // false and hand `timeout: NaN` to the sandbox — undefined behaviour on the
    // one code path this whole mechanism exists to bound. `startBudget` is
    // exported, so the guard has to live here, not only at the call sites.
    for (const bogus of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const budget = startBudget(bogus, () => 0);
      expect(budget.totalMs).toBe(DEFAULT_TOTAL_BUDGET_MS);
      expect(budget.remaining()).toBe(DEFAULT_TOTAL_BUDGET_MS);
      expect(budget.expired()).toBe(false);
      expect(budget.allow(1_000)).toBe(1_000);
    }
  });

  it("treats a zero or negative total as immediately exhausted", () => {
    expect(startBudget(0, () => 0).expired()).toBe(true);
    expect(startBudget(-1, () => 0).expired()).toBe(true);
    // Even exhausted, a grant is never 0 — see the floor test above.
    expect(startBudget(0, () => 0).allow(60_000)).toBeGreaterThan(0);
  });
});

describe("SandboxEvaluator — total budget", () => {
  /**
   * A clock that holds `held` until `trigger()` is called, then jumps to
   * `after`.
   *
   * Scripted rather than free-running because `evaluate` reads the clock many
   * times per phase — every `expired()` check is itself a read — so a clock
   * that advanced on each read would drain the budget at a phase nobody chose,
   * and a test could assert the right reason while exercising the wrong path.
   */
  function scriptedClock(held: number, after: number) {
    let fired = false;
    return {
      now: () => (fired ? after : held),
      trigger: () => {
        fired = true;
      },
    };
  }

  it("returns a verdict, not an error, when the budget is gone by the end of the tree read", async () => {
    const { binding, runCalls } = makeMockSandbox({ exitCode: 0 });
    const clock = scriptedClock(0, DEFAULT_TOTAL_BUDGET_MS + 1);
    const readFiles = vi.fn().mockImplementation(async () => {
      // The read is what consumed the budget, so the gate right after it is the
      // first to see an empty budget.
      clock.trigger();
      return ok(FULL_TREE);
    });
    const evaluator = new SandboxEvaluator(binding, repo, readFiles, clock.now);

    const result = await evaluator.evaluate("", makePolicy(), mockLogger);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.score).toBe(0);
      expect(result.data.reason).toContain("sandbox budget exceeded (tree-read)");
      // No sandbox was created, so there is no sandbox time to report — and
      // clone time is `git_ops`, never `sandbox_ms`.
      expect(result.data.costs).toBeUndefined();
    }
    // Nothing ran, and the sandbox was never even created.
    expect(runCalls).toEqual([]);
    expect(binding.create).not.toHaveBeenCalled();
  });

  it("stops before the scored command once install has drained the budget", async () => {
    const { binding, runCalls, instance } = makeMockSandbox({ exitCode: 0 });
    const clock = scriptedClock(0, DEFAULT_TOTAL_BUDGET_MS + 1);
    // Burn the budget during the install, so the gate before the scored command
    // is the one that trips — the install itself must have run.
    (instance.run as ReturnType<typeof vi.fn>).mockImplementation(async (command: string) => {
      runCalls.push({ command });
      if (command.startsWith("npm ci")) clock.trigger();
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles(), clock.now);

    const result = await evaluator.evaluate("", makePolicy(), mockLogger);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.reason).toContain("sandbox budget exceeded (command)");
      expect(result.data.costs?.[0]?.kind).toBe("sandbox_ms");
    }
    // The install ran; the scored command did not.
    expect(runCalls.map((c) => c.command)).toEqual([
      "npm ci --no-audit --no-fund --ignore-scripts",
    ]);
  });

  it("classifies a budget-shortened phase that throws as a verdict, via the catch", async () => {
    // The grant here is capped by the budget rather than by the project's own
    // timeout, so the timeout that fires is the budget's — a verdict, and it has
    // to be reached through the catch block, not a phase gate.
    const { binding, instance, runCalls } = makeMockSandbox({ exitCode: 0 });
    // Jumps to exactly the grant: a timeout fires when the grant is spent, not
    // a millisecond before it.
    const clock = scriptedClock(0, DEFAULT_TOTAL_BUDGET_MS);
    (instance.run as ReturnType<typeof vi.fn>).mockImplementation(
      async (command: string, opts?: { timeout?: number }) => {
        runCalls.push({ command, opts });
        clock.trigger();
        throw new Error("Timeout");
      },
    );
    const policy = makePolicy({
      // Larger than the budget, so `allow()` must cap it.
      evaluators: [{ type: "sandbox", installTimeoutMs: 300_000 }],
    });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles(), clock.now);

    const result = await evaluator.evaluate("", policy, mockLogger);

    expect(runCalls[0]?.opts?.timeout).toBe(DEFAULT_TOTAL_BUDGET_MS);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.reason).toContain("sandbox budget exceeded (install)");
      // The time the throwing phase burned is still charged.
      expect(result.data.costs?.[0]?.quantity).toBe(DEFAULT_TOTAL_BUDGET_MS);
    }
  });

  it("keeps err for a phase that hits the project's own timeout, not the budget", async () => {
    // The grant was the configured value, so this is the project's timeout
    // firing, not the budget's. Relabelling it would silently change what every
    // pre-existing sandbox timeout reports.
    const { binding } = makeMockSandbox({ runThrows: true });
    const clock = scriptedClock(0, 30_000);
    const policy = makePolicy({ evaluators: [{ type: "sandbox", installTimeoutMs: 10_000 }] });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles(), clock.now);

    const result = await evaluator.evaluate("", policy, mockLogger);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("Timeout");
    }
  });

  it("keeps err for a transient failure part-way through a budget-shortened phase", async () => {
    // The grant is capped by the budget, but the throw arrives long before the
    // grant is spent — a Sandbox API blip, not a timeout. Reporting it as a
    // verdict would turn a retryable infrastructure error into a definitive
    // judgement that fails the merge gate.
    const { binding, instance, runCalls } = makeMockSandbox({ exitCode: 0 });
    let elapsed = 0;
    const clock = () => elapsed;
    (instance.run as ReturnType<typeof vi.fn>).mockImplementation(
      async (command: string, opts?: { timeout?: number }) => {
        runCalls.push({ command, opts });
        // Fails 200ms into a grant far larger than that.
        elapsed += 200;
        throw new Error("Sandbox API unavailable");
      },
    );
    const policy = makePolicy({
      evaluators: [{ type: "sandbox", installTimeoutMs: 300_000 }],
    });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles(), clock);

    const result = await evaluator.evaluate("", policy, mockLogger);

    // The grant really was budget-capped, so only the elapsed-time check
    // separates this from the timeout case.
    expect(runCalls[0]?.opts?.timeout).toBe(DEFAULT_TOTAL_BUDGET_MS);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("Sandbox API unavailable");
    }
  });

  it("still returns err for a throw with budget left, so infra failure is not a verdict", async () => {
    // A sandbox that broke for its own reasons must not be scored as if the
    // change were too slow.
    const { binding } = makeMockSandbox({ runThrows: true });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles(), () => 0);

    const result = await evaluator.evaluate("", makePolicy(), mockLogger);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("Timeout");
    }
  });

  it("clamps a bogus totalBudgetMs that never went through the policy loader", async () => {
    // `evaluate` is reachable from a KV policy cache and from callers that never
    // loaded a file, so a cached `totalBudgetMs: 0` must not make every change
    // on the project fail before a sandbox is created.
    const { binding, runCalls } = makeMockSandbox({ exitCode: 0 });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles(), () => 0);
    const policy = makePolicy({ evaluators: [{ type: "sandbox", totalBudgetMs: 0 }] });

    const result = await evaluator.evaluate("", policy, mockLogger);

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.passed).toBe(true);
    expect(runCalls.map((c) => c.command)).toContain("npm test");
  });

  it("honors a policy-supplied totalBudgetMs", async () => {
    const { binding, runCalls } = makeMockSandbox({ exitCode: 0 });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles(), () => 1_000);
    const policy = makePolicy({
      evaluators: [{ type: "sandbox", totalBudgetMs: 20_000, installTimeoutMs: 90_000 }],
    });

    await evaluator.evaluate("", policy, mockLogger);

    expect(runCalls[0]?.opts).toEqual({ timeout: 20_000 });
  });

  it("does not let a rejecting destroy() replace the verdict", async () => {
    // An `await` that rejects inside `finally` overrides the return value and
    // propagates — which would reject the `Promise.all` in `runEvaluation` and
    // discard every other evaluator's result.
    const { binding, instance } = makeMockSandbox({ exitCode: 0 });
    instance.destroy = vi.fn().mockRejectedValue(new Error("sandbox stuck"));
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles());

    const result = await evaluator.evaluate("", makePolicy(), mockLogger);

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.passed).toBe(true);
  });

  it("names the phase in a stable, greppable reason", () => {
    expect(budgetExceededReason("install", 150_000)).toContain("sandbox budget exceeded (install)");
    expect(budgetExceededReason("install", 150_000)).toContain("150000ms");
  });
});

describe("installCommandFor — lifecycle script policy", () => {
  const npmProject = encodeTree([
    ["package.json", "{}"],
    ["package-lock.json", "{}"],
  ]);
  const noLockfile = encodeTree([["package.json", "{}"]]);

  it("ignores lifecycle scripts by default", () => {
    // The tree is authored by whoever can push; a postinstall must not run
    // before anyone has reviewed the change.
    expect(installCommandFor(npmProject)).toBe("npm ci --no-audit --no-fund --ignore-scripts");
    expect(installCommandFor(noLockfile)).toBe("npm install --no-audit --no-fund --ignore-scripts");
  });

  it("ignores lifecycle scripts when the flag is explicitly false", () => {
    expect(installCommandFor(npmProject, { allowInstallScripts: false })).toBe(
      "npm ci --no-audit --no-fund --ignore-scripts",
    );
  });

  it("ignores lifecycle scripts when opts is present but the flag is absent", () => {
    // Safe by omission: forgetting the field must not silently opt in.
    expect(installCommandFor(npmProject, {})).toBe("npm ci --no-audit --no-fund --ignore-scripts");
  });

  it("runs lifecycle scripts only on an explicit opt-in", () => {
    expect(installCommandFor(npmProject, { allowInstallScripts: true })).toBe(
      "npm ci --no-audit --no-fund",
    );
    expect(installCommandFor(noLockfile, { allowInstallScripts: true })).toBe(
      "npm install --no-audit --no-fund",
    );
  });

  it("still returns null for a non-npm tree regardless of the flag", () => {
    expect(installCommandFor(new Map(), { allowInstallScripts: true })).toBeNull();
  });

  it("threads allowInstallScripts from policy through evaluate()", async () => {
    const { binding, runCalls } = makeMockSandbox({ exitCode: 0 });
    const evaluator = new SandboxEvaluator(binding, repo, makeReadFiles());
    const policy = makePolicy({
      evaluators: [{ type: "sandbox", allowInstallScripts: true }],
    });

    await evaluator.evaluate("", policy, mockLogger);

    expect(runCalls.map((c) => c.command)).toEqual(["npm ci --no-audit --no-fund", "npm test"]);
  });
});
