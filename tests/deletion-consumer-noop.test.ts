import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/storage/changes", () => ({
  getChange: vi.fn(),
  updateChangeStatus: vi.fn(async () => ({ success: true, data: undefined })),
  markChangeMerged: vi.fn(async () => ({ success: true, data: { transitioned: true } })),
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
vi.mock("../src/storage/state", () => ({
  getProject: vi.fn(),
  getWorkspace: vi.fn(),
}));
vi.mock("../src/storage/git-ops", () => ({
  freshRepoToken: vi.fn(async () => ({ success: true, data: "tok" })),
  mergeWorkspaceIntoProject: vi.fn(async () => ({ success: true, data: "deadbeef" })),
}));
vi.mock("../src/storage/provenance", () => ({
  recordProvenance: vi.fn(async () => ({ success: true, data: undefined })),
}));
vi.mock("../src/storage/metrics", () => ({
  recordCommitMetrics: vi.fn(async () => ({ success: true, data: undefined })),
  commitPhasesFromSpans: (spans: Record<string, number>) => spans,
}));

import { MergeQueue } from "../src/queue/merge-queue";
import { getChange } from "../src/storage/changes";
import { freshRepoToken } from "../src/storage/git-ops";
import { getProject, getWorkspace } from "../src/storage/state";
import type { Env } from "../src/types";

const ctx = {} as unknown as DurableObjectState;

// DB stub: the owner row reports a non-null deleting_at (owner being erased).
const deletingDb = {
  prepare: () => ({
    bind: () => ({
      first: async () => ({ deleting_at: "2026-06-17T00:00:00.000Z" }),
    }),
  }),
} as unknown as D1Database;

const env = { DB: deletingDb, STATE: {}, ARTIFACTS: {} } as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  // Minimal stubs (typed `as never` to satisfy the full Result shapes without any).
  vi.mocked(getChange).mockResolvedValue({
    success: true,
    data: { id: "chg_1", project: "@alice/api", workspace: "ws_1", status: "approved" },
  } as never);
  vi.mocked(getProject).mockResolvedValue({
    success: true,
    data: { id: "proj_1", remote: "https://artifacts/x.git", ownerType: "user", ownerId: "usr_1" },
  } as never);
  vi.mocked(getWorkspace).mockResolvedValue({
    success: true,
    data: { remote: "https://artifacts/x-ws1.git" },
  } as never);
});

describe("MergeQueue no-ops when the owner is deleting", () => {
  it("returns failure and never mints repo tokens or resolves the workspace", async () => {
    const queue = new MergeQueue(ctx, env);
    const result = await queue.merge("chg_1");

    expect(result.success).toBe(false);
    expect(result.error).toContain("deleted");
    // Short-circuited BEFORE the merge work: no token mint, no workspace lookup.
    expect(freshRepoToken).not.toHaveBeenCalled();
    expect(getWorkspace).not.toHaveBeenCalled();
  });
});
