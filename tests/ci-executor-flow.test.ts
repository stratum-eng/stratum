/**
 * First-party CI end to end, from Stratum's side (#415, ADR 012).
 *
 * The whole Worker (`src/index.ts`, every middleware included) against a real
 * SQLite D1 and the real policy and CI-config parsers, with the same faked
 * edges as tests/check-runs.test.ts: the Artifacts git reads, the merge
 * backend — and here, the executor Worker's HTTP endpoint.
 *
 * The executor in these tests does what the real one does at this boundary:
 * verifies the dispatch's signature, and reports each step to
 * `<callbackUrl>/<checkRunId>` signed with the instance's executor secret.
 * What it does with a job is the executor package's own test suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacSha256Hex } from "../src/evaluation/signing-secret";
import worker from "../src/index";
import { ciLogSigningInput } from "../src/services/ci-executor";
import { putSecret } from "../src/storage/project-secrets";
import { setProject } from "../src/storage/state";
import type { Env, ProjectEntry } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import { AppError } from "../src/utils/errors";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

vi.mock("../src/storage/git-ops", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    freshRepoToken: vi.fn(),
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
import { freshRepoToken, getDiffBetweenRepos, readFileFromRepo } from "../src/storage/git-ops";

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
const EXECUTOR = "https://ci-executor.test";
const TOKEN = "stratum_user_11111111111111111111111111111111";
const OUTSIDER_TOKEN = "stratum_user_22222222222222222222222222222222";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const EXECUTOR_SECRET = "instance-executor-secret-0123456789abcdef";
const RUNNER_SECRET = "project-runner-signing-key-0123456789";
const RUNNER_URL = "https://ci.example.com/stratum";
const PROJECT_REMOTE = "https://acct.artifacts.cloudflare.net/git/x/prj-app.git";
const WORKSPACE_REMOTE = "https://acct.artifacts.cloudflare.net/git/x/ws-feature.git";
/** What `freshRepoToken` mints: a secret, and when it stops working. */
const READ_TOKEN_SECRET = "art_v1_readonlytokensecret";
const READ_TOKEN = `${READ_TOKEN_SECRET}?expires=4102444800`;

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

const BASE_POLICY = "evaluators:\n  - type: diff\n";

const BASE_CI = `
steps:
  - name: lint
    run: npm run lint
  - name: test
    run: npm test
    timeoutMinutes: 20
  - name: audit
    run: npm audit
    optional: true
`;

interface JobDispatch {
  signature: string;
  rawBody: string;
  body: {
    event: string;
    changeId: string;
    baseSha: string;
    headSha: string;
    headTreeSha: string;
    diff: string;
    checkRunIds: Record<string, string>;
    callbackUrl: string;
    deadline: string;
    job: {
      profile: string;
      steps: Array<{ name: string; run: string; timeoutSeconds: number }>;
      timeoutSeconds: number;
      instance?: string;
      allowHosts: string[];
      repository: { url: string; username: string; password: string; expiresAt: string };
      logUrls: Record<string, string>;
    };
  };
}

interface CheckView {
  id: string;
  name: string;
  status: string;
  attempt: number;
  summary?: string;
  detailsUrl?: string;
}

let env: Env;
/** Every job the executor received, in order. */
let jobs: JobDispatch[];
/** Every request made to the project's own runner. */
let runnerDispatches: Array<{ rawBody: string; checkRunIds: Record<string, string> }>;
/** What the executor answers a dispatch with. */
let executorAnswer: () => Response;
/** Logs the executor holds, by check run id. */
let executorLogs: Map<string, string>;
let logRequests: Array<{ path: string; verified: boolean }>;
let basePolicy: string;
/** `.stratum/ci.yaml` on the project's default branch; undefined when absent. */
let baseCi: string | undefined;
/** When set, every read of the project's repository fails, as a failed clone does. */
let repositoryUnreadable: boolean;
let ciFileUnreadable: boolean;
let workspaceTip: string;
/** The project's current head, or null when it cannot be read. */
let projectHead: string | null;
let diffText: string;
let sequence: number;

function request(method: string, path: string, body?: unknown, headers: HeadersInit = AUTH) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function api<T>(method: string, path: string, body?: unknown, headers: HeadersInit = AUTH) {
  const res = await worker.fetch(request(method, path, body, headers), env);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

async function createChange(): Promise<{ id: string; job: JobDispatch | undefined }> {
  const before = jobs.length;
  const res = await api<{ change: { id: string } }>("POST", "/api/projects/@owner%2Fapp/changes", {
    workspace: "feature",
  });
  expect([201, 202]).toContain(res.status);
  return { id: res.body.change.id, job: jobs[before] };
}

async function listChecks(changeId: string): Promise<CheckView[]> {
  const res = await api<{ checks: CheckView[] }>("GET", `/api/changes/${changeId}/checks`);
  expect(res.status).toBe(200);
  return res.body.checks;
}

function mergeChange(changeId: string) {
  return api<{ code?: string; error?: string; reasons?: string[] }>(
    "POST",
    `/api/changes/${changeId}/merge`,
  );
}

/** What the executor does for a step: a signed report with no Stratum credential. */
async function report(
  job: { body: Pick<JobDispatch["body"], "checkRunIds" | "headSha" | "callbackUrl"> },
  name: string,
  status: string,
  secret = EXECUTOR_SECRET,
) {
  const checkRunId = job.body.checkRunIds[name] ?? "";
  const rawBody = JSON.stringify({
    checkRunId,
    headSha: job.body.headSha,
    status,
    sequence: ++sequence,
  });
  const res = await worker.fetch(
    new Request(`${job.body.callbackUrl}/${checkRunId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Stratum-Signature": `sha256=${await hmacSha256Hex(secret, rawBody)}`,
      },
      body: rawBody,
    }),
    env,
  );
  return { status: res.status, body: (await res.json()) as { applied?: boolean; code?: string } };
}

async function passAll(job: JobDispatch | undefined, names = ["lint", "test"]) {
  if (!job) throw new Error("no job was dispatched");
  for (const name of names) expect((await report(job, name, "passed")).status).toBe(200);
}

beforeEach(async () => {
  vi.clearAllMocks();
  const sqlite = makeSqliteD1();
  env = {
    DB: sqlite.db,
    STATE: makeFakeKV(),
    ARTIFACTS: {} as Env["ARTIFACTS"],
    DEPLOY_SECRET_KEY: "test-deploy-secret-key-0123456789abcdef",
    APP_URL: ORIGIN,
    CI_EXECUTOR_URL: EXECUTOR,
    CI_EXECUTOR_SECRET: EXECUTOR_SECRET,
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
    value: RUNNER_SECRET,
    actorId: "usr_owner",
  });
  if (!secret.success) throw secret.error;

  jobs = [];
  runnerDispatches = [];
  executorLogs = new Map();
  logRequests = [];
  executorAnswer = () => Response.json({ state: "running" }, { status: 202 });
  basePolicy = BASE_POLICY;
  baseCi = BASE_CI;
  repositoryUnreadable = false;
  ciFileUnreadable = false;
  workspaceTip = "tip-1";
  projectHead = "base-1";
  diffText = "diff --git a/x b/x\n+hello\n";
  sequence = 0;

  vi.mocked(freshRepoToken).mockImplementation((async () => ({
    success: true,
    data: READ_TOKEN,
  })) as unknown as typeof freshRepoToken);
  // Served by remote AND path: a read of the workspace's copy of either file
  // is observable, and would return a config that requires nothing.
  vi.mocked(readFileFromRepo).mockImplementation((async (
    remote: string,
    _token: string,
    path: string,
  ) => {
    if (repositoryUnreadable && remote === PROJECT_REMOTE) {
      return {
        success: false,
        error: new AppError("Failed to clone repository", "EXTERNAL_SERVICE_ERROR", 502),
      };
    }
    // The clone worked and this one read did not: a fault, not an absent file.
    if (ciFileUnreadable && remote === PROJECT_REMOTE && path === ".stratum/ci.yaml") {
      return {
        success: false,
        error: new AppError(`Could not read ${path} from the repository`, "GIT_ERROR", 500),
      };
    }
    const files: Record<string, string | undefined> =
      remote === PROJECT_REMOTE
        ? { ".stratum/policy.yaml": basePolicy, ".stratum/ci.yaml": baseCi }
        : {
            ".stratum/policy.yaml": "evaluators: []\n",
            ".stratum/ci.yaml": "steps:\n  - { name: lint, run: 'true' }\n",
          };
    const content = files[path];
    if (content !== undefined) return { success: true, data: content };
    return { success: false, error: new AppError(`Failed to read file: ${path}`, "FS_ERROR", 500) };
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
  ) => {
    if (remote === WORKSPACE_REMOTE) return { success: true, data: [{ sha: workspaceTip }] };
    if (projectHead === null) return { success: false, error: new Error("git unavailable") };
    return { success: true, data: [{ sha: projectHead }] };
  }) as unknown as typeof getCommitLogPreferNative);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(req.url);
      if (url.origin === EXECUTOR && url.pathname === "/jobs") {
        const rawBody = await req.text();
        jobs.push({
          signature: req.headers.get("X-Stratum-Signature") ?? "",
          rawBody,
          body: JSON.parse(rawBody) as JobDispatch["body"],
        });
        return executorAnswer();
      }
      if (url.origin === EXECUTOR && url.pathname.startsWith("/logs/")) {
        const id = url.pathname.slice("/logs/".length);
        const timestamp = req.headers.get("X-Stratum-Timestamp") ?? "";
        const expected = `sha256=${await hmacSha256Hex(EXECUTOR_SECRET, ciLogSigningInput(id, timestamp))}`;
        const verified = expected === req.headers.get("X-Stratum-Signature");
        logRequests.push({ path: url.pathname, verified });
        if (!verified) return Response.json({ code: "INVALID_SIGNATURE" }, { status: 401 });
        const log = executorLogs.get(id);
        if (log === undefined) return Response.json({ code: "LOG_NOT_FOUND" }, { status: 404 });
        return new Response(log, { headers: { "Content-Type": "text/html" } });
      }
      if (req.url === RUNNER_URL) {
        const rawBody = await req.text();
        runnerDispatches.push({
          rawBody,
          checkRunIds: (JSON.parse(rawBody) as { checkRunIds: Record<string, string> }).checkRunIds,
        });
        return new Response(null, { status: 202 });
      }
      throw new Error(`unexpected fetch to ${req.url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dispatching a job", () => {
  it("sends the executor one signed job with the base's steps and the tree to verify", async () => {
    const { id, job } = await createChange();
    if (!job) throw new Error("no job was dispatched");

    expect(jobs).toHaveLength(1);
    // Signed over the exact bytes, with the INSTANCE's executor secret.
    expect(job.signature).toBe(`sha256=${await hmacSha256Hex(EXECUTOR_SECRET, job.rawBody)}`);
    expect(job.body).toMatchObject({
      event: "checks.requested",
      changeId: id,
      baseSha: "base-1",
      headSha: "tip-1",
      headTreeSha: "tree-tip-1",
      diff: diffText,
      callbackUrl: `${ORIGIN}/api/checks`,
    });
    expect(job.body.job.profile).toBe("ci");
    expect(job.body.job.steps).toEqual([
      { name: "lint", run: "npm run lint", timeoutSeconds: 600 },
      { name: "test", run: "npm test", timeoutSeconds: 1200 },
      { name: "audit", run: "npm audit", timeoutSeconds: 600 },
    ]);
    expect(job.body.job.timeoutSeconds).toBe(1800);
    expect(job.body.job.allowHosts).toEqual([]);

    const checks = await listChecks(id);
    // Listed by name, as the checks endpoint always has.
    expect(checks.map((c) => [c.name, c.status, c.attempt])).toEqual([
      ["audit", "queued", 1],
      ["lint", "queued", 1],
      ["test", "queued", 1],
    ]);
    expect(Object.values(job.body.checkRunIds).sort()).toEqual(checks.map((c) => c.id).sort());
    for (const check of checks) {
      expect(job.body.job.logUrls[check.name]).toBe(
        `${ORIGIN}/api/changes/${id}/checks/${check.id}/log`,
      );
    }
    // The checks outlive the job's own limit by the queue and report allowances.
    expect(Date.parse(job.body.deadline) - Date.now()).toBeGreaterThan(1800_000);
  });

  it("gives the executor a read-only token for the PROJECT's repository, and no secret", async () => {
    const { job } = await createChange();
    if (!job) throw new Error("no job was dispatched");

    expect(job.body.job.repository).toEqual({
      url: PROJECT_REMOTE,
      username: "x",
      password: READ_TOKEN_SECRET,
      expiresAt: "2100-01-01T00:00:00.000Z",
    });
    // Minted for this job, for reading, for the base repository.
    const mints = vi
      .mocked(freshRepoToken)
      .mock.calls.filter(([, remote]) => remote === PROJECT_REMOTE);
    expect(mints.length).toBeGreaterThan(0);
    for (const [, , scope] of mints) expect(scope).toBe("read");
    expect(job.rawBody).not.toContain(EXECUTOR_SECRET);
    expect(job.rawBody).not.toContain(RUNNER_SECRET);
    expect(job.rawBody).not.toContain(WORKSPACE_REMOTE);
  });

  it("dispatches nothing for a project with no ci.yaml", async () => {
    baseCi = undefined;
    const { id } = await createChange();
    expect(jobs).toHaveLength(0);
    expect(await listChecks(id)).toEqual([]);
    expect((await mergeChange(id)).status).toBe(200);
  });

  it("fails every step closed when the instance has no executor", async () => {
    env.CI_EXECUTOR_URL = undefined;
    const { id } = await createChange();

    expect(jobs).toHaveLength(0);
    const checks = await listChecks(id);
    expect(checks.map((c) => c.status)).toEqual(["errored", "errored", "errored"]);
    expect(checks[0]?.summary).toBe(
      "Dispatch failed: this instance has no CI executor; the operator must set CI_EXECUTOR_URL and CI_EXECUTOR_SECRET.",
    );
    const merge = await mergeChange(id);
    expect(merge.status).toBe(403);
    expect(merge.body.reasons).toEqual([
      "Required check 'lint' errored",
      "Required check 'test' errored",
    ]);
  });

  it("refuses to send a job under a secret too short to be one", async () => {
    env.CI_EXECUTOR_SECRET = "short";
    const { id } = await createChange();

    expect(jobs).toHaveLength(0);
    const [check] = await listChecks(id);
    expect(check?.status).toBe("errored");
    expect(check?.summary).toContain("CI_EXECUTOR_SECRET is shorter than 32 characters");
    expect(check?.summary).not.toContain("short;");
  });

  it("says so when the executor is at capacity, and leaves the checks re-runnable", async () => {
    executorAnswer = () =>
      Response.json(
        { error: "2 job(s) running and 10 queued", code: "AT_CAPACITY" },
        { status: 429 },
      );
    const { id } = await createChange();

    const checks = await listChecks(id);
    expect(checks.map((c) => c.status)).toEqual(["errored", "errored", "errored"]);
    expect(checks[0]?.summary).toBe(
      "Dispatch failed: the CI executor is at capacity (2 job(s) running and 10 queued); re-run the check once running jobs have finished.",
    );
    expect((await mergeChange(id)).status).toBe(403);
  });

  it("reaches the executor over the service binding when one is bound", async () => {
    const bound: string[] = [];
    env.CI_EXECUTOR = {
      fetch: async (req: Request) => {
        bound.push(new URL(req.url).pathname);
        return Response.json({ state: "queued" }, { status: 202 });
      },
    } as unknown as Fetcher;
    const { id } = await createChange();

    expect(bound).toEqual(["/jobs"]);
    expect(jobs).toHaveLength(0);
    expect((await listChecks(id)).map((c) => c.status)).toEqual(["queued", "queued", "queued"]);
  });
});

describe("steps are required checks by default", () => {
  it("blocks the merge until every non-optional step has passed", async () => {
    const { id, job } = await createChange();
    if (!job) throw new Error("no job was dispatched");

    // Nothing in the policy file names these checks: declaring the step is
    // what makes it a gate.
    expect(basePolicy).not.toContain("requiredChecks");
    const blocked = await mergeChange(id);
    expect(blocked.status).toBe(403);
    expect(blocked.body.reasons).toEqual([
      "Required check 'lint' is queued",
      "Required check 'test' is queued",
    ]);

    await report(job, "lint", "passed");
    expect((await mergeChange(id)).body.reasons).toEqual(["Required check 'test' is queued"]);
    await report(job, "test", "failed");
    expect((await mergeChange(id)).body.reasons).toEqual(["Required check 'test' failed"]);
  });

  it("does not wait for, or care about, a step marked optional", async () => {
    const { id, job } = await createChange();
    if (!job) throw new Error("no job was dispatched");
    await passAll(job);
    await report(job, "audit", "failed");

    expect((await mergeChange(id)).status).toBe(200);
  });

  it("treats a step that never ran as not passed", async () => {
    const { id, job } = await createChange();
    if (!job) throw new Error("no job was dispatched");
    await report(job, "lint", "passed");
    await report(job, "test", "errored");

    expect((await mergeChange(id)).body.reasons).toEqual(["Required check 'test' errored"]);
  });

  it("combines with a project runner's checks without confusing the two", async () => {
    basePolicy = `evaluators:
  - type: diff
  - type: checks
    url: ${RUNNER_URL}
    secretRef: WEBHOOK_CI
    checks: [e2e]
merge:
  requiredChecks: [e2e]
`;
    const { id, job } = await createChange();
    if (!job) throw new Error("no job was dispatched");

    expect(runnerDispatches).toHaveLength(1);
    expect(Object.keys(runnerDispatches[0]?.checkRunIds ?? {})).toEqual(["e2e"]);
    expect(Object.keys(job.body.checkRunIds).sort()).toEqual(["audit", "lint", "test"]);
    await passAll(job);
    expect((await mergeChange(id)).body.reasons).toEqual(["Required check 'e2e' is queued"]);
  });
});

describe("who may report a first-party check", () => {
  it("accepts the executor's secret and refuses a project's own runner key", async () => {
    const { id, job } = await createChange();
    if (!job) throw new Error("no job was dispatched");

    // A project's signing key is the project's: anyone who can set project
    // secrets has it. It must not be able to pass the instance's CI.
    const forged = await report(job, "lint", "passed", RUNNER_SECRET);
    expect(forged.status).toBe(401);
    expect((await listChecks(id)).find((c) => c.name === "lint")?.status).toBe("queued");

    expect((await report(job, "lint", "passed")).status).toBe(200);
  });

  it("refuses the executor's secret on a project runner's check", async () => {
    basePolicy = `evaluators:
  - type: checks
    url: ${RUNNER_URL}
    secretRef: WEBHOOK_CI
    checks: [e2e]
`;
    baseCi = undefined;
    const { id } = await createChange();
    const runner = runnerDispatches[0];
    if (!runner) throw new Error("the runner was not dispatched");
    const asRunner = {
      body: {
        checkRunIds: runner.checkRunIds,
        headSha: "tip-1",
        callbackUrl: `${ORIGIN}/api/checks`,
      },
    };

    expect((await report(asRunner, "e2e", "passed", EXECUTOR_SECRET)).status).toBe(401);
    expect((await report(asRunner, "e2e", "passed", RUNNER_SECRET)).status).toBe(200);
    expect((await listChecks(id))[0]?.status).toBe("passed");
  });

  it("refuses every report once the instance's executor secret is removed", async () => {
    const { job } = await createChange();
    if (!job) throw new Error("no job was dispatched");
    env.CI_EXECUTOR_SECRET = undefined;
    expect((await report(job, "lint", "passed")).status).toBe(401);
  });
});

describe("the merge gate fails closed when the checks are not the base's steps", () => {
  const MISMATCH = (names: string) =>
    `${names} not run for the evaluated revision under the base branch's current .stratum/ci.yaml; re-evaluate the change`;

  it("blocks when a step's command changed on the base after the job ran", async () => {
    const { id, job } = await createChange();
    await passAll(job, ["lint", "test", "audit"]);
    expect((await mergeChange(id)).status).toBe(200);

    // Same names, same passes — but `test` is no longer the command that passed.
    const second = await createChange();
    await passAll(second.job, ["lint", "test", "audit"]);
    baseCi = BASE_CI.replace("run: npm test", "run: npm test -- --coverage");

    const merge = await mergeChange(second.id);
    expect(merge.status).toBe(403);
    expect(merge.body.reasons).toEqual([MISMATCH("CI steps 'lint', 'test', 'audit' have")]);
  });

  it("blocks when the base gained a step the revision was never tested with", async () => {
    const { id, job } = await createChange();
    await passAll(job, ["lint", "test", "audit"]);
    baseCi = `${BASE_CI}  - name: typecheck\n    run: npm run typecheck\n`;

    const merge = await mergeChange(id);
    expect(merge.status).toBe(403);
    expect(merge.body.reasons).toEqual([
      MISMATCH("CI steps 'lint', 'test', 'audit', 'typecheck' have"),
    ]);
  });

  it("blocks when the base dropped a step: what ran is still not what is declared", async () => {
    const { id, job } = await createChange();
    await passAll(job, ["lint", "test", "audit"]);
    baseCi = "steps:\n  - name: lint\n    run: npm run lint\n";

    const merge = await mergeChange(id);
    expect(merge.status).toBe(403);
    expect(merge.body.reasons).toEqual([MISMATCH("CI step 'lint' has")]);
  });

  it("blocks when a ci.yaml appears on the base after the change was evaluated", async () => {
    baseCi = undefined;
    const { id } = await createChange();
    expect(jobs).toHaveLength(0);
    baseCi = BASE_CI;

    const merge = await mergeChange(id);
    expect(merge.status).toBe(403);
    expect(merge.body.reasons).toEqual([MISMATCH("CI steps 'lint', 'test', 'audit' have")]);
  });

  it("blocks when the base's ci.yaml becomes invalid", async () => {
    const { id, job } = await createChange();
    await passAll(job, ["lint", "test", "audit"]);
    baseCi = "steps:\n  - { name: lint, run: npm run lint, optinal: true }\n";

    const merge = await mergeChange(id);
    expect(merge.status).toBe(403);
    expect(merge.body.reasons?.join("\n")).toMatch(/\.stratum\/ci\.yaml is present but invalid/);
  });

  it("blocks a revision CI ran on while the base cannot be read at all", async () => {
    const { id, job } = await createChange();
    if (!job) throw new Error("no job was dispatched");
    await report(job, "lint", "passed");
    await report(job, "test", "failed");
    expect((await mergeChange(id)).body.reasons).toEqual(["Required check 'test' failed"]);

    // Every read of the base now fails. The loader cannot tell this from a
    // repository with no config, and falls back to the default policy — which
    // must not turn a failed required step into a mergeable change.
    repositoryUnreadable = true;
    const merge = await mergeChange(id);
    expect(merge.status).toBe(403);
    expect(merge.body.reasons).toEqual([
      "This project runs first-party CI, but .stratum/ci.yaml could not be read from the base branch to confirm which steps are required; try again",
    ]);

    repositoryUnreadable = false;
    expect((await mergeChange(id)).body.reasons).toEqual(["Required check 'test' failed"]);
  });

  it("blocks when ci.yaml alone cannot be read, though the policy can", async () => {
    const { id, job } = await createChange();
    if (!job) throw new Error("no job was dispatched");
    await report(job, "lint", "passed");
    await report(job, "test", "failed");

    // A failed read of the file is not the file being absent. Taken for
    // absent, the project would look like it declares no steps, and a policy
    // with no merge block would let the failed step through.
    ciFileUnreadable = true;
    const merge = await mergeChange(id);
    expect(merge.status).toBe(403);
    expect(merge.body.reasons).toEqual([
      "CI configuration .stratum/ci.yaml could not be read from the base branch; merges are blocked until it can be.",
    ]);
  });

  it("blocks a change opened while the base was unreadable, in a project that runs CI", async () => {
    // The project has run first-party CI before.
    const earlier = await createChange();
    await passAll(earlier.job);

    // This change is opened during the outage: no steps could be read, so
    // none were dispatched, and it has no check runs of its own to fail on.
    repositoryUnreadable = true;
    const { id, job } = await createChange();
    expect(job).toBeUndefined();
    expect(await listChecks(id)).toEqual([]);

    const merge = await mergeChange(id);
    expect(merge.status).toBe(403);
    expect(merge.body.reasons?.[0]).toMatch(/^This project runs first-party CI, but/);

    // Once the base is back, it is the ordinary "never ran under this file".
    repositoryUnreadable = false;
    expect((await mergeChange(id)).body.reasons?.[0]).toMatch(/have not run for the evaluated/);
  });

  it("leaves a repository that cannot be read, and never ran CI, as usable as before", async () => {
    // What an empty repository looks like: nothing can be read, nothing was
    // ever dispatched. Blocking here would make a new project unmergeable.
    baseCi = undefined;
    const { id } = await createChange();
    repositoryUnreadable = true;

    expect((await mergeChange(id)).status).toBe(200);
  });

  it("is cleared by re-evaluating, which runs the steps the base declares now", async () => {
    const { id, job } = await createChange();
    await passAll(job, ["lint", "test", "audit"]);
    baseCi = BASE_CI.replace("run: npm test", "run: npm test -- --coverage");
    expect((await mergeChange(id)).status).toBe(403);

    await api("POST", `/api/changes/${id}/evaluate`);
    const rerun = jobs[1];
    if (!rerun) throw new Error("re-evaluation dispatched no job");
    expect(rerun.body.job.steps[1]?.run).toBe("npm test -- --coverage");
    expect((await mergeChange(id)).body.reasons).toEqual([
      "Required check 'lint' is queued",
      "Required check 'test' is queued",
    ]);
    await passAll(rerun);
    expect((await mergeChange(id)).status).toBe(200);
  });

  it("applies in merge-batch exactly as in the single merge", async () => {
    const { id, job } = await createChange();
    await passAll(job, ["lint", "test", "audit"]);
    baseCi = BASE_CI.replace("run: npm test", "run: 'true'");

    const batch = await api<{ error?: string }>(
      "POST",
      "/api/projects/@owner%2Fapp/changes/merge-batch",
      { changeIds: [id] },
    );
    expect(batch.status).toBe(400);
    expect(batch.body.error).toBe("No eligible changes to merge (1 skipped)");
  });
});

describe("the steps are read from the base", () => {
  it("a change that rewrites ci.yaml is still tested, and gated, by the base's version", async () => {
    // The change replaces every step with `true`. The workspace's copy says so
    // (see the readFileFromRepo fake), and the diff shows it.
    diffText = [
      "diff --git a/.stratum/ci.yaml b/.stratum/ci.yaml",
      "--- a/.stratum/ci.yaml",
      "+++ b/.stratum/ci.yaml",
      "@@ -1,9 +1,2 @@",
      "-steps:",
      "-  - name: lint",
      "-    run: npm run lint",
      "+steps:",
      "+  - { name: lint, run: 'true' }",
      "",
    ].join("\n");

    const { id, job } = await createChange();
    if (!job) throw new Error("no job was dispatched");

    // The job runs the BASE's commands, all of them.
    expect(job.body.job.steps.map((step) => [step.name, step.run])).toEqual([
      ["lint", "npm run lint"],
      ["test", "npm test"],
      ["audit", "npm audit"],
    ]);
    // Neither config file was ever read from the workspace.
    const reads = vi.mocked(readFileFromRepo).mock.calls;
    expect(reads.some(([, , path]) => path === ".stratum/ci.yaml")).toBe(true);
    expect(new Set(reads.map(([remote]) => remote))).toEqual(new Set([PROJECT_REMOTE]));

    // Passing the base's steps is not enough either: editing the gate needs a human.
    await passAll(job);
    const merge = await mergeChange(id);
    expect(merge.status).toBe(403);
    expect(merge.body.reasons).toEqual(["Requires 1 approval, has 0"]);
  });
});

describe("re-running a step", () => {
  it("re-runs the whole job, because the steps share one checkout", async () => {
    const { id, job } = await createChange();
    if (!job) throw new Error("no job was dispatched");
    await report(job, "lint", "passed");
    await report(job, "test", "failed");
    const failedId = job.body.checkRunIds.test ?? "";

    const rerun = await api<{ check: CheckView }>(
      "POST",
      `/api/changes/${id}/checks/${failedId}/rerun`,
    );
    expect(rerun.status).toBe(202);
    expect(rerun.body.check).toMatchObject({ name: "test", status: "queued", attempt: 2 });

    const second = jobs[1];
    if (!second) throw new Error("the re-run was not dispatched");
    expect(second.body.job.steps.map((step) => step.name)).toEqual(["lint", "test", "audit"]);
    expect(second.body.checkRunIds.test).toBe(rerun.body.check.id);
    expect(second.body.headTreeSha).toBe("tree-tip-1");
    // Every step has a new run: the earlier pass of `lint` does not carry over.
    expect((await listChecks(id)).map((c) => [c.name, c.status, c.attempt])).toEqual([
      ["audit", "queued", 2],
      ["lint", "queued", 2],
      ["test", "queued", 2],
    ]);
    // And the replaced runs are dead.
    expect((await report(job, "test", "passed")).body.code).toBe("CHECK_SUPERSEDED");

    await passAll(second);
    expect((await mergeChange(id)).status).toBe(200);
  });

  it("refuses a step the base no longer declares", async () => {
    const { id, job } = await createChange();
    if (!job) throw new Error("no job was dispatched");
    baseCi = "steps:\n  - name: lint\n    run: npm run lint\n";

    const rerun = await api<{ code?: string }>(
      "POST",
      `/api/changes/${id}/checks/${job.body.checkRunIds.test}/rerun`,
    );
    expect(rerun.status).toBe(409);
    expect(rerun.body.code).toBe("CHECK_NOT_DECLARED");
    expect(jobs).toHaveLength(1);
  });
});

describe("a step's log", () => {
  async function getLog(path: string, headers: HeadersInit = AUTH) {
    return worker.fetch(new Request(`${ORIGIN}${path}`, { headers }), env);
  }

  it("is served to someone who can read the project, as inert text", async () => {
    const { id, job } = await createChange();
    if (!job) throw new Error("no job was dispatched");
    const lintId = job.body.checkRunIds.lint ?? "";
    executorLogs.set(lintId, "<script>alert(1)</script>\n3 problems\n");

    const res = await getLog(`/api/changes/${id}/checks/${lintId}/log`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<script>alert(1)</script>\n3 problems\n");
    // Untrusted output served from Stratum's origin: never HTML, never sniffed,
    // whatever the executor called it.
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    // Fetched from the executor with a signature it could verify.
    expect(logRequests).toEqual([{ path: `/logs/${lintId}`, verified: true }]);
    // The link the executor is told to report is this very URL.
    expect(job.body.job.logUrls.lint).toBe(`${ORIGIN}/api/changes/${id}/checks/${lintId}/log`);
  });

  it("is hidden from anyone who cannot read the project, without asking the executor", async () => {
    const { id, job } = await createChange();
    if (!job) throw new Error("no job was dispatched");
    const path = `/api/changes/${id}/checks/${job.body.checkRunIds.lint}/log`;
    executorLogs.set(job.body.checkRunIds.lint ?? "", "private output\n");

    const outsider = await getLog(path, { Authorization: `Bearer ${OUTSIDER_TOKEN}` });
    expect(outsider.status).toBe(404);
    expect(await outsider.text()).not.toContain("private output");
    const anonymous = await getLog(path, {});
    expect([401, 404]).toContain(anonymous.status);
    expect(await anonymous.text()).not.toContain("private output");
    expect(logRequests).toEqual([]);
  });

  it("cannot be reached through another change", async () => {
    const first = await createChange();
    const second = await createChange();
    const lintOfFirst = first.job?.body.checkRunIds.lint ?? "";
    executorLogs.set(lintOfFirst, "first change's output\n");

    const res = await getLog(`/api/changes/${second.id}/checks/${lintOfFirst}/log`);
    expect(res.status).toBe(404);
    expect(logRequests).toEqual([]);
  });

  it("answers 404 for a run with no log yet, and for a check that is not a CI step", async () => {
    basePolicy = `evaluators:
  - type: checks
    url: ${RUNNER_URL}
    secretRef: WEBHOOK_CI
    checks: [e2e]
`;
    const { id, job } = await createChange();
    if (!job) throw new Error("no job was dispatched");

    const missing = await api<{ code?: string }>(
      "GET",
      `/api/changes/${id}/checks/${job.body.checkRunIds.lint}/log`,
    );
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("CHECK_LOG_NOT_FOUND");

    const e2e = (await listChecks(id)).find((c) => c.name === "e2e");
    const foreign = await api<{ code?: string }>("GET", `/api/changes/${id}/checks/${e2e?.id}/log`);
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe("CHECK_HAS_NO_LOG");
    expect(logRequests).toHaveLength(1);
  });

  it("says the executor is unavailable rather than pretending there is no log", async () => {
    const { id, job } = await createChange();
    if (!job) throw new Error("no job was dispatched");
    const path = `/api/changes/${id}/checks/${job.body.checkRunIds.lint}/log`;

    env.CI_EXECUTOR_SECRET = `${EXECUTOR_SECRET}-rotated-on-one-side-only`;
    const refused = await api<{ code?: string }>("GET", path);
    expect(refused.status).toBe(502);
    expect(refused.body.code).toBe("CI_EXECUTOR_UNAVAILABLE");

    env.CI_EXECUTOR_URL = undefined;
    expect((await api("GET", path)).status).toBe(503);
  });
});

describe("requireFreshBase", () => {
  beforeEach(() => {
    basePolicy = `${BASE_POLICY}merge:\n  requireFreshBase: true\n`;
  });

  it("merges a change whose base is the project's head", async () => {
    const { id, job } = await createChange();
    await passAll(job);
    expect((await mergeChange(id)).status).toBe(200);
  });

  it("refuses a change whose base has moved", async () => {
    const { id, job } = await createChange();
    await passAll(job);
    projectHead = "base-2";

    const merge = await mergeChange(id);
    expect(merge.status).toBe(409);
    expect(merge.body.code).toBe("STALE_BASE");
  });

  it("refuses, rather than waves through, when the project's head cannot be read", async () => {
    const { id, job } = await createChange();
    await passAll(job);
    // "I could not check" used to mean "fresh": the gate was skipped.
    projectHead = null;

    const merge = await mergeChange(id);
    expect(merge.status).toBe(503);
    expect(merge.body.code).toBe("BASE_UNVERIFIABLE");
  });

  it("answers a batch the same way when that leaves nothing to merge", async () => {
    const { id, job } = await createChange();
    await passAll(job);
    projectHead = null;

    const batch = await api<{ code?: string; skipped?: { changeId: string; reason: string }[] }>(
      "POST",
      "/api/projects/@owner%2Fapp/changes/merge-batch",
      { changeIds: [id] },
    );
    // Not a 400: the caller must be able to tell "try again" from "nothing
    // here is eligible".
    expect(batch.status).toBe(503);
    expect(batch.body.code).toBe("BASE_UNVERIFIABLE");
    expect(batch.body.skipped).toEqual([
      { changeId: id, reason: "base freshness could not be verified" },
    ]);
  });

  it("still answers 400 for a batch with nothing eligible and a readable head", async () => {
    const batch = await api<{ error?: string }>(
      "POST",
      "/api/projects/@owner%2Fapp/changes/merge-batch",
      { changeIds: ["chg_does_not_exist"] },
    );
    expect(batch.status).toBe(400);
    expect(batch.body.error).toBe("No eligible changes to merge (1 skipped)");
  });
});
