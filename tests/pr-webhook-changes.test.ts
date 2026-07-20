import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/utils/logger";

const logger = createLogger({ component: "test" });

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../src/storage/github-bridge", () => ({
  getProjectByGitHubRepo: vi.fn(),
}));

vi.mock("../src/storage/changes", () => ({
  getChangeByGitHubBranch: vi.fn(),
  createChange: vi.fn(),
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

vi.mock("../src/storage/state", () => ({
  getWorkspace: vi.fn(),
}));

import { handlePullRequest, handlePullRequestReview } from "../src/github/webhooks";
import { createChange, getChangeByGitHubBranch, updateChangeStatus } from "../src/storage/changes";
import { getProjectByGitHubRepo } from "../src/storage/github-bridge";
import { getWorkspace } from "../src/storage/state";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT = {
  id: "proj-1",
  name: "my-repo",
  namespace: "@owner",
  slug: "my-repo",
  ownerId: "user-1",
  ownerType: "user" as const,
  remote: "https://artifacts.example.com/repo",
  token: "token123",
  sourceUrl: "https://github.com/owner/repo",
  sourceDefaultBranch: "main",
  createdAt: new Date().toISOString(),
};

const CHANGE = {
  id: "chg-abc123",
  project: "proj-1",
  workspace: "ws-1234",
  status: "open" as const,
  githubBranch: "ws-1234",
  createdAt: new Date().toISOString(),
};

import type { Env } from "../src/types";

function makeEnv(): Env {
  return {
    DB: {} as D1Database,
    STATE: {} as KVNamespace,
    ARTIFACTS: {} as Env["ARTIFACTS"],
  } as unknown as Env;
}

// ---------------------------------------------------------------------------
// getChangeByGitHubBranch unit tests (real implementation, separate D1 mock)
// ---------------------------------------------------------------------------

describe("getChangeByGitHubBranch (real implementation)", () => {
  it("returns the Change when found", async () => {
    const { getChangeByGitHubBranch: realFn } =
      await vi.importActual<typeof import("../src/storage/changes")>("../src/storage/changes");

    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue({
          id: "chg-1",
          project: "proj-1",
          workspace: "ws-1",
          status: "open",
          agent_id: null,
          eval_score: null,
          eval_passed: null,
          eval_reason: null,
          created_at: new Date().toISOString(),
          merged_at: null,
          github_owner: "owner",
          github_repo: "repo",
          github_branch: "ws-1",
          github_pr_number: null,
          github_pr_url: null,
          github_pr_state: null,
          github_head_sha: null,
          github_comment_id: null,
          promoted_at: null,
          promoted_by: null,
        }),
      })),
    } as unknown as D1Database;

    const result = await realFn(db, logger, "proj-1", "ws-1");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("chg-1");
    expect(result?.githubBranch).toBe("ws-1");
  });

  it("returns null when no row found", async () => {
    const { getChangeByGitHubBranch: realFn } =
      await vi.importActual<typeof import("../src/storage/changes")>("../src/storage/changes");

    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
      })),
    } as unknown as D1Database;

    const result = await realFn(db, logger, "proj-1", "nonexistent-branch");
    expect(result).toBeNull();
  });

  it("returns null on D1 error (does not throw)", async () => {
    const { getChangeByGitHubBranch: realFn } =
      await vi.importActual<typeof import("../src/storage/changes")>("../src/storage/changes");

    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockRejectedValue(new Error("D1 error")),
      })),
    } as unknown as D1Database;

    const result = await realFn(db, logger, "proj-1", "some-branch");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handlePullRequest tests
// ---------------------------------------------------------------------------

describe("handlePullRequest", () => {
  beforeEach(() => {
    vi.mocked(getProjectByGitHubRepo).mockResolvedValue({
      success: true,
      data: PROJECT,
    } as Awaited<ReturnType<typeof getProjectByGitHubRepo>>);
    vi.mocked(updateChangeStatus).mockResolvedValue({ success: true, data: undefined });
    vi.clearAllMocks();
    vi.mocked(getProjectByGitHubRepo).mockResolvedValue({
      success: true,
      data: PROJECT,
    } as Awaited<ReturnType<typeof getProjectByGitHubRepo>>);
    vi.mocked(updateChangeStatus).mockResolvedValue({ success: true, data: undefined });
  });

  function makePRPayload(action: string, headRef: string, merged = false, sha = "abc1234") {
    return {
      action,
      number: 42,
      pull_request: {
        title: "Test PR",
        body: "",
        state: action === "closed" ? "closed" : "open",
        merged,
        html_url: "https://github.com/owner/repo/pull/42",
        head: { ref: headRef, sha },
        base: { ref: "main" },
        user: { login: "author" },
      },
      repository: { owner: { login: "owner" }, name: "repo" },
    };
  }

  it("opened with matching workspace creates a Change", async () => {
    vi.mocked(getChangeByGitHubBranch).mockResolvedValue(null);
    vi.mocked(getWorkspace).mockResolvedValue({
      success: true,
      data: {
        name: "ws-1234",
        branchName: "ws-1234",
        remote: "r",
        parent: "proj-1",
        createdAt: new Date().toISOString(),
      },
    });
    vi.mocked(createChange).mockResolvedValue({
      success: true,
      data: CHANGE,
    } as Awaited<ReturnType<typeof createChange>>);

    const env = makeEnv();
    await handlePullRequest(env, makePRPayload("opened", "ws-1234"), logger);

    expect(createChange).toHaveBeenCalledWith(env.DB, logger, {
      project: PROJECT.id,
      projectId: PROJECT.id,
      workspace: "ws-1234",
    });
    expect(updateChangeStatus).toHaveBeenCalled();
  });

  it("opened with NO matching workspace skips silently (no phantom records)", async () => {
    vi.mocked(getChangeByGitHubBranch).mockResolvedValue(null);
    vi.mocked(getWorkspace).mockResolvedValue({
      success: false,
      error: { message: "not found", code: "NOT_FOUND", statusCode: 404 },
    } as Awaited<ReturnType<typeof getWorkspace>>);

    const env = makeEnv();
    await handlePullRequest(env, makePRPayload("opened", "external-branch"), logger);

    expect(createChange).not.toHaveBeenCalled();
  });

  it("opened with existing Change is idempotent (updates SHA, does not create)", async () => {
    vi.mocked(getChangeByGitHubBranch).mockResolvedValue(CHANGE);

    const env = makeEnv();
    await handlePullRequest(env, makePRPayload("opened", "ws-1234"), logger);

    expect(createChange).not.toHaveBeenCalled();
    expect(updateChangeStatus).toHaveBeenCalledWith(
      env.DB,
      logger,
      CHANGE.id,
      CHANGE.status,
      expect.objectContaining({ githubHeadSha: "abc1234" }),
    );
  });

  it("closed+merged updates status to merged", async () => {
    vi.mocked(getChangeByGitHubBranch).mockResolvedValue(CHANGE);

    const env = makeEnv();
    await handlePullRequest(env, makePRPayload("closed", "ws-1234", true), logger);

    expect(updateChangeStatus).toHaveBeenCalledWith(
      env.DB,
      logger,
      CHANGE.id,
      "merged",
      expect.objectContaining({ githubPrState: "closed" }),
    );
  });

  it("closed+not merged updates status to rejected", async () => {
    vi.mocked(getChangeByGitHubBranch).mockResolvedValue(CHANGE);

    const env = makeEnv();
    await handlePullRequest(env, makePRPayload("closed", "ws-1234", false), logger);

    expect(updateChangeStatus).toHaveBeenCalledWith(
      env.DB,
      logger,
      CHANGE.id,
      "rejected",
      expect.objectContaining({ githubPrState: "closed" }),
    );
  });
});

// ---------------------------------------------------------------------------
// handlePullRequestReview tests
// ---------------------------------------------------------------------------

describe("handlePullRequestReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectByGitHubRepo).mockResolvedValue({
      success: true,
      data: PROJECT,
    } as Awaited<ReturnType<typeof getProjectByGitHubRepo>>);
    vi.mocked(getChangeByGitHubBranch).mockResolvedValue(CHANGE);
    vi.mocked(updateChangeStatus).mockResolvedValue({ success: true, data: undefined });
  });

  function makeReviewPayload(reviewState: string, headRef = "ws-1234") {
    return {
      action: "submitted",
      pull_request: { number: 42, head: { ref: headRef } },
      review: { state: reviewState, user: { login: "reviewer" } },
      repository: { owner: { login: "owner" }, name: "repo" },
    };
  }

  it("approved updates Change status to accepted", async () => {
    const env = makeEnv();
    await handlePullRequestReview(env, makeReviewPayload("approved"), logger);

    expect(updateChangeStatus).toHaveBeenCalledWith(env.DB, logger, CHANGE.id, "accepted");
  });

  it("changes_requested updates Change status to needs_changes", async () => {
    const env = makeEnv();
    await handlePullRequestReview(env, makeReviewPayload("changes_requested"), logger);

    expect(updateChangeStatus).toHaveBeenCalledWith(env.DB, logger, CHANGE.id, "needs_changes");
  });

  it("dismissed makes no status change", async () => {
    const env = makeEnv();
    await handlePullRequestReview(env, makeReviewPayload("dismissed"), logger);

    expect(updateChangeStatus).not.toHaveBeenCalled();
  });
});
