/**
 * Issue #181 wiring: callers that operate on a PROJECT repo must pass the
 * project's resolved default branch (projectDefaultBranch) into the git ops,
 * instead of letting them fall back to "main".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/storage/git-ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    freshRepoToken: vi.fn(async () => ({ success: true, data: "tok" })),
    cloneRepo: vi.fn(),
    readRepoFiles: vi.fn(),
    getCommitParent: vi.fn(),
    revertToCommit: vi.fn(),
    pushMain: vi.fn(async () => ({ success: true, data: undefined })),
    readFileFromRepo: vi.fn(),
    mergeWorkspaceIntoProject: vi.fn(async () => ({ success: true, data: "deadbeef" })),
  };
});
vi.mock("../src/storage/changes", () => ({
  getChange: vi.fn(),
  updateChangeStatus: vi.fn(async () => ({ success: true, data: undefined })),
  markChangeMerged: vi.fn(async () => ({ success: true, data: { transitioned: true } })),
  mergeTransitionOpts: (_change: unknown, mergedAt: string) => ({ mergedAt }),
}));
vi.mock("../src/storage/state", () => ({
  getProject: vi.fn(),
  getWorkspace: vi.fn(),
}));
vi.mock("../src/storage/deletion", () => ({
  isTargetDeleting: vi.fn(async () => false),
}));
vi.mock("../src/storage/provenance", () => ({
  recordProvenance: vi.fn(async () => ({ success: true, data: undefined })),
}));
vi.mock("../src/storage/metrics", () => ({
  recordCommitMetrics: vi.fn(async () => ({ success: true, data: undefined })),
  commitPhasesFromSpans: (spans: Record<string, number>) => spans,
}));
vi.mock("../src/storage/costs", () => ({
  recordCosts: vi.fn(async () => ({ success: true, data: undefined })),
}));
vi.mock("../src/queue/events", () => ({
  emitEvent: vi.fn(async () => ({ success: true, data: undefined })),
}));

import git from "isomorphic-git";
import { restoreProjectRepo } from "../src/backup/repo-restore";
import { snapshotRepo } from "../src/backup/repo-snapshot";
import { loadPolicy } from "../src/evaluation/policy-loader";
import { runPostMergeCheck } from "../src/merge/post-merge";
import { MergeQueue } from "../src/queue/merge-queue";
import { getChange } from "../src/storage/changes";
import {
  cloneRepo,
  extractTreeObjects,
  getCommitParent,
  mergeWorkspaceIntoProject,
  pushMain,
  readFileFromRepo,
  readRepoFiles,
  revertToCommit,
} from "../src/storage/git-ops";
import { MemoryFS } from "../src/storage/memory-fs";
import { packObjects } from "../src/storage/object-loader";
import { writeSnapshotFromRepo } from "../src/storage/repo-snapshot";
import { getProject, getWorkspace } from "../src/storage/state";
import type { Env, ProjectEntry } from "../src/types";
import { getFileContent } from "../src/ui/file-content";
import type { Logger } from "../src/utils/logger";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => logger,
} as unknown as Logger;

const trunkProject = {
  id: "proj_1",
  name: "acme/web",
  slug: "web",
  namespace: "@acme",
  ownerId: "u1",
  ownerType: "user",
  remote: "https://acct.artifacts.cloudflare.net/git/ns/acme__web.git",
  createdAt: "2026-01-01T00:00:00Z",
  sourceDefaultBranch: "trunk",
} as ProjectEntry;

const errResult = {
  success: false as const,
  // biome-ignore lint/suspicious/noExplicitAny: minimal AppError stub
  error: { message: "nope", code: "GIT_ERROR", statusCode: 500 } as any,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pushMain).mockResolvedValue({ success: true, data: undefined });
  vi.mocked(mergeWorkspaceIntoProject).mockResolvedValue({ success: true, data: "deadbeef" });
});

describe("post-merge check passes the project's default branch", () => {
  it("readRepoFiles / getCommitParent / revertToCommit all get 'trunk'", async () => {
    vi.mocked(readRepoFiles).mockResolvedValue({ success: true, data: new Map() });
    vi.mocked(getCommitParent).mockResolvedValue({ success: true, data: "parentsha" });
    vi.mocked(revertToCommit).mockResolvedValue({ success: true, data: "revertsha" });

    const sandbox = {
      writeFile: vi.fn(),
      run: vi.fn(async () => ({ exitCode: 1, stdout: "boom", stderr: "" })),
      destroy: vi.fn(),
    };
    const env = {
      ARTIFACTS: {},
      DB: {},
      SANDBOX: { create: vi.fn(async () => sandbox) },
      EVENTS_QUEUE: null,
    } as unknown as Env;

    const result = await runPostMergeCheck(
      env,
      trunkProject,
      {
        changeId: "chg_1",
        mergeCommit: "m".repeat(40),
        policy: { evaluators: [], merge: { postMergeCommand: "run-checks" } },
      },
      logger,
    );

    expect(result.status).toBe("reverted");
    expect(vi.mocked(readRepoFiles).mock.calls[0]?.[3]).toBe("trunk");
    expect(vi.mocked(getCommitParent).mock.calls[0]?.[4]).toBe("trunk");
    expect(vi.mocked(revertToCommit).mock.calls[0]?.[5]).toBe("trunk");
  });
});

describe("KV repo snapshot passes the default branch to the clone", () => {
  it("clones the given defaultBranch", async () => {
    vi.mocked(cloneRepo).mockResolvedValue(errResult);
    // biome-ignore lint/suspicious/noExplicitAny: minimal KV stub
    const kv = {} as any;
    // biome-ignore lint/suspicious/noExplicitAny: minimal Artifacts stub
    const artifacts = {} as any;
    await writeSnapshotFromRepo(
      kv,
      artifacts,
      { remote: trunkProject.remote, namespace: "@acme", slug: "web", defaultBranch: "trunk" },
      logger,
    );
    // Index 3, not 4: cloneRepo takes (remote, token, logger, opts, httpClient)
    // since #210 moved opts ahead of the http client.
    expect(vi.mocked(cloneRepo).mock.calls[0]?.[3]).toEqual({ ref: "trunk" });
  });

  it("defaults to main when no defaultBranch is given (regression)", async () => {
    vi.mocked(cloneRepo).mockResolvedValue(errResult);
    await writeSnapshotFromRepo(
      // biome-ignore lint/suspicious/noExplicitAny: minimal KV stub
      {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal Artifacts stub
      {} as any,
      { remote: trunkProject.remote, namespace: "@acme", slug: "web" },
      logger,
    );
    expect(vi.mocked(cloneRepo).mock.calls[0]?.[3]).toEqual({ ref: "main" });
  });
});

describe("backup snapshot passes the project's default branch to the clone", () => {
  it("clones fullHistory at the project's default branch", async () => {
    vi.mocked(cloneRepo).mockResolvedValue(errResult);
    const env = { ARTIFACTS: {} } as unknown as Env;
    const result = await snapshotRepo(env, trunkProject, "2026-01-01T00:00:00Z", logger);
    expect(result.success).toBe(false);
    expect(vi.mocked(cloneRepo).mock.calls[0]?.[3]).toEqual({
      fullHistory: true,
      ref: "trunk",
    });
  });
});

describe("backup restore reconstructs and pushes the project's default branch", () => {
  it("pushes the restored repo under the project's default branch ref", async () => {
    // Build a tiny real repo and pack its full object set (commit + tree + blob).
    const fs = new MemoryFS().toNodeFS();
    const author = { name: "a", email: "a@b.c", timestamp: 1700000000, timezoneOffset: 0 };
    await git.init({ fs, dir: "/", defaultBranch: "trunk" });
    await fs.promises.writeFile("/a.txt", "hello\n");
    await git.add({ fs, dir: "/", filepath: "a.txt" });
    const tipSha = await git.commit({ fs, dir: "/", message: "c1", author, committer: author });
    const tree = (await git.readCommit({ fs, dir: "/", oid: tipSha })).commit.tree;
    const commitWrapped = await git.readObject({ fs, dir: "/", oid: tipSha, format: "wrapped" });
    const objects = [
      { oid: tipSha, bytes: commitWrapped.object as Uint8Array },
      ...(await extractTreeObjects(fs, "/", tree)),
    ];
    const snapshot = {
      pack: packObjects(objects),
      manifest: {
        projectId: trunkProject.id,
        project: trunkProject,
        tipSha,
        objectCount: objects.length,
        byteCount: 0,
        capturedAt: "2026-01-01T00:00:00Z",
      },
    };

    const env = {
      ARTIFACTS: {
        get: vi.fn(async () => {
          throw new Error("not found");
        }),
        create: vi.fn(async () => ({ remote: trunkProject.remote, token: "t" })),
        delete: vi.fn(async () => true),
      },
    } as unknown as Env;

    const result = await restoreProjectRepo(env, snapshot, { force: false }, logger);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tipSha).toBe(tipSha);

    const pushCall = vi.mocked(pushMain).mock.calls[0];
    expect(pushCall?.[5]).toEqual({ force: false, branch: "trunk" });
    // The reconstructed repo really has refs/heads/trunk at the tip.
    const rebuiltFs = pushCall?.[2];
    // biome-ignore lint/style/noNonNullAssertion: asserted above via toEqual
    const resolved = await git.resolveRef({ fs: rebuiltFs!, dir: "/", ref: "trunk" });
    expect(resolved).toBe(tipSha);
  });
});

describe("policy loader threads the branch to readFileFromRepo", () => {
  it("reads both candidate policy files at the given branch", async () => {
    vi.mocked(readFileFromRepo).mockResolvedValue(errResult);
    await loadPolicy("https://r/p.git", "tok", logger, "trunk");
    const calls = vi.mocked(readFileFromRepo).mock.calls;
    expect(calls[0]?.[2]).toBe(".stratum/policy.yaml");
    expect(calls[0]?.[4]).toBe("trunk");
    expect(calls[1]?.[2]).toBe("stratum.config.json");
    expect(calls[1]?.[4]).toBe("trunk");
  });
});

describe("file-content threads the branch to readFileFromRepo", () => {
  it("passes the branch through", async () => {
    vi.mocked(readFileFromRepo).mockResolvedValue({ success: true, data: "hello" });
    const result = await getFileContent("https://r/p.git", "tok", "a.txt", logger, "trunk");
    expect(result.success).toBe(true);
    expect(vi.mocked(readFileFromRepo).mock.calls[0]?.[4]).toBe("trunk");
  });
});

describe("MergeQueue passes the project's default branch to the merge", () => {
  it("sets options.branch from projectDefaultBranch(project)", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { id: "chg_1", project: "acme/web", workspace: "ws_1", status: "approved" },
      // biome-ignore lint/suspicious/noExplicitAny: minimal Change stub
    } as any);
    vi.mocked(getProject).mockResolvedValue({
      success: true,
      data: trunkProject,
      // biome-ignore lint/suspicious/noExplicitAny: minimal Project stub
    } as any);
    vi.mocked(getWorkspace).mockResolvedValue({
      success: true,
      data: { remote: "https://acct.artifacts.cloudflare.net/git/ns/ws1.git" },
      // biome-ignore lint/suspicious/noExplicitAny: minimal Workspace stub
    } as any);

    const env = { DB: {}, STATE: {}, ARTIFACTS: {} } as unknown as Env;
    const ctx = {} as unknown as DurableObjectState;
    const result = await new MergeQueue(ctx, env).merge("chg_1");
    expect(result.success).toBe(true);

    const opts = vi.mocked(mergeWorkspaceIntoProject).mock.calls[0]?.[5] as { branch?: string };
    expect(opts.branch).toBe("trunk");
  });
});
