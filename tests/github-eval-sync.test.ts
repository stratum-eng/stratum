import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Change, ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";

vi.mock("../src/github/client", () => ({
  GitHubClient: vi.fn(),
}));

import { GitHubClient } from "../src/github/client";
import {
  EVALUATION_STATUS_CONTEXT,
  buildEvaluationComment,
  buildEvaluationReport,
  postEvaluationComment,
  reportEvaluationToGitHub,
  resolveGitHubRepo,
  syncChangeStatusToGitHub,
} from "../src/github/sync";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseProject: ProjectEntry = {
  id: "proj_1",
  name: "api",
  slug: "api",
  namespace: "@acme",
  ownerId: "user_1",
  ownerType: "user",
  remote: "https://artifacts.example.com/repos/api",
  createdAt: "2026-01-01T00:00:00.000Z",
  sourceUrl: "https://github.com/acme/api",
  sourceProvider: "github",
};

const baseChange: Change = {
  id: "chg_1",
  project: "@acme/api",
  projectId: "proj_1",
  workspace: "feat-x",
  status: "open",
  createdAt: "2026-01-01T01:00:00.000Z",
  githubOwner: "acme",
  githubRepo: "api",
  githubPrNumber: 12,
  githubPrUrl: "https://github.com/acme/api/pull/12",
  githubHeadSha: "headsha123",
};

const evaluation = {
  score: 0.92,
  passed: true,
  results: [
    { evaluatorType: "secret_scan", score: 1, passed: true, reason: "No secrets detected" },
    { evaluatorType: "diff", score: 0.84, passed: true, reason: "Diff passed all checks." },
  ],
};

function makeDb() {
  const run = vi.fn().mockResolvedValue({ success: true });
  const bind = vi.fn().mockReturnValue({ run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { db: { prepare } as unknown as D1Database, prepare, bind, run };
}

function makeClient(
  overrides: Partial<{
    postComment: ReturnType<typeof vi.fn>;
    updateComment: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
  }> = {},
) {
  const client = {
    postComment: vi.fn().mockResolvedValue({ success: true, id: 999 }),
    updateComment: vi.fn().mockResolvedValue({ success: true, id: 555 }),
    setStatus: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
  vi.mocked(GitHubClient).mockImplementation(
    () => client as unknown as InstanceType<typeof GitHubClient>,
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// buildEvaluationReport
// ---------------------------------------------------------------------------

describe("buildEvaluationReport", () => {
  it("maps aggregate verdict and per-evaluator runs", () => {
    const report = buildEvaluationReport({ score: 0.7, passed: false }, [
      { evaluatorType: "diff", result: { score: 0.7, passed: false, reason: "too big" } },
    ]);
    expect(report).toEqual({
      score: 0.7,
      passed: false,
      results: [{ evaluatorType: "diff", score: 0.7, passed: false, reason: "too big" }],
    });
  });
});

// ---------------------------------------------------------------------------
// resolveGitHubRepo — KV-sourced project identity, no D1 join
// ---------------------------------------------------------------------------

describe("resolveGitHubRepo", () => {
  it("parses owner/repo from sourceUrl", () => {
    expect(resolveGitHubRepo(baseProject)).toEqual({ owner: "acme", repo: "api" });
  });

  it("parses owner/repo from legacy githubUrl", () => {
    const project: ProjectEntry = {
      ...baseProject,
      sourceUrl: undefined,
      sourceProvider: undefined,
      githubUrl: "https://github.com/legacy-org/legacy-repo.git",
    };
    expect(resolveGitHubRepo(project)).toEqual({ owner: "legacy-org", repo: "legacy-repo" });
  });

  it("returns null for a non-GitHub provider", () => {
    const project: ProjectEntry = {
      ...baseProject,
      sourceProvider: "gitlab",
      sourceUrl: "https://gitlab.com/acme/api",
    };
    expect(resolveGitHubRepo(project)).toBeNull();
  });

  it("returns null for a non-GitHub URL with no provider set", () => {
    const project: ProjectEntry = {
      ...baseProject,
      sourceProvider: undefined,
      sourceUrl: "https://gitlab.com/acme/api",
      sourceOwner: undefined,
      sourceRepo: undefined,
    };
    expect(resolveGitHubRepo(project)).toBeNull();
  });

  it("falls back to explicit sourceOwner/sourceRepo fields", () => {
    const project: ProjectEntry = {
      ...baseProject,
      sourceUrl: undefined,
      sourceOwner: "field-owner",
      sourceRepo: "field-repo",
    };
    expect(resolveGitHubRepo(project)).toEqual({ owner: "field-owner", repo: "field-repo" });
  });

  it("falls back to legacy githubOwner/githubRepo fields", () => {
    const project: ProjectEntry = {
      ...baseProject,
      sourceUrl: undefined,
      sourceProvider: undefined,
      githubOwner: "gh-owner",
      githubRepo: "gh-repo",
    };
    expect(resolveGitHubRepo(project)).toEqual({ owner: "gh-owner", repo: "gh-repo" });
  });

  it("returns null for a pure-Stratum project", () => {
    const project: ProjectEntry = {
      ...baseProject,
      sourceUrl: undefined,
      sourceProvider: undefined,
    };
    expect(resolveGitHubRepo(project)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// postEvaluationComment
// ---------------------------------------------------------------------------

describe("postEvaluationComment", () => {
  it("creates a new comment and stores its id when none exists", async () => {
    const client = makeClient();
    const { db, prepare, bind } = makeDb();

    const result = await postEvaluationComment(
      db,
      { change: baseChange, owner: "acme", repo: "api", githubToken: "tok", evaluation },
      logger,
    );

    expect(result.success).toBe(true);
    expect(result.success && result.data.commentId).toBe(999);
    expect(GitHubClient).toHaveBeenCalledWith("tok", logger);
    expect(client.postComment).toHaveBeenCalledWith({
      owner: "acme",
      repo: "api",
      issue_number: 12,
      body: expect.stringContaining("Stratum Evaluation Results"),
    });
    expect(client.updateComment).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledWith("UPDATE changes SET github_comment_id = ? WHERE id = ?");
    expect(bind).toHaveBeenCalledWith(999, "chg_1");
  });

  it("updates the existing comment on re-evaluation instead of posting a new one", async () => {
    const client = makeClient();
    const { db, prepare } = makeDb();
    const change: Change = { ...baseChange, githubCommentId: 555 };

    const result = await postEvaluationComment(
      db,
      { change, owner: "acme", repo: "api", githubToken: "tok", evaluation },
      logger,
    );

    expect(result.success).toBe(true);
    expect(result.success && result.data.commentId).toBe(555);
    expect(client.updateComment).toHaveBeenCalledWith({
      owner: "acme",
      repo: "api",
      comment_id: 555,
      body: expect.stringContaining("Stratum Evaluation Results"),
    });
    expect(client.postComment).not.toHaveBeenCalled();
    // No new id to store.
    expect(prepare).not.toHaveBeenCalled();
  });

  it("falls back to creating a comment when updating the stored one fails", async () => {
    const client = makeClient({
      updateComment: vi.fn().mockResolvedValue({ success: false, error: "404 gone" }),
    });
    const { db, bind } = makeDb();
    const change: Change = { ...baseChange, githubCommentId: 555 };

    const result = await postEvaluationComment(
      db,
      { change, owner: "acme", repo: "api", githubToken: "tok", evaluation },
      logger,
    );

    expect(result.success).toBe(true);
    expect(result.success && result.data.commentId).toBe(999);
    expect(client.postComment).toHaveBeenCalled();
    expect(bind).toHaveBeenCalledWith(999, "chg_1");
  });

  it("fails with INVALID_STATE when the change has no linked PR", async () => {
    makeClient();
    const { db } = makeDb();
    const change: Change = { ...baseChange, githubPrNumber: undefined };

    const result = await postEvaluationComment(
      db,
      { change, owner: "acme", repo: "api", githubToken: "tok", evaluation },
      logger,
    );

    expect(result.success).toBe(false);
    expect(!result.success && result.error.code).toBe("INVALID_STATE");
  });

  it("returns GITHUB_ERROR when comment creation fails", async () => {
    makeClient({
      postComment: vi.fn().mockResolvedValue({ success: false, error: "boom" }),
    });
    const { db, prepare } = makeDb();

    const result = await postEvaluationComment(
      db,
      { change: baseChange, owner: "acme", repo: "api", githubToken: "tok", evaluation },
      logger,
    );

    expect(result.success).toBe(false);
    expect(!result.success && result.error.code).toBe("GITHUB_ERROR");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("still succeeds when storing the comment id fails (best-effort)", async () => {
    makeClient();
    const run = vi.fn().mockRejectedValue(new Error("D1 down"));
    const db = {
      prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ run }) }),
    } as unknown as D1Database;

    const result = await postEvaluationComment(
      db,
      { change: baseChange, owner: "acme", repo: "api", githubToken: "tok", evaluation },
      logger,
    );

    expect(result.success).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to store GitHub comment id on change",
      expect.objectContaining({ changeId: "chg_1" }),
    );
  });

  it("stringifies non-Error failures when storing the comment id fails", async () => {
    makeClient();
    const run = vi.fn().mockRejectedValue("string failure");
    const db = {
      prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ run }) }),
    } as unknown as D1Database;

    const result = await postEvaluationComment(
      db,
      { change: baseChange, owner: "acme", repo: "api", githubToken: "tok", evaluation },
      logger,
    );

    expect(result.success).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to store GitHub comment id on change",
      expect.objectContaining({ error: "string failure" }),
    );
  });
});

// ---------------------------------------------------------------------------
// syncChangeStatusToGitHub
// ---------------------------------------------------------------------------

describe("syncChangeStatusToGitHub", () => {
  it("sets a success status on the GitHub head sha with the stratum/evaluation context", async () => {
    const client = makeClient();

    const result = await syncChangeStatusToGitHub(
      { change: baseChange, owner: "acme", repo: "api", githubToken: "tok", evaluation },
      logger,
    );

    expect(result.success).toBe(true);
    expect(result.success && result.data.sha).toBe("headsha123");
    expect(client.setStatus).toHaveBeenCalledWith({
      owner: "acme",
      repo: "api",
      sha: "headsha123",
      state: "success",
      description: "Stratum evaluation passed: score 92.0%",
      context: EVALUATION_STATUS_CONTEXT,
    });
  });

  it("sets a failure status when the evaluation failed", async () => {
    const client = makeClient();

    await syncChangeStatusToGitHub(
      {
        change: baseChange,
        owner: "acme",
        repo: "api",
        githubToken: "tok",
        evaluation: { score: 0.3, passed: false },
      },
      logger,
    );

    expect(client.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "failure",
        description: "Stratum evaluation failed: score 30.0%",
        context: "stratum/evaluation",
      }),
    );
  });

  it("falls back to the evaluated sha when GitHub never reported a head sha", async () => {
    const client = makeClient();
    const change: Change = {
      ...baseChange,
      githubHeadSha: undefined,
      evaluatedSha: "evaluatedsha456",
    };

    await syncChangeStatusToGitHub(
      { change, owner: "acme", repo: "api", githubToken: "tok", evaluation },
      logger,
    );

    expect(client.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "evaluatedsha456" }),
    );
  });

  it("passes the target url through when given", async () => {
    const client = makeClient();

    await syncChangeStatusToGitHub(
      {
        change: baseChange,
        owner: "acme",
        repo: "api",
        githubToken: "tok",
        evaluation,
        targetUrl: "https://stratum.example.com/changes/chg_1",
      },
      logger,
    );

    expect(client.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ target_url: "https://stratum.example.com/changes/chg_1" }),
    );
  });

  it("fails with INVALID_STATE when no sha is available", async () => {
    const client = makeClient();
    const change: Change = { ...baseChange, githubHeadSha: undefined, evaluatedSha: undefined };

    const result = await syncChangeStatusToGitHub(
      { change, owner: "acme", repo: "api", githubToken: "tok", evaluation },
      logger,
    );

    expect(result.success).toBe(false);
    expect(!result.success && result.error.code).toBe("INVALID_STATE");
    expect(client.setStatus).not.toHaveBeenCalled();
  });

  it("returns GITHUB_ERROR when the status API call fails", async () => {
    makeClient({
      setStatus: vi.fn().mockResolvedValue({ success: false, error: "500" }),
    });

    const result = await syncChangeStatusToGitHub(
      { change: baseChange, owner: "acme", repo: "api", githubToken: "tok", evaluation },
      logger,
    );

    expect(result.success).toBe(false);
    expect(!result.success && result.error.code).toBe("GITHUB_ERROR");
  });
});

// ---------------------------------------------------------------------------
// reportEvaluationToGitHub — the pipeline entry point
// ---------------------------------------------------------------------------

describe("reportEvaluationToGitHub", () => {
  it("posts comment and commit status for a GitHub-linked change", async () => {
    const client = makeClient();
    const { db } = makeDb();

    await reportEvaluationToGitHub(
      { DB: db, GITHUB_TOKEN: "instance-token" },
      baseChange,
      baseProject,
      evaluation,
      logger,
    );

    expect(GitHubClient).toHaveBeenCalledWith("instance-token", logger);
    expect(client.postComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "api", issue_number: 12 }),
    );
    expect(client.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "headsha123", state: "success" }),
    );
  });

  it("prefers the change row's PR coordinates over the project's source repo", async () => {
    const client = makeClient();
    const { db } = makeDb();
    const change: Change = { ...baseChange, githubOwner: "fork-org", githubRepo: "fork-repo" };

    await reportEvaluationToGitHub(
      { DB: db, GITHUB_TOKEN: "tok" },
      change,
      baseProject,
      evaluation,
      logger,
    );

    expect(client.postComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "fork-org", repo: "fork-repo" }),
    );
  });

  it("uses the project's source repo when the change has no PR coordinates", async () => {
    const client = makeClient();
    const { db } = makeDb();
    const change: Change = { ...baseChange, githubOwner: undefined, githubRepo: undefined };

    await reportEvaluationToGitHub(
      { DB: db, GITHUB_TOKEN: "tok" },
      change,
      baseProject,
      evaluation,
      logger,
    );

    expect(client.postComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "api" }),
    );
  });

  it("does nothing when the change has no linked PR", async () => {
    const client = makeClient();
    const { db } = makeDb();
    const change: Change = { ...baseChange, githubPrNumber: undefined };

    await reportEvaluationToGitHub(
      { DB: db, GITHUB_TOKEN: "tok" },
      change,
      baseProject,
      evaluation,
      logger,
    );

    expect(client.postComment).not.toHaveBeenCalled();
    expect(client.setStatus).not.toHaveBeenCalled();
  });

  it("does nothing for a project without a GitHub source", async () => {
    const client = makeClient();
    const { db } = makeDb();
    const project: ProjectEntry = {
      ...baseProject,
      sourceUrl: undefined,
      sourceProvider: undefined,
    };

    await reportEvaluationToGitHub(
      { DB: db, GITHUB_TOKEN: "tok" },
      baseChange,
      project,
      evaluation,
      logger,
    );

    expect(client.postComment).not.toHaveBeenCalled();
    expect(client.setStatus).not.toHaveBeenCalled();
  });

  it("skips with a warning when GITHUB_TOKEN is not configured", async () => {
    const client = makeClient();
    const { db } = makeDb();

    await reportEvaluationToGitHub({ DB: db }, baseChange, baseProject, evaluation, logger);

    expect(client.postComment).not.toHaveBeenCalled();
    expect(client.setStatus).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "GITHUB_TOKEN not configured — skipping evaluation report to GitHub",
      { changeId: "chg_1" },
    );
  });

  it("still sets the commit status when the comment fails, and never throws", async () => {
    const client = makeClient({
      postComment: vi.fn().mockResolvedValue({ success: false, error: "500" }),
    });
    const { db } = makeDb();

    await expect(
      reportEvaluationToGitHub(
        { DB: db, GITHUB_TOKEN: "tok" },
        baseChange,
        baseProject,
        evaluation,
        logger,
      ),
    ).resolves.toBeUndefined();

    expect(client.setStatus).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to post evaluation comment to GitHub",
      expect.objectContaining({ changeId: "chg_1" }),
    );
  });

  it("logs but does not throw when a GitHub call throws unexpectedly", async () => {
    makeClient({
      postComment: vi.fn().mockRejectedValue(new Error("network exploded")),
    });
    const { db } = makeDb();

    await expect(
      reportEvaluationToGitHub(
        { DB: db, GITHUB_TOKEN: "tok" },
        baseChange,
        baseProject,
        evaluation,
        logger,
      ),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      "GitHub evaluation report threw; evaluation unaffected",
      expect.objectContaining({ changeId: "chg_1", error: "network exploded" }),
    );
  });

  it("stringifies non-Error throws from the GitHub client", async () => {
    makeClient({
      postComment: vi.fn().mockRejectedValue("weird rejection"),
    });
    const { db } = makeDb();

    await expect(
      reportEvaluationToGitHub(
        { DB: db, GITHUB_TOKEN: "tok" },
        baseChange,
        baseProject,
        evaluation,
        logger,
      ),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      "GitHub evaluation report threw; evaluation unaffected",
      expect.objectContaining({ changeId: "chg_1", error: "weird rejection" }),
    );
  });

  it("logs but does not throw when setting the status fails", async () => {
    makeClient({
      setStatus: vi.fn().mockResolvedValue({ success: false, error: "422" }),
    });
    const { db } = makeDb();

    await expect(
      reportEvaluationToGitHub(
        { DB: db, GITHUB_TOKEN: "tok" },
        baseChange,
        baseProject,
        evaluation,
        logger,
      ),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to set evaluation commit status on GitHub",
      expect.objectContaining({ changeId: "chg_1" }),
    );
  });
});

// ---------------------------------------------------------------------------
// buildEvaluationComment
// ---------------------------------------------------------------------------

describe("buildEvaluationComment", () => {
  it("renders the verdict, per-evaluator table, and footer", () => {
    const body = buildEvaluationComment(evaluation);
    expect(body).toContain("## ✅ Stratum Evaluation Results");
    expect(body).toContain("**Composite Score:** 92.0%");
    expect(body).toContain("**Status:** PASSED");
    expect(body).toContain("| secret_scan | 100.0% | ✅ | No secrets detected |");
    expect(body).toContain("| diff | 84.0% | ✅ | Diff passed all checks. |");
    expect(body).toContain("_Evaluation performed by [Stratum](https://stratum.dev)_");
  });

  it("renders a failed verdict", () => {
    const body = buildEvaluationComment({
      score: 0.1,
      passed: false,
      results: [{ evaluatorType: "diff", score: 0.1, passed: false, reason: "too big" }],
    });
    expect(body).toContain("## ❌ Stratum Evaluation Results");
    expect(body).toContain("**Status:** FAILED");
    expect(body).toContain("| diff | 10.0% | ❌ | too big |");
  });

  it("escapes pipes and truncates long reasons so the table stays intact", () => {
    const body = buildEvaluationComment({
      score: 1,
      passed: true,
      results: [
        {
          evaluatorType: "diff",
          score: 1,
          passed: true,
          reason: `a | b\nmultiline ${"x".repeat(300)}`,
        },
      ],
    });
    expect(body).toContain("a \\| b multiline");
    expect(body).toContain("…");
    expect(body).not.toContain("x".repeat(250));
  });
});
