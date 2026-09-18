/**
 * Every path that records a cost row names who pays.
 *
 * Attribution is only worth having if it is uniform: one unattributed recording
 * site is a hole an account can be steered through. So these tests drive the
 * real routes and services and read the rows out of a real SQLite D1 with the
 * production migrations applied, rather than asserting on a spy's arguments —
 * a `recordCosts` mock would pass whether or not migration 048's columns
 * accept what the call site sends.
 *
 * The conflict-resolution path is the reason this file exists at all: it ran
 * the full evaluator suite, LLM included, and recorded nothing.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalPolicy, EvaluationContext } from "../src/evaluation/types";
import { authMiddleware } from "../src/middleware/auth";
import type { Change, Env, ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

/** Lets a test fail the suite without stopping the evaluators reporting costs. */
const control = vi.hoisted(() => ({ llmPassed: true }));

/**
 * Stand-in evaluators that report spend, so the flattening of
 * `EvalResult.costs` into `recordCosts` is exercised rather than assumed. The
 * LLM one claims BYOK: `source` has to survive the flatten, or a project
 * paying its own provider bill is recorded as platform spend.
 */
function reportingEvaluatorClass(name: string, costs: unknown, passes = () => true) {
  return class {
    async evaluate(
      _diff: string,
      _policy: EvalPolicy,
      _logger: Logger,
      _context?: EvaluationContext,
    ) {
      const passed = passes();
      const reason = `${name} ${passed ? "ok" : "blocked"}`;
      return {
        success: true as const,
        data: { score: passed ? 1 : 0, passed, reason, costs },
      };
    }
  };
}

vi.mock("../src/evaluation/secret-scanner", async (importActual) => ({
  ...(await importActual<typeof import("../src/evaluation/secret-scanner")>()),
  SecretScanEvaluator: reportingEvaluatorClass("secret_scan", undefined),
}));

vi.mock("../src/evaluation/llm-evaluator", async (importActual) => ({
  ...(await importActual<typeof import("../src/evaluation/llm-evaluator")>()),
  LLMEvaluator: reportingEvaluatorClass(
    "llm",
    [{ kind: "llm_tokens", quantity: 1500, estimated: true, source: "byok" }],
    () => control.llmPassed,
  ),
}));

vi.mock("../src/evaluation/policy-loader", async (importActual) => ({
  ...(await importActual<typeof import("../src/evaluation/policy-loader")>()),
  loadPolicy: vi.fn(),
}));

vi.mock("../src/storage/git-ops", async (importActual) => ({
  ...(await importActual<typeof import("../src/storage/git-ops")>()),
  freshRepoToken: vi.fn(async () => ({ success: true, data: "test-token" })),
  getCommitLog: vi.fn(),
  getDiffBetweenRepos: vi.fn(),
  buildManualResolutionDiff: vi.fn(),
  mergeWorkspaceIntoProject: vi.fn(async () => ({ success: true, data: "sha_merged" })),
  resolveConflict: vi.fn(async () => ({ success: true, data: { commitSha: "resolved_sha" } })),
}));

vi.mock("../src/storage/sync", async (importActual) => ({
  ...(await importActual<typeof import("../src/storage/sync")>()),
  recordSyncHistory: vi.fn(async () => undefined),
}));

vi.mock("../src/storage/repo-snapshot", () => ({
  readRepoSnapshot: vi.fn(async () => ({ success: true, data: null })),
}));

vi.mock("../src/storage/state", async (importActual) => ({
  ...(await importActual<typeof import("../src/storage/state")>()),
  getProject: vi.fn(),
  getProjectByPath: vi.fn(),
  getWorkspace: vi.fn(),
}));

vi.mock("../src/storage/changes", async (importActual) => ({
  ...(await importActual<typeof import("../src/storage/changes")>()),
  createChange: vi.fn(),
  getChange: vi.fn(),
  updateChangeStatus: vi.fn(async () => ({ success: true, data: undefined })),
  markChangeMerged: vi.fn(async () => ({ success: true, data: { transitioned: true } })),
  dismissApprovalsAndUpdateStatus: vi.fn(async () => ({
    success: true,
    data: { dismissedReviewerIds: [] },
  })),
}));

vi.mock("../src/storage/eval-runs", async (importActual) => ({
  ...(await importActual<typeof import("../src/storage/eval-runs")>()),
  recordEvalRuns: vi.fn(async () => ({ success: true, data: [] })),
}));

vi.mock("../src/storage/provenance", () => ({
  recordProvenance: vi.fn(async () => ({ success: true, data: undefined })),
}));

vi.mock("../src/merge/post-merge", () => ({
  runPostMergeCheck: vi.fn(async () => ({ status: "skipped" })),
}));

vi.mock("../src/storage/deletion", () => ({
  isTargetDeleting: vi.fn(async () => false),
}));

vi.mock("../src/queue/events", () => ({
  emitEvent: vi.fn(async () => undefined),
}));

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(),
  getUser: vi.fn(),
}));

import { loadPolicy } from "../src/evaluation/policy-loader";
import { changesRouter } from "../src/routes/changes";
import { syncManagementRouter } from "../src/routes/sync-management";
import { createChangeWithEvaluation } from "../src/services/change-flow";
import { createChange, getChange } from "../src/storage/changes";
import {
  buildManualResolutionDiff,
  getCommitLog,
  getDiffBetweenRepos,
} from "../src/storage/git-ops";
import { getProject, getProjectByPath, getWorkspace } from "../src/storage/state";
import { getUserByToken } from "../src/storage/users";
import { createLogger } from "../src/utils/logger";

const logger = createLogger({ component: "test" });
const USER_AUTH = { Authorization: "Bearer stratum_user_testtoken00000000000000000" };

function projectEntry(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    id: "proj_abc",
    name: "my-repo",
    slug: "my-repo",
    namespace: "@alice",
    ownerId: "user_alice",
    ownerType: "user",
    remote: "https://artifacts.example.com/repos/my-repo",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const WORKSPACE = {
  name: "ws-1",
  remote: "https://artifacts.example.com/repos/ws-1",
  parent: "proj_abc",
  createdAt: "2026-01-01T01:00:00.000Z",
};

const CHANGE: Change = {
  id: "chg_abc123",
  project: "@alice/my-repo",
  projectId: "proj_abc",
  workspace: "ws-1",
  status: "accepted",
  evalPassed: true,
  evalScore: 1,
  createdAt: "2026-01-01T02:00:00.000Z",
};

interface CostRow {
  project: string;
  project_id: string | null;
  change_id: string | null;
  workspace: string | null;
  kind: string;
  quantity: number;
  owner_id: string | null;
  owner_type: string | null;
  source: string;
}

let db: D1Database;
let raw: ReturnType<typeof makeSqliteD1>["raw"];

function costRows(): CostRow[] {
  return raw.prepare("SELECT * FROM cost_records ORDER BY kind").all() as unknown as CostRow[];
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: makeFakeKV(),
    DB: db,
    AI: {} as Env["AI"],
    ...overrides,
  } as Env;
}

beforeEach(() => {
  const made = makeSqliteD1();
  db = made.db;
  raw = made.raw;
  vi.clearAllMocks();
  control.llmPassed = true;

  vi.mocked(loadPolicy).mockResolvedValue({
    evaluators: [{ type: "llm" }],
    requireAll: true,
    minScore: 0.7,
  });
  vi.mocked(getCommitLog).mockResolvedValue({
    success: true,
    data: [{ sha: "head_sha", message: "m", author: "a", timestamp: 0 }],
  });
  vi.mocked(getDiffBetweenRepos).mockResolvedValue({
    success: true,
    data: {
      diff: "diff --git a/a.ts b/a.ts\n+line",
      workspaceOid: "ws_tip",
      workspaceTreeOid: "ws_tree",
      workspaceSha: "ws_tip",
      baseOid: "base_from_diff_clone",
    },
  });
  vi.mocked(createChange).mockResolvedValue({ success: true, data: CHANGE });
  vi.mocked(getChange).mockResolvedValue({ success: true, data: CHANGE });
  vi.mocked(getProject).mockResolvedValue({ success: true, data: projectEntry() });
  vi.mocked(getProjectByPath).mockResolvedValue({ success: true, data: projectEntry() });
  vi.mocked(getWorkspace).mockResolvedValue({ success: true, data: WORKSPACE });
  vi.mocked(getUserByToken).mockResolvedValue({
    success: true,
    data: {
      id: "user_alice",
      email: "alice@example.com",
      username: "alice",
      tokenHash: "hash",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  });
});

function makeApp(router: Hono<{ Bindings: Env }>) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.route("/api", router);
  return app;
}

// ---------------------------------------------------------------------------
// Change creation (src/services/change-flow.ts)
// ---------------------------------------------------------------------------

describe("createChangeWithEvaluation records attributed costs", () => {
  async function create(project: ProjectEntry) {
    return createChangeWithEvaluation(makeEnv(), logger, {
      project,
      projectName: "@alice/my-repo",
      workspaceName: WORKSPACE.name,
      workspaceRemote: WORKSPACE.remote,
      actor: { userId: "user_alice" },
    });
  }

  it("bills the owning user, and carries the evaluator's own source through", async () => {
    const outcome = await create(projectEntry());
    expect(outcome.success).toBe(true);

    const byKind = Object.fromEntries(costRows().map((r) => [r.kind, r]));
    expect(byKind.git_ops).toMatchObject({
      owner_id: "user_alice",
      owner_type: "user",
      source: "platform",
      change_id: "chg_abc123",
      project_id: "proj_abc",
      workspace: "ws-1",
    });
    // The evaluator paid its own provider; the clone of both repos was ours.
    expect(byKind.llm_tokens).toMatchObject({
      owner_id: "user_alice",
      owner_type: "user",
      source: "byok",
      quantity: 1500,
    });
  });

  it("bills an org-owned project to the org", async () => {
    await create(projectEntry({ ownerId: "org_acme", ownerType: "org" }));
    // Guarded: a regression that stopped recording costs entirely would leave a
    // bare `for` over an empty array green, which is the one property this file
    // exists to protect.
    expect(costRows().length).toBeGreaterThan(0);
    for (const row of costRows()) {
      expect(row.owner_id).toBe("org_acme");
      expect(row.owner_type).toBe("org");
    }
  });

  it("walks an agent-owned project to its user", async () => {
    // An agent is not a payer, it belongs to one. The walk is
    // `resolveBillingSubject`'s D1 read, and every site on the request — the
    // ledger row below and the evaluators' meter checks — now sees the same
    // resolved user, where the evaluators used to see nothing at all.
    raw
      .prepare("INSERT INTO users (id, email, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .run("user_alice", "alice@example.com", "hash", "2026-01-01T00:00:00.000Z");
    raw
      .prepare("INSERT INTO agents (id, name, owner_id, token_hash) VALUES (?, ?, ?, ?)")
      .run("agt_bot", "bot", "user_alice", "agent-hash");

    await create(projectEntry({ ownerId: "agt_bot", ownerType: "agent" }));

    expect(costRows().length).toBeGreaterThan(0);
    for (const row of costRows()) {
      expect(row.owner_id).toBe("user_alice");
      expect(row.owner_type).toBe("user");
    }
  });

  it("still records the change's costs when no owner can be resolved", async () => {
    // A failed resolution must cost the attribution, never the change: the
    // change is created and the row lands with a NULL owner.
    const outcome = await create(projectEntry({ ownerId: "" }));
    expect(outcome.success).toBe(true);
    expect(costRows().length).toBeGreaterThan(0);
    for (const row of costRows()) expect(row.owner_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Re-evaluation and merge (src/routes/changes.ts)
// ---------------------------------------------------------------------------

describe("POST /api/changes/:id/evaluate records attributed costs", () => {
  it("attributes the re-evaluation's spend to the project's owner", async () => {
    const res = await makeApp(changesRouter).fetch(
      new Request("http://localhost/api/changes/chg_abc123/evaluate", {
        method: "POST",
        headers: { ...USER_AUTH, "Content-Type": "application/json" },
        body: "{}",
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    const byKind = Object.fromEntries(costRows().map((r) => [r.kind, r]));
    expect(byKind.llm_tokens).toMatchObject({
      owner_id: "user_alice",
      owner_type: "user",
      source: "byok",
      change_id: "chg_abc123",
    });
    expect(byKind.git_ops?.owner_id).toBe("user_alice");
  });
});

describe("POST /api/changes/:id/merge records attributed costs", () => {
  function mergeRequest(query = ""): Request {
    return new Request(`http://localhost/api/changes/chg_abc123/merge${query}`, {
      method: "POST",
      headers: USER_AUTH,
    });
  }

  // NOTE ON WHAT THIS COVERS. `makeEnv()` binds no MERGE_QUEUE, which is the
  // ONLY reason control reaches the recordCosts this asserts on. With the
  // binding present — as it is in the top-level, production and staging configs
  // — a `strategy=merge` request takes the MergeQueue branch at
  // `changes.ts:589`, which returns before that recording. So this covers the
  // cold path a self-hoster without the binding gets, and `?strategy=squash`.
  // It does NOT cover a default merge on the hosted instance, which records
  // nothing at all; the sibling test below pins that gap so it cannot be
  // mistaken for coverage.
  it("attributes the cold path's git operations to the project's owner", async () => {
    const res = await makeApp(changesRouter).fetch(mergeRequest(), makeEnv());

    expect(res.status).toBe(200);
    expect(costRows()).toHaveLength(1);
    expect(costRows()[0]).toMatchObject({
      kind: "git_ops",
      owner_id: "user_alice",
      owner_type: "user",
      source: "platform",
      change_id: "chg_abc123",
    });
  });

  it("still records for ?strategy=squash, which never takes the queue branch", async () => {
    // The queue branch is gated on `strategy === "merge"`, so squash reaches the
    // cold path even with the binding present. Written because the note above
    // claims this coverage.
    const queueEnv = makeEnv({
      MERGE_QUEUE: {
        idFromName: (name: string) => name,
        get: () => ({
          merge: async () => {
            throw new Error("squash must not reach the merge queue");
          },
        }),
      } as unknown as Env["MERGE_QUEUE"],
    });

    const res = await makeApp(changesRouter).fetch(mergeRequest("?strategy=squash"), queueEnv);

    expect(res.status).toBe(200);
    expect(costRows()[0]).toMatchObject({ kind: "git_ops", owner_id: "user_alice" });
  });

  it("records NOTHING when the merge queue is bound, which is every deployed config", async () => {
    // Asserting the gap rather than the fix, deliberately. Closing it means
    // recording inside the queue branch, which is its own change; until then a
    // green suite must not imply merges are metered in production. Flip this to
    // expect a row when that lands.
    // `transitioned: false` is the queue branch's earliest clean exit — it
    // returns 200 right after logging, skipping the event emit and post-merge
    // work this test has no business exercising. Any successful outcome reaches
    // the same conclusion: no recordCosts on the way out.
    const queueEnv = makeEnv({
      MERGE_QUEUE: {
        idFromName: (name: string) => name,
        get: () => ({
          merge: async () => ({ success: true, transitioned: false, commit: "merged_sha" }),
        }),
      } as unknown as Env["MERGE_QUEUE"],
    });

    const res = await makeApp(changesRouter).fetch(mergeRequest(), queueEnv);

    expect(res.status).toBe(200);
    expect(costRows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2.5 — the path that recorded nothing
// ---------------------------------------------------------------------------

describe("POST /api/projects/conflicts/:id/resolve records attributed costs", () => {
  const CONFLICT_CTX = {
    conflictId: "conflict-abc",
    namespace: "@alice",
    slug: "my-repo",
    workspaceName: "ws-1",
    conflictingFiles: ["src/a.ts"],
    detectedAt: "2026-01-01T00:00:00.000Z",
    changeId: "chg_abc123",
  };

  function envWithConflict(ctx: Record<string, unknown> = CONFLICT_CTX): Env {
    const kv = makeFakeKV();
    kv.store.set(`conflict:${CONFLICT_CTX.conflictId}`, JSON.stringify(ctx));
    return makeEnv({ STATE: kv });
  }

  function resolveRequest() {
    return new Request("http://localhost/api/projects/conflicts/conflict-abc/resolve", {
      method: "POST",
      headers: { ...USER_AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        strategy: "manual",
        resolutions: [{ file: "src/a.ts", content: "resolved\n" }],
      }),
    });
  }

  beforeEach(() => {
    vi.mocked(buildManualResolutionDiff).mockResolvedValue({
      success: true,
      data: { diff: "diff --git a/a.ts b/a.ts\n+line", baseSha: "conflict_base_sha" },
    });
  });

  it("records the suite's spend against the project's owner", async () => {
    const res = await makeApp(syncManagementRouter).fetch(resolveRequest(), envWithConflict());

    expect(res.status).toBe(200);
    const byKind = Object.fromEntries(costRows().map((r) => [r.kind, r]));
    expect(byKind.llm_tokens).toMatchObject({
      owner_id: "user_alice",
      owner_type: "user",
      source: "byok",
      quantity: 1500,
      // A resolution is part of landing the change whose merge hit the conflict.
      change_id: "chg_abc123",
      workspace: "ws-1",
      project: "@alice/my-repo",
    });
    expect(byKind.git_ops?.owner_id).toBe("user_alice");
  });

  it("records the spend even when the suite rejects the resolution", async () => {
    // The tokens were spent producing the rejection. Recording after the
    // verdict would make a blocked resolution free, which is exactly the shape
    // of spend an unmetered account would learn to produce. The evaluator
    // still runs and still reports what it cost — it just says no.
    control.llmPassed = false;

    const res = await makeApp(syncManagementRouter).fetch(resolveRequest(), envWithConflict());

    expect(res.status).toBe(422);
    const byKind = Object.fromEntries(costRows().map((r) => [r.kind, r]));
    expect(byKind.llm_tokens).toMatchObject({ owner_id: "user_alice", quantity: 1500 });
  });

  it("records the clone and push for a strategy that runs no evaluator", async () => {
    // accept-project and accept-workspace skip the evaluator suite entirely, but
    // resolveConflict still clones both repos and pushes for every strategy. The
    // suite's recording lives in the manual branch, so billing the git work
    // there would have made these two resolutions free.
    const request = new Request("http://localhost/api/projects/conflicts/conflict-abc/resolve", {
      method: "POST",
      headers: { ...USER_AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: "accept-project" }),
    });

    const res = await makeApp(syncManagementRouter).fetch(request, envWithConflict());

    expect(res.status).toBe(200);
    const rows = costRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "git_ops",
      quantity: 2,
      owner_id: "user_alice",
      owner_type: "user",
      project: "@alice/my-repo",
    });
  });

  it("bills the manual path for the resolve clone on top of the suite", async () => {
    const res = await makeApp(syncManagementRouter).fetch(resolveRequest(), envWithConflict());

    expect(res.status).toBe(200);
    // One git_op for buildManualResolutionDiff's clone, two for resolveConflict's
    // clone-both-and-push. Under-counting here was the whole defect.
    const gitOps = costRows()
      .filter((r) => r.kind === "git_ops")
      .reduce((sum, r) => sum + r.quantity, 0);
    expect(gitOps).toBe(3);
  });

  it("leaves change_id null when the conflict predates that field", async () => {
    const { changeId: _dropped, ...legacy } = CONFLICT_CTX;
    const res = await makeApp(syncManagementRouter).fetch(
      resolveRequest(),
      envWithConflict(legacy),
    );

    expect(res.status).toBe(200);
    expect(costRows().length).toBeGreaterThan(0);
    for (const row of costRows()) {
      expect(row.change_id).toBeNull();
      // Still attributed: the payer comes from the project, not the change.
      expect(row.owner_id).toBe("user_alice");
    }
  });
});
