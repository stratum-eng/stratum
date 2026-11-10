/**
 * Asynchronous evaluation end to end (#412): the change routes against a real
 * SQLite D1, the queue consumer, and the merge gate. Only the edges are faked —
 * KV lookups, Artifacts tokens and the diff, the policy read, and the queue.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { handleEvaluationQueue } from "../src/queue/evaluation-queue";
import { changesRouter } from "../src/routes/changes";
import { reviewsRouter } from "../src/routes/reviews";
import { getChange } from "../src/storage/changes";
import type { Env, EvaluationQueueMessage, MessageBatch } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

vi.mock("../src/storage/state", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/state")>();
  return { ...actual, getProject: vi.fn(), getWorkspace: vi.fn() };
});

vi.mock("../src/storage/git-ops", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    freshRepoToken: vi.fn(async () => ({ success: true, data: "tok" })),
    getDiffBetweenRepos: vi.fn(),
    getCommitLog: vi.fn(async () => ({ success: true, data: [] })),
  };
});

vi.mock("../src/storage/artifacts-reads", () => ({
  getCommitLogPreferNative: vi.fn(async () => ({ success: true, data: [{ sha: "base-sha" }] })),
}));

vi.mock("../src/storage/repo-snapshot", () => ({
  readRepoSnapshot: vi.fn(async () => ({ success: true, data: null })),
}));

vi.mock("../src/storage/deletion", () => ({
  isTargetDeleting: vi.fn(async () => false),
}));

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(async () => ({
    success: true,
    data: {
      id: "usr_owner",
      email: "owner@example.com",
      username: "owner",
      tokenHash: "hash",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  })),
  getUser: vi.fn(),
}));

// The real evaluators run, except where a test swaps the secret scan for one
// that never settles. The policy read is the only part replaced outright.
const secretScanEvaluate = vi.fn();
vi.mock("../src/evaluation", async (importActual) => {
  const actual = await importActual<typeof import("../src/evaluation")>();
  return {
    ...actual,
    loadPolicy: vi.fn(),
    SecretScanEvaluator: vi.fn().mockImplementation(() => ({ evaluate: secretScanEvaluate })),
  };
});

import { loadPolicy } from "../src/evaluation";
import { getDiffBetweenRepos } from "../src/storage/git-ops";
import { getProject, getWorkspace } from "../src/storage/state";

const AUTH = { Authorization: "Bearer stratum_user_testtoken00000000000000000" };

const project = {
  id: "prj_1",
  name: "repo",
  slug: "repo",
  namespace: "@owner",
  ownerId: "usr_owner",
  ownerType: "user" as const,
  remote: "https://artifacts.example.com/repos/repo",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const workspace = {
  name: "ws",
  remote: "https://artifacts.example.com/repos/ws",
  parent: "prj_1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const logger: Logger = {
  trace: vi.fn(),
  fatal: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.route("/api", changesRouter);
  app.route("/api", reviewsRouter);
  return app;
}

function json(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { ...AUTH, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function batchOf(body: EvaluationQueueMessage) {
  const message = {
    id: "msg_1",
    body,
    attempts: 1,
    timestamp: new Date(),
    ack: vi.fn(),
    retry: vi.fn(),
  };
  const batch = {
    queue: "stratum-evaluations",
    messages: [message],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
  return { batch, message };
}

describe("asynchronous evaluation (#412)", () => {
  let db: D1Database;
  let send: ReturnType<typeof vi.fn>;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ db } = makeSqliteD1());
    send = vi.fn(async () => undefined);
    env = {
      DB: db,
      STATE: {} as KVNamespace,
      ARTIFACTS: {} as Env["ARTIFACTS"],
      EVALUATION_QUEUE: { send } as unknown as Env["EVALUATION_QUEUE"],
    };
    vi.mocked(getProject).mockResolvedValue({ success: true, data: project });
    vi.mocked(getWorkspace).mockResolvedValue({ success: true, data: workspace });
    vi.mocked(loadPolicy).mockResolvedValue({
      evaluators: [],
      merge: { allowForce: true },
    });
    vi.mocked(getDiffBetweenRepos).mockResolvedValue({
      success: true,
      data: {
        diff: "diff --git a/x b/x\n+hello\n",
        workspaceOid: "tip-1",
        workspaceTreeOid: "tree-1",
        workspaceSha: "tip-1",
        baseOid: "base-sha",
        mergeBaseOid: "base-sha",
        behindBy: 0,
      },
    });
    secretScanEvaluate.mockResolvedValue({
      success: true,
      data: { score: 1, passed: true, reason: "No secrets detected" },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function createQueued(): Promise<{ id: string; runId: string }> {
    const res = await makeApp().fetch(
      json("POST", "/api/projects/@owner%2Frepo/changes", { workspace: "ws" }),
      env,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      change: { id: string; status: string; evalRunId: string };
    };
    return { id: body.change.id, runId: body.change.evalRunId };
  }

  it("returns 202 without running evaluators, so a hanging evaluator cannot block creation", async () => {
    // If creation awaited this, the request would never resolve.
    secretScanEvaluate.mockImplementation(() => new Promise(() => {}));

    const res = await makeApp().fetch(
      json("POST", "/api/projects/@owner%2Frepo/changes", { workspace: "ws" }),
      env,
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      change: { id: string; status: string; evalRunId: string };
      evaluation: { status: string };
    };
    expect(body.change.status).toBe("evaluating");
    expect(body.evaluation.status).toBe("evaluating");
    expect(secretScanEvaluate).not.toHaveBeenCalled();
    expect(getDiffBetweenRepos).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({
      type: "change.evaluate",
      changeId: body.change.id,
      runId: body.change.evalRunId,
    });
    const stored = await getChange(db, logger, body.change.id);
    expect(stored.success && stored.data.status).toBe("evaluating");
  });

  it("evaluates inline and answers 201 when no evaluation queue is bound", async () => {
    const { EVALUATION_QUEUE: _unbound, ...inlineEnv } = env;
    const res = await makeApp().fetch(
      json("POST", "/api/projects/@owner%2Frepo/changes", { workspace: "ws" }),
      inlineEnv,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { change: { status: string }; eval: { passed: boolean } };
    expect(body.change.status).toBe("accepted");
    expect(body.eval.passed).toBe(true);
  });

  it("refuses to merge while evaluation is pending, even with force", async () => {
    const { id } = await createQueued();

    for (const query of ["", "?force=true"]) {
      const res = await makeApp().fetch(json("POST", `/api/changes/${id}/merge${query}`), env);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("EVALUATION_PENDING");
    }
  });

  it("re-enqueues on POST /changes/:id/evaluate under a new run that supersedes the old one", async () => {
    const first = await createQueued();

    const res = await makeApp().fetch(json("POST", `/api/changes/${first.id}/evaluate`), env);

    expect(res.status).toBe(202);
    const body = (await res.json()) as { change: { status: string; evalRunId: string } };
    expect(body.change.status).toBe("evaluating");
    expect(body.change.evalRunId).not.toBe(first.runId);
    expect(send).toHaveBeenLastCalledWith({
      type: "change.evaluate",
      changeId: first.id,
      runId: body.change.evalRunId,
    });

    // The first run's message still arrives; it must record nothing.
    const { batch, message } = batchOf({
      type: "change.evaluate",
      changeId: first.id,
      runId: first.runId,
    });
    await handleEvaluationQueue(batch, env);
    expect(message.ack).toHaveBeenCalled();
    expect(secretScanEvaluate).not.toHaveBeenCalled();
    const stored = await getChange(db, logger, first.id);
    expect(stored.success && stored.data.status).toBe("evaluating");
    expect(stored.success && stored.data.evalRunId).toBe(body.change.evalRunId);
  });

  it("records the consumer's verdict, after which merge protection applies as before", async () => {
    vi.mocked(loadPolicy).mockResolvedValue({
      evaluators: [],
      merge: { requiredEvaluators: ["secret_scan"], requiredApprovals: 1 },
    });
    const { id, runId } = await createQueued();

    const { batch, message } = batchOf({ type: "change.evaluate", changeId: id, runId });
    await handleEvaluationQueue(batch, env);

    expect(message.ack).toHaveBeenCalled();
    const stored = await getChange(db, logger, id);
    if (!stored.success) throw stored.error;
    expect(stored.data.status).toBe("accepted");
    expect(stored.data.evaluatedSha).toBe("tip-1");

    // No longer EVALUATION_PENDING: the ordinary protection rules decide.
    const res = await makeApp().fetch(json("POST", `/api/changes/${id}/merge`), env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; reasons: string[] };
    expect(body.code).toBe("PROTECTION_BLOCKED");
    expect(body.reasons).toEqual(["Requires 1 approval, has 0"]);
  });

  it("fails a hanging llm evaluator closed after its timeout, and records the verdict", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.mocked(loadPolicy).mockResolvedValue({
      evaluators: [{ type: "llm", timeoutMs: 2_000 }],
    });
    env.AI = { run: vi.fn(() => new Promise(() => {})) } as unknown as Env["AI"];
    const { id, runId } = await createQueued();

    const { batch, message } = batchOf({ type: "change.evaluate", changeId: id, runId });
    const consumed = handleEvaluationQueue(batch, env);
    await vi.advanceTimersByTimeAsync(2_000);
    await consumed;

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    const stored = await getChange(db, logger, id);
    if (!stored.success) throw stored.error;
    expect(stored.data.status).toBe("needs_changes");
    expect(stored.data.evalPassed).toBe(false);
    expect(stored.data.evalReason).toContain("no verdict within 2000ms");
  });

  it("retries a transient failure, then fails the run closed on its last delivery", async () => {
    vi.mocked(getDiffBetweenRepos).mockResolvedValue({
      success: false,
      error: Object.assign(new Error("clone failed"), { code: "GIT_ERROR", statusCode: 502 }),
    } as unknown as Awaited<ReturnType<typeof getDiffBetweenRepos>>);
    const { id, runId } = await createQueued();

    const early = batchOf({ type: "change.evaluate", changeId: id, runId });
    await handleEvaluationQueue(early.batch, env);
    expect(early.message.retry).toHaveBeenCalled();
    const pending = await getChange(db, logger, id);
    expect(pending.success && pending.data.status).toBe("evaluating");

    const last = batchOf({ type: "change.evaluate", changeId: id, runId });
    last.message.attempts = 3;
    await handleEvaluationQueue(last.batch, env);
    expect(last.message.ack).toHaveBeenCalled();
    const failed = await getChange(db, logger, id);
    if (!failed.success) throw failed.error;
    expect(failed.data.status).toBe("needs_changes");
    expect(failed.data.evalReason).toMatch(/Evaluation did not complete: clone failed/);
  });

  it("refuses to merge, even with force, a change whose run failed closed with no verdict", async () => {
    vi.mocked(getDiffBetweenRepos).mockResolvedValue({
      success: false,
      error: Object.assign(new Error("clone failed"), { code: "GIT_ERROR", statusCode: 502 }),
    } as unknown as Awaited<ReturnType<typeof getDiffBetweenRepos>>);
    const { id, runId } = await createQueued();
    const last = batchOf({ type: "change.evaluate", changeId: id, runId });
    last.message.attempts = 3;
    await handleEvaluationQueue(last.batch, env);
    const failed = await getChange(db, logger, id);
    expect(failed.success && failed.data.status).toBe("needs_changes");
    expect(failed.success && failed.data.evaluatedSha).toBeUndefined();

    // allowForce is on in this policy: force would otherwise merge the live tip.
    const res = await makeApp().fetch(json("POST", `/api/changes/${id}/merge?force=true`), env);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("EVALUATION_MISSING");
  });

  it("keeps a request for changes made while evaluating when the run then passes", async () => {
    const { id, runId } = await createQueued();

    const review = await makeApp().fetch(
      json("POST", `/api/changes/${id}/reviews`, { verdict: "request_changes", comment: "no" }),
      env,
    );
    expect(review.status).toBe(201);
    expect(((await review.json()) as { changeStatus: string }).changeStatus).toBe("evaluating");

    const { batch } = batchOf({ type: "change.evaluate", changeId: id, runId });
    await handleEvaluationQueue(batch, env);

    const stored = await getChange(db, logger, id);
    expect(stored.success && stored.data.evalPassed).toBe(true);
    expect(stored.success && stored.data.status).toBe("needs_changes");
  });

  it("refuses an approval while evaluating", async () => {
    const { id } = await createQueued();

    const res = await makeApp().fetch(
      json("POST", `/api/changes/${id}/reviews`, { verdict: "approve" }),
      env,
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("EVALUATION_PENDING");
  });

  it("fails an inline run closed when the evaluation throws, rather than leaving it evaluating", async () => {
    send.mockRejectedValueOnce(new Error("queue unavailable"));
    vi.mocked(getDiffBetweenRepos).mockRejectedValueOnce(new Error("artifacts blew up"));

    const res = await makeApp().fetch(
      json("POST", "/api/projects/@owner%2Frepo/changes", { workspace: "ws" }),
      env,
    );

    expect(res.status).toBe(500);
    const message = ((await res.json()) as { error: string }).error;
    const changeId = /change (chg_\w+)/.exec(message)?.[1];
    expect(changeId).toBeDefined();
    const change = await getChange(env.DB, logger, changeId as string);
    expect(change.success && change.data.status).toBe("needs_changes");
  });

  it("runs inline when the queue send fails, rather than stranding the change", async () => {
    send.mockRejectedValueOnce(new Error("queue unavailable"));

    const res = await makeApp().fetch(
      json("POST", "/api/projects/@owner%2Frepo/changes", { workspace: "ws" }),
      env,
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { change: { id: string; status: string } };
    expect(body.change.status).toBe("accepted");
  });
});
