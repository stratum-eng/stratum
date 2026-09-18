import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalPolicy } from "../src/evaluation/types";
import { runPostMergeCheck } from "../src/merge/post-merge";
import { emitEvent } from "../src/queue/events";
import { updateChangeStatus } from "../src/storage/changes";
import { getCommitParent, readRepoFiles, revertToCommit } from "../src/storage/git-ops";
import type { Env, ProjectEntry, SandboxInstance } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeExecutingSandbox } from "./helpers/fake-sandbox";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

vi.mock("../src/storage/git-ops", () => ({
  readRepoFiles: vi.fn(),
  getCommitParent: vi.fn(),
  revertToCommit: vi.fn(),
  freshRepoToken: vi.fn(async (_artifacts: unknown, _remote: string, _scope: string) => ({
    success: true,
    data: "minted-token",
  })),
}));

vi.mock("../src/storage/changes", () => ({
  updateChangeStatus: vi.fn().mockResolvedValue({ success: true, data: undefined }),
  markChangeMerged: vi.fn().mockResolvedValue({ success: true, data: { transitioned: true } }),
  mergeTransitionOpts: (
    change: { evalScore?: number; evalPassed?: boolean; evalReason?: string },
    mergedAt: string,
  ) => ({
    ...(change?.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
    ...(change?.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
    ...(change?.evalReason !== undefined ? { evalReason: change.evalReason } : {}),
    mergedAt,
  }),
}));

vi.mock("../src/queue/events", () => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
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

const project = {
  id: "proj_1",
  name: "my-project",
  slug: "my-project",
  namespace: "@user",
  ownerId: "user_1",
  ownerType: "user",
  remote: "https://example.com/repo.git",
  token: "tok",
  createdAt: "2026-01-01T00:00:00.000Z",
} as ProjectEntry;

function makeSandboxEnv(runResult: { exitCode: number; stdout: string; stderr: string }): {
  env: Env;
  run: ReturnType<typeof vi.fn>;
  destroyed: { value: boolean };
} {
  const destroyed = { value: false };
  const run = vi.fn().mockResolvedValue(runResult);
  const sandbox: SandboxInstance = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    run,
    destroy: vi.fn().mockImplementation(async () => {
      destroyed.value = true;
    }),
  };
  const env = {
    DB: {} as D1Database,
    SANDBOX: { create: vi.fn().mockResolvedValue(sandbox) },
  } as unknown as Env;
  return { env, run, destroyed };
}

const policyWith = (merge: EvalPolicy["merge"]): EvalPolicy => ({ evaluators: [], merge });

describe("runPostMergeCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readRepoFiles).mockResolvedValue({
      success: true,
      data: new Map([["src/index.ts", new TextEncoder().encode("export {};")]]),
    });
    vi.mocked(getCommitParent).mockResolvedValue({ success: true, data: "sha_premerge" });
    vi.mocked(revertToCommit).mockResolvedValue({ success: true, data: "sha_revert" });
    vi.mocked(updateChangeStatus).mockResolvedValue({ success: true, data: undefined });
    vi.mocked(emitEvent).mockResolvedValue(undefined);
  });

  it("skips when no post-merge command is configured", async () => {
    const { env } = makeSandboxEnv({ exitCode: 0, stdout: "", stderr: "" });
    const result = await runPostMergeCheck(
      env,
      project,
      { changeId: "chg_1", mergeCommit: "sha_merge", policy: policyWith(undefined) },
      mockLogger,
    );
    expect(result.status).toBe("skipped");
  });

  it("skips when the sandbox binding is absent", async () => {
    const env = { DB: {} as D1Database } as unknown as Env;
    const result = await runPostMergeCheck(
      env,
      project,
      {
        changeId: "chg_1",
        mergeCommit: "sha_merge",
        policy: policyWith({ postMergeCommand: "npm test" }),
      },
      mockLogger,
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("Sandbox");
  });

  it("passes when the command exits 0 and destroys the sandbox", async () => {
    const { env, run, destroyed } = makeSandboxEnv({ exitCode: 0, stdout: "ok", stderr: "" });
    const result = await runPostMergeCheck(
      env,
      project,
      {
        changeId: "chg_1",
        mergeCommit: "sha_merge",
        policy: policyWith({ postMergeCommand: "npm test" }),
      },
      mockLogger,
    );
    expect(result.status).toBe("passed");
    expect(run).toHaveBeenCalledWith("npm test", { timeout: 60_000 });
    expect(destroyed.value).toBe(true);
    expect(revertToCommit).not.toHaveBeenCalled();
  });

  it("reverts the merge, marks the change reverted, and emits an event on failure", async () => {
    const { env } = makeSandboxEnv({ exitCode: 1, stdout: "2 failed", stderr: "" });
    const result = await runPostMergeCheck(
      env,
      project,
      {
        changeId: "chg_1",
        mergeCommit: "sha_merge",
        policy: policyWith({ postMergeCommand: "npm test" }),
      },
      mockLogger,
    );

    expect(result.status).toBe("reverted");
    expect(result.revertCommit).toBe("sha_revert");
    expect(getCommitParent).toHaveBeenCalledWith(
      project.remote,
      "minted-token",
      "sha_merge",
      mockLogger,
      "main",
    );
    expect(revertToCommit).toHaveBeenCalledWith(
      project.remote,
      "minted-token",
      "sha_premerge",
      expect.stringContaining("Revert merge"),
      mockLogger,
      "main",
    );
    expect(updateChangeStatus).toHaveBeenCalledWith(
      env.DB,
      mockLogger,
      "chg_1",
      "reverted",
      expect.objectContaining({ evalReason: expect.stringContaining("reverted") }),
    );
    expect(emitEvent).toHaveBeenCalledWith(
      env.DB,
      null,
      expect.objectContaining({ type: "change.reverted", revertCommit: "sha_revert" }),
      { type: "system" },
      mockLogger,
      project.id,
    );
  });

  it("reports failed without reverting when autoRevert is disabled", async () => {
    const { env } = makeSandboxEnv({ exitCode: 1, stdout: "boom", stderr: "" });
    const result = await runPostMergeCheck(
      env,
      project,
      {
        changeId: "chg_1",
        mergeCommit: "sha_merge",
        policy: policyWith({ postMergeCommand: "npm test", autoRevert: false }),
      },
      mockLogger,
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("boom");
    expect(revertToCommit).not.toHaveBeenCalled();
  });

  it("reports failed with combined reason when the revert itself fails", async () => {
    const { env } = makeSandboxEnv({ exitCode: 1, stdout: "tests failed", stderr: "" });
    vi.mocked(revertToCommit).mockResolvedValue({
      success: false,
      error: new Error("push rejected") as never,
    });
    const result = await runPostMergeCheck(
      env,
      project,
      {
        changeId: "chg_1",
        mergeCommit: "sha_merge",
        policy: policyWith({ postMergeCommand: "npm test" }),
      },
      mockLogger,
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("tests failed");
    expect(result.reason).toContain("push rejected");
  });

  it("base64-encodes a binary file and runs an in-sandbox decode step before the command", async () => {
    // 00 80 C0 AF FF is not valid UTF-8 — decoding it with a plain TextDecoder
    // would silently corrupt it (U+FFFD replacement), so it must round-trip
    // through the sandbox's writeFile (string-only) as base64 instead.
    const binaryBytes = new Uint8Array([0x00, 0x80, 0xc0, 0xaf, 0xff]);
    vi.mocked(readRepoFiles).mockResolvedValue({
      success: true,
      data: new Map([["assets/logo.png", binaryBytes]]),
    });
    const { env, run } = makeSandboxEnv({ exitCode: 0, stdout: "ok", stderr: "" });
    const sandbox = await (env.SANDBOX as { create: () => Promise<SandboxInstance> }).create();

    const result = await runPostMergeCheck(
      env,
      project,
      {
        changeId: "chg_1",
        mergeCommit: "sha_merge",
        policy: policyWith({ postMergeCommand: "npm test" }),
      },
      mockLogger,
    );

    expect(result.status).toBe("passed");
    // writeFile only ever carries strings; the raw bytes must have been
    // base64-encoded rather than passed through (or UTF-8-decoded and lost).
    const writeCalls = vi.mocked(sandbox.writeFile).mock.calls;
    const logoCall = writeCalls.find(([path]) => path === "assets/logo.png");
    expect(logoCall?.[1]).toBe(btoa(String.fromCharCode(...binaryBytes)));
    expect(logoCall?.[1]).not.toContain("�");
    // The decode step must run before the actual post-merge command.
    const commands: string[] = run.mock.calls.map(([command]) => command);
    const decodeIndex = commands.findIndex((c) => c.includes("stratum-binary-decode"));
    expect(decodeIndex).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf("npm test")).toBeGreaterThan(decodeIndex);
  });

  it("never clobbers tracked files sitting at the decode helper paths (#271)", async () => {
    // Same hazard as the evaluator path, with a sharper consequence: the
    // helpers are staged into the merged tree and deleted again by the decode
    // script, so a repo that tracks a file at either name would have the smoke
    // command run against a tree missing it — failing the check and reverting
    // a merge that was fine. The sandbox here executes the emitted script for
    // real, so the assertions describe the tree the command actually sees.
    const trackedManifest = "release-notes checked into the repo\n";
    const trackedScript = "module.exports = { theRepoOwnsThisFile: true };\n";
    const binaryBytes = new Uint8Array([0x00, 0x80, 0xc0, 0xaf, 0xff]);
    vi.mocked(readRepoFiles).mockResolvedValue({
      success: true,
      data: new Map([
        [".stratum-binary-manifest.txt", new TextEncoder().encode(trackedManifest)],
        [".stratum-binary-decode.cjs", new TextEncoder().encode(trackedScript)],
        ["assets/logo.png", binaryBytes],
      ]),
    });
    const sandbox = makeExecutingSandbox();
    const env = {
      DB: {} as D1Database,
      SANDBOX: { create: vi.fn().mockResolvedValue(sandbox.instance) },
    } as unknown as Env;

    const result = await runPostMergeCheck(
      env,
      project,
      {
        changeId: "chg_1",
        mergeCommit: "sha_merge",
        policy: policyWith({ postMergeCommand: "npm test" }),
      },
      mockLogger,
    );

    expect(result.status).toBe("passed");
    expect(sandbox.files.get(".stratum-binary-manifest.txt")).toBe(trackedManifest);
    expect(sandbox.files.get(".stratum-binary-decode.cjs")).toBe(trackedScript);
    expect(Uint8Array.from(sandbox.files.get("assets/logo.png") as Uint8Array)).toEqual(
      binaryBytes,
    );
    expect(sandbox.commands[0]).toBe("node .stratum-binary-decode-1.cjs");
    expect(sandbox.files.has(".stratum-binary-manifest-1.txt")).toBe(false);
    expect(sandbox.files.has(".stratum-binary-decode-1.cjs")).toBe(false);
  });

  it("honors a custom timeout", async () => {
    const { env, run } = makeSandboxEnv({ exitCode: 0, stdout: "", stderr: "" });
    await runPostMergeCheck(
      env,
      project,
      {
        changeId: "chg_1",
        mergeCommit: "sha_merge",
        policy: policyWith({ postMergeCommand: "make check", postMergeTimeoutMs: 120_000 }),
      },
      mockLogger,
    );
    expect(run).toHaveBeenCalledWith("make check", { timeout: 120_000 });
  });
});

describe("runPostMergeCheck cost attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readRepoFiles).mockResolvedValue({
      success: true,
      data: new Map([["src/index.ts", new TextEncoder().encode("export {};")]]),
    });
  });

  /** Real SQLite with the production migrations, so the row is really written. */
  function sandboxEnvWithDb(): { env: Env; raw: ReturnType<typeof makeSqliteD1>["raw"] } {
    const { db, raw } = makeSqliteD1();
    const sandbox: SandboxInstance = {
      writeFile: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" }),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const env = {
      DB: db,
      SANDBOX: { create: vi.fn().mockResolvedValue(sandbox) },
    } as unknown as Env;
    return { env, raw };
  }

  it("bills the sandbox run and the tree read to the project's owner", async () => {
    // This is the one metered path outside the evaluators: a post-merge command
    // is sandbox time somebody pays for.
    const { env, raw } = sandboxEnvWithDb();
    const result = await runPostMergeCheck(
      env,
      project,
      {
        changeId: "chg_1",
        mergeCommit: "sha_merge",
        policy: policyWith({ postMergeCommand: "npm test" }),
      },
      mockLogger,
    );

    expect(result.status).toBe("passed");
    const rows = raw
      .prepare(
        "SELECT kind, owner_id, owner_type, source, change_id FROM cost_records ORDER BY kind",
      )
      .all() as unknown as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.kind)).toEqual(["git_ops", "sandbox_ms"]);
    for (const row of rows) {
      expect(row.owner_id).toBe("user_1");
      expect(row.owner_type).toBe("user");
      // Sandbox time is always the operator's compute; BYOK is an LLM concept.
      expect(row.source).toBe("platform");
      expect(row.change_id).toBe("chg_1");
    }
  });

  it("records the run unattributed rather than skipping it when the owner is unnameable", async () => {
    const { env, raw } = sandboxEnvWithDb();
    const ownerless = { ...project, ownerId: "" } as ProjectEntry;
    const result = await runPostMergeCheck(
      env,
      ownerless,
      {
        changeId: "chg_1",
        mergeCommit: "sha_merge",
        policy: policyWith({ postMergeCommand: "npm test" }),
      },
      mockLogger,
    );

    expect(result.status).toBe("passed");
    const rows = raw.prepare("SELECT owner_id FROM cost_records").all() as unknown as Array<{
      owner_id: string | null;
    }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.owner_id).toBeNull();
  });
});
