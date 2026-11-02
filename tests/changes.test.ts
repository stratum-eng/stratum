import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { changesRouter } from "../src/routes/changes";
import type { Change, Env } from "../src/types";

vi.mock("../src/storage/changes", () => ({
  createChange: vi.fn(),
  getChange: vi.fn(),
  getChangesByIds: vi.fn(),
  listChanges: vi.fn(),
  updateChangeStatus: vi.fn(async () => ({ success: true, data: undefined })),
  dismissApprovalsAndUpdateStatus: vi.fn(async () => ({
    success: true,
    data: { dismissedReviewerIds: [] },
  })),
  // Default: this request won the transition, so the merge path emits + records.
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
    pushBranchToRemote: vi.fn(async () => ({ success: true, data: undefined })),
    resolveLocalTip: vi.fn(),
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

vi.mock("../src/storage/change-reviews", () => ({
  countApprovals: vi.fn(async () => ({ success: true, data: 0 })),
}));

vi.mock("../src/storage/audit", () => ({
  recordAudit: vi.fn(async () => ({ success: true, data: undefined })),
}));

vi.mock("../src/queue/events", () => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
}));

// The default matches what the real module does for the policies these tests
// use — no postMergeCommand, so nothing runs. Tests of the deploy trigger
// override it, because that trigger keys off this result.
vi.mock("../src/merge/post-merge", () => ({
  runPostMergeCheck: vi.fn(async () => ({ status: "skipped" })),
}));

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(),
  // Agent auth resolves the agent's owner via getUser (fail-closed on the
  // owner lookup); default to a live owner so agent-token tests authenticate
  // as before unless a test overrides this to exercise the deleting/failed path.
  getUser: vi.fn(async () => ({
    success: true,
    data: {
      id: "usr_owner",
      email: "owner@example.com",
      username: "owner",
      tokenHash: "hash",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  })),
}));

// Need to setup mocks in beforeEach instead

vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(),
  getAgent: vi.fn(),
}));

import {
  CompositeEvaluator,
  SecretScanEvaluator,
  diffTouchesProtectedConfig,
  loadPolicy,
} from "../src/evaluation";
import { resetCircuitBreakersForTests } from "../src/github/client";
import { runPostMergeCheck } from "../src/merge/post-merge";
import { emitEvent } from "../src/queue/events";
import { getAgent, getAgentByToken } from "../src/storage/agents";
import { recordAudit } from "../src/storage/audit";
import {
  createChange,
  dismissApprovalsAndUpdateStatus,
  getChange,
  getChangesByIds,
  listChanges,
  markChangeMerged,
  updateChangeStatus,
} from "../src/storage/changes";
import { isTargetDeleting } from "../src/storage/deletion";
import { listEvalRuns, recordEvalRuns } from "../src/storage/eval-runs";
import {
  MergeConflictError,
  type NodeFS,
  batchMergeStagedTrees,
  cloneRepo,
  freshRepoToken,
  getCommitLog,
  getDiffBetweenRepos,
  mergeWorkspaceIntoProject,
  pushBranchToRemote,
  resolveLocalTip,
} from "../src/storage/git-ops";
import { packObjects } from "../src/storage/object-loader";
import { recordProvenance } from "../src/storage/provenance";
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
  createdAt: "2026-01-01T00:00:00.000Z",
};

const mockWorkspace = {
  name: "fix-bug",
  remote: "https://artifacts.example.com/repos/fix-bug",
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
    vi.mocked(getAgent).mockResolvedValue({
      success: true,
      data: {
        id: "agent_test",
        ownerId: "user_test",
        name: "test-agent",
        model: "claude-fable-5",
        promptHash: "sha256:promptdigest",
        tokenHash: "hash",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
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
    vi.mocked(getCommitLog).mockResolvedValue({
      success: true,
      data: [{ sha: "sha_base", message: "m", author: "a", timestamp: 0 }],
    });
    vi.mocked(getDiffBetweenRepos).mockResolvedValue({
      success: true,
      data: {
        diff: "diff --git a/src/index.ts b/src/index.ts\n+new line",
        workspaceOid: "ws_tip_sha",
        workspaceTreeOid: "ws_tree_oid",
        workspaceSha: "ws_tip_sha",
        baseOid: "base_sha_from_diff_clone",
      },
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

  it("409s when the project is being deleted (no change created)", async () => {
    vi.mocked(isTargetDeleting).mockResolvedValueOnce(true);
    const res = await app.fetch(
      request("POST", "/api/projects/my-project/changes", { workspace: "fix-bug" }, USER_AUTH),
      env,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("TARGET_DELETING");
    expect(vi.mocked(createChange)).not.toHaveBeenCalled();
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
      // Pins the evaluated workspace commit (from the diff's own clone) for a sound
      // merge — both the #115 select (workspaceHeadSha) and SEC-2 assert (evaluatedSha).
      expect.objectContaining({
        evalPassed: true,
        evaluatedSha: "ws_tip_sha",
        workspaceHeadSha: "ws_tip_sha",
      }),
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

  it("snapshots the agent's model and prompt hash onto the change (PROV)", async () => {
    await app.fetch(
      request("POST", "/api/projects/my-project/changes", { workspace: "fix-bug" }, AGENT_AUTH),
      env,
    );
    expect(createChange).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({
        agentId: "agent_test",
        agentModel: "claude-fable-5",
        agentPromptHash: "sha256:promptdigest",
      }),
    );
  });

  it("records the evaluated workspace sha on the change (SEC-2)", async () => {
    await app.fetch(
      request("POST", "/api/projects/my-project/changes", { workspace: "fix-bug" }, USER_AUTH),
      env,
    );
    expect(updateChangeStatus).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ evaluatedSha: "ws_tip_sha" }),
    );
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

  it("accepts a workspace whose parent stores the project id", async () => {
    // Workspaces created via the namespaced API store the project id, not its name.
    vi.mocked(getWorkspace).mockResolvedValue({
      success: true,
      data: { ...mockWorkspace, parent: mockProject.id },
    });
    const res = await app.fetch(
      request("POST", "/api/projects/my-project/changes", { workspace: "fix-bug" }, USER_AUTH),
      env,
    );
    expect(res.status).toBe(201);
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
    expect(listChanges).toHaveBeenCalledWith(env.DB, expect.any(Object), "my-project", undefined, {
      projectId: mockProject.id,
      limit: 100,
    });
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
    expect(listChanges).toHaveBeenCalledWith(env.DB, expect.any(Object), "my-project", "open", {
      projectId: mockProject.id,
      limit: 100,
    });
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
    expect(listChanges).toHaveBeenCalledWith(env.DB, expect.any(Object), "my-project", "promoted", {
      projectId: mockProject.id,
      limit: 100,
    });
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

  it("returns 404 when listing another user's private project changes", async () => {
    const res = await app.fetch(
      request("GET", "/api/projects/my-project/changes", undefined, OTHER_USER_AUTH),
      env,
    );
    expect(res.status).toBe(404);
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

  it("returns 404 when reading another user's private change", async () => {
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
    expect(res.status).toBe(404);
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
    // Distinct tokens per repo so merge assertions catch a project/workspace swap.
    // The merge path mints three tokens (policy-read + merge-write on the project,
    // merge-read on the workspace), so we key the mock on the remote rather than
    // relying on call order.
    vi.mocked(freshRepoToken).mockImplementation(async (_artifacts, remote) => ({
      success: true,
      data: remote === mockWorkspace.remote ? "workspace-token" : "project-token",
    }));
    vi.mocked(updateChangeStatus).mockResolvedValue({
      success: true,
      data: undefined,
    });
    // Default policy: no branch-protection rules.
    vi.mocked(loadPolicy).mockResolvedValue({ evaluators: [], requireAll: true, minScore: 0.7 });
    vi.mocked(getCommitLog).mockResolvedValue({
      success: true,
      data: [{ sha: "sha_head", message: "m", author: "a", timestamp: 0 }],
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
      "project-token",
      "https://artifacts.example.com/repos/fix-bug",
      "workspace-token",
      expect.any(Object),
      { strategy: "merge", branch: "main" },
    );
    expect(markChangeMerged).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      "chg_abc123",
      expect.objectContaining({ mergedAt: expect.any(String) }),
    );
  });

  it("emits change.merged when this request wins the transition (guards the unsafe direction)", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...mockChange, status: "accepted" },
    });
    vi.mocked(markChangeMerged).mockResolvedValueOnce({
      success: true,
      data: { transitioned: true },
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/merge", undefined, USER_AUTH),
      env,
    );

    expect(res.status).toBe(200);
    expect(emitEvent).toHaveBeenCalledWith(
      env.DB,
      env.EVENTS_QUEUE,
      expect.objectContaining({ type: "change.merged", changeId: "chg_abc123" }),
      expect.any(Object),
      expect.any(Object),
      expect.anything(),
    );
  });

  it("does NOT re-emit change.merged when a concurrent request already merged (dedup)", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...mockChange, status: "accepted" },
    });
    // This request's CAS found the change already merged: transitioned = false.
    vi.mocked(markChangeMerged).mockResolvedValueOnce({
      success: true,
      data: { transitioned: false },
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/merge", undefined, USER_AUTH),
      env,
    );

    // Still reports success (idempotent), but fires no second change.merged event.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: boolean };
    expect(body.merged).toBe(true);
    const mergedEmits = vi
      .mocked(emitEvent)
      .mock.calls.filter((call) => (call[2] as { type?: string })?.type === "change.merged");
    expect(mergedEmits).toHaveLength(0);
  });

  it("merges the pinned evaluated sha, not the workspace's live tip", async () => {
    const pinnedChange: Change = {
      ...mockChange,
      status: "accepted",
      workspaceHeadSha: "sha_evaluated",
    };
    vi.mocked(getChange).mockResolvedValue({ success: true, data: pinnedChange });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/merge", undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
    expect(mergeWorkspaceIntoProject).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ workspaceSha: "sha_evaluated" }),
    );
  });

  it("redirects browser form posts back to the change page after merging", async () => {
    const acceptedChange: Change = { ...mockChange, status: "accepted" };
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: acceptedChange,
    });

    const res = await app.fetch(
      new Request("http://localhost/api/changes/chg_abc123/merge", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...USER_AUTH,
        },
        body: "",
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/changes/chg_abc123");
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

  it("SEC-2: pins the cold merge to the evaluated sha (expectedWorkspaceSha)", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...mockChange, status: "accepted", evaluatedSha: "sha_head" },
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/merge", undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
    const opts = vi.mocked(mergeWorkspaceIntoProject).mock.calls[0]?.[5] as {
      expectedWorkspaceSha?: string;
    };
    expect(opts.expectedWorkspaceSha).toBe("sha_head");
  });

  it("SEC-2: maps a STALE_WORKSPACE cold-merge error to 409", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...mockChange, status: "accepted", evaluatedSha: "sha_head" },
    });
    vi.mocked(mergeWorkspaceIntoProject).mockResolvedValue({
      success: false,
      error: new AppError("Workspace changed since evaluation", "STALE_WORKSPACE", 409),
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/merge", undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("STALE_WORKSPACE");
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
    // Force is deny-by-default; this project opts in.
    vi.mocked(loadPolicy).mockResolvedValue({ ...mockPolicy, merge: { allowForce: true } });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/merge?force=true", undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: boolean };
    expect(body.merged).toBe(true);
    expect(mergeWorkspaceIntoProject).toHaveBeenCalled();
  });

  it("refuses to force-merge a change that edits the protection config, even with allowForce (SA-3)", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...mockChange, touchesProtectedConfig: true },
    });
    // Even where the policy permits force, a protection-config edit can't skip
    // the approval gate.
    vi.mocked(loadPolicy).mockResolvedValue({ ...mockPolicy, merge: { allowForce: true } });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/merge?force=true", undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(400);
    expect(mergeWorkspaceIntoProject).not.toHaveBeenCalled();
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
      "project-token",
      "https://artifacts.example.com/repos/fix-bug",
      "workspace-token",
      expect.any(Object),
      { strategy: "squash", branch: "main" },
    );
  });

  it("returns 409 with the conflicting file list and persists conflict context (#185)", async () => {
    const approvedChange: Change = { ...mockChange, status: "accepted" };
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: approvedChange,
    });
    vi.mocked(mergeWorkspaceIntoProject).mockResolvedValue({
      success: false,
      error: new MergeConflictError("Merge failed; workspace may be stale or conflicting", [
        "src/a.ts",
        "docs/readme.md",
      ]),
    });
    const put = vi.fn(async (_key: string, _value: string, _opts?: unknown) => undefined);
    env.STATE = { put } as unknown as KVNamespace;

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/merge", undefined, USER_AUTH),
      env,
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      conflictId: string;
      conflictingFiles: string[];
    };
    expect(body.code).toBe("MERGE_CONFLICT");
    expect(body.conflictingFiles).toEqual(["src/a.ts", "docs/readme.md"]);
    expect(body.conflictId).toBeTruthy();

    // The persisted conflict context carries the same file list for the
    // resolution flow.
    expect(put).toHaveBeenCalledWith(
      `conflict:${body.conflictId}`,
      expect.any(String),
      expect.objectContaining({ expirationTtl: expect.any(Number) }),
    );
    const persisted = JSON.parse(put.mock.calls[0]?.[1] ?? "{}") as {
      conflictingFiles: string[];
      workspaceName: string;
    };
    expect(persisted.conflictingFiles).toEqual(["src/a.ts", "docs/readme.md"]);
    expect(persisted.workspaceName).toBe("fix-bug");
    expect(markChangeMerged).not.toHaveBeenCalled();
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

  it("blocks merge with 403 when required evaluators are missing", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...mockChange, status: "accepted" },
    });
    vi.mocked(loadPolicy).mockResolvedValue({
      evaluators: [],
      merge: { requiredEvaluators: ["secret_scan"] },
    });
    vi.mocked(listEvalRuns).mockResolvedValue({ success: true, data: [] });

    const res = await app.fetch(
      request("POST", `/api/changes/${mockChange.id}/merge`, undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; reasons: string[] };
    expect(body.code).toBe("PROTECTION_BLOCKED");
    expect(body.reasons[0]).toContain("secret_scan");
  });

  it("merges when required evaluators have passing latest runs", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...mockChange, status: "accepted" },
    });
    vi.mocked(loadPolicy).mockResolvedValue({
      evaluators: [],
      merge: { requiredEvaluators: ["secret_scan"] },
    });
    vi.mocked(listEvalRuns).mockResolvedValue({
      success: true,
      data: [
        {
          id: "run_1",
          changeId: mockChange.id,
          evaluatorType: "secret_scan",
          score: 1,
          passed: true,
          reason: "ok",
          ranAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const res = await app.fetch(
      request("POST", `/api/changes/${mockChange.id}/merge`, undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: boolean };
    expect(body.merged).toBe(true);
  });

  it("rejects ?force=true when the policy disables force merges", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...mockChange, status: "open" },
    });
    vi.mocked(loadPolicy).mockResolvedValue({
      evaluators: [],
      merge: { allowForce: false },
    });

    const res = await app.fetch(
      request("POST", `/api/changes/${mockChange.id}/merge?force=true`, undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Force merge is disabled");
  });

  it("SEC-3: rejects ?force=true by default when no policy enables it", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...mockChange, status: "open" },
    });
    // Default policy (mockPolicy) has no merge block → force denied.
    vi.mocked(loadPolicy).mockResolvedValue(mockPolicy);

    const res = await app.fetch(
      request("POST", `/api/changes/${mockChange.id}/merge?force=true`, undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Force merge is disabled");
  });

  it("returns 409 STALE_BASE when requireFreshBase is set and the base moved", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...mockChange, status: "accepted", baseSha: "sha_old" },
    });
    vi.mocked(loadPolicy).mockResolvedValue({
      evaluators: [],
      merge: { requireFreshBase: true },
    });

    const res = await app.fetch(
      request("POST", `/api/changes/${mockChange.id}/merge`, undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; currentHead: string };
    expect(body.code).toBe("STALE_BASE");
    expect(body.currentHead).toBe("sha_head");
  });

  it("SEC-2: returns 409 STALE_WORKSPACE when the workspace moved since evaluation", async () => {
    // Workspace tip resolves to "sha_head" (getCommitLog mock); this change was
    // evaluated against a different sha.
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...mockChange, status: "accepted", evaluatedSha: "sha_evaluated_old" },
    });

    const res = await app.fetch(
      request("POST", `/api/changes/${mockChange.id}/merge`, undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; currentTip: string; evaluatedSha: string };
    expect(body.code).toBe("STALE_WORKSPACE");
    expect(body.currentTip).toBe("sha_head");
    expect(body.evaluatedSha).toBe("sha_evaluated_old");
    expect(mergeWorkspaceIntoProject).not.toHaveBeenCalled();
  });

  it("SEC-2: merges when the workspace tip still matches the evaluated sha", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...mockChange, status: "accepted", evaluatedSha: "sha_head" },
    });

    const res = await app.fetch(
      request("POST", `/api/changes/${mockChange.id}/merge`, undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
  });

  it("SEC-2: fails closed with 409 when the workspace tip can't be resolved", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...mockChange, status: "accepted", evaluatedSha: "sha_head" },
    });
    // Tip resolution fails (e.g. token-mint / clone failure) → currentTip null.
    vi.mocked(getCommitLog).mockResolvedValue({
      success: false,
      error: new AppError("clone failed", "GIT_ERROR", 500),
    });

    const res = await app.fetch(
      request("POST", `/api/changes/${mockChange.id}/merge`, undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("WORKSPACE_UNVERIFIABLE");
    expect(mergeWorkspaceIntoProject).not.toHaveBeenCalled();
  });

  it("SEC-2: legacy change with no evaluatedSha skips the check and merges", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...mockChange, status: "accepted" },
    });

    const res = await app.fetch(
      request("POST", `/api/changes/${mockChange.id}/merge`, undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
  });

  it("SEC-2: force=true bypasses the stale-workspace check", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...mockChange, status: "accepted", evaluatedSha: "sha_evaluated_old" },
    });
    vi.mocked(loadPolicy).mockResolvedValue({
      evaluators: [],
      merge: { allowForce: true },
    });

    const res = await app.fetch(
      request("POST", `/api/changes/${mockChange.id}/merge?force=true`, undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
  });

  it("does not fail a forced merge when the merge.forced audit write fails", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...mockChange, status: "accepted", evaluatedSha: "sha_evaluated_old" },
    });
    vi.mocked(loadPolicy).mockResolvedValue({
      evaluators: [],
      merge: { allowForce: true },
    });
    vi.mocked(recordAudit).mockResolvedValueOnce({
      success: false,
      error: new AppError("D1 unavailable", "DATABASE_ERROR", 500),
    });

    const res = await app.fetch(
      request("POST", `/api/changes/${mockChange.id}/merge?force=true`, undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
  });

  it("PROV: records the snapshotted model and prompt hash on merge", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: {
        ...mockChange,
        status: "accepted",
        agentId: "agent_test",
        agentModel: "claude-fable-5",
        agentPromptHash: "sha256:promptdigest",
      },
    });

    const res = await app.fetch(
      request("POST", `/api/changes/${mockChange.id}/merge`, undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
    expect(recordProvenance).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({
        model: "claude-fable-5",
        promptHash: "sha256:promptdigest",
      }),
    );
  });

  it("merges when requireFreshBase is set and the base matches HEAD", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...mockChange, status: "accepted", baseSha: "sha_head" },
    });
    vi.mocked(loadPolicy).mockResolvedValue({
      evaluators: [],
      merge: { requireFreshBase: true },
    });

    const res = await app.fetch(
      request("POST", `/api/changes/${mockChange.id}/merge`, undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
  });

  it("force merge bypasses protection rules when force is allowed", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...mockChange, status: "open" },
    });
    vi.mocked(loadPolicy).mockResolvedValue({
      evaluators: [],
      merge: { requiredEvaluators: ["secret_scan"], allowForce: true },
    });
    vi.mocked(listEvalRuns).mockResolvedValue({ success: true, data: [] });

    const res = await app.fetch(
      request("POST", `/api/changes/${mockChange.id}/merge?force=true`, undefined, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
  });

  /**
   * The deploy trigger hangs off the post-merge RESULT, not the change.merged
   * event, because a failed post-merge check auto-reverts the merge. Anyone who
   * "simplifies" this onto the event reintroduces deploying reverted code.
   */
  describe("post-merge deploy trigger", () => {
    let send: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      send = vi.fn(async () => {});
      env.DEPLOY_QUEUE = { send } as unknown as Env["DEPLOY_QUEUE"];
      vi.mocked(getChange).mockResolvedValue({
        success: true,
        data: { ...mockChange, status: "accepted" },
      });
      vi.mocked(runPostMergeCheck).mockResolvedValue({ status: "skipped" });
    });

    afterEach(() => {
      // Restore the module default for the rest of the file.
      vi.mocked(runPostMergeCheck).mockResolvedValue({ status: "skipped" });
    });

    it("enqueues the merged commit after a clean post-merge check", async () => {
      vi.mocked(runPostMergeCheck).mockResolvedValue({ status: "passed" });

      const res = await app.fetch(
        request("POST", "/api/changes/chg_abc123/merge", undefined, USER_AUTH),
        env,
      );

      expect(res.status).toBe(200);
      // `mergedAt` is the merge time the route just stamped on the change. The
      // deployment row is ordered by it rather than by when the queue delivers
      // the message, because the queue promises no ordering.
      expect(send).toHaveBeenCalledWith({
        kind: "merge",
        projectId: mockProject.id,
        changeId: "chg_abc123",
        commitSha: "sha_merged",
        mergedAt: expect.any(String),
      });
    });

    it("does not enqueue when the post-merge check reverted the merge", async () => {
      vi.mocked(runPostMergeCheck).mockResolvedValue({
        status: "reverted",
        reason: "smoke test failed",
        revertCommit: "sha_revert",
      });

      const res = await app.fetch(
        request("POST", "/api/changes/chg_abc123/merge", undefined, USER_AUTH),
        env,
      );

      expect(res.status).toBe(200);
      expect(send).not.toHaveBeenCalled();
    });

    it("does not enqueue when the post-merge check failed", async () => {
      vi.mocked(runPostMergeCheck).mockResolvedValue({
        status: "failed",
        reason: "smoke test failed",
      });

      await app.fetch(request("POST", "/api/changes/chg_abc123/merge", undefined, USER_AUTH), env);

      expect(send).not.toHaveBeenCalled();
    });

    it("enqueues only after the post-merge check has run", async () => {
      const order: string[] = [];
      vi.mocked(runPostMergeCheck).mockImplementation(async () => {
        order.push("post-merge");
        return { status: "passed" };
      });
      send.mockImplementation(async () => {
        order.push("enqueue");
      });

      await app.fetch(request("POST", "/api/changes/chg_abc123/merge", undefined, USER_AUTH), env);

      expect(order).toEqual(["post-merge", "enqueue"]);
    });

    it("still reports the merge when the queue send fails", async () => {
      send.mockRejectedValue(new Error("queue unavailable"));

      const res = await app.fetch(
        request("POST", "/api/changes/chg_abc123/merge", undefined, USER_AUTH),
        env,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { merged: boolean; commit: string };
      expect(body.merged).toBe(true);
      expect(body.commit).toBe("sha_merged");
    });
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

  it("redirects browser form posts back to the change page", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: mockChange,
    });

    const res = await app.fetch(
      new Request("http://localhost/api/changes/chg_abc123/reject", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...USER_AUTH,
        },
        body: "",
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/changes/chg_abc123");
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

describe("POST /api/projects/:name/changes/merge-batch", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;
  let gcCalls: string[][];
  let waitUntils: Promise<unknown>[];

  // Minimal valid staged-tree value: [40-byte oid][packObjects([])].
  const stagedValue = (() => {
    const oid = "a".repeat(40);
    const pack = packObjects([]);
    const v = new Uint8Array(40 + pack.length);
    v.set(new TextEncoder().encode(oid));
    v.set(pack, 40);
    return v;
  })();

  const exec = () => ({
    waitUntil: (p: Promise<unknown>) => {
      waitUntils.push(p);
    },
    passThroughOnException: () => {},
  });

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
    gcCalls = [];
    waitUntils = [];

    vi.mocked(getUserByToken).mockImplementation(async (_db, token) =>
      token === "stratum_user_testtoken00000000000000000"
        ? {
            success: true,
            data: {
              id: "user_test",
              email: "test@example.com",
              username: "test",
              tokenHash: "hash",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          }
        : { success: false, error: new NotFoundError("User", token) },
    );
    vi.mocked(getAgentByToken).mockResolvedValue({
      success: false,
      error: new NotFoundError("Agent", "x"),
    });
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    vi.mocked(getProject).mockResolvedValue({ success: true, data: mockProject } as any);
    // Batch tests below force; force is deny-by-default, so opt the project in.
    vi.mocked(loadPolicy).mockResolvedValue({ ...mockPolicy, merge: { allowForce: true } });
    vi.mocked(getChangesByIds).mockResolvedValue({
      success: true,
      data: [
        {
          id: "chg_b1",
          project: "my-project",
          workspace: "fix-bug",
          status: "approved",
          baseSha: "base1",
        },
        {
          id: "chg_b2",
          project: "my-project",
          workspace: "feat-x",
          status: "approved",
          baseSha: "base1",
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: minimal Change stubs
    } as any);
    vi.mocked(batchMergeStagedTrees).mockResolvedValue({
      success: true,
      data: [
        { changeId: "chg_b1", merged: true, commit: "merge-1" },
        { changeId: "chg_b2", merged: false },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: minimal result stub
    } as any);

    const stub = {
      getStagedTrees: vi.fn(async (ws: string[]) =>
        ws.map((w) => ({ workspace: w, value: stagedValue })),
      ),
      gcStagedTrees: vi.fn(async (ws: string[]) => {
        gcCalls.push(ws);
      }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal DO + D1 stubs
    env.REPO_DO = { idFromName: (n: string) => n, get: () => stub } as any;
    // biome-ignore lint/suspicious/noExplicitAny: minimal D1 stub
    env.DB = { prepare: () => ({ bind: () => ({}) }), batch: vi.fn(async () => []) } as any;
  });

  it("merges eligible changes via the DO hot index, dedupes ids, reports per-change outcomes", async () => {
    const res = await app.fetch(
      request(
        "POST",
        "/api/projects/my-project/changes/merge-batch",
        { changeIds: ["chg_b1", "chg_b2", "chg_b1"], force: true },
        USER_AUTH,
      ),
      env,
      // biome-ignore lint/suspicious/noExplicitAny: minimal ExecutionContext
      exec() as any,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: string[]; conflicted: string[] };
    expect(body.merged).toEqual(["chg_b1"]);
    expect(body.conflicted).toEqual(["chg_b2"]);

    // Dedupe: chg_b1 supplied twice but merged once (two distinct items total).
    const items = vi.mocked(batchMergeStagedTrees).mock.calls[0]?.[4] as { changeId: string }[];
    expect(items.map((i) => i.changeId).sort()).toEqual(["chg_b1", "chg_b2"]);

    // Deferred bookkeeping GCs only the landed workspace from the hot index.
    await Promise.all(waitUntils);
    expect(gcCalls).toEqual([["fix-bug"]]);
  });

  it("does not throw in deferred persist when a batch merge.forced audit write fails", async () => {
    vi.mocked(recordAudit).mockResolvedValueOnce({
      success: false,
      error: new AppError("D1 unavailable", "DATABASE_ERROR", 500),
    });

    const res = await app.fetch(
      request(
        "POST",
        "/api/projects/my-project/changes/merge-batch",
        { changeIds: ["chg_b1", "chg_b2", "chg_b1"], force: true },
        USER_AUTH,
      ),
      env,
      // biome-ignore lint/suspicious/noExplicitAny: minimal ExecutionContext
      exec() as any,
    );
    expect(res.status).toBe(200);

    // The audit failure must not reject the deferred waitUntil work.
    await expect(Promise.all(waitUntils)).resolves.toBeDefined();
    expect(gcCalls).toEqual([["fix-bug"]]);
  });

  it("SEC-2: skips a batch change whose staged tree doesn't match the evaluated tree", async () => {
    // Staged tree oid is "a".repeat(40) for every workspace. chg_b1 was evaluated
    // against that tree (matches → merges); chg_b2 was evaluated against a
    // different tree (mismatch → skipped, even though this is a force batch).
    vi.mocked(getChangesByIds).mockResolvedValue({
      success: true,
      data: [
        {
          id: "chg_b1",
          project: "my-project",
          workspace: "fix-bug",
          status: "approved",
          baseSha: "base1",
          evaluatedTreeOid: "a".repeat(40),
        },
        {
          id: "chg_b2",
          project: "my-project",
          workspace: "feat-x",
          status: "approved",
          baseSha: "base1",
          evaluatedTreeOid: "b".repeat(40),
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: minimal Change stubs
    } as any);

    const res = await app.fetch(
      request(
        "POST",
        "/api/projects/my-project/changes/merge-batch",
        { changeIds: ["chg_b1", "chg_b2"], force: true },
        USER_AUTH,
      ),
      env,
      // biome-ignore lint/suspicious/noExplicitAny: minimal ExecutionContext
      exec() as any,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped: { changeId: string; reason: string }[] };
    const skippedB2 = body.skipped.find((s) => s.changeId === "chg_b2");
    expect(skippedB2?.reason).toBe("workspace changed since evaluation");
    // Only chg_b1 reaches the merge, carrying its evaluated tree oid so the
    // merge layer re-validates right where the synthetic commit is built (#124).
    const items = vi.mocked(batchMergeStagedTrees).mock.calls[0]?.[4] as {
      changeId: string;
      expectedTreeOid?: string;
    }[];
    expect(items.map((i) => i.changeId)).toEqual(["chg_b1"]);
    expect(items[0]?.expectedTreeOid).toBe("a".repeat(40));
  });

  it("#124: GCs both the latest and the sha-keyed staged-tree copies of a merged pinned change", async () => {
    vi.mocked(getChangesByIds).mockResolvedValue({
      success: true,
      data: [
        {
          id: "chg_b1",
          project: "my-project",
          workspace: "fix-bug",
          status: "approved",
          baseSha: "base1",
          workspaceHeadSha: "wshead1",
          evaluatedSha: "wshead1",
          evaluatedTreeOid: "a".repeat(40),
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: minimal Change stub
    } as any);
    vi.mocked(batchMergeStagedTrees).mockResolvedValue({
      success: true,
      data: [{ changeId: "chg_b1", merged: true, commit: "merge-1" }],
      // biome-ignore lint/suspicious/noExplicitAny: minimal result stub
    } as any);
    const r2Deletes: string[] = [];
    env.REPO_OBJECTS = {
      delete: vi.fn(async (k: string) => {
        r2Deletes.push(k);
      }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal R2 stub
    } as any;

    const res = await app.fetch(
      request(
        "POST",
        "/api/projects/my-project/changes/merge-batch",
        { changeIds: ["chg_b1"], force: true },
        USER_AUTH,
      ),
      env,
      // biome-ignore lint/suspicious/noExplicitAny: minimal ExecutionContext
      exec() as any,
    );
    expect(res.status).toBe(200);
    await Promise.all(waitUntils);
    expect(r2Deletes.sort()).toEqual([
      "repos/proj_test123/ws/fix-bug",
      "repos/proj_test123/ws/fix-bug/sha/wshead1",
    ]);
  });

  it("rejects a batch above the size cap", async () => {
    const ids = Array.from({ length: 81 }, (_u, i) => `c${i}`);
    const res = await app.fetch(
      request(
        "POST",
        "/api/projects/my-project/changes/merge-batch",
        { changeIds: ids, force: true },
        USER_AUTH,
      ),
      env,
      // biome-ignore lint/suspicious/noExplicitAny: minimal ExecutionContext
      exec() as any,
    );
    expect(res.status).toBe(400);
  });

  it("skips changes whose tree is absent from the hot index", async () => {
    const stub = { getStagedTrees: vi.fn(async () => []), gcStagedTrees: vi.fn(async () => {}) };
    // biome-ignore lint/suspicious/noExplicitAny: minimal DO stub
    env.REPO_DO = { idFromName: (n: string) => n, get: () => stub } as any;
    const res = await app.fetch(
      request(
        "POST",
        "/api/projects/my-project/changes/merge-batch",
        { changeIds: ["chg_b1"], force: true },
        USER_AUTH,
      ),
      env,
      // biome-ignore lint/suspicious/noExplicitAny: minimal ExecutionContext
      exec() as any,
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/changes/:id/github-pr", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;
  let fetchMock: ReturnType<typeof vi.fn>;

  const acceptedChange: Change = {
    ...mockChange,
    status: "accepted",
    evalScore: 0.9,
    evalPassed: true,
  };

  const githubProject = {
    ...mockProject,
    githubUrl: "https://github.com/acme/widgets",
    githubDefaultBranch: "develop",
  };

  // GitHub always answers with an html_url inside the repository the request was
  // addressed to, so derive it from the API URL rather than hard-coding one repo.
  // A fixed acme/widgets link would be wrong for the sourceUrl tests, which
  // promote to a different repository.
  function githubPrCreated(apiUrl = "https://api.github.com/repos/acme/widgets/pulls"): Response {
    const slug = new URL(apiUrl).pathname.replace(/^\/repos\//, "").replace(/\/pulls.*$/, "");
    return new Response(
      JSON.stringify({
        number: 42,
        html_url: `https://github.com/${slug}/pull/42`,
        state: "open",
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  }

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    env.GITHUB_TOKEN = "ghp_secret_token";
    vi.clearAllMocks();
    // GitHubClient's circuit breaker is module-level state shared by every
    // instance — this suite deliberately drives many consecutive GitHub
    // failures against the same acme/widgets repo across test cases, which
    // would otherwise trip the breaker and starve later, unrelated
    // assertions with a spurious 503.
    resetCircuitBreakersForTests();
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
      error: new NotFoundError("Agent", "none"),
    });
    vi.mocked(getChange).mockResolvedValue({ success: true, data: acceptedChange });
    vi.mocked(getProject).mockResolvedValue({ success: true, data: githubProject });
    vi.mocked(getWorkspace).mockResolvedValue({ success: true, data: mockWorkspace });
    vi.mocked(updateChangeStatus).mockResolvedValue({ success: true, data: undefined });
    vi.mocked(freshRepoToken).mockResolvedValue({ success: true, data: "artifacts-token" });
    vi.mocked(cloneRepo).mockResolvedValue({
      success: true,
      data: { fs: {} as NodeFS, dir: "/" },
    });
    vi.mocked(pushBranchToRemote).mockResolvedValue({ success: true, data: undefined });
    fetchMock = vi.fn(async (url: string) => githubPrCreated(url));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const promote = (body?: unknown) =>
    app.fetch(request("POST", "/api/changes/chg_abc123/github-pr", body ?? {}, USER_AUTH), env);

  it("pushes the change branch to GitHub, then opens the PR from it", async () => {
    const res = await promote();
    expect(res.status).toBe(200);

    // The workspace fork is cloned with a fresh read token…
    expect(freshRepoToken).toHaveBeenCalledWith(
      env.ARTIFACTS,
      mockWorkspace.remote,
      "read",
      expect.anything(),
    );
    expect(cloneRepo).toHaveBeenCalledWith(
      mockWorkspace.remote,
      "artifacts-token",
      expect.anything(),
      // #181: the fork copies the parent's default branch under the same name,
      // so a `develop`-default project has no `main` for the clone to find.
      { ref: "develop", fullHistory: true, timeoutMs: 120_000 },
    );
    // …and its tip is pushed to the Stratum-owned head ref on GitHub. The
    // pushed LOCAL ref has to be the same branch the clone above asked for:
    // that clone is singleBranch, so a `develop`-default project's clone holds
    // no `main`, and pushing one fails locally before any request is made.
    expect(pushBranchToRemote).toHaveBeenCalledWith(
      {},
      "/",
      {
        url: "https://github.com/acme/widgets.git",
        remoteRef: "refs/heads/stratum/chg_abc123",
        token: "ghp_secret_token",
        localRef: "develop",
        force: true,
      },
      expect.anything(),
    );

    // The push strictly precedes PR creation (a missing head ref is a 422).
    const pushOrder = vi.mocked(pushBranchToRemote).mock.invocationCallOrder[0] ?? -1;
    const prOrder = fetchMock.mock.invocationCallOrder[0] ?? -1;
    expect(pushOrder).toBeGreaterThan(0);
    expect(pushOrder).toBeLessThan(prOrder);

    // The PR is opened from the branch that was just pushed.
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/widgets/pulls",
      expect.objectContaining({ method: "POST" }),
    );
    const prPayload = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(prPayload.head).toBe("stratum/chg_abc123");
    expect(prPayload.base).toBe("develop"); // project's known default branch
    expect(prPayload.draft).toBe(true);

    const body = (await res.json()) as { github: Record<string, unknown> };
    expect(body.github).toEqual({
      owner: "acme",
      repo: "widgets",
      branch: "stratum/chg_abc123",
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/acme/widgets/pull/42",
    });
    expect(updateChangeStatus).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      "chg_abc123",
      "promoted",
      expect.objectContaining({
        githubOwner: "acme",
        githubRepo: "widgets",
        githubBranch: "stratum/chg_abc123",
        githubPrNumber: 42,
        promotedBy: "user_test",
      }),
    );
  });

  // #243: the evaluation gate is only meaningful if the code published to
  // GitHub is the code that was evaluated. change.evaluatedSha is the pinned
  // revision; the clone above is a live read of the workspace, which can have
  // advanced since evaluation ran.
  describe("evaluatedSha gate (#243)", () => {
    it("pushes and promotes, recording the published sha, when the workspace tip matches evaluatedSha", async () => {
      vi.mocked(getChange).mockResolvedValue({
        success: true,
        data: { ...acceptedChange, evaluatedSha: "sha-evaluated" },
      });
      vi.mocked(resolveLocalTip).mockResolvedValue({ success: true, data: "sha-evaluated" });

      const res = await promote();
      expect(res.status).toBe(200);
      // The ref is the project's default branch (this suite's project defaults
      // to `develop`), not a hard-coded `main` — see the dedicated case below.
      expect(resolveLocalTip).toHaveBeenCalledWith({}, "/", "develop");

      // The gate runs strictly before the push (before anything is published).
      const tipOrder = vi.mocked(resolveLocalTip).mock.invocationCallOrder[0] ?? -1;
      const pushOrder = vi.mocked(pushBranchToRemote).mock.invocationCallOrder[0] ?? -1;
      expect(tipOrder).toBeGreaterThan(0);
      expect(tipOrder).toBeLessThan(pushOrder);

      expect(updateChangeStatus).toHaveBeenCalledWith(
        env.DB,
        expect.anything(),
        "chg_abc123",
        "promoted",
        expect.objectContaining({ githubHeadSha: "sha-evaluated" }),
      );
    });

    it("rejects the promotion with a structured error when the workspace tip has moved past evaluatedSha", async () => {
      vi.mocked(getChange).mockResolvedValue({
        success: true,
        data: { ...acceptedChange, evaluatedSha: "sha-evaluated" },
      });
      vi.mocked(resolveLocalTip).mockResolvedValue({ success: true, data: "sha-advanced" });

      const res = await promote();
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: string;
        code: string;
        evaluatedSha: string;
        currentTip: string;
      };
      expect(body.code).toBe("STALE_WORKSPACE");
      expect(body.evaluatedSha).toBe("sha-evaluated");
      expect(body.currentTip).toBe("sha-advanced");
      // Fails closed BEFORE anything is published or persisted.
      expect(pushBranchToRemote).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(updateChangeStatus).not.toHaveBeenCalled();
    });

    it("502s without pushing when the local tip can't be resolved", async () => {
      vi.mocked(getChange).mockResolvedValue({
        success: true,
        data: { ...acceptedChange, evaluatedSha: "sha-evaluated" },
      });
      vi.mocked(resolveLocalTip).mockResolvedValue({
        success: false,
        error: new AppError(
          "Git error: Failed to resolve local tip",
          "EXTERNAL_SERVICE_ERROR",
          502,
        ),
      });

      const res = await promote();
      expect(res.status).toBe(502);
      expect(pushBranchToRemote).not.toHaveBeenCalled();
      expect(updateChangeStatus).not.toHaveBeenCalled();
    });

    // The gate resolves the tip of the branch that was actually cloned. The
    // clone is singleBranch on the project's default branch, so a project whose
    // default is not `main` has no `main` for isomorphic-git to resolve: a
    // hard-coded ref here throws and 502s a promotion that should have passed
    // the gate. Asserted through the ref the resolver is handed rather than the
    // status alone, because the resolver is mocked in this suite and would
    // happily answer for any ref.
    it("resolves the tip of the project's default branch, not `main`", async () => {
      vi.mocked(getProject).mockResolvedValue({
        success: true,
        data: { ...githubProject, githubDefaultBranch: "release-2026" },
      });
      vi.mocked(getChange).mockResolvedValue({
        success: true,
        data: { ...acceptedChange, evaluatedSha: "sha-evaluated" },
      });
      vi.mocked(resolveLocalTip).mockResolvedValue({ success: true, data: "sha-evaluated" });

      const res = await promote();
      expect(res.status).toBe(200);
      // Same ref the clone asked for — the two must not drift apart.
      expect(cloneRepo).toHaveBeenCalledWith(
        mockWorkspace.remote,
        "artifacts-token",
        expect.anything(),
        { ref: "release-2026", fullHistory: true, timeoutMs: 120_000 },
      );
      expect(resolveLocalTip).toHaveBeenCalledWith({}, "/", "release-2026");
    });

    it("skips the gate (legacy live-tip behavior) when the change has no evaluatedSha", async () => {
      // acceptedChange has no evaluatedSha.
      const res = await promote();
      expect(res.status).toBe(200);
      expect(resolveLocalTip).not.toHaveBeenCalled();
      expect(updateChangeStatus).toHaveBeenCalledWith(
        env.DB,
        expect.anything(),
        "chg_abc123",
        "promoted",
        expect.not.objectContaining({ githubHeadSha: expect.anything() }),
      );
    });
  });

  it("promotes a bulk-imported project that only has sourceUrl", async () => {
    vi.mocked(getProject).mockResolvedValue({
      success: true,
      data: {
        ...mockProject,
        sourceUrl: "https://github.com/imported/repo.git",
        sourceDefaultBranch: "trunk",
      },
    });

    const res = await promote();
    expect(res.status).toBe(200);
    expect(pushBranchToRemote).toHaveBeenCalledWith(
      {},
      "/",
      expect.objectContaining({
        url: "https://github.com/imported/repo.git",
        localRef: "trunk",
      }),
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/imported/repo/pulls",
      expect.anything(),
    );
    const prPayload = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(prPayload.base).toBe("trunk"); // sourceDefaultBranch wins
    // The same resolved branch reaches the workspace clone.
    expect(cloneRepo).toHaveBeenCalledWith(
      mockWorkspace.remote,
      "artifacts-token",
      expect.anything(),
      { ref: "trunk", fullHistory: true, timeoutMs: 120_000 },
    );
  });

  // `base` is caller-supplied and may name a branch that exists on GitHub but
  // not in the workspace fork. It must never be used as the clone ref — only
  // the project's own default branch is guaranteed to exist there.
  it("clones and pushes the project default branch, never a body-supplied base", async () => {
    const res = await promote({ base: "release/2026-08" });
    expect(res.status).toBe(200);

    // Since SA-6 the base is the project's own default branch, so the body value
    // reaches nothing. This case still earns its place alongside the SA-6 test
    // below: it is the only one pinning the clone ref and push localRef, which
    // must follow the fork's branch rather than the GitHub base.
    const prPayload = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(prPayload.base).toBe("develop");
    expect(cloneRepo).toHaveBeenCalledWith(
      mockWorkspace.remote,
      "artifacts-token",
      expect.anything(),
      { ref: "develop", fullHistory: true, timeoutMs: 120_000 },
    );
    // `release/2026-08` is not in the fork, and neither is `main`.
    expect(pushBranchToRemote).toHaveBeenCalledWith(
      {},
      "/",
      expect.objectContaining({ localRef: "develop" }),
      expect.anything(),
    );
  });

  // SA-6: this endpoint acts with the instance-wide GitHub token, so a
  // caller-supplied base would aim that shared credential at a branch of the
  // caller's choosing. `base` is not read from the body at all.
  it("ignores a caller-supplied base and targets the project's own default branch", async () => {
    vi.mocked(getProject).mockResolvedValue({
      success: true,
      data: {
        ...mockProject,
        sourceUrl: "https://github.com/imported/repo.git",
        sourceDefaultBranch: "trunk",
      },
    });

    const res = await promote({ base: "attacker-controlled" });

    expect(res.status).toBe(200);
    const prPayload = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(prPayload.base).toBe("trunk");
    expect(prPayload.base).not.toBe("attacker-controlled");
  });

  // Precedence, pinned because nothing else does: every other case sets at most
  // one of the two recorded defaults, so none of them would notice the order
  // being reversed.
  it("prefers sourceDefaultBranch over githubDefaultBranch when both are recorded", async () => {
    vi.mocked(getProject).mockResolvedValue({
      success: true,
      data: {
        ...githubProject,
        sourceDefaultBranch: "trunk",
        githubDefaultBranch: "develop",
      },
    } as Awaited<ReturnType<typeof getProject>>);

    const res = await promote();

    expect(res.status).toBe(200);
    const prPayload = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(prPayload.base).toBe("trunk");
    expect(prPayload.base).not.toBe("develop");
  });

  // The reason projectDefaultBranch uses `||` rather than `??`: an import can
  // record an empty string, and `??` would forward that to GitHub as a branch
  // name. It must fall through to the next candidate instead.
  it("falls through an empty sourceDefaultBranch to githubDefaultBranch", async () => {
    vi.mocked(getProject).mockResolvedValue({
      success: true,
      data: {
        ...githubProject,
        sourceDefaultBranch: "",
        githubDefaultBranch: "develop",
      },
    } as Awaited<ReturnType<typeof getProject>>);

    const res = await promote();

    expect(res.status).toBe(200);
    const prPayload = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(prPayload.base).toBe("develop");
  });

  it("rejects promotion when the project's own default branch is not a valid ref", async () => {
    vi.mocked(getProject).mockResolvedValue({
      success: true,
      data: {
        ...mockProject,
        sourceUrl: "https://github.com/imported/repo.git",
        sourceDefaultBranch: "bad..branch",
      },
    });

    const res = await promote();

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A shape-only URL check (github.com suffix + non-empty path) accepts real
  // GitHub URLs that are not this PR's page. Persisting one strands the change
  // exactly as a malformed record would, so the create response is rejected.
  it.each([
    ["an api.github.com endpoint", "https://api.github.com/repos/acme/widgets/pulls/42"],
    ["a gist.github.com subdomain", "https://gist.github.com/acme/widgets/pull/42"],
    ["an unrelated github.com page", "https://github.com/login"],
    ["a PR in another repository", "https://github.com/other/repo/pull/42"],
    ["a different PR number", "https://github.com/acme/widgets/pull/99"],
    ["a non-https scheme", "http://github.com/acme/widgets/pull/42"],
    // Userinfo/query/fragment survive into the persisted, user-visible link, so
    // a host+path check that ignores them would store credentials or a token.
    ["embedded credentials", "https://user:password@github.com/acme/widgets/pull/42"],
    ["an embedded username only", "https://user@github.com/acme/widgets/pull/42"],
    ["a query string", "https://github.com/acme/widgets/pull/42?token=secret"],
    ["a fragment", "https://github.com/acme/widgets/pull/42#diff-abc"],
    // hostname drops the port, so a non-default port needs `host` to be caught.
    ["a non-default port", "https://github.com:8443/acme/widgets/pull/42"],
    ["a trailing slash", "https://github.com/acme/widgets/pull/42/"],
  ])("502s when GitHub returns %s as html_url", async (_label, htmlUrl) => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ number: 42, html_url: htmlUrl, state: "open" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const res = await promote();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("GITHUB_ERROR");
    // Nothing unusable may be persisted.
    expect(updateChangeStatus).not.toHaveBeenCalled();
  });

  it("accepts the canonical PR url regardless of owner/repo casing", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          number: 42,
          html_url: "https://github.com/Acme/Widgets/pull/42",
          state: "open",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    const res = await promote();
    expect(res.status).toBe(200);
  });

  it("prefers sourceUrl over a stale legacy githubUrl", async () => {
    // A project migrated onto sourceUrl keeps its old githubUrl value. This URL
    // is what the change branch gets FORCE-PUSHED to, so preferring the legacy
    // field would publish to — and open a PR against — the wrong repository.
    vi.mocked(getProject).mockResolvedValue({
      success: true,
      data: {
        ...mockProject,
        githubUrl: "https://github.com/stale/old-repo",
        sourceUrl: "https://github.com/current/new-repo.git",
      },
    });

    const res = await promote();
    expect(res.status).toBe(200);
    expect(pushBranchToRemote).toHaveBeenCalledWith(
      {},
      "/",
      expect.objectContaining({ url: "https://github.com/current/new-repo.git" }),
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/current/new-repo/pulls",
      expect.anything(),
    );
    // Nothing may reach the stale repo.
    expect(JSON.stringify(vi.mocked(pushBranchToRemote).mock.calls)).not.toContain(
      "stale/old-repo",
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("stale/old-repo");
  });

  // The base-validation matrix moved off the request body and onto the project's
  // own recorded default branch. `base` is no longer accepted from callers at
  // all (SA-6), but the project record can still carry a branch name that
  // arrived through import and was never checked, so the same rules apply — the
  // input is just a different one.
  const withDefaultBranch = (sourceDefaultBranch: string) =>
    vi.mocked(getProject).mockResolvedValue({
      success: true,
      data: {
        ...mockProject,
        sourceUrl: "https://github.com/imported/repo.git",
        sourceDefaultBranch,
      },
    });

  it.each(["release/1.2", "feature/@/thing", "feature/@-fix", "v1.0.0", "a.b.c/d.e"])(
    "promotes against the legal project default branch %j (@ inside a longer name is unambiguous)",
    async (branch) => {
      withDefaultBranch(branch);
      const res = await promote();
      expect(res.status).toBe(200);
      const prPayload = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
      expect(prPayload.base).toBe(branch);
    },
  );

  it.each([
    "two words",
    "bad..dots",
    "-leading-dash",
    "@{upstream}",
    "branch.lock",
    "/leading-slash",
    "trailing-slash/",
    "trailing-dot.",
    "double//slash",
    "back\\slash",
    "colon:ref",
    "star*glob",
    "quest?ion",
    "ctrl\u0007bell",
    "a".repeat(201),
    // git applies its per-component rules to every slash-separated component,
    // not just the whole ref, so these are invalid despite the full string
    // neither starting with "." nor ending with "." / ".lock".
    ".hidden",
    "release/.hidden",
    "release/v1.",
    "release/v1.lock",
    "release/v1.lock/next",
    // git will create refs/heads/@, but "@" is git's shorthand for HEAD, so the
    // name is ambiguous everywhere it is used. Rejected deliberately.
    "@",
  ])("refuses to promote against the garbage project default branch %j", async (branch) => {
    withDefaultBranch(branch);
    const res = await promote();
    expect(res.status).toBe(400);
    expect(pushBranchToRemote).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores a base in the request body even when it is a legal branch name", async () => {
    withDefaultBranch("trunk");
    const res = await promote({ base: "release/1.2" });
    expect(res.status).toBe(200);
    const prPayload = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(prPayload.base).toBe("trunk");
  });

  it("400s when the project has neither githubUrl nor sourceUrl", async () => {
    vi.mocked(getProject).mockResolvedValue({ success: true, data: mockProject });
    const res = await promote();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Project is not connected to GitHub",
    );
  });

  it("400s when the source is not a GitHub repository", async () => {
    vi.mocked(getProject).mockResolvedValue({
      success: true,
      data: { ...mockProject, sourceUrl: "https://gitlab.com/acme/widgets" },
    });
    const res = await promote();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Project source is not a GitHub repository",
    );
    expect(pushBranchToRemote).not.toHaveBeenCalled();
  });

  it("surfaces GitHub's status and message on PR-creation failure, without the token", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: "Validation Failed",
          errors: [{ resource: "PullRequest", field: "base", code: "invalid" }],
        }),
        { status: 422 },
      ),
    );
    const res = await promote();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; code: string; githubStatus: number };
    expect(body.code).toBe("GITHUB_ERROR");
    expect(body.githubStatus).toBe(422);
    expect(body.error).toContain("422");
    expect(body.error).toContain("Validation Failed");
    expect(body.error).toContain("base invalid");
    expect(JSON.stringify(body)).not.toContain("ghp_secret_token");
    expect(updateChangeStatus).not.toHaveBeenCalled();
  });

  it("surfaces a non-JSON GitHub failure as status-only", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }));
    const res = await promote();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; githubStatus: number };
    expect(body.error).toBe("GitHub PR creation failed (502)");
    expect(body.githubStatus).toBe(502);
  });

  // The branch is already pushed when the error body is parsed, so anything
  // thrown here escapes as a bare 500 and loses the structured GITHUB_ERROR
  // the caller needs. GitHub is not guaranteed to send the documented shape.
  it.each([
    ["an object instead of an array", { message: "Validation Failed", errors: {} }],
    ["a string instead of an array", { message: "Validation Failed", errors: "invalid" }],
    ["null entries", { message: "Validation Failed", errors: [null] }],
    ["non-string members", { message: "Validation Failed", errors: [{ message: 42 }] }],
    ["a non-object body", "just a string"],
    ["a null body", null],
  ])("still returns a structured 502 when GitHub sends %s", async (_label, payload) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 422 }));
    const res = await promote();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; githubStatus: number };
    expect(body.code).toBe("GITHUB_ERROR");
    expect(body.githubStatus).toBe(422);
    expect(updateChangeStatus).not.toHaveBeenCalled();
  });

  // startsWith("https://") accepts values that are not reachable PR links.
  it.each([
    ["a bare scheme", "https://"],
    ["no path", "https://github.com"],
    ["a non-GitHub host", "https://evil.example.com/acme/widgets/pull/1"],
    ["a lookalike host", "https://github.com.evil.example/acme/widgets/pull/1"],
    ["a non-https scheme", "http://github.com/acme/widgets/pull/1"],
    ["not a URL at all", "https:/ /nonsense"],
  ])("502s instead of persisting a PR whose html_url is %s", async (_label, url) => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ number: 7, html_url: url, state: "open" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const res = await promote();
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("GITHUB_ERROR");
    expect(updateChangeStatus).not.toHaveBeenCalled();
  });

  it("502s without leaking details when the PR-creation request itself fails (timeout/network)", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted", "TimeoutError"));
    const res = await promote();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("GITHUB_ERROR");
    expect(body.error).toContain("timed out or network error");
    expect(updateChangeStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", () => new Response("not json at all", { status: 201 })],
    [
      "a body missing the PR fields",
      () => new Response(JSON.stringify({ ok: true }), { status: 201 }),
    ],
  ])(
    "502s rather than throwing when GitHub returns a 2xx with %s",
    async (_label, makeResponse) => {
      fetchMock.mockResolvedValueOnce(makeResponse());
      const res = await promote();
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe("GITHUB_ERROR");
      expect(body.error).toContain("unreadable response");
      // The branch was already pushed by this point; the change must not be
      // recorded as promoted against a PR number we never actually read.
      expect(pushBranchToRemote).toHaveBeenCalledTimes(1);
      expect(updateChangeStatus).not.toHaveBeenCalled();
    },
  );

  it("reconciles a duplicate-head 422 by reusing the PR GitHub already has open", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: "Validation Failed",
          errors: [
            {
              resource: "PullRequest",
              code: "custom",
              message: "A pull request already exists for acme:stratum/chg_abc123.",
            },
          ],
        }),
        { status: 422 },
      ),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { number: 99, html_url: "https://github.com/acme/widgets/pull/99", state: "open" },
        ]),
        { status: 200 },
      ),
    );

    const res = await promote();
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/acme/widgets/pulls?head=acme:stratum/chg_abc123&state=open",
      expect.anything(),
    );
    const body = (await res.json()) as { github: Record<string, unknown> };
    expect(body.github).toEqual(
      expect.objectContaining({
        pullRequestNumber: 99,
        pullRequestUrl: "https://github.com/acme/widgets/pull/99",
      }),
    );
    expect(updateChangeStatus).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      "chg_abc123",
      "promoted",
      expect.objectContaining({ githubPrNumber: 99 }),
    );
  });

  // A persisted PR record is what a later re-promotion checks to decide the PR
  // already exists and skip creation, so storing a malformed one strands the
  // change forever. Every one of these must 502 rather than persist.
  it.each([
    ["a zero PR number", { number: 0, html_url: "https://github.com/a/b/pull/1", state: "open" }],
    [
      "a non-integer PR number",
      { number: 1.5, html_url: "https://github.com/a/b/pull/1", state: "open" },
    ],
    [
      "a string PR number",
      { number: "7", html_url: "https://github.com/a/b/pull/7", state: "open" },
    ],
    ["an empty url", { number: 7, html_url: "", state: "open" }],
    ["a non-https url", { number: 7, html_url: "javascript:alert(1)", state: "open" }],
    ["a closed state", { number: 7, html_url: "https://github.com/a/b/pull/7", state: "closed" }],
    ["a missing state", { number: 7, html_url: "https://github.com/a/b/pull/7" }],
    ["a null body", null],
  ])("502s instead of persisting a create response with %s", async (_label, payload) => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(payload), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const res = await promote();
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("GITHUB_ERROR");
    expect(updateChangeStatus).not.toHaveBeenCalled();
  });

  // Same guard on the other path in: the duplicate-head lookup must not hand
  // back an unusable record either, and must survive a non-array body.
  it.each([
    ["a non-array body", { message: "not a list" }],
    ["an empty array", []],
    ["a closed PR", [{ number: 5, html_url: "https://github.com/a/b/pull/5", state: "closed" }]],
    ["a malformed entry", [{ number: -1, html_url: "" }]],
  ])(
    "falls back to the original 502 when the duplicate-head lookup returns %s",
    async (_l, body) => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: "Validation Failed",
            errors: [{ message: "A pull request already exists for acme:stratum/chg_abc123." }],
          }),
          { status: 422 },
        ),
      );
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));

      const res = await promote();
      expect(res.status).toBe(502);
      const parsed = (await res.json()) as { code: string; githubStatus: number };
      expect(parsed.code).toBe("GITHUB_ERROR");
      expect(parsed.githubStatus).toBe(422);
      expect(updateChangeStatus).not.toHaveBeenCalled();
    },
  );

  it("falls back to the original 502 when the duplicate-head lookup itself finds nothing open", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: "Validation Failed",
          errors: [
            {
              resource: "PullRequest",
              code: "custom",
              message: "A pull request already exists for acme:stratum/chg_abc123.",
            },
          ],
        }),
        { status: 422 },
      ),
    );
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    const res = await promote();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; githubStatus: number };
    expect(body.code).toBe("GITHUB_ERROR");
    expect(body.githubStatus).toBe(422);
    expect(updateChangeStatus).not.toHaveBeenCalled();
  });

  it("502s when the branch push fails, without calling the PR API", async () => {
    vi.mocked(pushBranchToRemote).mockResolvedValue({
      success: false,
      error: new AppError(
        "Git error: Failed to push branch: remote hung up",
        "EXTERNAL_SERVICE_ERROR",
        502,
      ),
    });
    const res = await promote();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("EXTERNAL_SERVICE_ERROR");
    expect(body.error).toContain("Failed to push branch");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateChangeStatus).not.toHaveBeenCalled();
  });

  const reusableStoredPr = {
    status: "promoted" as const,
    githubOwner: "acme",
    githubRepo: "widgets",
    githubBranch: "stratum/chg_abc123",
    githubPrNumber: 7,
    githubPrUrl: "https://github.com/acme/widgets/pull/7",
    githubPrState: "open",
  };

  it("re-promotion re-pushes the branch and reuses the existing PR", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...acceptedChange, ...reusableStoredPr },
    });
    const res = await promote();
    expect(res.status).toBe(200);
    expect(pushBranchToRemote).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled(); // no duplicate-head 422
    const body = (await res.json()) as { github: Record<string, unknown> };
    expect(body.github).toEqual(
      expect.objectContaining({
        pullRequestNumber: 7,
        pullRequestUrl: "https://github.com/acme/widgets/pull/7",
      }),
    );
  });

  // The reuse path returns before the create path's updateChangeStatus, so the
  // revision it just force-pushed has to be recorded here or not at all. This
  // is every re-promotion, so a miss leaves github_head_sha describing the
  // PREVIOUS head while the branch on GitHub has moved.
  it("re-promotion records the revision it just published, not the one it replaced", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: {
        ...acceptedChange,
        ...reusableStoredPr,
        evaluatedSha: "sha-second",
        githubHeadSha: "sha-first",
      },
    });
    vi.mocked(resolveLocalTip).mockResolvedValue({ success: true, data: "sha-second" });

    const res = await promote();

    expect(res.status).toBe(200);
    expect(updateChangeStatus).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      "chg_abc123",
      "promoted",
      { githubHeadSha: "sha-second" },
    );
    // Only the sha: re-promotion is not treated as a fresh promotion event, so
    // promoted_at/promoted_by are deliberately left alone.
    expect(updateChangeStatus).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      "chg_abc123",
      "promoted",
      expect.not.objectContaining({ promotedAt: expect.anything() }),
    );
  });

  it("re-promotion of a legacy change with no evaluatedSha records no sha", async () => {
    // No evaluatedSha means the staleness gate never ran, so there is no
    // confirmed published revision to record — writing one would be inventing it.
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...acceptedChange, ...reusableStoredPr, evaluatedSha: undefined },
    });

    const res = await promote();

    expect(res.status).toBe(200);
    expect(resolveLocalTip).not.toHaveBeenCalled();
    expect(updateChangeStatus).not.toHaveBeenCalled();
  });

  it("re-promotion still succeeds when recording the published revision fails", async () => {
    // The branch is pushed and the PR exists, so the promotion genuinely
    // happened; a D1 blip must not turn it into an error.
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...acceptedChange, ...reusableStoredPr, evaluatedSha: "sha-second" },
    });
    vi.mocked(resolveLocalTip).mockResolvedValue({ success: true, data: "sha-second" });
    vi.mocked(updateChangeStatus).mockResolvedValue({
      success: false,
      error: new AppError("d1 unavailable", "DATABASE_ERROR", 500),
    });

    const res = await promote();

    expect(res.status).toBe(200);
    expect(updateChangeStatus).toHaveBeenCalled();
  });

  // Rows written before this route validated GitHub responses can hold
  // anything, and a closed PR must not be returned as a live promotion.
  // Falling through to creation is the recovery path: the record gets rebuilt
  // from GitHub's own answer rather than left broken.
  it.each([
    [
      "a closed PR",
      {
        githubOwner: "acme",
        githubRepo: "widgets",
        githubBranch: "stratum/chg_abc123",
        githubPrNumber: 7,
        githubPrUrl: "https://github.com/a/b/pull/7",
        githubPrState: "closed",
      },
    ],
    // A project can be re-pointed at a different GitHub repo (migration, or
    // sourceUrl superseding a legacy githubUrl). The push then lands in the new
    // repo while these stored values still name a PR in the old one, so the
    // record is well-formed but belongs to the wrong target.
    [
      "a PR from a different owner",
      {
        githubOwner: "other",
        githubRepo: "widgets",
        githubBranch: "stratum/chg_abc123",
        githubPrNumber: 7,
        githubPrUrl: "https://github.com/a/b/pull/7",
        githubPrState: "open",
      },
    ],
    [
      "a PR from a different repo",
      {
        githubOwner: "acme",
        githubRepo: "gadgets",
        githubBranch: "stratum/chg_abc123",
        githubPrNumber: 7,
        githubPrUrl: "https://github.com/a/b/pull/7",
        githubPrState: "open",
      },
    ],
    [
      "a PR for a different branch",
      {
        githubOwner: "acme",
        githubRepo: "widgets",
        githubBranch: "stratum/chg_old",
        githubPrNumber: 7,
        githubPrUrl: "https://github.com/a/b/pull/7",
        githubPrState: "open",
      },
    ],
    [
      "no stored target (legacy row)",
      { githubPrNumber: 7, githubPrUrl: "https://github.com/a/b/pull/7", githubPrState: "open" },
    ],
    [
      "no stored state",
      {
        githubOwner: "acme",
        githubRepo: "widgets",
        githubBranch: "stratum/chg_abc123",
        githubPrNumber: 7,
        githubPrUrl: "https://github.com/a/b/pull/7",
      },
    ],
    [
      "a zero PR number",
      {
        githubOwner: "acme",
        githubRepo: "widgets",
        githubBranch: "stratum/chg_abc123",
        githubPrNumber: 0,
        githubPrUrl: "https://github.com/a/b/pull/7",
        githubPrState: "open",
      },
    ],
    [
      "an unusable url",
      {
        githubOwner: "acme",
        githubRepo: "widgets",
        githubBranch: "stratum/chg_abc123",
        githubPrNumber: 7,
        githubPrUrl: "https://",
        githubPrState: "open",
      },
    ],
    [
      "a number but no url",
      {
        githubOwner: "acme",
        githubRepo: "widgets",
        githubBranch: "stratum/chg_abc123",
        githubPrNumber: 7,
        githubPrState: "open",
      },
    ],
  ])("re-creates the PR when the stored record has %s", async (_label, stored) => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...acceptedChange, status: "promoted", ...stored },
    });

    const res = await promote();
    expect(res.status).toBe(200);
    // It must not short-circuit on the bad record — creation has to run.
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/widgets/pulls",
      expect.objectContaining({ method: "POST" }),
    );
    const body = (await res.json()) as { github: Record<string, unknown> };
    expect(body.github).toEqual(
      expect.objectContaining({
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/acme/widgets/pull/42",
      }),
    );
    // …and the repaired record is what gets persisted.
    expect(updateChangeStatus).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      "chg_abc123",
      "promoted",
      expect.objectContaining({
        githubPrNumber: 42,
        githubPrUrl: "https://github.com/acme/widgets/pull/42",
        githubPrState: "open",
      }),
    );
  });

  it("400s when the change is not accepted", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...mockChange, status: "open" },
    });
    const res = await promote();
    expect(res.status).toBe(400);
    expect(pushBranchToRemote).not.toHaveBeenCalled();
  });

  it("400s when GITHUB_TOKEN is not configured", async () => {
    env.GITHUB_TOKEN = undefined;
    const res = await promote();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "GitHub integration is not configured",
    );
    expect(pushBranchToRemote).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s when the change's workspace no longer exists", async () => {
    vi.mocked(getWorkspace).mockResolvedValue({
      success: false,
      error: new NotFoundError("Workspace", "fix-bug"),
    });
    const res = await promote();
    expect(res.status).toBe(404);
    expect(pushBranchToRemote).not.toHaveBeenCalled();
  });

  it("400s when the workspace lookup fails for another reason", async () => {
    vi.mocked(getWorkspace).mockResolvedValue({
      success: false,
      error: new AppError("KV unavailable", "KV_ERROR", 500),
    });
    const res = await promote();
    expect(res.status).toBe(400);
    expect(pushBranchToRemote).not.toHaveBeenCalled();
  });

  it("404s when the change does not exist", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: false,
      error: new NotFoundError("Change", "chg_abc123"),
    });
    const res = await promote();
    expect(res.status).toBe(404);
  });

  it("400s when the change lookup fails for another reason", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: false,
      error: new AppError("D1 unavailable", "DATABASE_ERROR", 500),
    });
    const res = await promote();
    expect(res.status).toBe(400);
  });

  it("404s when the project does not exist", async () => {
    vi.mocked(getProject).mockResolvedValue({
      success: false,
      error: new NotFoundError("Project", "my-project"),
    });
    const res = await promote();
    expect(res.status).toBe(404);
  });

  it("400s when the project lookup fails for another reason", async () => {
    vi.mocked(getProject).mockResolvedValue({
      success: false,
      error: new AppError("KV unavailable", "KV_ERROR", 500),
    });
    const res = await promote();
    expect(res.status).toBe(400);
  });

  it("400s when recording the promoted status fails after PR creation", async () => {
    vi.mocked(updateChangeStatus).mockResolvedValue({
      success: false,
      error: new AppError("write failed", "DATABASE_ERROR", 500),
    });
    const res = await promote();
    expect(res.status).toBe(400);
  });

  it("502s when the workspace clone fails, preserving the upstream Git status", async () => {
    vi.mocked(cloneRepo).mockResolvedValue({
      success: false,
      error: new AppError("Git error: Failed to clone repository", "EXTERNAL_SERVICE_ERROR", 502),
    });
    const res = await promote();
    expect(res.status).toBe(502);
    expect(pushBranchToRemote).not.toHaveBeenCalled();
  });
});

describe("POST /api/changes/:id/evaluate — stale approval dismissal (#193)", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  const evaluatedChange: Change = {
    ...mockChange,
    status: "approved",
    evaluatedSha: "old_sha",
    evaluatedTreeOid: "old_tree",
  };

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
      return { success: false, error: new NotFoundError("User", token) };
    });
    vi.mocked(getChange).mockResolvedValue({ success: true, data: evaluatedChange });
    vi.mocked(getProject).mockResolvedValue({ success: true, data: mockProject });
    vi.mocked(getWorkspace).mockResolvedValue({ success: true, data: mockWorkspace });
    vi.mocked(freshRepoToken).mockImplementation(async () => ({
      success: true,
      data: "test-token",
    }));
    vi.mocked(loadPolicy).mockResolvedValue(mockPolicy);
    // Re-push landed new commits: the re-evaluated tip differs from old_sha.
    vi.mocked(getDiffBetweenRepos).mockResolvedValue({
      success: true,
      data: {
        diff: "diff --git a/src/index.ts b/src/index.ts\n+new line",
        workspaceOid: "new_sha",
        workspaceTreeOid: "new_tree",
        workspaceSha: "new_sha",
        baseOid: "base_sha_from_diff_clone",
      },
    });
    vi.mocked(updateChangeStatus).mockResolvedValue({ success: true, data: undefined });
    vi.mocked(recordEvalRuns).mockResolvedValue({ success: true, data: [] });
    vi.mocked(dismissApprovalsAndUpdateStatus).mockResolvedValue({
      success: true,
      data: { dismissedReviewerIds: ["user_1"] },
    });
    vi.mocked(recordAudit).mockResolvedValue({ success: true, data: undefined });
    vi.mocked(CompositeEvaluator).mockImplementation(
      () =>
        ({
          aggregate: vi.fn().mockReturnValue(passingEvalResult),
        }) as unknown as CompositeEvaluator,
    );
  });

  it("atomically dismisses stale approvals and re-pins the sha in one batch call (#238)", async () => {
    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/evaluate", {}, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);

    // The dismissal and the status/sha re-pin are ONE call now, not two
    // separate writes — see storage/changes.ts dismissApprovalsAndUpdateStatus.
    expect(dismissApprovalsAndUpdateStatus).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      "chg_abc123",
      "accepted",
      expect.objectContaining({ evaluatedSha: "new_sha" }),
    );
    // The plain, non-atomic updateChangeStatus must not also run for this path
    // — that would reintroduce the two-write race #238 removes.
    expect(updateChangeStatus).not.toHaveBeenCalled();
  });

  it("records an audit entry for the dismissal", async () => {
    vi.mocked(dismissApprovalsAndUpdateStatus).mockResolvedValue({
      success: true,
      data: { dismissedReviewerIds: ["user_1", "user_2"] },
    });
    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/evaluate", {}, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);

    expect(recordAudit).toHaveBeenCalledWith(env.DB, expect.any(Object), {
      action: "review.approvals_dismissed",
      actorType: "user",
      actorId: "user_test",
      subject: "chg_abc123",
      detail: {
        project: "my-project",
        dismissed: 2,
        dismissedReviewerIds: ["user_1", "user_2"],
        previousEvaluatedSha: "old_sha",
        evaluatedSha: "new_sha",
        // The fixture change carries no baseSha, so only the tip moved here.
        previousBaseSha: undefined,
        baseSha: "base_sha_from_diff_clone",
        dismissedFor: "tip",
      },
    });
    // The audit entry is only recorded once the batch itself has succeeded.
    const batchOrder = vi.mocked(dismissApprovalsAndUpdateStatus).mock.invocationCallOrder[0] ?? 0;
    const auditOrder = vi.mocked(recordAudit).mock.invocationCallOrder[0] ?? 0;
    expect(batchOrder).toBeLessThan(auditOrder);
  });

  it("logs but does not fail the request when auditing the dismissal fails", async () => {
    vi.mocked(dismissApprovalsAndUpdateStatus).mockResolvedValue({
      success: true,
      data: { dismissedReviewerIds: ["user_1"] },
    });
    vi.mocked(recordAudit).mockResolvedValue({
      success: false,
      error: new AppError("D1 unavailable", "DATABASE_ERROR", 500),
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/evaluate", {}, USER_AUTH),
      env,
    );

    // The dismissal + re-pin batch already landed; a failed audit write must
    // not fail the request.
    expect(res.status).toBe(200);
    expect(dismissApprovalsAndUpdateStatus).toHaveBeenCalled();
  });

  it("recomputes the protected-config flag from the re-evaluated diff", async () => {
    // A change that was benign when opened can acquire a policy edit before
    // re-evaluation. Re-evaluation re-pins evaluatedSha to the new tip, which is
    // what the merge route's staleness check compares against — so if the flag
    // kept its creation-time value, the relaxation would merge without the
    // approval SA-3 requires.
    const policyDiff =
      "diff --git a/.stratum/policy.yaml b/.stratum/policy.yaml\n+requiredApprovals: 0";
    vi.mocked(getDiffBetweenRepos).mockResolvedValue({
      success: true,
      data: {
        diff: policyDiff,
        workspaceOid: "new_sha",
        workspaceTreeOid: "new_tree",
        workspaceSha: "new_sha",
        baseOid: "base_sha_from_diff_clone",
      },
    });
    vi.mocked(diffTouchesProtectedConfig).mockReturnValue(true);

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/evaluate", {}, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);

    // Detection must run against the diff this re-evaluation actually saw, not
    // the one the change was opened with.
    expect(diffTouchesProtectedConfig).toHaveBeenCalledWith(policyDiff);
    // The evaluated sha changes here (old_sha -> new_sha), so the re-pin goes
    // through the atomic dismiss+update batch (#238), not the plain
    // updateChangeStatus path.
    expect(dismissApprovalsAndUpdateStatus).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      "chg_abc123",
      expect.any(String),
      expect.objectContaining({ touchesProtectedConfig: true }),
    );
  });

  it("#274: re-pins the recorded base to the one the re-evaluation ran against", async () => {
    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/evaluate", {}, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);

    // Without this the merge gate keeps comparing `change.baseSha` — the base at
    // CREATION — against the current project head, so a change whose base moved
    // stays STALE_BASE no matter how often it is re-evaluated, and re-evaluation
    // (the documented remedy) reports a fresh pass that can never be merged.
    expect(dismissApprovalsAndUpdateStatus).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      "chg_abc123",
      expect.any(String),
      expect.objectContaining({ baseSha: "base_sha_from_diff_clone" }),
    );
  });

  it("clears the protected-config flag when the re-evaluated diff no longer touches it", async () => {
    // The recomputation must be symmetric: dropping the policy edit before
    // re-evaluation must clear the flag, not leave the change permanently gated.
    vi.mocked(diffTouchesProtectedConfig).mockReturnValue(false);

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/evaluate", {}, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);

    // The default beforeEach setup re-pins a new evaluated sha, so this also
    // goes through the atomic dismiss+update batch (#238).
    expect(dismissApprovalsAndUpdateStatus).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      "chg_abc123",
      expect.any(String),
      expect.objectContaining({ touchesProtectedConfig: false }),
    );
  });

  it("keeps approvals when the re-evaluated sha is unchanged", async () => {
    vi.mocked(getDiffBetweenRepos).mockResolvedValue({
      success: true,
      data: {
        diff: "diff --git a/src/index.ts b/src/index.ts\n+new line",
        workspaceOid: "old_sha",
        workspaceTreeOid: "old_tree",
        workspaceSha: "old_sha",
        baseOid: "base_sha_from_diff_clone",
      },
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/evaluate", {}, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
    expect(dismissApprovalsAndUpdateStatus).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    // No approvals at risk here, so the plain single-write path is used.
    expect(updateChangeStatus).toHaveBeenCalled();
  });

  it("dismisses approvals when the BASE moved even though the tip did not", async () => {
    // The bypass this closes is one this PR opened. `baseSha` used to be frozen
    // at creation, so a change whose base advanced stayed permanently
    // STALE_BASE and could not merge on an old approval at all. Re-pinning the
    // base (#274) makes re-evaluation the remedy for staleness — and without
    // this, an unchanged workspace tip would clear the merge gate carrying
    // approvals given for a diff against the OLD base. Reviewers approve a
    // diff, not a tip, so either endpoint moving invalidates the verdict.
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...evaluatedChange, baseSha: "base_at_creation" },
    });
    vi.mocked(getDiffBetweenRepos).mockResolvedValue({
      success: true,
      data: {
        diff: "diff --git a/src/index.ts b/src/index.ts\n+new line",
        workspaceOid: "old_sha",
        workspaceTreeOid: "old_tree",
        workspaceSha: "old_sha",
        baseOid: "base_sha_from_diff_clone",
      },
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/evaluate", {}, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
    expect(dismissApprovalsAndUpdateStatus).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      "chg_abc123",
      expect.any(String),
      expect.objectContaining({ baseSha: "base_sha_from_diff_clone" }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      expect.objectContaining({
        action: "review.approvals_dismissed",
        // The audit has to name WHICH endpoint moved: a reader otherwise
        // cannot tell a re-push from a base advance, and the causes differ.
        detail: expect.objectContaining({
          dismissedFor: "base",
          previousBaseSha: "base_at_creation",
          baseSha: "base_sha_from_diff_clone",
        }),
      }),
    );
  });

  it("keeps approvals when neither the tip nor the base moved", async () => {
    // The paired negative: without it, the test above would also pass against
    // an implementation that dismissed on every re-evaluation.
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...evaluatedChange, baseSha: "base_sha_from_diff_clone" },
    });
    vi.mocked(getDiffBetweenRepos).mockResolvedValue({
      success: true,
      data: {
        diff: "diff --git a/src/index.ts b/src/index.ts\n+new line",
        workspaceOid: "old_sha",
        workspaceTreeOid: "old_tree",
        workspaceSha: "old_sha",
        baseOid: "base_sha_from_diff_clone",
      },
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/evaluate", {}, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
    expect(dismissApprovalsAndUpdateStatus).not.toHaveBeenCalled();
    expect(updateChangeStatus).toHaveBeenCalled();
  });

  it("keeps approvals on a legacy change with no recorded evaluated sha", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: true,
      data: { ...mockChange, status: "approved" },
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/evaluate", {}, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
    expect(dismissApprovalsAndUpdateStatus).not.toHaveBeenCalled();
  });

  it("skips the audit entry when there were no approvals to dismiss", async () => {
    vi.mocked(dismissApprovalsAndUpdateStatus).mockResolvedValue({
      success: true,
      data: { dismissedReviewerIds: [] },
    });
    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/evaluate", {}, USER_AUTH),
      env,
    );
    expect(res.status).toBe(200);
    expect(dismissApprovalsAndUpdateStatus).toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("fails closed — without re-pinning the sha or losing approvals — when the atomic batch fails (#238)", async () => {
    vi.mocked(dismissApprovalsAndUpdateStatus).mockResolvedValue({
      success: false,
      error: new AppError("D1 unavailable", "DATABASE_ERROR", 500),
    });

    const res = await app.fetch(
      request("POST", "/api/changes/chg_abc123/evaluate", {}, USER_AUTH),
      env,
    );
    expect(res.status).toBe(500);
    // Neither write is applied outside the failed batch: no separate
    // updateChangeStatus fallback, and no audit entry for a dismissal that
    // never actually landed.
    expect(updateChangeStatus).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
