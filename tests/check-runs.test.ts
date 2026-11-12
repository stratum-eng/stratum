/**
 * Check runs end to end (#414, ADR 011).
 *
 * The whole Worker (`src/index.ts`, every middleware included) against a real
 * SQLite D1, a real project-secret store and the real policy parser. Only the
 * edges are faked: the Artifacts git reads (tokens, the diff, the policy file's
 * bytes, the workspace tip), the merge backend, and the runner's HTTP endpoint.
 *
 * The runner in these tests is the code a real one would write: it reads the
 * dispatch body, checks its signature, and POSTs signed reports to
 * `<callbackUrl>/<checkRunId>` with no Stratum credential.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacSha256Hex } from "../src/evaluation/signing-secret";
import worker from "../src/index";
import { createAgent } from "../src/storage/agents";
import { deleteSecret, putSecret } from "../src/storage/project-secrets";
import { setProject } from "../src/storage/state";
import type { Env, EvaluationQueueMessage, MessageBatch, ProjectEntry } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

vi.mock("../src/storage/git-ops", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    freshRepoToken: vi.fn(async () => ({ success: true, data: "tok" })),
    getDiffBetweenRepos: vi.fn(),
    readFileFromRepo: vi.fn(),
  };
});

vi.mock("../src/storage/artifacts-reads", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/artifacts-reads")>();
  return { ...actual, getCommitLogPreferNative: vi.fn() };
});

vi.mock("../src/storage/repo-snapshot", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/repo-snapshot")>();
  return { ...actual, readRepoSnapshot: vi.fn(async () => ({ success: true, data: null })) };
});

import { getCommitLogPreferNative } from "../src/storage/artifacts-reads";
import { getDiffBetweenRepos, readFileFromRepo } from "../src/storage/git-ops";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const ORIGIN = "https://stratum.test";
const TOKEN = "stratum_user_11111111111111111111111111111111";
const OUTSIDER_TOKEN = "stratum_user_22222222222222222222222222222222";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const SECRET = "runner-signing-key-0123456789";
const RUNNER_URL = "https://ci.example.com/stratum";
const PROJECT_REMOTE = "https://acct.artifacts.cloudflare.net/git/x/prj-app.git";
const WORKSPACE_REMOTE = "https://acct.artifacts.cloudflare.net/git/x/ws-feature.git";

const PROJECT: ProjectEntry = {
  id: "prj_app",
  name: "app",
  slug: "app",
  namespace: "@owner",
  ownerId: "usr_owner",
  ownerType: "user",
  remote: PROJECT_REMOTE,
  createdAt: "2026-01-01T00:00:00.000Z",
  visibility: "private",
};

/** The policy on the project's default branch. */
const BASE_POLICY = `
evaluators:
  - type: checks
    url: ${RUNNER_URL}
    secretRef: WEBHOOK_CI
    checks: [lint, test]
merge:
  requiredChecks: [lint, test]
`;

interface Dispatch {
  url: string;
  signature: string;
  rawBody: string;
  body: {
    event: string;
    changeId: string;
    title: string | null;
    description: string | null;
    project: string;
    baseSha: string;
    headSha: string;
    headTreeSha: string;
    diff: string;
    checkRunIds: Record<string, string>;
    callbackUrl: string;
    deadline: string;
  };
}

interface CheckView {
  id: string;
  name: string;
  status: string;
  attempt: number;
  revision: string;
  summary?: string;
  detailsUrl?: string;
  startedAt?: string;
  completedAt?: string;
}

let env: Env;
let raw: ReturnType<typeof makeSqliteD1>["raw"];
/** Every dispatch the runner's endpoint received, in order. */
let dispatches: Dispatch[];
/** What the runner's endpoint answers a dispatch with. */
let runnerStatus: number;
/** The workspace's current tip, as git would report it. */
let workspaceTip: string;
/** The policy file's bytes on the project's default branch. */
let basePolicy: string;
let diffText: string;
let sequence: number;

function request(method: string, path: string, body?: unknown, headers = AUTH): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function api<T>(method: string, path: string, body?: unknown, headers = AUTH) {
  const res = await worker.fetch(request(method, path, body, headers), env);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

/** Open a change and return its id with the dispatch it caused, if any. */
async function createChange(
  text: { title?: string; description?: string } = {},
): Promise<{ id: string; dispatch: Dispatch | undefined }> {
  const before = dispatches.length;
  const res = await api<{ change: { id: string } }>("POST", "/api/projects/@owner%2Fapp/changes", {
    workspace: "feature",
    ...text,
  });
  expect([201, 202]).toContain(res.status);
  return { id: res.body.change.id, dispatch: dispatches[before] };
}

async function listChecks(changeId: string, query = ""): Promise<CheckView[]> {
  const res = await api<{ checks: CheckView[] }>("GET", `/api/changes/${changeId}/checks${query}`);
  expect(res.status).toBe(200);
  return res.body.checks;
}

async function mergeChange(changeId: string) {
  return api<{ code?: string; reasons?: string[] }>("POST", `/api/changes/${changeId}/merge`);
}

/**
 * What a runner does: sign the exact bytes it sends and POST them to the
 * callback, with no Stratum credential of any kind.
 */
async function report(
  dispatch: Dispatch,
  name: string,
  fields: Record<string, unknown>,
  opts: { secret?: string; checkRunId?: string; rawBody?: string } = {},
) {
  const checkRunId = opts.checkRunId ?? dispatch.body.checkRunIds[name] ?? "";
  const rawBody =
    opts.rawBody ??
    JSON.stringify({
      checkRunId,
      headSha: dispatch.body.headSha,
      sequence: ++sequence,
      ...fields,
    });
  const signature = await hmacSha256Hex(opts.secret ?? SECRET, rawBody);
  const res = await worker.fetch(
    new Request(`${dispatch.body.callbackUrl}/${checkRunId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Stratum-Signature": `sha256=${signature}` },
      body: rawBody,
    }),
    env,
  );
  return {
    status: res.status,
    rawBody,
    signature,
    body: (await res.json()) as {
      applied?: boolean;
      code?: string;
      error?: string;
      check?: CheckView;
    },
  };
}

function queueBatch(body: EvaluationQueueMessage) {
  const message = {
    id: "msg_1",
    body,
    attempts: 1,
    timestamp: new Date(),
    ack: vi.fn(),
    retry: vi.fn(),
  };
  return {
    queue: "stratum-evaluations",
    messages: [message],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
}

beforeEach(async () => {
  vi.clearAllMocks();
  const sqlite = makeSqliteD1();
  raw = sqlite.raw;
  env = {
    DB: sqlite.db,
    STATE: makeFakeKV(),
    ARTIFACTS: {} as Env["ARTIFACTS"],
    DEPLOY_SECRET_KEY: "test-deploy-secret-key-0123456789abcdef",
    APP_URL: ORIGIN,
    // The merge backend. `transitioned: false` is its "nothing more to do"
    // answer, which keeps the post-merge tail (git, deploys) out of these
    // tests: reaching it at all is what proves the gate let the merge through.
    MERGE_QUEUE: {
      idFromName: () => "do-id",
      get: () => ({ merge: async () => ({ success: true, transitioned: false }) }),
    },
  } as unknown as Env;

  for (const [id, username, token] of [
    ["usr_owner", "owner", TOKEN],
    ["usr_outsider", "outsider", OUTSIDER_TOKEN],
  ] as const) {
    await env.DB.prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
      .bind(id, `${username}@test`, username, await hashToken(token))
      .run();
  }
  const stored = await setProject(env.STATE, PROJECT, logger);
  if (!stored.success) throw stored.error;
  await env.STATE.put(
    `workspace:${PROJECT.id}:feature`,
    JSON.stringify({
      name: "feature",
      remote: WORKSPACE_REMOTE,
      parent: PROJECT.id,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  const secret = await putSecret(env.DB, logger, env, {
    projectId: PROJECT.id,
    name: "WEBHOOK_CI",
    value: SECRET,
    actorId: "usr_owner",
  });
  if (!secret.success) throw secret.error;

  dispatches = [];
  runnerStatus = 202;
  workspaceTip = "tip-1";
  basePolicy = BASE_POLICY;
  diffText = "diff --git a/x b/x\n+hello\n";
  sequence = 0;

  // The policy file is served by remote, so a read of the WORKSPACE's copy is
  // observable — and would return a policy that requires nothing.
  vi.mocked(readFileFromRepo).mockImplementation((async (
    remote: string,
    _token: string,
    path: string,
  ) => {
    if (path !== ".stratum/policy.yaml") return { success: true, data: null };
    return {
      success: true,
      data: remote === PROJECT_REMOTE ? basePolicy : "evaluators: []\n",
    };
  }) as unknown as typeof readFileFromRepo);
  vi.mocked(getDiffBetweenRepos).mockImplementation(async () => ({
    success: true,
    data: {
      diff: diffText,
      workspaceOid: workspaceTip,
      workspaceTreeOid: `tree-${workspaceTip}`,
      workspaceSha: workspaceTip,
      baseOid: "base-1",
      mergeBaseOid: "base-1",
      behindBy: 0,
      commits: [],
    },
  }));
  vi.mocked(getCommitLogPreferNative).mockImplementation((async (
    _artifacts: unknown,
    remote: string,
  ) => ({
    success: true,
    data: [{ sha: remote === WORKSPACE_REMOTE ? workspaceTip : "base-1" }],
  })) as unknown as typeof getCommitLogPreferNative);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawBody = String(init?.body ?? "");
      const headers = new Headers(init?.headers);
      dispatches.push({
        url: String(input),
        signature: headers.get("X-Stratum-Signature") ?? "",
        rawBody,
        body: JSON.parse(rawBody) as Dispatch["body"],
      });
      return new Response(null, { status: runnerStatus });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("dispatch", () => {
  it("carries the change's title and description as the author wrote them", async () => {
    const { dispatch } = await createChange({
      title: "Retry the flaky upload",
      description: "Uploads time out under load.\n\n- adds a retry",
    });
    if (!dispatch) throw new Error("no dispatch was sent");
    expect(dispatch.body).toMatchObject({
      title: "Retry the flaky upload",
      description: "Uploads time out under load.\n\n- adds a retry",
    });
  });

  it("POSTs a signed payload naming one queued check run per declared check", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");

    expect(dispatches).toHaveLength(1);
    expect(dispatch.url).toBe(RUNNER_URL);
    // Signed over the exact bytes sent, with the key resolved by name from the
    // project's secret store — the same scheme the webhook evaluator uses.
    expect(dispatch.signature).toBe(`sha256=${await hmacSha256Hex(SECRET, dispatch.rawBody)}`);

    expect(Object.keys(dispatch.body).sort()).toEqual([
      "baseSha",
      "callbackUrl",
      "changeId",
      "checkRunIds",
      "deadline",
      "description",
      "diff",
      "event",
      "headSha",
      "headTreeSha",
      "project",
      "title",
    ]);
    expect(dispatch.body).toMatchObject({
      event: "checks.requested",
      changeId: id,
      // Sent even when the change has none, so a runner can rely on the keys.
      title: null,
      description: null,
      project: "@owner/app",
      baseSha: "base-1",
      headSha: "tip-1",
      // The TREE the evaluated commit points at: what a runner that rebuilds
      // the revision from `baseSha` + `diff` compares its result against.
      headTreeSha: "tree-tip-1",
      diff: diffText,
      callbackUrl: `${ORIGIN}/api/checks`,
    });
    expect(Object.keys(dispatch.body.checkRunIds).sort()).toEqual(["lint", "test"]);
    // Neither the key nor its name leaves the Worker.
    expect(dispatch.rawBody).not.toContain(SECRET);
    expect(dispatch.rawBody).not.toContain("WEBHOOK_CI");

    const checks = await listChecks(id);
    expect(checks.map((c) => [c.name, c.status, c.attempt, c.revision])).toEqual([
      ["lint", "queued", 1, "tip-1"],
      ["test", "queued", 1, "tip-1"],
    ]);
    expect(checks.map((c) => c.id).sort()).toEqual(Object.values(dispatch.body.checkRunIds).sort());
    // Plumbing stays out of the API shape.
    expect(JSON.stringify(checks)).not.toContain("WEBHOOK_CI");
    expect(Date.parse(dispatch.body.deadline)).toBeGreaterThan(Date.now());
  });

  it("returns immediately: the change is evaluated while its checks are still queued", async () => {
    const { id } = await createChange();
    const change = await api<{
      change: { status: string };
      evalRuns: Array<{ evaluatorType: string }>;
    }>("GET", `/api/changes/${id}`);
    expect(change.body.change.status).toBe("accepted");
    // A dispatch is not a verdict: it contributes no evaluator run, so it can
    // neither pass nor fail the evaluation on its own.
    expect(change.body.evalRuns.map((run) => run.evaluatorType)).toEqual(["secret_scan"]);
  });

  it("marks the runs errored when the runner refuses the dispatch", async () => {
    runnerStatus = 500;
    const { id } = await createChange();

    const checks = await listChecks(id);
    expect(checks.map((c) => c.status)).toEqual(["errored", "errored"]);
    expect(checks[0]?.summary).toBe("Dispatch failed: the runner answered HTTP 500.");
    const merge = await mergeChange(id);
    expect(merge.status).toBe(403);
    expect(merge.body.reasons).toEqual([
      "Required check 'lint' errored",
      "Required check 'test' errored",
    ]);
  });

  it("fails closed without contacting the runner when the signing secret is missing", async () => {
    await deleteSecret(env.DB, logger, { projectId: PROJECT.id, name: "WEBHOOK_CI" });
    const { id } = await createChange();

    expect(dispatches).toHaveLength(0);
    const checks = await listChecks(id);
    expect(checks.map((c) => c.status)).toEqual(["errored", "errored"]);
    expect(checks[0]?.summary).toContain("project secret WEBHOOK_CI is not set");
    expect((await mergeChange(id)).status).toBe(403);
  });

  it("dispatches from the queue consumer once the verdict lands, using APP_URL", async () => {
    const send = vi.fn(async () => undefined);
    env.EVALUATION_QUEUE = { send } as unknown as Env["EVALUATION_QUEUE"];

    const res = await api<{ change: { id: string; evalRunId: string } }>(
      "POST",
      "/api/projects/@owner%2Fapp/changes",
      { workspace: "feature" },
    );
    expect(res.status).toBe(202);
    const { id, evalRunId } = res.body.change;
    // Nothing is evaluated on the request, so nothing is dispatched yet.
    expect(dispatches).toHaveLength(0);
    expect(await listChecks(id)).toEqual([]);

    await worker.queue(
      queueBatch({ type: "change.evaluate", changeId: id, runId: evalRunId }),
      env,
    );

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.body.callbackUrl).toBe(`${ORIGIN}/api/checks`);
    expect((await listChecks(id)).map((c) => c.status)).toEqual(["queued", "queued"]);
  });

  it("fails closed on the queue when the instance has no public URL to hand the runner", async () => {
    const { APP_URL: _unset, ...withoutAppUrl } = env;
    env = withoutAppUrl as Env;
    const send = vi.fn(async () => undefined);
    env.EVALUATION_QUEUE = { send } as unknown as Env["EVALUATION_QUEUE"];
    const res = await api<{ change: { id: string; evalRunId: string } }>(
      "POST",
      "/api/projects/@owner%2Fapp/changes",
      { workspace: "feature" },
    );
    const { id, evalRunId } = res.body.change;

    await worker.queue(
      queueBatch({ type: "change.evaluate", changeId: id, runId: evalRunId }),
      env,
    );

    expect(dispatches).toHaveLength(0);
    const checks = await listChecks(id);
    expect(checks.map((c) => c.status)).toEqual(["errored", "errored"]);
    expect(checks[0]?.summary).toContain("APP_URL");
  });
});

describe("a runner reporting results", () => {
  it("moves a check queued → running → passed, and the merge gate follows", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");

    // Nothing has reported: both required checks block.
    const blocked = await mergeChange(id);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("PROTECTION_BLOCKED");
    expect(blocked.body.reasons).toEqual([
      "Required check 'lint' is queued",
      "Required check 'test' is queued",
    ]);

    const running = await report(dispatch, "lint", {
      status: "running",
      summary: "eslint started",
      detailsUrl: "https://ci.example.com/runs/1",
    });
    expect(running.status).toBe(200);
    expect(running.body.applied).toBe(true);
    expect(running.body.check).toMatchObject({
      name: "lint",
      status: "running",
      summary: "eslint started",
      detailsUrl: "https://ci.example.com/runs/1",
    });
    expect(running.body.check?.startedAt).toBeDefined();
    expect(running.body.check?.completedAt).toBeUndefined();
    expect((await mergeChange(id)).body.reasons).toEqual([
      "Required check 'lint' is still running",
      "Required check 'test' is queued",
    ]);

    const passed = await report(dispatch, "lint", { status: "passed", summary: "0 problems" });
    expect(passed.body.check).toMatchObject({
      status: "passed",
      summary: "0 problems",
      // A terminal report that omits the link keeps the one already set.
      detailsUrl: "https://ci.example.com/runs/1",
    });
    expect(passed.body.check?.completedAt).toBeDefined();

    // One required check passing is not enough.
    expect((await mergeChange(id)).body.reasons).toEqual(["Required check 'test' is queued"]);

    await report(dispatch, "test", { status: "passed" });
    expect((await mergeChange(id)).status).toBe(200);
  });

  it("blocks the merge on a failed required check", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    await report(dispatch, "lint", { status: "passed" });
    const failed = await report(dispatch, "test", { status: "failed", summary: "3 tests failed" });
    expect(failed.body.check?.status).toBe("failed");

    const merge = await mergeChange(id);
    expect(merge.status).toBe(403);
    expect(merge.body.reasons).toEqual(["Required check 'test' failed"]);
  });

  it("needs no Stratum credential, and gains nothing from one", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    // `report` sends only the signature header: no Authorization, no cookie.
    expect((await report(dispatch, "lint", { status: "running" })).status).toBe(200);

    // The project owner's own token, with no signature, is just another
    // unsigned caller: write access to the project is not a way to report.
    const checkRunId = dispatch.body.checkRunIds.test ?? "";
    const res = await api<{ code: string }>("POST", `/api/checks/${checkRunId}`, {
      checkRunId,
      headSha: "tip-1",
      sequence: 99,
      status: "passed",
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_SIGNATURE");
    expect((await listChecks(id)).find((c) => c.name === "test")?.status).toBe("queued");
  });

  it("rejects a report that is signed but malformed, without changing the check", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");

    for (const fields of [
      { status: "queued" },
      { status: "green" },
      { status: "passed", sequence: 0 },
      { status: "passed", sequence: "7" },
      { status: "passed", detailsUrl: "javascript:alert(1)" },
      { status: "passed", detailsUrl: "https://user:pw@ci.example.com/run" },
      { status: "passed", headSha: "" },
    ]) {
      const res = await report(dispatch, "lint", fields);
      expect(res.status, JSON.stringify(fields)).toBe(400);
      expect(res.body.code).toBe("INVALID_REPORT");
    }
    expect((await listChecks(id)).map((c) => c.status)).toEqual(["queued", "queued"]);
  });

  it("truncates an oversized summary instead of losing the result", async () => {
    const { dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    const res = await report(dispatch, "lint", { status: "failed", summary: "x".repeat(10_000) });
    expect(res.status).toBe(200);
    expect(res.body.check?.summary).toHaveLength(4000);
  });
});

describe("a runner that never reports", () => {
  it("cannot leave a change mergeable, before or after the deadline sweep", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    // The default deadline: thirty minutes from dispatch.
    expect(dispatch.body.deadline).toBe("2026-11-09T12:30:00.000Z");

    // Hours of silence. The gate never reads silence as a pass.
    vi.setSystemTime(new Date("2026-11-09T12:29:00.000Z"));
    expect((await mergeChange(id)).body.reasons).toEqual([
      "Required check 'lint' is queued",
      "Required check 'test' is queued",
    ]);

    // Past the deadline but before the cron has run: still blocked, and the
    // gate already says why.
    vi.setSystemTime(new Date("2026-11-09T12:31:00.000Z"));
    expect((await mergeChange(id)).body.reasons).toEqual([
      "Required check 'lint' did not report before its deadline",
      "Required check 'test' did not report before its deadline",
    ]);

    // The five-minute cron flips them to a terminal state a person can read.
    const scheduled: Promise<unknown>[] = [];
    await worker.scheduled({ cron: "*/5 * * * *" } as ScheduledEvent, env, {
      waitUntil: (promise: Promise<unknown>) => scheduled.push(promise),
    } as unknown as ExecutionContext);
    await Promise.allSettled(scheduled);

    const checks = await listChecks(id);
    expect(checks.map((c) => c.status)).toEqual(["errored", "errored"]);
    expect(checks[0]?.summary).toBe("The runner did not report a result before the deadline.");
    const merge = await mergeChange(id);
    expect(merge.status).toBe(403);
    expect(merge.body.reasons).toEqual([
      "Required check 'lint' errored",
      "Required check 'test' errored",
    ]);

    // And a report that turns up afterwards cannot reopen it.
    const late = await report(dispatch, "lint", { status: "passed" });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("CHECK_TERMINAL");
    expect((await mergeChange(id)).status).toBe(403);
  });

  it("refuses a pass that arrives after the deadline even if the sweep has not run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");

    vi.setSystemTime(new Date("2026-11-09T12:30:01.000Z"));
    const late = await report(dispatch, "lint", { status: "passed" });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("CHECK_DEADLINE_EXCEEDED");
    expect(late.body.check?.status).toBe("errored");
    expect((await listChecks(id)).find((c) => c.name === "lint")?.status).toBe("errored");
  });

  it("honours a policy-set deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
    basePolicy = BASE_POLICY.replace(
      "checks: [lint, test]",
      "checks: [lint, test]\n    deadlineMs: 120000",
    );
    const { dispatch } = await createChange();
    expect(dispatch?.body.deadline).toBe("2026-11-09T12:02:00.000Z");
  });
});

describe("callback authentication", () => {
  const UNAUTHENTICATED = { error: "Invalid signature", code: "INVALID_SIGNATURE" };

  it("rejects a bad signature and leaves the check untouched", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");

    const wrongKey = await report(
      dispatch,
      "lint",
      { status: "passed" },
      { secret: "not-the-key" },
    );
    expect(wrongKey.status).toBe(401);
    expect(wrongKey.body).toEqual(UNAUTHENTICATED);
    expect((await listChecks(id)).map((c) => c.status)).toEqual(["queued", "queued"]);
    expect((await mergeChange(id)).status).toBe(403);
  });

  it("rejects a body altered after it was signed", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    const checkRunId = dispatch.body.checkRunIds.lint ?? "";
    const signed = JSON.stringify({
      checkRunId,
      headSha: "tip-1",
      sequence: 1,
      status: "failed",
    });
    const signature = await hmacSha256Hex(SECRET, signed);

    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/checks/${checkRunId}`, {
        method: "POST",
        headers: { "X-Stratum-Signature": `sha256=${signature}` },
        body: signed.replace('"failed"', '"passed"'),
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect((await listChecks(id)).find((c) => c.name === "lint")?.status).toBe("queued");
  });

  it("answers every unauthenticated caller identically, whether or not the check exists", async () => {
    const { dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    const realId = dispatch.body.checkRunIds.lint ?? "";
    const body = JSON.stringify({
      checkRunId: realId,
      headSha: "tip-1",
      sequence: 1,
      status: "passed",
    });
    const wellFormedButWrong = `sha256=${"0".repeat(64)}`;

    const probes: Array<[string, Record<string, string>]> = [
      [realId, {}],
      [realId, { "X-Stratum-Signature": "sha256=nothex" }],
      [realId, { "X-Stratum-Signature": wellFormedButWrong }],
      ["chk_00000000000000000000000000000000", {}],
      ["chk_00000000000000000000000000000000", { "X-Stratum-Signature": wellFormedButWrong }],
    ];
    for (const [id, headers] of probes) {
      const res = await worker.fetch(
        new Request(`${ORIGIN}/api/checks/${id}`, { method: "POST", headers, body }),
        env,
      );
      expect(res.status).toBe(401);
      // Byte-identical: no name, status or revision of a real check leaks.
      expect(await res.json()).toEqual(UNAUTHENTICATED);
    }
    // There is nothing to read, either.
    const get = await worker.fetch(new Request(`${ORIGIN}/api/checks/${realId}`), env);
    expect(get.status).toBe(404);
  });

  it("does not accept a signature made with another project's key", async () => {
    const { dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    // A secret of the same name in a different project signs nothing here: the
    // key is resolved from the project the check belongs to.
    const other = await putSecret(env.DB, logger, env, {
      projectId: "prj_other",
      name: "WEBHOOK_CI",
      value: "other-project-key",
      actorId: "usr_outsider",
    });
    if (!other.success) throw other.error;
    const res = await report(
      dispatch,
      "lint",
      { status: "passed" },
      { secret: "other-project-key" },
    );
    expect(res.status).toBe(401);
  });

  it("stops accepting the old key as soon as the project secret is rotated", async () => {
    const { dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    const rotated = await putSecret(env.DB, logger, env, {
      projectId: PROJECT.id,
      name: "WEBHOOK_CI",
      value: "rotated-key",
      actorId: "usr_owner",
    });
    if (!rotated.success) throw rotated.error;

    expect((await report(dispatch, "lint", { status: "running" })).status).toBe(401);
    expect(
      (await report(dispatch, "lint", { status: "running" }, { secret: "rotated-key" })).status,
    ).toBe(200);
  });

  it("refuses an oversized body before reading anything about the check", async () => {
    const { dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/checks/${dispatch.body.checkRunIds.lint}`, {
        method: "POST",
        headers: { "X-Stratum-Signature": `sha256=${"0".repeat(64)}` },
        body: "x".repeat(70_000),
      }),
      env,
    );
    expect(res.status).toBe(413);
  });
});

describe("revision binding", () => {
  it("rejects a report that names a different revision", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    const res = await report(dispatch, "lint", { status: "passed", headSha: "tip-other" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STALE_REVISION");
    expect((await listChecks(id)).find((c) => c.name === "lint")?.status).toBe("queued");
  });

  it("a new revision invalidates the old revision's checks, and rejects their late reports", async () => {
    const { id, dispatch: first } = await createChange();
    if (!first) throw new Error("no dispatch was sent");
    await report(first, "lint", { status: "passed" });
    await report(first, "test", { status: "running" });

    // The author pushes again and the change is re-evaluated at the new tip.
    workspaceTip = "tip-2";
    const reevaluated = await api("POST", `/api/changes/${id}/evaluate`);
    expect(reevaluated.status).toBe(200);
    const second = dispatches[1];
    if (!second) throw new Error("the new revision was not dispatched");
    expect(second.body.headSha).toBe("tip-2");
    expect(Object.values(second.body.checkRunIds)).not.toEqual(
      expect.arrayContaining(Object.values(first.body.checkRunIds)),
    );

    // The pass recorded for tip-1 does not count for tip-2.
    const checks = await listChecks(id);
    expect(checks.map((c) => [c.name, c.status, c.revision])).toEqual([
      ["lint", "queued", "tip-2"],
      ["test", "queued", "tip-2"],
    ]);
    expect((await mergeChange(id)).body.reasons).toEqual([
      "Required check 'lint' is queued",
      "Required check 'test' is queued",
    ]);

    // The old runner finishing its work for tip-1 changes nothing.
    const stale = await report(first, "test", { status: "passed" });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("STALE_REVISION");
    expect((await mergeChange(id)).status).toBe(403);

    // The history keeps both revisions; the old pending run was ended.
    const history = await listChecks(id, "?all=true");
    expect(history.map((c) => [c.revision, c.name, c.status])).toEqual([
      ["tip-1", "lint", "passed"],
      ["tip-1", "test", "errored"],
      ["tip-2", "lint", "queued"],
      ["tip-2", "test", "queued"],
    ]);

    // Only reports for the current revision open the gate.
    await report(second, "lint", { status: "passed" });
    await report(second, "test", { status: "passed" });
    expect((await mergeChange(id)).status).toBe(200);
  });

  it("a re-evaluation of the same revision replaces its runs rather than reusing them", async () => {
    const { id, dispatch: first } = await createChange();
    if (!first) throw new Error("no dispatch was sent");
    await report(first, "lint", { status: "passed" });
    await report(first, "test", { status: "passed" });

    await api("POST", `/api/changes/${id}/evaluate`);
    const checks = await listChecks(id);
    expect(checks.map((c) => [c.name, c.status, c.attempt])).toEqual([
      ["lint", "queued", 2],
      ["test", "queued", 2],
    ]);
    expect((await mergeChange(id)).status).toBe(403);
    // The replaced run's id is dead, even though its revision is current.
    const old = await report(first, "lint", { status: "passed" });
    expect(old.status).toBe(409);
    expect(old.body.code).toBe("CHECK_SUPERSEDED");
  });
});

describe("terminal states and replay", () => {
  it("rejects any transition out of a terminal state", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    await report(dispatch, "lint", { status: "failed", summary: "2 problems" });

    for (const status of ["passed", "running", "errored"]) {
      const res = await report(dispatch, "lint", { status });
      expect(res.status, status).toBe(409);
      expect(res.body.code).toBe("CHECK_TERMINAL");
    }
    const lint = (await listChecks(id)).find((c) => c.name === "lint");
    expect(lint).toMatchObject({ status: "failed", summary: "2 problems" });
  });

  it("treats a redelivered report as a no-op, so a runner can retry safely", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    const first = await report(dispatch, "lint", { status: "passed", summary: "ok" });
    expect(first.body.applied).toBe(true);

    // The identical signed bytes, sent again.
    const replay = await report(dispatch, "lint", {}, { rawBody: first.rawBody });
    expect(replay.status).toBe(200);
    expect(replay.body.applied).toBe(false);
    expect(replay.body.check?.status).toBe("passed");
    expect((await listChecks(id)).find((c) => c.name === "lint")?.summary).toBe("ok");
  });

  it("ignores an older report that arrives after a newer one", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    const early = await report(dispatch, "lint", { status: "running", summary: "step 1 of 3" });
    await report(dispatch, "lint", { status: "running", summary: "step 3 of 3" });

    const reordered = await report(dispatch, "lint", {}, { rawBody: early.rawBody });
    expect(reordered.status).toBe(200);
    expect(reordered.body.applied).toBe(false);
    expect((await listChecks(id)).find((c) => c.name === "lint")?.summary).toBe("step 3 of 3");
  });

  it("cannot replay one check's signed report against another check", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    const lintPassed = await report(dispatch, "lint", { status: "passed" });

    // Same project, same key, so the signature is genuine — but the body names
    // the check it was made for.
    const crossed = await report(
      dispatch,
      "test",
      {},
      { rawBody: lintPassed.rawBody, checkRunId: dispatch.body.checkRunIds.test ?? "" },
    );
    expect(crossed.status).toBe(400);
    expect((await listChecks(id)).find((c) => c.name === "test")?.status).toBe("queued");
    expect((await mergeChange(id)).body.reasons).toEqual(["Required check 'test' is queued"]);
  });

  it("gives a runner no way to create a check or satisfy a name it was not dispatched for", async () => {
    basePolicy = BASE_POLICY.replace(
      "requiredChecks: [lint, test]",
      "requiredChecks: [lint]",
    ).replace("checks: [lint, test]", "checks: [lint]");
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    expect(Object.keys(dispatch.body.checkRunIds)).toEqual(["lint"]);

    // The policy changes on the base to require `test` as well. Nothing was
    // dispatched for it on this revision, and a callback can only address a
    // run that exists — so the runner cannot report it into being.
    basePolicy = BASE_POLICY;
    await report(dispatch, "lint", { status: "passed" });
    const invented = await report(
      dispatch,
      "test",
      { status: "passed", name: "test" },
      { checkRunId: "chk_ffffffffffffffffffffffffffffffff" },
    );
    expect(invented.status).toBe(401);
    // Extra fields in a genuine report are ignored, not honoured.
    await report(dispatch, "lint", { status: "passed", name: "test", revision: "tip-9" });
    expect((await listChecks(id)).map((c) => c.name)).toEqual(["lint"]);

    const merge = await mergeChange(id);
    expect(merge.status).toBe(403);
    expect(merge.body.reasons).toEqual([
      "Required check 'test' has not been reported for the evaluated revision",
    ]);
  });
});

describe("re-running a check", () => {
  it("creates a new run on the same revision, which replaces the old one", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    await report(dispatch, "lint", { status: "passed" });
    await report(dispatch, "test", { status: "failed", summary: "flaky" });
    const failedId = dispatch.body.checkRunIds.test ?? "";

    const rerun = await api<{ check: CheckView }>(
      "POST",
      `/api/changes/${id}/checks/${failedId}/rerun`,
    );
    expect(rerun.status).toBe(202);
    expect(rerun.body.check).toMatchObject({
      name: "test",
      status: "queued",
      attempt: 2,
      revision: "tip-1",
    });
    expect(rerun.body.check.id).not.toBe(failedId);

    // Only the re-run check is dispatched, for the same revision.
    const redispatch = dispatches[1];
    if (!redispatch) throw new Error("the re-run was not dispatched");
    expect(redispatch.body.headSha).toBe("tip-1");
    expect(redispatch.body.checkRunIds).toEqual({ test: rerun.body.check.id });
    expect(redispatch.signature).toBe(`sha256=${await hmacSha256Hex(SECRET, redispatch.rawBody)}`);

    // The gate reads the newest run: the earlier failure no longer decides,
    // but the re-run has not passed yet either. `lint` is untouched.
    expect((await mergeChange(id)).body.reasons).toEqual(["Required check 'test' is queued"]);

    await report(redispatch, "test", { status: "passed" });
    expect((await mergeChange(id)).status).toBe(200);
  });

  it("ends a hung run it replaces, and rejects that run's late report", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    await report(dispatch, "test", { status: "running" });
    const hungId = dispatch.body.checkRunIds.test ?? "";

    expect((await api("POST", `/api/changes/${id}/checks/${hungId}/rerun`)).status).toBe(202);

    const late = await report(dispatch, "test", { status: "passed" });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("CHECK_SUPERSEDED");
    const history = await listChecks(id, "?all=true");
    expect(history.find((c) => c.id === hungId)).toMatchObject({
      status: "errored",
      summary: "Superseded by a newer run of this check.",
    });
    // Re-running the replaced run again is refused: there is a newer one.
    const again = await api<{ code: string }>("POST", `/api/changes/${id}/checks/${hungId}/rerun`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("CHECK_SUPERSEDED");
  });

  it("refuses to carry a check onto commits that were never evaluated", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    workspaceTip = "tip-2";

    const rerun = await api<{ code: string }>(
      "POST",
      `/api/changes/${id}/checks/${dispatch.body.checkRunIds.lint}/rerun`,
    );
    expect(rerun.status).toBe(409);
    expect(rerun.body.code).toBe("STALE_REVISION");
    expect(dispatches).toHaveLength(1);
  });

  it("refuses a check the base policy no longer declares", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    basePolicy = "evaluators: []\n";

    const rerun = await api<{ code: string }>(
      "POST",
      `/api/changes/${id}/checks/${dispatch.body.checkRunIds.lint}/rerun`,
    );
    expect(rerun.status).toBe(409);
    expect(rerun.body.code).toBe("CHECK_NOT_DECLARED");
  });

  it("reports a re-run the runner refused, leaving the new run errored", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    runnerStatus = 503;

    const rerun = await api<{ code: string; check: CheckView }>(
      "POST",
      `/api/changes/${id}/checks/${dispatch.body.checkRunIds.lint}/rerun`,
    );
    expect(rerun.status).toBe(502);
    expect(rerun.body.code).toBe("CHECK_DISPATCH_FAILED");
    expect(rerun.body.check).toMatchObject({ name: "lint", status: "errored", attempt: 2 });
  });

  it("requires write access, and hides the change from a caller without it", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    const path = `/api/changes/${id}/checks/${dispatch.body.checkRunIds.lint}/rerun`;

    const anonymous = await worker.fetch(new Request(`${ORIGIN}${path}`, { method: "POST" }), env);
    expect(anonymous.status).toBe(401);

    // Re-running a gate is a user decision, as re-evaluating is: the owner's
    // own agent may read the checks but not re-run one.
    const agent = await createAgent(env.DB, "usr_owner", "builder", logger);
    if (!agent.success) throw agent.error;
    const asAgent = { Authorization: `Bearer ${agent.data.plaintext}` };
    expect((await api("GET", `/api/changes/${id}/checks`, undefined, asAgent)).status).toBe(200);
    expect((await api("POST", path, undefined, asAgent)).status).toBe(401);
    expect(dispatches).toHaveLength(1);

    const outsider = { Authorization: `Bearer ${OUTSIDER_TOKEN}` };
    expect((await api("POST", path, undefined, outsider)).status).toBe(403);
    expect((await api("GET", `/api/changes/${id}/checks`, undefined, outsider)).status).toBe(404);
    // A run on another change is indistinguishable from one that does not exist.
    const other = await createChange();
    expect(
      (await api("POST", `/api/changes/${other.id}/checks/${dispatch.body.checkRunIds.lint}/rerun`))
        .status,
    ).toBe(404);
    expect(dispatches).toHaveLength(2);
  });
});

describe("the policy is read from the base", () => {
  it("a change cannot drop its own required checks", async () => {
    // The change rewrites the policy file to require nothing. The workspace's
    // copy says so (see the readFileFromRepo fake), and the diff shows it.
    diffText = [
      "diff --git a/.stratum/policy.yaml b/.stratum/policy.yaml",
      "--- a/.stratum/policy.yaml",
      "+++ b/.stratum/policy.yaml",
      "@@ -1,8 +1 @@",
      "-merge:",
      "-  requiredChecks: [lint, test]",
      "+evaluators: []",
      "",
    ].join("\n");

    const { id, dispatch } = await createChange();

    // The checks the BASE declares were dispatched for it regardless.
    expect(Object.keys(dispatch?.body.checkRunIds ?? {}).sort()).toEqual(["lint", "test"]);
    // And the policy file was only ever read from the project's own remote.
    const remotesRead = vi.mocked(readFileFromRepo).mock.calls.map(([remote]) => remote);
    expect(remotesRead.length).toBeGreaterThan(0);
    expect(new Set(remotesRead)).toEqual(new Set([PROJECT_REMOTE]));

    const merge = await mergeChange(id);
    expect(merge.status).toBe(403);
    expect(merge.body.reasons).toEqual([
      "Required check 'lint' is queued",
      "Required check 'test' is queued",
      // Editing the gate itself also needs a human (SA-3).
      "Requires 1 approval, has 0",
    ]);
  });
});

describe("merge-batch", () => {
  async function mergeBatch(changeId: string) {
    return api<{ error?: string }>("POST", "/api/projects/@owner%2Fapp/changes/merge-batch", {
      changeIds: [changeId],
    });
  }

  it("applies requiredChecks exactly as the single-merge path does", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");

    // Pending required checks: the change is skipped at the gate.
    const blocked = await mergeBatch(id);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toBe("No eligible changes to merge (1 skipped)");

    await report(dispatch, "lint", { status: "passed" });
    await report(dispatch, "test", { status: "failed" });
    expect((await mergeBatch(id)).body.error).toBe("No eligible changes to merge (1 skipped)");

    // With both passed the change clears the gate and reaches the merge
    // backend — which this environment does not bind, and says so. That error
    // is past every protection check.
    const { id: second, dispatch: secondDispatch } = await createChange();
    if (!secondDispatch) throw new Error("no dispatch was sent");
    await report(secondDispatch, "lint", { status: "passed" });
    await report(secondDispatch, "test", { status: "passed" });
    const allowed = await mergeBatch(second);
    expect(allowed.status).toBe(500);
    expect(allowed.body.error).toBe("RepoDO not bound");
  });
});

describe("surfaces", () => {
  it("renders the evaluated revision's checks on the change page, with a re-run form", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    await report(dispatch, "lint", {
      status: "failed",
      summary: "<b>2 problems</b>",
      detailsUrl: "https://ci.example.com/runs/7",
    });

    const res = await worker.fetch(new Request(`${ORIGIN}/changes/${id}`, { headers: AUTH }), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h2>Checks</h2>");
    expect(html).toContain("badge badge-rejected");
    expect(html).toContain("badge badge-queued");
    // Runner-supplied text is escaped, never markup.
    expect(html).toContain("&lt;b&gt;2 problems&lt;/b&gt;");
    expect(html).not.toContain("<b>2 problems</b>");
    expect(html).toContain('href="https://ci.example.com/runs/7"');
    expect(html).toContain(
      `action="/api/changes/${id}/checks/${dispatch.body.checkRunIds.lint}/rerun"`,
    );
    // Server-rendered: the section brings no script with it.
    expect(html.split("<h2>Checks</h2>")[1]?.split("</table>")[0]).not.toContain("<script");
  });

  it("redirects the page's re-run form back to the change", async () => {
    const { id, dispatch } = await createChange();
    if (!dispatch) throw new Error("no dispatch was sent");
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/changes/${id}/checks/${dispatch.body.checkRunIds.lint}/rerun`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/changes/${id}`);
    expect((await listChecks(id)).find((c) => c.name === "lint")?.attempt).toBe(2);
  });

  it("omits the section for a project that declares no checks", async () => {
    basePolicy = "evaluators: []\n";
    const { id } = await createChange();
    expect(dispatches).toHaveLength(0);
    expect(await listChecks(id)).toEqual([]);
    // No check rows are written for a project that has not opted in.
    expect(raw.prepare("SELECT COUNT(*) AS n FROM checks").get()).toEqual({ n: 0 });
    const res = await worker.fetch(new Request(`${ORIGIN}/changes/${id}`, { headers: AUTH }), env);
    expect(await res.text()).not.toContain("<h2>Checks</h2>");
  });

  describe("over MCP", () => {
    interface RpcReply {
      result?: { content?: Array<{ text: string }>; isError?: boolean };
    }
    async function tool(name: string, args: unknown): Promise<{ isError: boolean; text: string }> {
      const res = await worker.fetch(
        request("POST", "/mcp", {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
        env,
      );
      const reply = (await res.json()) as RpcReply;
      return {
        isError: reply.result?.isError === true,
        text: reply.result?.content?.map((part) => part.text).join("\n") ?? "",
      };
    }

    it("stratum_list_checks returns what the gate reads, and stratum_rerun_check re-dispatches", async () => {
      const { id, dispatch } = await createChange();
      if (!dispatch) throw new Error("no dispatch was sent");
      await report(dispatch, "test", { status: "failed", summary: "flaky" });

      const listed = await tool("stratum_list_checks", { change_id: id });
      expect(listed.isError).toBe(false);
      const { revision, checks } = JSON.parse(listed.text) as {
        revision: string;
        checks: CheckView[];
      };
      expect(revision).toBe("tip-1");
      expect(checks.map((c) => [c.name, c.status])).toEqual([
        ["lint", "queued"],
        ["test", "failed"],
      ]);

      const failed = checks.find((c) => c.name === "test");
      const rerun = await tool("stratum_rerun_check", { change_id: id, check_id: failed?.id });
      expect(rerun.isError).toBe(false);
      expect((JSON.parse(rerun.text) as { check: CheckView }).check).toMatchObject({
        name: "test",
        status: "queued",
        attempt: 2,
      });
      expect(dispatches).toHaveLength(2);

      const history = await tool("stratum_list_checks", { change_id: id, all: true });
      expect((JSON.parse(history.text) as { checks: CheckView[] }).checks).toHaveLength(3);
    });

    it("surfaces the route's refusal, not a generic failure", async () => {
      const { id, dispatch } = await createChange();
      if (!dispatch) throw new Error("no dispatch was sent");
      workspaceTip = "tip-2";
      const rerun = await tool("stratum_rerun_check", {
        change_id: id,
        check_id: dispatch.body.checkRunIds.lint,
      });
      expect(rerun.isError).toBe(true);
      expect(rerun.text).toContain("re-evaluate the change instead");
    });

    it("cannot reach the runner's callback: no tool maps to it and the sub-app does not mount it", async () => {
      const { dispatchApiRequest } = await import("../src/mcp/dispatch");
      const res = await dispatchApiRequest(
        new Request(`${ORIGIN}/api/checks/chk_00000000000000000000000000000000`, {
          method: "POST",
          headers: AUTH,
          body: "{}",
        }),
        env,
        undefined,
        "203.0.113.1",
      );
      expect(res.status).toBe(404);
    });
  });
});
