import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { changesRouter } from "../src/routes/changes";
import type { Change, Env } from "../src/types";

vi.mock("../src/storage/changes", () => ({
  createChange: vi.fn(),
  getChange: vi.fn(),
  listChanges: vi.fn(),
  updateChangeStatus: vi.fn(),
}));

vi.mock("../src/storage/git-ops", () => ({
  getDiffBetweenRepos: vi.fn(),
  mergeWorkspaceIntoProject: vi.fn(),
}));

vi.mock("../src/storage/state", () => ({
  getProject: vi.fn(),
  getWorkspace: vi.fn(),
}));

vi.mock("../src/evaluation", () => ({
  loadPolicy: vi.fn(),
  DiffEvaluator: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn().mockResolvedValue({
      success: true,
      data: {
        score: 1,
        passed: true,
        reason: "Diff passed all checks.",
      },
    }),
  })),
  WebhookEvaluator: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn().mockResolvedValue({
      success: true,
      data: {
        score: 1,
        passed: true,
        reason: "Webhook passed.",
      },
    }),
  })),
  SecretScanEvaluator: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn().mockResolvedValue({
      success: true,
      data: {
        score: 1,
        passed: true,
        reason: "No secrets detected",
      },
    }),
  })),
  SandboxEvaluator: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn().mockResolvedValue({
      success: true,
      data: {
        score: 1,
        passed: true,
        reason: "Sandbox passed.",
      },
    }),
  })),
  LLMEvaluator: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn().mockResolvedValue({
      success: true,
      data: {
        score: 1,
        passed: true,
        reason: "LLM passed.",
      },
    }),
  })),
  CompositeEvaluator: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn().mockResolvedValue({
      success: true,
      data: [{ score: 1, passed: true, reason: "All evaluators passed." }],
    }),
    evaluateAndAggregate: vi.fn().mockResolvedValue({
      success: true,
      data: { score: 1, passed: true, reason: "All evaluators passed." },
    }),
    aggregate: vi.fn().mockReturnValue({
      score: 1,
      passed: true,
      reason: "All evaluators passed.",
    }),
  })),
}));

vi.mock("../src/storage/eval-runs", () => ({
  listEvalRuns: vi.fn().mockResolvedValue([]),
  recordEvalRuns: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/storage/provenance", () => ({
  recordProvenance: vi.fn().mockResolvedValue({}),
}));

vi.mock("../src/queue/events", () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(),
}));

// Need to setup mocks in beforeEach instead

vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(),
}));

import { CompositeEvaluator, SecretScanEvaluator, loadPolicy } from "../src/evaluation";
import { getAgentByToken } from "../src/storage/agents";
import { createChange, getChange, listChanges, updateChangeStatus } from "../src/storage/changes";
import { listEvalRuns, recordEvalRuns } from "../src/storage/eval-runs";
import { getDiffBetweenRepos, mergeWorkspaceIntoProject } from "../src/storage/git-ops";
import { getProject, getWorkspace } from "../src/storage/state";
import { getUserByToken } from "../src/storage/users";

const USER_AUTH = { Authorization: "Bearer stratum_user_testtoken00000000000000000" };
const OTHER_USER_AUTH = { Authorization: "Bearer stratum_user_othertoken000000000000000" };
const AGENT_AUTH = { Authorization: "Bearer stratum_agent_testtoken0000000000000000" };

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.route("/api", changesRouter);
  return app;
}

function makeEnv(): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: {} as KVNamespace,
    DB: {} as D1Database,
  };
}

function request(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  const hasBody = body !== undefined;
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
}

import { AppError, NotFoundError } from "../src/utils/errors";

const mockProject = {
  id: "proj_test123",
  name: "my-project",
  slug: "my-project",
  namespace: "user_test",
  ownerId: "user_test",
  ownerType: "user" as const,
  remote: "https://artifacts.example.com/repos/my-project",
  token: "tok_project",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const mockWorkspace = {
  name: "fix-bug",
  remote: "https://artifacts.example.com/repos/fix-bug",
  token: "tok_workspace",
  parent: "my-project",
  createdAt: "2026-01-01T01:00:00.000Z",
};

const mockChange: Change = {
  id: "chg_abc123",
  project: "my-project",
  workspace: "fix-bug",
  status: "open",
  createdAt: "2026-01-01T02:00:00.000Z",
};

const mockPolicy = {
  evaluators: [{ type: "diff" as const }],
  requireAll: true,
  minScore: 0.7,
};

const passingEvalResult = {
  score: 1.0,
  passed: true,
  reason: "Diff passed all checks.",
};

const failingEvalResult = {
  score: 0.2,
  passed: false,
  reason: "Diff failed: too many lines.",
};

describe("POST /api/projects/:name/changes", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
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
      if (token === "stratum_user_othertoken000000000000000") {
        return {
          success: true,
          data: {
            id: "user_other",
            email: "other@example.com",
            username: "other",
            tokenHash: "hash",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        };
      }
      return {
        success: false,
        error: new NotFoundError("User", token),
      };
    });
    vi.mocked(getAgentByToken).mockImplementation(async (_db, token) => {
      if (token === "stratum_agent_testtoken0000000000000000") {
        return {
          success: true,
          data: {
            id: "agent_test",
            ownerId: "user_test",
            name: "test-agent",
            tokenHash: "hash",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        };
      }
      return {
        success: false,
        error: new NotFoundError("Agent", token),
      };
    });
    vi.mocked(getProject).mockResolvedValue({
      success: true,
      data: mockProject,
    });
    vi.mocked(getWorkspace).mockResolvedValue({
      success: true,
      data: mockWorkspace,
    });
    vi.mocked(createChange).mockResolvedValue({
      success: true,
      data: mockChange,
    });
    vi.mocked(loadPolicy).mockResolvedValue(mockPolicy);
    vi.mocked(getDiffBetweenRepos).mockResolvedValue({
      success: true,
      data: "diff --git a/src/index.ts b/src/index.ts\n+new line",
    });
    vi.mocked(updateChangeStatus).mockResolvedValue({
      success: true,
      data: undefined,
    });
    vi.mocked(recordEvalRuns).mockResolvedValue({
      success: true,
      data: [],
    });
    vi.mocked(CompositeEvaluator).mockImplementation(
      () =>
        ({
          evaluate: vi.fn().mockResolvedValue({
            success: true,
            data: [passingEvalResult],
          }),
          evaluateAndAggregate: vi.fn().mockResolvedValue({
            success: true,
            data: passingEvalResult,
          }),
          aggregate: vi.fn().mockReturnValue(passingEvalResult),
        }) as unknown as CompositeEvaluator,
    );
  });

  it("creates a change, runs evaluators, and returns accepted status when eval passes", async () => {
    const res = await app.fetch(
      request("POST", "/api/projects/my-project/changes", { workspace: "fix-bug" }, USER_AUTH),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      change: Change;
      eval: typeof passingEvalResult;
      evalRuns: unknown[];
    };
    expect(body.change.status).toBe("accepted");
    expect(body.change.evalPassed).toBe(true);
    expect(body.eval.passed).toBe(true);
    expect(updateChangeStatus).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      "chg_abc123",
      "accepted",
      expect.objectContaining({ evalPassed: true }),
    );
    expect(recordEvalRuns).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      "chg_abc123",
      expect.arrayContaining([
        expect.objectContaining({ evaluatorType: "secret_scan" }),
        expect.objectContaining({ evaluatorType: "diff" }),
      ]),
    );
  });

  it("creates a change when authenticated as agent", async () => {
    const res = await app.fetch(
      request("POST", "/api/projects/my-project/changes", { workspace: "fix-bug" }, AGENT_AUTH),
      env,
    );
    expect(res.status).toBe(201);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await app.fetch(
      request("POST", "/api/projects/my-project/changes", { workspace: "fix-bug" }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller does not own project", async () => {
    const res = await app.fetch(
      request(
        "POST",
        "/api/projects/my-project/changes",
        { workspace: "fix-bug" },
        OTHER_USER_AUTH,
      ),
      env,
    );
    expect(res.status).toBe(403);
    expect(createChange).not.toHaveBeenCalled();
  });

  it("returns needs_changes status when eval fails", async () => {
    vi.mocked(CompositeEvaluator).mockImplementation(
      () =>
        ({
          evaluate: vi.fn().mockResolvedValue({
            success: true,
            data: [failingEvalResult],
          }),
          evaluateAndAggregate: vi.fn().mockResolvedValue({
            success: true,
            data: failingEvalResult,
          }),
          aggregate: vi.fn().mockReturnValue(failingEvalResult),
        }) as unknown as CompositeEvaluator,
    );

    const res = await app.fetch(
      request("POST", "/api/projects/my-project/changes", { workspace: "fix-bug" }, USER_AUTH),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { change: Change; eval: typeof failingEvalResult };
    expect(body.change.status).toBe("needs_changes");
    expect(body.change.evalPassed).toBe(false);
    expect(body.eval.passed).toBe(false);
    expect(updateChangeStatus).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      "chg_abc123",
      "needs_changes",
      expect.objectContaining({ evalPassed: false }),
    );
  });

  it("keeps secret scan failures blocking even when policy allows any evaluator to pass", async () => {
    vi.mocked(loadPolicy).mockResolvedValue({
      evaluators: [{ type: "diff" }],
      requireAll: false,
      minScore: 0.7,
    });
    vi.mocked(SecretScanEvaluator).mockImplementationOnce(
      () =>
        ({
          evaluate: vi.fn().mockResolvedValue({
            success: true,
            data: {
              score: 0,
              passed: false,
              reason: "Secret detected: AWS Access Key",
              issues: ["AWS Access Key: line 4"],
            },
          }),
        }) as unknown as SecretScanEvaluator,
    );
    vi.mocked(CompositeEvaluator).mockImplementation(
      () =>
        ({
          evaluate: vi.fn().mockResolvedValue({
            success: true,
            data: [
              {
                score: 1,
                passed: true,
                reason: "All evaluators passed.",
              },
            ],
          }),
          evaluateAndAggregate: vi.fn().mockResolvedValue({
            success: true,
            data: {
              score: 1,
              passed: true,
              reason: "All evaluators passed.",
            },
          }),
          aggregate: vi.fn().mockReturnValue({
            score: 1,
            passed: true,
            reason: "All evaluators passed.",
          }),
        }) as unknown as CompositeEvaluator,
    );

    const res = await app.fetch(
      request("POST", "/api/projects/my-project/changes", { workspace: "fix-bug" }, USER_AUTH),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { change: Change; eval: typeof failingEvalResult };
    expect(body.change.status).toBe("needs_changes");
    expect(body.eval.passed).toBe(false);
    expect(body.eval.reason).toContain("Secret detected");
  });

  it("records unavailable sandbox evaluator when SANDBOX binding is missing", async () => {
    vi.mocked(loadPolicy).mockResolvedValue({
      evaluators: [{ type: "sandbox" }],
      requireAll: true,
      minScore: 0.7,
    });

    const res = await app.fetch(
      request("POST", "/api/projects/my-project/changes", { workspace: "fix-bug" }, USER_AUTH),
      env,
    );
    expect(res.status).toBe(201);
    expect(recordEvalRuns).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      "chg_abc123",
      expect.arrayContaining([
        expect.objectContaining({
          evaluatorType: "sandbox",
          result: expect.objectContaining({
            passed: false,
            reason: expect.stringContaining("SANDBOX binding is not configured"),
          }),
        }),
      ]),
    );
  });

  it("returns 404 when project not found", async () => {
    vi.mocked(getProject).mockResolvedValue({
      success: false,
      error: new NotFoundError("Project", "no-such-project"),
    });
    const res = await app.fetch(
      request("POST", "/api/projects/no-such-project/changes", { workspace: "fix-bug" }, USER_AUTH),
      env,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no-such-project");
  });

  it("returns 400 when workspace is missing from body", async () => {
    const res = await app.fetch(
      request("POST", "/api/projects/my-project/changes", {}, USER_AUTH),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when workspace does not exist", async () => {
    vi.mocked(getWorkspace).mockResolvedValue({
      success: false,
      error: new NotFoundError("Workspace", "nonexistent"),
    });
    const res = await app.fetch(
      request("POST", "/api/projects/my-project/changes", { workspace: "nonexistent" }, USER_AUTH),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when workspace does not belong to project", async () => {
    vi.mocked(getWorkspace).mockResolvedValue({
      success: true,
      data: { ...mockWorkspace, parent: "other-project" },
    });
    const res = await app.fetch(
      request("POST", "/api/projects/my-project/changes", { workspace: "fix-bug" }, USER_AUTH),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("does not belong to project");
  });
});

describe("GET /api/projects/:name/changes", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
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
      if (token === "stratum_user_othertoken000000000000000") {
        return {
          success: true,
          data: {
            id: "user_other",
            email: "other@example.com",
            username: "other",
            tokenHash: "hash",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        };
      }
      return {
        success: false,
        error: new NotFoundError("User", token),
      };
    });
    vi.mocked(getProject).mockResolvedValue({
      success: true,
      data: mockProject,
    });
    vi.mocked(listChanges).mockResolvedValue({
      success: true,
      data: [mockChange],
    });
  });

  it("lists changes for a project", async () => {
    const res = await app.fetch(
      request("GET", "/api/projects/my-project/changes", undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: string; changes: Change[] };
    expect(body.project).toBe("my-project");
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]?.id).toBe("chg_abc123");
    expect(listChanges).toHaveBeenCalledWith(env.DB, expect.any(Object), "my-project", undefined);
  });

  it("filters by status when ?status= is provided", async () => {
    vi.mocked(listChanges).mockResolvedValue({
      success: true,
      data: [],
    });
    const res = await app.fetch(
      request("GET", "/api/projects/my-project/changes?status=open", undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
    expect(listChanges).toHaveBeenCalledWith(env.DB, expect.any(Object), "my-project", "open");
  });

  it("filters by promoted status when ?status= is provided", async () => {
    vi.mocked(listChanges).mockResolvedValue({
      success: true,
      data: [],
    });
    const res = await app.fetch(
      request("GET", "/api/projects/my-project/changes?status=promoted", undefined, USER_AUTH),
      env,
    );

    expect(res.status).toBe(200);
    expect(listChanges).toHaveBeenCalledWith(env.DB, expect.any(Object), "my-project", "promoted");
  });

  it("returns 404 when project not found", async () => {
    vi.mocked(getProject).mockResolvedValue({
      success: false,
      error: new NotFoundError("Project", "nope"),
    });
    const res = await app.fetch(
      request("GET", "/api/projects/nope/changes", undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when listing another user's private project changes", async () => {
    const res = await app.fetch(
      request("GET", "/api/projects/my-project/changes", undefined, OTHER_USER_AUTH),
      env,
    );
    expect(res.status).toBe(403);
    expect(listChanges).not.toHaveBeenCalled();
  });
});

describe("GET /api/changes/:id", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
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
      if (token === "stratum_user_othertoken000000000000000") {
        return {
          success: true,
          data: {
            id: "user_other",
            email: "other@example.com",
            username: "other",
            tokenHash: "hash",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        };
      }
      return {
        success: false,
        error: new NotFoundError("User", token),
      };
    });
  });

  it("returns a single change by id", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: mockChange,
    });
    vi.mocked(getProject).mockResolvedValue({
      success: true,
      data: mockProject,
    });
    vi.mocked(listEvalRuns).mockResolvedValue({
      success: true,
      data: [
        {
          id: "evl_abc123",
          changeId: "chg_abc123",
          evaluatorType: "diff",
          score: 1,
          passed: true,
          reason: "ok",
          ranAt: "2026-01-01T02:01:00.000Z",
        },
      ],
    });
    const res = await app.fetch(
      request("GET", "/api/changes/chg_abc123", undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { change: Change; evalRuns: unknown[] };
    expect(body.change.id).toBe("chg_abc123");
    expect(body.change.project).toBe("my-project");
    expect(body.evalRuns).toHaveLength(1);
  });
  it("returns 404 when change not found", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: false,
      error: new NotFoundError("Change", "chg_missing"),
    });

    const res = await app.fetch(
      request("GET", "/api/changes/chg_missing", undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when reading another user's private change", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: mockChange,
    });
    vi.mocked(getProject).mockResolvedValue({
      success: true,
      data: mockProject,
    });
    const res = await app.fetch(
      request("GET", "/api/changes/chg_abc123", undefined, OTHER_USER_AUTH),
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /api/changes/:id/merge", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
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
      if (token === "stratum_user_othertoken000000000000000") {
        return {
          success: true,
          data: {
            id: "user_other",
            email: "other@example.com",
            username: "other",
            tokenHash: "hash",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        };
      }
      return {
        success: false,
        error: new NotFoundError("User", token),
      };
    });
    vi.mocked(getProject).mockResolvedValue({
      success: true,
      data: mockProject,
    });
    vi.mocked(getWorkspace).mockResolvedValue({
      success: true,
      data: mockWorkspace,
    });
    vi.mocked(mergeWorkspaceIntoProject).mockResolvedValue({
      success: true,
      data: "sha_merged",
    });
    vi.mocked(updateChangeStatus).mockResolvedValue({
      success: true,
      data: undefined,
    });
  });

  it("merges an approved change and returns merged=true", async () => {
    const approvedChange: Change = { ...mockChange, status: "accepted" };
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: approvedChange,
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/merge", undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merged: boolean;
      changeId: string;
      project: string;
      workspace: string;
      commit: string;
    };
    expect(body.merged).toBe(true);
    expect(body.changeId).toBe("chg_abc123");
    expect(body.project).toBe("my-project");
    expect(body.workspace).toBe("fix-bug");
    expect(body.commit).toBe("sha_merged");
    expect(mergeWorkspaceIntoProject).toHaveBeenCalledWith(
      "https://artifacts.example.com/repos/my-project",
      "tok_project",
      "https://artifacts.example.com/repos/fix-bug",
      "tok_workspace",
      expect.any(Object),
      { strategy: "merge" },
    );
    expect(updateChangeStatus).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      "chg_abc123",
      "merged",
      expect.objectContaining({ mergedAt: expect.any(String) }),
    );
  });

  it("merges an accepted change", async () => {
    const acceptedChange: Change = { ...mockChange, status: "accepted" };
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: acceptedChange,
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/merge", undefined, USER_AUTH),
      env,
    );

    expect(res.status).toBe(200);
    expect(mergeWorkspaceIntoProject).toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    const approvedChange: Change = { ...mockChange, status: "accepted" };
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: approvedChange,
    });

    const res = await app.fetch(request("POST", "/api/changes/chg_abc123/merge"), env);
    expect(res.status).toBe(401);
  });

  it("returns 403 when merging another user's project", async () => {
    const approvedChange: Change = { ...mockChange, status: "accepted" };
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: approvedChange,
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/merge", undefined, OTHER_USER_AUTH),
      env,
    );
    expect(res.status).toBe(403);
    expect(mergeWorkspaceIntoProject).not.toHaveBeenCalled();
  });

  it("returns 400 when change is not accepted", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: mockChange,
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/merge", undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("accepted");
    expect(mergeWorkspaceIntoProject).not.toHaveBeenCalled();
  });

  it("merges even non-approved change when ?force=true", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: mockChange,
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/merge?force=true", undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: boolean };
    expect(body.merged).toBe(true);
    expect(mergeWorkspaceIntoProject).toHaveBeenCalled();
  });

  it("passes explicit squash strategy to merge implementation", async () => {
    const approvedChange: Change = { ...mockChange, status: "accepted" };
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: approvedChange,
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/merge?strategy=squash", undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
    expect(mergeWorkspaceIntoProject).toHaveBeenCalledWith(
      "https://artifacts.example.com/repos/my-project",
      "tok_project",
      "https://artifacts.example.com/repos/fix-bug",
      "tok_workspace",
      expect.any(Object),
      { strategy: "squash" },
    );
  });

  it("returns 400 when merge implementation reports a conflict", async () => {
    const approvedChange: Change = { ...mockChange, status: "accepted" };
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: approvedChange,
    });
    vi.mocked(mergeWorkspaceIntoProject).mockResolvedValue({
      success: false,
      error: new AppError(
        "Merge failed; workspace may be stale or conflicting",
        "MERGE_CONFLICT",
        409,
      ),
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/merge", undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("stale or conflicting");
    expect(updateChangeStatus).not.toHaveBeenCalled();
  });

  it("rejects unknown merge strategy", async () => {
    const approvedChange: Change = { ...mockChange, status: "accepted" };
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: approvedChange,
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/merge?strategy=rebase", undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(400);
    expect(mergeWorkspaceIntoProject).not.toHaveBeenCalled();
  });

  it("returns 404 when change not found", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: false,
      error: new NotFoundError("Change", "chg_missing"),
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_missing/merge", undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/changes/:id/reject", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
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
      if (token === "stratum_user_othertoken000000000000000") {
        return {
          success: true,
          data: {
            id: "user_other",
            email: "other@example.com",
            username: "other",
            tokenHash: "hash",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        };
      }
      return {
        success: false,
        error: new NotFoundError("User", token),
      };
    });
    vi.mocked(getProject).mockResolvedValue({
      success: true,
      data: mockProject,
    });
    vi.mocked(updateChangeStatus).mockResolvedValue({
      success: true,
      data: undefined,
    });
  });

  it("rejects an open change", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: mockChange,
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/reject", undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rejected: boolean; changeId: string };
    expect(body.rejected).toBe(true);
    expect(body.changeId).toBe("chg_abc123");
    expect(updateChangeStatus).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      "chg_abc123",
      "rejected",
      expect.any(Object),
    );
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: mockChange,
    });

    const res = await app.fetch(request("POST", "/api/changes/chg_abc123/reject"), env);
    expect(res.status).toBe(401);
  });

  it("returns 403 when rejecting another user's project change", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: mockChange,
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/reject", undefined, OTHER_USER_AUTH),
      env,
    );
    expect(res.status).toBe(403);
    expect(updateChangeStatus).not.toHaveBeenCalled();
  });

  it("returns 400 when trying to reject a merged change", async () => {
    const mergedChange: Change = {
      ...mockChange,
      status: "merged",
      mergedAt: "2026-01-01T03:00:00.000Z",
    };
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: mergedChange,
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/reject", undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Cannot reject a merged change");
    expect(updateChangeStatus).not.toHaveBeenCalled();
  });

  it("returns 404 when change not found", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: false,
      error: new NotFoundError("Change", "chg_missing"),
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_missing/reject", undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(404);
  });
});
