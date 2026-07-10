import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/storage/changes", () => ({
  getChange: vi.fn(),
  updateChangeStatus: vi.fn(async () => ({ success: true, data: undefined })),
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
import { recordCommitMetrics } from "../src/storage/metrics";
import { getProject, getWorkspace } from "../src/storage/state";
import type { Env } from "../src/types";

const env = { DB: {}, STATE: {}, ARTIFACTS: {} } as unknown as Env;
const ctx = {} as unknown as DurableObjectState;

function makeStorageCtx(): { ctx: DurableObjectState; deleteAll: ReturnType<typeof vi.fn> } {
  const deleteAll = vi.fn(async () => {});
  const storageCtx = { storage: { deleteAll } } as unknown as DurableObjectState;
  return { ctx: storageCtx, deleteAll };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getChange).mockResolvedValue({
    success: true,
    data: {
      id: "chg_1",
      project: "acme/web",
      workspace: "ws_1",
      status: "approved",
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal Change stub for the test
  } as any);
  vi.mocked(getProject).mockResolvedValue({
    success: true,
    data: { id: "proj_1", remote: "https://artifacts/acme-web.git" },
    // biome-ignore lint/suspicious/noExplicitAny: minimal Project stub
  } as any);
  vi.mocked(getWorkspace).mockResolvedValue({
    success: true,
    data: { remote: "https://artifacts/acme-web-ws1.git" },
    // biome-ignore lint/suspicious/noExplicitAny: minimal Workspace stub
  } as any);
});

describe("MergeQueue records commit metrics", () => {
  it("writes exactly one cold_fallback row on a successful merge", async () => {
    const queue = new MergeQueue(ctx, env);
    const result = await queue.merge("chg_1");

    expect(result.success).toBe(true);
    expect(recordCommitMetrics).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(recordCommitMetrics).mock.calls[0]?.[1];
    expect(arg?.outcome).toBe("cold_fallback");
    expect(arg?.project).toBe("acme/web");
    expect(arg?.changeId).toBe("chg_1");
    expect(typeof arg?.totalMs).toBe("number");
  });

  it("does not fail the merge when metrics recording fails", async () => {
    vi.mocked(recordCommitMetrics).mockResolvedValueOnce({
      success: false,
      // biome-ignore lint/suspicious/noExplicitAny: error shape not under test
      error: { message: "db down" } as any,
    });
    const queue = new MergeQueue(ctx, env);
    const result = await queue.merge("chg_1");
    expect(result.success).toBe(true);
  });
});

describe("MergeQueue.purge (deletion-cascade RPC)", () => {
  it("wipes the DO's durable storage", async () => {
    const { ctx: storageCtx, deleteAll } = makeStorageCtx();
    const queue = new MergeQueue(storageCtx, env);

    await queue.purge();

    expect(deleteAll).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: purging twice in a row does not throw", async () => {
    const { ctx: storageCtx, deleteAll } = makeStorageCtx();
    const queue = new MergeQueue(storageCtx, env);

    await queue.purge();
    await expect(queue.purge()).resolves.toBeUndefined();
    expect(deleteAll).toHaveBeenCalledTimes(2);
  });
});
