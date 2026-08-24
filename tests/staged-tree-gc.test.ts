import { describe, expect, it, vi } from "vitest";
import { stagedTreeGcHandler } from "../src/queue/event-consumer";
import { deletePinnedStagedTreeForChange } from "../src/storage/staged-tree-gc";
import type { Change, Env } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeFakeR2 } from "./helpers/fake-r2";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

function change(overrides: Partial<Change> = {}): Change {
  return {
    id: "chg_1",
    project: "demo",
    projectId: "project-1",
    workspace: "feature",
    status: "rejected",
    workspaceHeadSha: "evaluated-sha",
    createdAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

function changeDb(row: Record<string, unknown>): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => row),
      })),
    })),
  } as unknown as D1Database;
}

describe("staged-tree GC", () => {
  it("deletes only the rejected change's pinned sha copy", async () => {
    const bucket = makeFakeR2();
    await bucket.put("repos/project-1/ws/feature", "latest");
    await bucket.put("repos/project-1/ws/feature/sha/evaluated-sha", "pinned");
    await bucket.put("repos/project-1/ws/feature/sha/newer-sha", "newer");

    const key = await deletePinnedStagedTreeForChange(bucket, change());

    expect(key).toBe("repos/project-1/ws/feature/sha/evaluated-sha");
    expect(bucket.store.has("repos/project-1/ws/feature/sha/evaluated-sha")).toBe(false);
    expect(bucket.store.has("repos/project-1/ws/feature")).toBe(true);
    expect(bucket.store.has("repos/project-1/ws/feature/sha/newer-sha")).toBe(true);
  });

  it("falls back to evaluatedSha and the event project id for legacy rows", async () => {
    const bucket = makeFakeR2();
    await bucket.put("repos/project-legacy/ws/feature/sha/eval-only", "pinned");

    const key = await deletePinnedStagedTreeForChange(
      bucket,
      change({ projectId: undefined, workspaceHeadSha: undefined, evaluatedSha: "eval-only" }),
      "project-legacy",
    );

    expect(key).toBe("repos/project-legacy/ws/feature/sha/eval-only");
    expect(bucket.store.size).toBe(0);
  });

  it("does nothing when a legacy change has no safe project id or pinned sha", async () => {
    const bucket = makeFakeR2();
    await bucket.put("repos/project-1/ws/feature/sha/some-sha", "keep");

    const key = await deletePinnedStagedTreeForChange(
      bucket,
      change({ projectId: undefined, workspaceHeadSha: undefined, evaluatedSha: undefined }),
    );

    expect(key).toBeNull();
    expect(bucket.store.has("repos/project-1/ws/feature/sha/some-sha")).toBe(true);
  });

  it("wires change.rejected events to exact pinned-tree reclamation", async () => {
    const bucket = makeFakeR2();
    await bucket.put("repos/project-1/ws/feature/sha/evaluated-sha", "pinned");
    await bucket.put("repos/project-1/ws/feature/sha/newer-sha", "newer");

    const db = changeDb({
      id: "chg_1",
      project: "demo",
      project_id: "project-1",
      workspace: "feature",
      status: "rejected",
      agent_id: null,
      eval_score: null,
      eval_passed: null,
      eval_reason: null,
      base_sha: null,
      evaluated_sha: "evaluated-sha",
      evaluated_tree_oid: null,
      agent_model: null,
      agent_prompt_hash: null,
      workspace_head_sha: "evaluated-sha",
      created_at: "2026-08-24T00:00:00.000Z",
      merged_at: null,
      github_owner: null,
      github_repo: null,
      github_branch: null,
      github_pr_number: null,
      github_pr_url: null,
      github_pr_state: null,
      github_head_sha: null,
      github_comment_id: null,
      promoted_at: null,
      promoted_by: null,
    });

    await stagedTreeGcHandler.handle(
      { DB: db, REPO_OBJECTS: bucket } as unknown as Env,
      {
        id: "evt_1",
        type: "change.rejected",
        project: "demo",
        projectId: "project-1",
        actorType: "user",
        payload: { changeId: "chg_1" },
        status: "pending",
        attempts: 0,
        createdAt: "2026-08-24T00:00:00.000Z",
      },
      logger,
    );

    expect(bucket.store.has("repos/project-1/ws/feature/sha/evaluated-sha")).toBe(false);
    expect(bucket.store.has("repos/project-1/ws/feature/sha/newer-sha")).toBe(true);
  });
});
