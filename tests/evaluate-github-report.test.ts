/**
 * Pipeline wiring: POST /api/changes/:id/evaluate reports the verdict to the
 * change's linked GitHub PR (comment + "stratum/evaluation" commit status),
 * gated on the project having a GitHub source and the change having a PR,
 * and best-effort — GitHub failures never fail the evaluation.
 *
 * Mocks storage + GitHubClient; runs the real route, change-flow helpers, and
 * src/github/sync.ts.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { changesRouter } from "../src/routes/changes";
import type { Change, Env } from "../src/types";
import { NotFoundError } from "../src/utils/errors";

vi.mock("../src/storage/changes", () => ({
  createChange: vi.fn(),
  getChange: vi.fn(),
  getChangesByIds: vi.fn(),
  listChanges: vi.fn(),
  updateChangeStatus: vi.fn(async () => ({ success: true, data: undefined })),
  markChangeMerged: vi.fn(async () => ({ success: true, data: { transitioned: true } })),
  mergeTransitionOpts: vi.fn(() => ({})),
}));

vi.mock("../src/storage/git-ops", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    getDiffBetweenRepos: vi.fn(),
    mergeWorkspaceIntoProject: vi.fn(),
    getCommitLog: vi.fn(),
    freshRepoToken: vi.fn(async () => ({ success: true, data: "test-token" })),
    cloneRepo: vi.fn(async () => ({ success: true, data: { fs: {}, dir: "/" } })),
    batchMergeStagedTrees: vi.fn(),
  };
});

vi.mock("../src/storage/repo-snapshot", () => ({
  readRepoSnapshot: vi.fn().mockResolvedValue({ success: true, data: null }),
}));

vi.mock("../src/storage/state", () => ({
  getProject: vi.fn(),
  getWorkspace: vi.fn(),
}));

vi.mock("../src/storage/deletion", () => ({
  isTargetDeleting: vi.fn().mockResolvedValue(false),
}));

vi.mock("../src/evaluation", () => ({
  loadPolicy: vi.fn(),
  diffTouchesProtectedConfig: vi.fn(() => false),
  DiffEvaluator: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn().mockResolvedValue({
      success: true,
      data: { score: 1, passed: true, reason: "Diff passed all checks." },
    }),
  })),
  WebhookEvaluator: vi.fn(),
  SecretScanEvaluator: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn().mockResolvedValue({
      success: true,
      data: { score: 1, passed: true, reason: "No secrets detected" },
    }),
  })),
  SandboxEvaluator: vi.fn(),
  LLMEvaluator: vi.fn(),
  CompositeEvaluator: vi.fn().mockImplementation(() => ({
    aggregate: vi.fn().mockReturnValue({
      score: 1,
      passed: true,
      reason: "All evaluators passed.",
    }),
  })),
}));

vi.mock("../src/storage/eval-runs", () => ({
  listEvalRuns: vi.fn().mockResolvedValue([]),
  recordEvalRuns: vi.fn(),
}));

vi.mock("../src/queue/events", () => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(),
  getUser: vi.fn(async () => ({ success: false, error: new Error("nf") })),
}));

vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(),
  getAgent: vi.fn(),
}));

vi.mock("../src/github/client", () => ({
  GitHubClient: vi.fn(),
}));

import { loadPolicy } from "../src/evaluation";
import { GitHubClient } from "../src/github/client";
import { getAgentByToken } from "../src/storage/agents";
import { getChange, updateChangeStatus } from "../src/storage/changes";
import { recordEvalRuns } from "../src/storage/eval-runs";
import { getDiffBetweenRepos } from "../src/storage/git-ops";
import { getProject, getWorkspace } from "../src/storage/state";
import { getUserByToken } from "../src/storage/users";

const USER_AUTH = { Authorization: "Bearer stratum_user_testtoken00000000000000000" };

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.route("/api", changesRouter);
  return app;
}

function makeDb() {
  const run = vi.fn().mockResolvedValue({ success: true });
  const bind = vi.fn().mockReturnValue({ run });
  const prepare = vi.fn().mockReturnValue({ bind });
  const batch = vi.fn().mockResolvedValue([]);
  return { db: { prepare, batch } as unknown as D1Database, prepare, bind, run };
}

const githubProject = {
  id: "proj_test123",
  name: "my-project",
  slug: "my-project",
  namespace: "user_test",
  ownerId: "user_test",
  ownerType: "user" as const,
  remote: "https://artifacts.example.com/repos/my-project",
  createdAt: "2026-01-01T00:00:00.000Z",
  sourceUrl: "https://github.com/acme/api",
  sourceProvider: "github" as const,
};

const stratumOnlyProject = {
  ...githubProject,
  sourceUrl: undefined,
  sourceProvider: undefined,
};

const prLinkedChange: Change = {
  id: "chg_abc123",
  project: "my-project",
  projectId: "proj_test123",
  workspace: "fix-bug",
  status: "open",
  createdAt: "2026-01-01T02:00:00.000Z",
  githubOwner: "acme",
  githubRepo: "api",
  githubPrNumber: 42,
  githubPrUrl: "https://github.com/acme/api/pull/42",
  githubHeadSha: "gh-head-sha",
};

const mockWorkspace = {
  name: "fix-bug",
  remote: "https://artifacts.example.com/repos/fix-bug",
  parent: "my-project",
  createdAt: "2026-01-01T01:00:00.000Z",
};

describe("POST /api/changes/:id/evaluate — GitHub verdict reporting", () => {
  let app: ReturnType<typeof makeApp>;
  let db: ReturnType<typeof makeDb>;
  let env: Env;
  let client: {
    postComment: ReturnType<typeof vi.fn>;
    updateComment: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    app = makeApp();
    db = makeDb();
    env = {
      ARTIFACTS: {} as Env["ARTIFACTS"],
      STATE: {} as KVNamespace,
      DB: db.db,
      GITHUB_TOKEN: "instance-token",
    } as Env;

    client = {
      postComment: vi.fn().mockResolvedValue({ success: true, id: 777 }),
      updateComment: vi.fn().mockResolvedValue({ success: true, id: 777 }),
      setStatus: vi.fn().mockResolvedValue({ success: true }),
    };
    vi.mocked(GitHubClient).mockImplementation(
      () => client as unknown as InstanceType<typeof GitHubClient>,
    );

    vi.mocked(getUserByToken).mockImplementation(async (_db, token) => {
      if (token === "stratum_user_testtoken00000000000000000") {
        return {
          success: true,
          data: {
            id: "user_test",
            email: "test@example.com",
            username: "test",
            tokenHash: "hash",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        };
      }
      return { success: false, error: new NotFoundError("User", token) };
    });
    vi.mocked(getAgentByToken).mockResolvedValue({
      success: false,
      error: new NotFoundError("Agent", "token"),
    });

    vi.mocked(getChange).mockResolvedValue({ success: true, data: prLinkedChange });
    vi.mocked(getProject).mockResolvedValue({ success: true, data: githubProject });
    vi.mocked(getWorkspace).mockResolvedValue({ success: true, data: mockWorkspace });
    vi.mocked(loadPolicy).mockResolvedValue({
      evaluators: [{ type: "diff" }],
      requireAll: true,
      minScore: 0.7,
    });
    vi.mocked(getDiffBetweenRepos).mockResolvedValue({
      success: true,
      data: {
        diff: "diff --git a/x b/x",
        workspaceOid: "ws-oid",
        workspaceTreeOid: "ws-tree-oid",
        workspaceSha: "ws-sha",
        baseOid: "base_sha_from_diff_clone",
      },
    });
    vi.mocked(recordEvalRuns).mockResolvedValue({ success: true, data: [] });
    vi.mocked(updateChangeStatus).mockResolvedValue({ success: true, data: undefined });
  });

  function evaluate(executionCtx?: ExecutionContext) {
    return app.fetch(
      new Request("http://localhost/api/changes/chg_abc123/evaluate", {
        method: "POST",
        headers: USER_AUTH,
      }),
      env,
      executionCtx,
    );
  }

  it("posts the verdict comment and commit status for a GitHub-linked change", async () => {
    const res = await evaluate();
    expect(res.status).toBe(200);

    expect(GitHubClient).toHaveBeenCalledWith("instance-token", expect.anything());
    expect(client.postComment).toHaveBeenCalledWith({
      owner: "acme",
      repo: "api",
      issue_number: 42,
      body: expect.stringContaining("Stratum Evaluation Results"),
    });
    expect(client.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "api",
        sha: "gh-head-sha",
        state: "success",
        context: "stratum/evaluation",
      }),
    );
    // The new comment id is stored for upsert on the next evaluation.
    expect(db.prepare).toHaveBeenCalledWith(
      "UPDATE changes SET github_comment_id = ? WHERE id = ?",
    );
    expect(db.bind).toHaveBeenCalledWith(777, "chg_abc123");
  });

  it("edits the stored comment on re-evaluation instead of posting a new one", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...prLinkedChange, githubCommentId: 777 },
    });

    const res = await evaluate();
    expect(res.status).toBe(200);
    expect(client.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 777 }));
    expect(client.postComment).not.toHaveBeenCalled();
  });

  it("does not touch GitHub for a pure-Stratum project", async () => {
    vi.mocked(getProject).mockResolvedValue({ success: true, data: stratumOnlyProject });

    const res = await evaluate();
    expect(res.status).toBe(200);
    expect(GitHubClient).not.toHaveBeenCalled();
    expect(client.postComment).not.toHaveBeenCalled();
    expect(client.setStatus).not.toHaveBeenCalled();
  });

  it("does not touch GitHub when the change has no linked PR", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: {
        ...prLinkedChange,
        githubPrNumber: undefined,
        githubPrUrl: undefined,
        githubOwner: undefined,
        githubRepo: undefined,
        githubHeadSha: undefined,
      },
    });

    const res = await evaluate();
    expect(res.status).toBe(200);
    expect(client.postComment).not.toHaveBeenCalled();
    expect(client.setStatus).not.toHaveBeenCalled();
  });

  it("still succeeds when GitHub returns errors (best-effort reporting)", async () => {
    client.postComment.mockResolvedValue({ success: false, error: "GitHub API error: 500" });
    client.setStatus.mockResolvedValue({ success: false, error: "GitHub API error: 500" });

    const res = await evaluate();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { eval: { passed: boolean } };
    expect(body.eval.passed).toBe(true);
  });

  it("still succeeds when the GitHub client throws", async () => {
    client.postComment.mockRejectedValue(new Error("network down"));

    const res = await evaluate();
    expect(res.status).toBe(200);
  });

  it("schedules the GitHub report via waitUntil instead of blocking the response", async () => {
    const scheduled: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: vi.fn((p: Promise<unknown>) => scheduled.push(p)),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    const res = await evaluate(executionCtx);
    expect(res.status).toBe(200);

    // The response resolves without awaiting the report — its promise is
    // handed to waitUntil instead of being awaited on the request path.
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);

    await Promise.all(scheduled);
    expect(client.postComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "api", issue_number: 42 }),
    );
    expect(client.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "api", sha: "gh-head-sha" }),
    );
  });
});
