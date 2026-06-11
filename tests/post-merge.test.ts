import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalPolicy } from "../src/evaluation/types";
import { runPostMergeCheck } from "../src/merge/post-merge";
import { emitEvent } from "../src/queue/events";
import { updateChangeStatus } from "../src/storage/changes";
import { getCommitParent, readRepoFiles, revertToCommit } from "../src/storage/git-ops";
import type { Env, ProjectEntry, SandboxInstance } from "../src/types";
import type { Logger } from "../src/utils/logger";

vi.mock("../src/storage/git-ops", () => ({
  readRepoFiles: vi.fn(),
  getCommitParent: vi.fn(),
  revertToCommit: vi.fn(),
}));

vi.mock("../src/storage/changes", () => ({
  updateChangeStatus: vi.fn().mockResolvedValue({ success: true, data: undefined }),
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
      data: new Map([["src/index.ts", "export {};"]]),
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
      project.token,
      "sha_merge",
      mockLogger,
    );
    expect(revertToCommit).toHaveBeenCalledWith(
      project.remote,
      project.token,
      "sha_premerge",
      expect.stringContaining("Revert merge"),
      mockLogger,
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
