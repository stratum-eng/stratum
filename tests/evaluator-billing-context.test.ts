import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalPolicy, EvaluationContext, Evaluator } from "../src/evaluation/types";
import { authMiddleware } from "../src/middleware/auth";
import type { Change, Env, ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";

/**
 * Task 1 is a pure refactor whose only observable effect is what reaches the
 * evaluator layer: `buildEvaluators` now takes the whole `ProjectEntry`, and
 * every `runEvaluation` call site carries a `BillingContext`. So these tests
 * assert on the `EvaluationContext` each evaluator is actually handed, at each
 * of the three call sites, rather than on any route's response body.
 */

/** Contexts captured from the evaluator classes the call sites really build. */
const captured = vi.hoisted(() => ({
  calls: [] as Array<{ evaluator: string; context?: EvaluationContext }>,
}));

function recordingEvaluatorClass(name: string) {
  return class {
    async evaluate(
      _diff: string,
      _policy: EvalPolicy,
      _logger: Logger,
      context?: EvaluationContext,
    ) {
      captured.calls.push({ evaluator: name, context });
      return { success: true as const, data: { score: 1, passed: true, reason: `${name} ok` } };
    }
  };
}

// The secret scan is on every evaluator set unconditionally, so it is the one
// evaluator guaranteed to observe the context at all three call sites.
vi.mock("../src/evaluation/secret-scanner", async (importActual) => ({
  ...(await importActual<typeof import("../src/evaluation/secret-scanner")>()),
  SecretScanEvaluator: recordingEvaluatorClass("secret_scan"),
}));

vi.mock("../src/evaluation/llm-evaluator", async (importActual) => ({
  ...(await importActual<typeof import("../src/evaluation/llm-evaluator")>()),
  LLMEvaluator: recordingEvaluatorClass("llm"),
}));

vi.mock("../src/evaluation/policy-loader", async (importActual) => ({
  ...(await importActual<typeof import("../src/evaluation/policy-loader")>()),
  // The real loader clones the project repo to read .stratum/policy.yaml.
  loadPolicy: vi.fn(),
}));

vi.mock("../src/storage/git-ops", async (importActual) => ({
  ...(await importActual<typeof import("../src/storage/git-ops")>()),
  freshRepoToken: vi.fn(async () => ({ success: true, data: "test-token" })),
  getCommitLog: vi.fn(),
  getDiffBetweenRepos: vi.fn(),
  buildManualResolutionDiff: vi.fn(),
  // The real one clones both repos and pushes; the conflict route's gate runs
  // before it, which is the part under test here.
  resolveConflict: vi.fn(async () => ({ success: true, data: { commitSha: "resolved_sha" } })),
}));

vi.mock("../src/storage/sync", async (importActual) => ({
  ...(await importActual<typeof import("../src/storage/sync")>()),
  recordSyncHistory: vi.fn(async () => undefined),
}));

vi.mock("../src/storage/audit", async (importActual) => ({
  ...(await importActual<typeof import("../src/storage/audit")>()),
  recordAudit: vi.fn(async () => ({ success: true, data: undefined })),
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
  dismissApprovalsAndUpdateStatus: vi.fn(async () => ({
    success: true,
    data: { dismissedReviewerIds: [] },
  })),
}));

vi.mock("../src/storage/eval-runs", async (importActual) => ({
  ...(await importActual<typeof import("../src/storage/eval-runs")>()),
  recordEvalRuns: vi.fn(async () => ({ success: true, data: [] })),
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

vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(async () => ({ success: false, error: { code: "NOT_FOUND" } })),
  // Cost attribution walks this for an agent-owned project (`resolveBillingSubject`).
  // These tests assert on the evaluation context, not the ledger, so the walk
  // resolving to nothing is the right default here — it costs the attribution
  // and never the change.
  getAgent: vi.fn(async () => ({
    success: false,
    error: { code: "NOT_FOUND", message: "Agent not found" },
  })),
}));

import { DiffEvaluator } from "../src/evaluation/diff-evaluator";
import { LLMEvaluator } from "../src/evaluation/llm-evaluator";
import { loadPolicy } from "../src/evaluation/policy-loader";
import { SecretScanEvaluator } from "../src/evaluation/secret-scanner";
import { WebhookEvaluator } from "../src/evaluation/webhook-evaluator";
import { changesRouter } from "../src/routes/changes";
import { syncManagementRouter } from "../src/routes/sync-management";
import {
  UnavailableEvaluator,
  billingContextFor,
  buildEvaluators,
  createChangeWithEvaluation,
  runEvaluation,
} from "../src/services/change-flow";
import { getChange } from "../src/storage/changes";
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
  status: "open",
  createdAt: "2026-01-01T02:00:00.000Z",
};

/** Only the bindings the paths under test touch; D1 is never really queried. */
function makeEnv(): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: {} as KVNamespace,
    DB: {} as D1Database,
    AI: {} as Env["AI"],
  };
}

/** The context the secret scan — present in every evaluator set — was given. */
function secretScanContext(): EvaluationContext | undefined {
  const call = captured.calls.find((c) => c.evaluator === "secret_scan");
  expect(call).toBeDefined();
  return call?.context;
}

function stubDiff() {
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
}

beforeEach(() => {
  vi.clearAllMocks();
  captured.calls.length = 0;
  vi.mocked(loadPolicy).mockResolvedValue({
    evaluators: [{ type: "llm" }],
    requireAll: true,
    minScore: 0.7,
  });
  vi.mocked(getCommitLog).mockResolvedValue({
    success: true,
    data: [{ sha: "head_sha", message: "m", author: "a", timestamp: 0 }],
  });
  stubDiff();
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

// ---------------------------------------------------------------------------
// 1.1 — the billing subject derived from a ProjectEntry
// ---------------------------------------------------------------------------

describe("billingContextFor", () => {
  it("names a user-owned project's owner as the billing subject", () => {
    expect(billingContextFor({ ownerId: "user_alice", ownerType: "user" }, "proj_abc")).toEqual({
      ownerId: "user_alice",
      ownerType: "user",
      projectId: "proj_abc",
    });
  });

  it("names an org-owned project's org as the billing subject", () => {
    expect(billingContextFor({ ownerId: "org_acme", ownerType: "org" }, "proj_abc")).toEqual({
      ownerId: "org_acme",
      ownerType: "org",
      projectId: "proj_abc",
    });
  });

  it("carries the actor alongside the payer, never instead of it", () => {
    // PRD §4a: the ledger records the owner, the limit is checked against the
    // person. One field each, so neither can be read as the other.
    expect(
      billingContextFor({ ownerId: "org_acme", ownerType: "org" }, "proj_abc", "user_alice"),
    ).toEqual({
      ownerId: "org_acme",
      ownerType: "org",
      projectId: "proj_abc",
      actorUserId: "user_alice",
    });
  });

  it("yields no subject when the project id is missing, rather than one keyed on ''", () => {
    // KV entries are cast without shape validation and legacy rows genuinely
    // lack fields, so the type's promise is not a runtime guarantee. Spend that
    // *looks* attributed but aggregates under "" is worse than spend visibly
    // attributed to nobody.
    expect(billingContextFor({ ownerId: "user_alice", ownerType: "user" }, "")).toBeUndefined();
  });

  it("yields no subject when none could be resolved", () => {
    // `resolveBillingSubject` returns null for a project naming no owner, and
    // for an agent whose owner row could not be read. Either way there is
    // nobody to charge, and guessing would be worse than not checking.
    expect(billingContextFor(null, "proj_abc", "user_alice")).toBeUndefined();
  });

  it("takes an agent-owned project's resolved owner, so its meters are checked", () => {
    // The regression this replaced: this function used to refuse an agent-owned
    // project outright, which left `LLMEvaluator` with no billing context and
    // therefore no meter check at all — the agent walk lived in
    // `resolveEnforcementSubject` and nothing ever reached it. The walk is
    // `resolveBillingSubject`'s, and its result is what arrives here.
    expect(billingContextFor({ ownerId: "user_bot_owner", ownerType: "user" }, "proj_abc")).toEqual(
      {
        ownerId: "user_bot_owner",
        ownerType: "user",
        projectId: "proj_abc",
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 1.2 — buildEvaluators takes a ProjectEntry and behaves exactly as before
// ---------------------------------------------------------------------------

describe("buildEvaluators — ProjectEntry replaces the display name", () => {
  const project = projectEntry();

  async function evaluatorFor(policy: EvalPolicy, type: string, env: Env = makeEnv()) {
    const built = await buildEvaluators(env, policy, project, logger);
    const entry = built.find((e) => e.type === type);
    expect(entry).toBeDefined();
    return entry?.evaluator;
  }

  // `SecretScanEvaluator` and `LLMEvaluator` are the recording stand-ins this
  // file substitutes above, not the shipped classes. The assertions still
  // separate the wired branch from `UnavailableEvaluator`, which is what they
  // are for — they just don't prove the real class was constructed.
  it("always prepends the blocking secret scan", async () => {
    const built = await buildEvaluators(makeEnv(), { evaluators: [] }, project, logger);
    expect(built.map((e) => e.type)).toEqual(["secret_scan"]);
    expect(built[0]?.evaluator).toBeInstanceOf(SecretScanEvaluator);
  });

  it("builds a real DiffEvaluator for a diff entry", async () => {
    expect(await evaluatorFor({ evaluators: [{ type: "diff" }] }, "diff")).toBeInstanceOf(
      DiffEvaluator,
    );
  });

  it("builds a real WebhookEvaluator for a webhook entry", async () => {
    const policy: EvalPolicy = { evaluators: [{ type: "webhook", url: "https://hook.test" }] };
    expect(await evaluatorFor(policy, "webhook")).toBeInstanceOf(WebhookEvaluator);
  });

  it("wires the llm evaluator, not UnavailableEvaluator, when the AI binding is present", async () => {
    const evaluator = await evaluatorFor({ evaluators: [{ type: "llm" }] }, "llm");
    expect(evaluator).toBeInstanceOf(LLMEvaluator);
    expect(evaluator).not.toBeInstanceOf(UnavailableEvaluator);
  });

  it("still fails the llm evaluator closed when the AI binding is missing", async () => {
    const policy: EvalPolicy = { evaluators: [{ type: "llm" }] };
    const evaluator = await evaluatorFor(policy, "llm", {} as Env);
    expect(evaluator).toBeInstanceOf(UnavailableEvaluator);
    const result = await evaluator?.evaluate("", policy, logger);
    expect(result?.success).toBe(true);
    if (!result?.success) return;
    expect(result.data.passed).toBe(false);
    expect(result.data.score).toBe(0);
    expect(result.data.reason).toContain("AI binding is not configured");
  });

  it("still fails the sandbox evaluator closed when the binding is missing", async () => {
    const policy: EvalPolicy = { evaluators: [{ type: "sandbox" }] };
    const evaluator = await evaluatorFor(policy, "sandbox");
    expect(evaluator).toBeInstanceOf(UnavailableEvaluator);
    const result = await evaluator?.evaluate("", policy, logger);
    expect(result?.success).toBe(true);
    if (!result?.success) return;
    expect(result.data.reason).toContain("SANDBOX binding is not configured");
  });

  it("drops an unknown evaluator type and names the project in the warning", async () => {
    const warn = vi.fn();
    const warningLogger = { ...logger, warn } as unknown as Logger;
    const policy = { evaluators: [{ type: "quantum" }] } as unknown as EvalPolicy;

    const built = await buildEvaluators(makeEnv(), policy, project, warningLogger);

    expect(built.map((e) => e.type)).toEqual(["secret_scan"]);
    expect(warn).toHaveBeenCalledTimes(1);
    // The display name is derived from the entry now; the log line that used to
    // receive it as a parameter must still identify the project.
    expect(warn.mock.calls[0]?.[0]).toContain("@alice/my-repo");
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ projectName: "@alice/my-repo" });
  });
});

// ---------------------------------------------------------------------------
// runEvaluation forwards the whole context, billing included
// ---------------------------------------------------------------------------

describe("the billing subject stays inside the Worker", () => {
  it("is not forwarded to the policy-supplied webhook URL", async () => {
    // The webhook evaluator POSTs to a URL taken from .stratum/policy.yaml —
    // repository content. It is safe only because it names the fields it sends
    // rather than spreading the context. This pins that: a `...context` there
    // would ship ownerId and projectId to an endpoint the policy file chose.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ score: 1, passed: true })));
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const policy: EvalPolicy = { evaluators: [{ type: "webhook", url: "https://hook.test" }] };
      await new WebhookEvaluator().evaluate("a diff", policy, logger, {
        baseSha: "base",
        billing: billingContextFor({ ownerId: "user_alice", ownerType: "user" }, "proj_abc"),
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body);
      expect(body).toContain("baseSha");
      expect(body).not.toContain("billing");
      expect(body).not.toContain("user_alice");
      expect(body).not.toContain("proj_abc");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("runEvaluation", () => {
  it("keeps a passing verdict when another evaluator REJECTS rather than returning", async () => {
    // `evaluate` returns a Result by contract, but a meter RPC or a provider
    // client can still reject. One rejection must not take the whole run down
    // with it: the gate that could not run fails, and everything else keeps its
    // verdict. Without the catch in `runEvaluation` this rejects the
    // `Promise.all` and fails change creation outright.
    const ok: Evaluator = {
      evaluate: async () => ({ success: true, data: { score: 1, passed: true, reason: "ok" } }),
    };
    const rejecting: Evaluator = {
      evaluate: async () => {
        throw new Error("durable object unreachable");
      },
    };
    const policy: EvalPolicy = { evaluators: [], requireAll: false, minScore: 0.7 };

    const { evalRuns, evalResult } = await runEvaluation(
      [
        { type: "secret_scan", evaluator: ok },
        { type: "llm", evaluator: rejecting },
      ],
      "diff",
      policy,
      logger,
      { baseSha: "base" },
    );

    expect(evalRuns).toHaveLength(2);
    const failed = evalRuns.find((run) => run.evaluatorType === "llm");
    expect(failed?.result).toMatchObject({ score: 0, passed: false });
    expect(failed?.result.reason).toContain("llm evaluator failed");
    expect(failed?.result.reason).toContain("durable object unreachable");
    expect(evalRuns.find((run) => run.evaluatorType === "secret_scan")?.result.passed).toBe(true);
    // The run resolved rather than rejecting, which is the property under test.
    expect(typeof evalResult.passed).toBe("boolean");
  });

  it("forwards the billing context to every evaluator", async () => {
    const seen: Array<EvaluationContext | undefined> = [];
    const spy: Evaluator = {
      evaluate: async (_diff, _policy, _logger, context) => {
        seen.push(context);
        return { success: true, data: { score: 1, passed: true, reason: "ok" } };
      },
    };
    const policy: EvalPolicy = { evaluators: [], requireAll: true, minScore: 0.7 };

    await runEvaluation(
      [
        { type: "secret_scan", evaluator: spy },
        { type: "diff", evaluator: spy },
      ],
      "diff",
      policy,
      logger,
      {
        baseSha: "base",
        billing: billingContextFor({ ownerId: "user_alice", ownerType: "user" }, "proj_abc"),
      },
    );

    expect(seen).toHaveLength(2);
    for (const context of seen) {
      expect(context?.baseSha).toBe("base");
      expect(context?.billing).toEqual({
        ownerId: "user_alice",
        ownerType: "user",
        projectId: "proj_abc",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 1.3 — call site 1: createChangeWithEvaluation (src/services/change-flow.ts)
// ---------------------------------------------------------------------------

describe("createChangeWithEvaluation passes the project through", () => {
  beforeEach(() => {
    vi.mocked(getProject).mockResolvedValue({ success: true, data: projectEntry() });
  });

  async function create(project: ProjectEntry) {
    const { createChange } = await import("../src/storage/changes");
    vi.mocked(createChange).mockResolvedValue({ success: true, data: CHANGE });
    return createChangeWithEvaluation(makeEnv(), logger, {
      project,
      projectName: "@alice/my-repo",
      workspaceName: WORKSPACE.name,
      workspaceRemote: WORKSPACE.remote,
      actor: { userId: "user_alice" },
    });
  }

  it("bills a user-owned project's owner", async () => {
    const outcome = await create(projectEntry());
    expect(outcome.success).toBe(true);
    expect(secretScanContext()).toEqual({
      baseSha: "base_from_diff_clone",
      billing: {
        ownerId: "user_alice",
        ownerType: "user",
        projectId: "proj_abc",
        actorUserId: "user_alice",
      },
    });
  });

  it("bills an org-owned project's org, and still names the actor", async () => {
    await create(projectEntry({ ownerId: "org_acme", ownerType: "org" }));
    // The recorded subject is the org and the ACTOR is carried beside it: PRD
    // §4a checks the limit against the person, while the ledger keeps naming
    // the org. Collapsing the two is the hole that separation closes.
    expect(secretScanContext()?.billing).toEqual({
      ownerId: "org_acme",
      ownerType: "org",
      projectId: "proj_abc",
      actorUserId: "user_alice",
    });
  });

  it("carries no billing subject for an agent-owned project", async () => {
    await create(projectEntry({ ownerId: "agent_bot", ownerType: "agent" }));
    const context = secretScanContext();
    // The base is still pinned: dropping the billing subject must not drop the
    // rest of the context the evaluators already relied on (#274).
    expect(context?.baseSha).toBe("base_from_diff_clone");
    expect(context?.billing).toBeUndefined();
  });

  it("still reaches the LLM evaluator, which is the metered one", async () => {
    await create(projectEntry());
    const llm = captured.calls.find((c) => c.evaluator === "llm");
    expect(llm?.context?.billing).toEqual({
      ownerId: "user_alice",
      ownerType: "user",
      projectId: "proj_abc",
      actorUserId: "user_alice",
    });
  });
});

// ---------------------------------------------------------------------------
// 1.3 — call site 2: POST /api/changes/:id/evaluate (src/routes/changes.ts)
// ---------------------------------------------------------------------------

describe("POST /api/changes/:id/evaluate passes the project through", () => {
  function makeApp() {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", authMiddleware);
    app.route("/api", changesRouter);
    return app;
  }

  it("bills the project's owner, not the change's project name string", async () => {
    vi.mocked(getChange).mockResolvedValue({ success: true, data: CHANGE });
    vi.mocked(getProject).mockResolvedValue({ success: true, data: projectEntry() });
    vi.mocked(getWorkspace).mockResolvedValue({ success: true, data: WORKSPACE });

    const res = await makeApp().fetch(
      new Request("http://localhost/api/changes/chg_abc123/evaluate", {
        method: "POST",
        headers: { ...USER_AUTH, "Content-Type": "application/json" },
        body: "{}",
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    // This route used to pass `change.project` — a string that names no owner
    // and no project id. The evaluators now see the loaded entry.
    expect(secretScanContext()).toEqual({
      baseSha: "base_from_diff_clone",
      billing: {
        ownerId: "user_alice",
        ownerType: "user",
        projectId: "proj_abc",
        actorUserId: "user_alice",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// 1.4 — call site 3: POST /api/projects/conflicts/:id/resolve
// ---------------------------------------------------------------------------

describe("POST /api/projects/conflicts/:id/resolve passes the project through", () => {
  const CONFLICT_CTX = {
    conflictId: "conflict-abc",
    namespace: "@alice",
    slug: "my-repo",
    workspaceName: "ws-1",
    conflictingFiles: ["src/a.ts"],
    detectedAt: "2026-01-01T00:00:00.000Z",
  };

  function makeApp() {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", authMiddleware);
    app.route("/api", syncManagementRouter);
    return app;
  }

  function makeKv(): KVNamespace {
    const kv = makeFakeKV();
    kv.store.set(`conflict:${CONFLICT_CTX.conflictId}`, JSON.stringify(CONFLICT_CTX));
    return kv;
  }

  it("bills the loaded project rather than the synthesized @ns/slug string", async () => {
    vi.mocked(getProjectByPath).mockResolvedValue({ success: true, data: projectEntry() });
    vi.mocked(getWorkspace).mockResolvedValue({ success: true, data: WORKSPACE });
    vi.mocked(buildManualResolutionDiff).mockResolvedValue({
      success: true,
      data: { diff: "diff --git a/a.ts b/a.ts\n+line", baseSha: "conflict_base_sha" },
    });

    const res = await makeApp().fetch(
      new Request("http://localhost/api/projects/conflicts/conflict-abc/resolve", {
        method: "POST",
        headers: { ...USER_AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy: "manual",
          resolutions: [{ file: "src/a.ts", content: "resolved\n" }],
        }),
      }),
      { ...makeEnv(), STATE: makeKv() },
    );

    expect(res.status).toBe(200);
    expect(secretScanContext()).toEqual({
      baseSha: "conflict_base_sha",
      billing: {
        ownerId: "user_alice",
        ownerType: "user",
        projectId: "proj_abc",
        actorUserId: "user_alice",
      },
    });
  });
});
