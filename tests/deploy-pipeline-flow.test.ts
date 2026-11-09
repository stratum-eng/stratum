/**
 * Deploy pipelines end to end, on the Stratum side (#416): a merge message in,
 * dispatches to a fake CI executor out, the executor's signed reports back in.
 *
 * D1 is real SQLite with the production migrations applied, so the claim that
 * serializes an environment is the real statement. The executor is a recorder
 * behind the `CI_EXECUTOR` service binding: it sees exactly the signed body
 * Stratum would send, which is what the credential assertions read.
 *
 * What is NOT here is a deployment: no container runs and nothing is deployed.
 * These tests establish what Stratum asks for and what it does with the
 * answers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeployFilesReader,
  type DeployQueueMessage,
  runDeployMessage,
} from "../src/deploy/runner";
import { hmacSha256Hex } from "../src/evaluation/signing-secret";
import {
  NO_REPORT_REASON,
  applyDeployReport,
  sweepOverdueDeployments,
} from "../src/services/deploy-reports";
import {
  type Deployment,
  approveDeployment,
  insertDeployment,
  listDeployments,
} from "../src/storage/deployments";
import { putSecret } from "../src/storage/project-secrets";
import { setProject } from "../src/storage/state";
import type { Env, ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { ok } from "../src/utils/result";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

const PROJECT_ID = "prj_pipeline";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const EXECUTOR_SECRET = "executor-shared-secret-0123456789abcdef";
const APP_URL = "https://stratum.example.com";
/** A project secret that exists in D1. It must never reach the executor. */
const STORED_PROJECT_SECRET = "cf-project-secret-MUST-NOT-BE-SENT";

const PROJECT: ProjectEntry = {
  id: PROJECT_ID,
  name: "app",
  slug: "app",
  namespace: "@alice",
  ownerId: "usr_alice",
  ownerType: "org",
  remote: "https://acct.artifacts.cloudflare.net/git/acct/app.git",
  createdAt: "2026-09-04T00:00:00.000Z",
};

const POLICY = "evaluators:\n  - type: diff\n";

const PIPELINE = `steps:
  - name: test
    run: npm test
deploy:
  timeoutMinutes: 20
  network:
    allow: [app-staging.example.workers.dev]
  environments:
    - name: staging
      steps:
        - name: migrate
          run: npx wrangler d1 migrations apply app --remote --env staging
        - name: deploy
          run: npx wrangler deploy --env staging
    - name: production
      requiresApproval: true
      steps:
        - name: migrate
          run: npx wrangler d1 migrations apply app --remote --env production
        - name: deploy
          run: npx wrangler deploy --env production
      rollback:
        - name: rollback
          run: npx wrangler rollback "$STRATUM_ROLLBACK_VERSION" --env production -m rollback
`;

/** The same pipeline with nobody to wait for between the two environments. */
const UNGATED = PIPELINE.replace("      requiresApproval: true\n", "");

interface Dispatch {
  event: string;
  deploymentId: string;
  projectId: string;
  environment: string;
  commitSha: string;
  callbackUrl: string;
  deadline: string;
  rollback?: { version?: string };
  job: {
    profile: string;
    steps: Array<{ name: string; run: string }>;
    timeoutSeconds: number;
    allowHosts: string[];
    repository: { password: string };
    logUrl: string;
  };
}

let db: D1Database;
let raw: ReturnType<typeof makeSqliteD1>["raw"];
let kv: KVNamespace;
let clock: number;
/** Every body the fake executor received, raw and parsed. */
let dispatched: Array<{ raw: string; signature: string | null; body: Dispatch }>;
/** What the executor answers the next dispatch with. */
let executorAnswer: () => Response;
/** Messages put on the deploy queue by reports and sweeps, awaiting {@link pump}. */
let queued: DeployQueueMessage[];
/** The tree at each commit. */
let trees: Map<string, Map<string, Uint8Array>>;

function treeOf(pipeline: string | null, policy: string | null = POLICY): Map<string, Uint8Array> {
  const encoder = new TextEncoder();
  const files = new Map<string, Uint8Array>([["index.js", encoder.encode("export default {}")]]);
  if (policy !== null) files.set(".stratum/policy.yaml", encoder.encode(policy));
  if (pipeline !== null) files.set(".stratum/ci.yaml", encoder.encode(pipeline));
  return files;
}

const readFiles: DeployFilesReader = async (_remote, _token, _logger, ref) => {
  const files = trees.get(ref);
  if (files === undefined) throw new Error(`no tree for ${ref}`);
  return ok(files);
};

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    STATE: kv,
    ARTIFACTS: {
      get: async () => ({ createToken: async () => ({ plaintext: "art_v1_repo_read_token" }) }),
    },
    DEPLOY_SECRET_KEY: "a-test-deploy-secret-key",
    APP_URL,
    CI_EXECUTOR_SECRET: EXECUTOR_SECRET,
    CI_EXECUTOR: {
      fetch: async (request: Request) => {
        const text = await request.text();
        dispatched.push({
          raw: text,
          signature: request.headers.get("X-Stratum-Signature"),
          body: JSON.parse(text) as Dispatch,
        });
        return executorAnswer();
      },
    },
    DEPLOY_QUEUE: {
      send: async (message: DeployQueueMessage) => {
        queued.push(message);
      },
    },
    ...overrides,
  } as unknown as Env;
}

beforeEach(async () => {
  const made = makeSqliteD1();
  db = made.db;
  raw = made.raw;
  kv = makeFakeKV();
  clock = Date.parse("2026-09-04T01:00:00.000Z");
  dispatched = [];
  queued = [];
  executorAnswer = () => Response.json({ jobId: "deploy-1", state: "running" }, { status: 202 });
  trees = new Map([
    [SHA_A, treeOf(PIPELINE)],
    [SHA_B, treeOf(PIPELINE)],
    [SHA_C, treeOf(PIPELINE)],
  ]);
  vi.clearAllMocks();

  const stored = await setProject(kv, PROJECT, logger);
  if (!stored.success) throw stored.error;
  for (const id of ["chg_a", "chg_b", "chg_c"]) {
    raw
      .prepare(
        "INSERT INTO changes (id, project, project_id, workspace, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, PROJECT.name, PROJECT_ID, `ws-${id}`, "merged", "2026-09-04T00:00:00.000Z");
  }
});

async function run(message: DeployQueueMessage, env: Env = makeEnv()) {
  const result = await runDeployMessage(env, message, logger, { readFiles, now: () => clock });
  if (!result.success) throw result.error;
  return result.data;
}

/** A merge of `sha`, stamped `minutes` after the fixture's start. */
function merge(sha: string, changeId: string, minutes: number): DeployQueueMessage {
  return {
    kind: "merge",
    projectId: PROJECT_ID,
    changeId,
    commitSha: sha,
    mergedAt: new Date(Date.parse("2026-09-04T00:00:00.000Z") + minutes * 60_000).toISOString(),
  };
}

/** Deliver everything reports and sweeps have put on the deploy queue. */
async function pump(env: Env = makeEnv()): Promise<void> {
  for (let i = 0; i < 20 && queued.length > 0; i++) {
    const message = queued.shift();
    if (message !== undefined) await run(message, env);
  }
}

async function rows(name?: string): Promise<Deployment[]> {
  const listed = await listDeployments(db, logger, {
    projectId: PROJECT_ID,
    ...(name !== undefined ? { name } : {}),
  });
  if (!listed.success) throw listed.error;
  return listed.data;
}

async function row(name: string, sha: string): Promise<Deployment> {
  const found = (await rows(name)).filter((entry) => entry.commitSha === sha);
  const latest = found.sort((a, b) => b.attempt - a.attempt)[0];
  if (latest === undefined) throw new Error(`no ${name} deployment of ${sha.slice(0, 7)}`);
  return latest;
}

/** The executor's report, signed as the executor signs it. */
async function report(
  deployment: Deployment,
  status: "succeeded" | "failed",
  extra: Record<string, unknown> = {},
  env: Env = makeEnv(),
) {
  const body = JSON.stringify({
    deploymentId: deployment.id,
    commitSha: deployment.commitSha,
    environment: deployment.name,
    status,
    sequence: 1,
    steps: [],
    ...extra,
  });
  return applyDeployReport(env, logger, {
    deploymentId: deployment.id,
    rawBody: body,
    signatureHeader: `sha256=${await hmacSha256Hex(EXECUTOR_SECRET, body)}`,
    now: new Date(clock),
  });
}

describe("a merge", () => {
  it("triggers a staging deploy and nothing else", async () => {
    const summary = await run(merge(SHA_A, "chg_a", 15));

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      name: "staging",
      target: "pipeline",
      status: "running",
      commitSha: SHA_A,
      changeId: "chg_a",
      requestedByType: "system",
    });
    expect(summary.deployments.map((entry) => `${entry.name}:${entry.status}`)).toEqual([
      "staging:running",
    ]);

    expect(dispatched).toHaveLength(1);
    const { body } = dispatched[0] ?? {};
    expect(body).toMatchObject({
      event: "deploy.requested",
      deploymentId: all[0]?.id,
      projectId: PROJECT_ID,
      environment: "staging",
      commitSha: SHA_A,
      callbackUrl: `${APP_URL}/api/deploy-reports`,
    });
    expect(body?.job.profile).toBe("deploy");
    expect(body?.job.steps.map((step) => step.name)).toEqual(["migrate", "deploy"]);
    expect(body?.job.timeoutSeconds).toBe(1200);
    expect(body?.job.allowHosts).toEqual(["app-staging.example.workers.dev"]);
    expect(body?.job.logUrl).toBe(`${APP_URL}/@alice/app/deployments/${all[0]?.id}`);
    // Nothing about production has been created, queued or dispatched.
    expect(await rows("production")).toEqual([]);
  });

  it("signs the dispatch, and sends no credential for the deploy target", async () => {
    // The project HAS a Cloudflare credential stored, for a static target.
    // A pipeline must not send it, or read it.
    const stored = await putSecret(
      db,
      logger,
      { DEPLOY_SECRET_KEY: "a-test-deploy-secret-key" },
      {
        projectId: PROJECT_ID,
        name: "CLOUDFLARE_API_TOKEN",
        value: STORED_PROJECT_SECRET,
        actorId: "usr_alice",
      },
    );
    if (!stored.success) throw stored.error;

    await run(merge(SHA_A, "chg_a", 15));

    const sent = dispatched[0];
    expect(sent?.signature).toBe(`sha256=${await hmacSha256Hex(EXECUTOR_SECRET, sent?.raw ?? "")}`);
    expect(sent?.raw).not.toContain(STORED_PROJECT_SECRET);
    // The one credential in the body is the read-only repository token every
    // CI job gets. There is no field for anything else.
    expect(sent?.body.job.repository.password).toBe("art_v1_repo_read_token");
    expect(Object.keys(sent?.body ?? {}).sort()).toEqual([
      "callbackUrl",
      "commitSha",
      "deadline",
      "deploymentId",
      "environment",
      "event",
      "job",
      "project",
      "projectId",
    ]);
    expect(Object.keys(sent?.body.job ?? {}).sort()).toEqual([
      "allowHosts",
      "logUrl",
      "profile",
      "repository",
      "steps",
      "timeoutSeconds",
    ]);
  });

  it("records nothing but `skipped` when the commit declares neither kind of deploy", async () => {
    trees.set(SHA_A, treeOf("steps:\n  - name: test\n    run: npm test\n"));
    await run(merge(SHA_A, "chg_a", 15));

    const all = await rows();
    expect(all.map((entry) => entry.status)).toEqual(["skipped"]);
    expect(dispatched).toEqual([]);
  });

  it("deploys nothing, visibly, when the deploy section is invalid", async () => {
    trees.set(SHA_A, treeOf(PIPELINE.replace("requiresApproval", "requireApproval")));
    await run(merge(SHA_A, "chg_a", 15));

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("failed");
    expect(all[0]?.reason).toContain("unrecognized field 'requireApproval'");
    expect(all[0]?.reason).toContain("nothing was deployed");
    expect(dispatched).toEqual([]);
  });

  it("keeps today's static targets working beside a pipeline, and refuses a shared name", async () => {
    const policy = `${POLICY}deploys:\n  - name: staging\n    target: vercel\n    requiresApproval: true\n`;
    trees.set(SHA_A, treeOf(PIPELINE, policy));
    await run(merge(SHA_A, "chg_a", 15));

    const all = await rows();
    // The static target's row is exactly what it was before pipelines existed.
    expect(all.find((entry) => entry.target === "vercel")).toMatchObject({
      name: "staging",
      status: "pending_approval",
    });
    const refused = all.find((entry) => entry.name === "(pipeline)");
    expect(refused?.status).toBe("failed");
    expect(refused?.reason).toContain("same name as a 'deploys:' entry");
    expect(dispatched).toEqual([]);
  });
});

describe("promotion", () => {
  it("production waits for approval, and exists only once staging has succeeded", async () => {
    await run(merge(SHA_A, "chg_a", 15));
    expect(await rows("production")).toEqual([]);

    const staging = await row("staging", SHA_A);
    const applied = await report(staging, "succeeded", { version: "ver-staging-a" });
    expect(applied.kind).toBe("ok");
    expect(await row("staging", SHA_A)).toMatchObject({
      status: "succeeded",
      version: "ver-staging-a",
    });
    await pump();

    const production = await row("production", SHA_A);
    expect(production).toMatchObject({
      status: "pending_approval",
      target: "pipeline",
      changeId: "chg_a",
      // Ordered by the merge, like the row it follows.
      createdAt: staging.createdAt,
    });
    // Nobody approved: the executor has been asked for staging and nothing more.
    expect(dispatched.map((entry) => entry.body.environment)).toEqual(["staging"]);

    const approved = await approveDeployment(db, logger, {
      projectId: PROJECT_ID,
      deploymentId: production.id,
      approvedBy: "usr_alice",
    });
    if (!approved.success || !approved.data.approved) throw new Error("approval failed");
    await run({ kind: "deployment", projectId: PROJECT_ID, deploymentId: production.id });

    expect(dispatched.map((entry) => entry.body.environment)).toEqual(["staging", "production"]);
    expect(dispatched[1]?.body.job.steps.map((step) => step.run)).toEqual([
      "npx wrangler d1 migrations apply app --remote --env production",
      "npx wrangler deploy --env production",
    ]);
    expect(await row("production", SHA_A)).toMatchObject({
      status: "running",
      approvedBy: "usr_alice",
    });
  });

  it("an unapproved production deployment cannot be started by a queue message", async () => {
    await run(merge(SHA_A, "chg_a", 15));
    await report(await row("staging", SHA_A), "succeeded");
    await pump();
    const production = await row("production", SHA_A);

    await run({ kind: "deployment", projectId: PROJECT_ID, deploymentId: production.id });

    expect((await row("production", SHA_A)).status).toBe("pending_approval");
    expect(dispatched.map((entry) => entry.body.environment)).toEqual(["staging"]);
  });

  it("a deployment still waiting for approval cannot retire an older one that is also waiting", async () => {
    for (const [sha, change, minutes] of [
      [SHA_A, "chg_a", 15],
      [SHA_B, "chg_b", 16],
    ] as const) {
      await run(merge(sha, change, minutes));
      await report(await row("staging", sha), "succeeded");
      await pump();
    }
    expect((await row("production", SHA_A)).status).toBe("pending_approval");
    const newer = await row("production", SHA_B);

    // A message for the newer, unapproved row: it must change nothing at all.
    await run({ kind: "deployment", projectId: PROJECT_ID, deploymentId: newer.id });

    expect((await row("production", SHA_A)).status).toBe("pending_approval");
    expect((await row("production", SHA_B)).status).toBe("pending_approval");
  });

  it("goes straight on when the next environment asks for no approval", async () => {
    trees.set(SHA_A, treeOf(UNGATED));
    await run(merge(SHA_A, "chg_a", 15));
    await report(await row("staging", SHA_A), "succeeded");
    await pump();

    expect((await row("production", SHA_A)).status).toBe("running");
    expect(dispatched.map((entry) => entry.body.environment)).toEqual(["staging", "production"]);
  });

  it("stops at the last environment", async () => {
    trees.set(SHA_A, treeOf(UNGATED));
    await run(merge(SHA_A, "chg_a", 15));
    await report(await row("staging", SHA_A), "succeeded");
    await pump();
    await report(await row("production", SHA_A), "succeeded");
    await pump();

    expect((await rows()).map((entry) => `${entry.name}:${entry.status}`).sort()).toEqual([
      "production:succeeded",
      "staging:succeeded",
    ]);
    expect(dispatched).toHaveLength(2);
  });

  it("is safe to deliver twice: one production row, one dispatch", async () => {
    trees.set(SHA_A, treeOf(UNGATED));
    await run(merge(SHA_A, "chg_a", 15));
    const staging = await row("staging", SHA_A);
    await report(staging, "succeeded");
    await pump();
    await run({ kind: "advance", projectId: PROJECT_ID, deploymentId: staging.id });
    await run({ kind: "advance", projectId: PROJECT_ID, deploymentId: staging.id });

    expect(await rows("production")).toHaveLength(1);
    expect(dispatched).toHaveLength(2);
  });
});

describe("a failed step", () => {
  it("leaves a visible failed deployment with its log, and promotes nothing", async () => {
    await run(merge(SHA_A, "chg_a", 15));
    const staging = await row("staging", SHA_A);

    const applied = await report(staging, "failed", {
      cause: "failed",
      summary: "Step 'migrate' failed. Failed with exit code 1 after 4s.",
      steps: [
        { name: "migrate", status: "failed", summary: "Failed with exit code 1 after 4s." },
        { name: "deploy", status: "skipped" },
      ],
      // A failed job reports no version; one that turns up anyway is not kept.
      version: "should-not-be-recorded",
      logTail: "applying 079_x.sql\nERROR: duplicate column name: version\n",
    });
    expect(applied.kind).toBe("ok");
    await pump();

    const failed = await row("staging", SHA_A);
    expect(failed.status).toBe("failed");
    expect(failed.reason).toBe("Step 'migrate' failed. Failed with exit code 1 after 4s.");
    expect(failed.logTail).toContain("[failed] migrate");
    expect(failed.logTail).toContain("[skipped] deploy");
    expect(failed.logTail).toContain("duplicate column name");
    expect(failed.version).toBeUndefined();
    expect(failed.completedAt).toBeDefined();

    // No production row was created, so there is nothing to approve, retry or
    // promote into production from this commit.
    expect(await rows("production")).toEqual([]);
    expect(dispatched).toHaveLength(1);
  });

  it("says so when the job could not run to the end, rather than blaming a step", async () => {
    await run(merge(SHA_A, "chg_a", 15));
    await report(await row("staging", SHA_A), "failed", {
      cause: "errored",
      summary: "Not run: the job exceeded its time limit of 20 minutes.",
    });
    expect((await row("staging", SHA_A)).reason).toBe(
      "The deploy job could not run to the end. Not run: the job exceeded its time limit of 20 minutes.",
    );
  });

  it("fails the deployment at once when the executor refuses the job, and frees the environment", async () => {
    executorAnswer = () =>
      Response.json(
        { error: "no deploy target for project", code: "INVALID_DISPATCH" },
        { status: 400 },
      );
    await run(merge(SHA_A, "chg_a", 15));

    const staging = await row("staging", SHA_A);
    expect(staging.status).toBe("failed");
    expect(staging.reason).toContain("the CI executor answered HTTP 400");
    expect(staging.reason).toContain("no deploy target for project");

    // The environment is not left held: the next merge deploys.
    executorAnswer = () => Response.json({ state: "running" }, { status: 202 });
    await run(merge(SHA_B, "chg_b", 20));
    expect((await row("staging", SHA_B)).status).toBe("running");
  });

  it("fails with the reason when the instance has no executor, or no public URL", async () => {
    await run(merge(SHA_A, "chg_a", 15), makeEnv({ CI_EXECUTOR: undefined }));
    expect((await row("staging", SHA_A)).reason).toContain("this instance has no CI executor");

    await run(merge(SHA_B, "chg_b", 20), makeEnv({ APP_URL: undefined }));
    expect((await row("staging", SHA_B)).reason).toContain("APP_URL");
    expect(dispatched).toEqual([]);
  });

  it("does not deploy a change that was reverted before its turn came", async () => {
    raw.prepare("UPDATE changes SET status = 'reverted' WHERE id = ?").run("chg_a");
    const staging = await insertDeployment(db, logger, {
      projectId: PROJECT_ID,
      project: PROJECT.name,
      changeId: "chg_a",
      commitSha: SHA_A,
      name: "staging",
      target: "pipeline",
      status: "queued",
      requestedByType: "system",
    });
    if (!staging.success || !staging.data.inserted) throw new Error("fixture");
    await run({
      kind: "deployment",
      projectId: PROJECT_ID,
      deploymentId: staging.data.deployment.id,
    });

    expect((await row("staging", SHA_A)).status).toBe("failed");
    expect(dispatched).toEqual([]);
  });
});

describe("two merges in quick succession", () => {
  it("do not run in one environment at the same time: the second waits, then runs", async () => {
    await run(merge(SHA_A, "chg_a", 15));
    await run(merge(SHA_B, "chg_b", 16));

    expect((await row("staging", SHA_A)).status).toBe("running");
    // B is not handed to the executor while A's steps may still be running.
    expect((await row("staging", SHA_B)).status).toBe("queued");
    expect(dispatched.map((entry) => entry.body.commitSha)).toEqual([SHA_A]);

    // Redelivering B's message changes nothing while A holds the environment.
    await run({
      kind: "deployment",
      projectId: PROJECT_ID,
      deploymentId: (await row("staging", SHA_B)).id,
    });
    expect(dispatched).toHaveLength(1);

    await report(await row("staging", SHA_A), "succeeded");
    await pump();

    expect((await row("staging", SHA_B)).status).toBe("running");
    expect(dispatched.map((entry) => entry.body.commitSha)).toEqual([SHA_A, SHA_B]);
  });

  it("the later merge is not overtaken: when the first finishes, the NEWEST waiting one runs", async () => {
    await run(merge(SHA_A, "chg_a", 15));
    await run(merge(SHA_B, "chg_b", 16));
    await run(merge(SHA_C, "chg_c", 17));
    expect(dispatched).toHaveLength(1);

    await report(await row("staging", SHA_A), "succeeded");
    await pump();

    // C goes next and B is retired: staging is never moved to B on its way to C.
    expect((await row("staging", SHA_C)).status).toBe("running");
    expect((await row("staging", SHA_B)).status).toBe("superseded");
    expect(dispatched.map((entry) => entry.body.commitSha)).toEqual([SHA_A, SHA_C]);

    // And B stays retired when C finishes.
    await report(await row("staging", SHA_C), "succeeded");
    await pump();
    expect((await row("staging", SHA_B)).status).toBe("superseded");
    expect(dispatched).toHaveLength(2);
  });

  it("an older merge delivered after a newer one succeeded is superseded, not deployed", async () => {
    await run(merge(SHA_B, "chg_b", 16));
    await report(await row("staging", SHA_B), "succeeded");
    await pump();

    await run(merge(SHA_A, "chg_a", 15));

    expect((await row("staging", SHA_A)).status).toBe("superseded");
    expect(dispatched.map((entry) => entry.body.commitSha)).toEqual([SHA_B]);
  });

  it("an older merge delivered while a newer one is running waits, then is superseded", async () => {
    await run(merge(SHA_B, "chg_b", 16));
    await run(merge(SHA_A, "chg_a", 15));
    expect((await row("staging", SHA_A)).status).toBe("queued");

    await report(await row("staging", SHA_B), "succeeded");
    await pump();

    expect((await row("staging", SHA_A)).status).toBe("superseded");
    expect(dispatched.map((entry) => entry.body.commitSha)).toEqual([SHA_B]);
  });

  it("serializes per environment, not per project: staging of B runs beside production of A", async () => {
    trees.set(SHA_A, treeOf(UNGATED));
    trees.set(SHA_B, treeOf(UNGATED));
    await run(merge(SHA_A, "chg_a", 15));
    await report(await row("staging", SHA_A), "succeeded");
    await pump();
    expect((await row("production", SHA_A)).status).toBe("running");

    await run(merge(SHA_B, "chg_b", 16));
    expect((await row("staging", SHA_B)).status).toBe("running");
  });

  it("a failed deployment also gives the environment to whoever is waiting", async () => {
    await run(merge(SHA_A, "chg_a", 15));
    await run(merge(SHA_B, "chg_b", 16));
    await report(await row("staging", SHA_A), "failed", { summary: "Step 'deploy' failed." });
    await pump();

    expect((await row("staging", SHA_B)).status).toBe("running");
  });

  it("the claim itself refuses a second running row, without a check beforehand", async () => {
    const { claimPipelineDeployment } = await import("../src/storage/deployments");
    const insert = async (sha: string) => {
      const inserted = await insertDeployment(db, logger, {
        projectId: PROJECT_ID,
        project: PROJECT.name,
        commitSha: sha,
        name: "staging",
        target: "pipeline",
        status: "queued",
        requestedByType: "system",
      });
      if (!inserted.success || !inserted.data.inserted) throw new Error("fixture");
      return inserted.data.deployment.id;
    };
    const [first, second] = [await insert(SHA_A), await insert(SHA_B)];
    const now = new Date(clock).toISOString();
    const claim = (deploymentId: string, at = now) =>
      claimPipelineDeployment(db, logger, {
        projectId: PROJECT_ID,
        deploymentId,
        leaseMs: 60_000,
        now: at,
      });

    // Issued together, as two consumers would.
    const [a, b] = await Promise.all([claim(first), claim(second)]);
    if (!a.success || !b.success) throw new Error("claim errored");
    expect([a.data.claimed, b.data.claimed].filter(Boolean)).toHaveLength(1);
    const loser = a.data.claimed ? b.data : a.data;
    expect(loser).toEqual({ claimed: false, reason: "environment_busy" });

    // A lease that has run out no longer holds the environment.
    const later = new Date(clock + 120_000).toISOString();
    const retry = await claim(a.data.claimed ? second : first, later);
    expect(retry.success && retry.data.claimed).toBe(true);
  });
});

describe("the executor's report", () => {
  it("is refused without the executor's signature, and changes nothing", async () => {
    await run(merge(SHA_A, "chg_a", 15));
    const staging = await row("staging", SHA_A);
    const body = JSON.stringify({
      deploymentId: staging.id,
      commitSha: SHA_A,
      status: "succeeded",
    });

    for (const signatureHeader of [
      undefined,
      "sha256=deadbeef",
      `sha256=${await hmacSha256Hex("some-other-secret-0123456789abcdefgh", body)}`,
    ]) {
      const outcome = await applyDeployReport(makeEnv(), logger, {
        deploymentId: staging.id,
        rawBody: body,
        signatureHeader,
      });
      expect(outcome.kind).toBe("unauthenticated");
    }
    // An unknown id gets the same answer as a bad signature.
    expect(
      (
        await applyDeployReport(makeEnv(), logger, {
          deploymentId: "dep_nope",
          rawBody: body,
          signatureHeader: "sha256=deadbeef",
        })
      ).kind,
    ).toBe("unauthenticated");
    expect((await row("staging", SHA_A)).status).toBe("running");
    expect(queued).toEqual([]);
  });

  it("cannot be replayed at another deployment, or for another commit", async () => {
    await run(merge(SHA_A, "chg_a", 15));
    const staging = await row("staging", SHA_A);
    const body = JSON.stringify({
      deploymentId: "dep_other",
      commitSha: SHA_A,
      status: "succeeded",
    });
    const replayed = await applyDeployReport(makeEnv(), logger, {
      deploymentId: staging.id,
      rawBody: body,
      signatureHeader: `sha256=${await hmacSha256Hex(EXECUTOR_SECRET, body)}`,
    });
    expect(replayed.kind).toBe("invalid");

    const wrongCommit = await report({ ...staging, commitSha: SHA_B }, "succeeded");
    expect(wrongCommit.kind).toBe("conflict");
    expect((await row("staging", SHA_A)).status).toBe("running");
  });

  it("finishes a deployment once: a second report, or a late one, is a conflict", async () => {
    await run(merge(SHA_A, "chg_a", 15));
    const staging = await row("staging", SHA_A);
    expect((await report(staging, "succeeded", { version: "v1" })).kind).toBe("ok");

    const again = await report(staging, "failed", { summary: "changed my mind" });
    expect(again.kind).toBe("conflict");
    expect(await row("staging", SHA_A)).toMatchObject({ status: "succeeded", version: "v1" });
    // One follow-up was queued, not two.
    expect(queued).toHaveLength(1);
  });

  it("cannot finish a deployment that was never handed to the executor", async () => {
    await run(merge(SHA_A, "chg_a", 15));
    await report(await row("staging", SHA_A), "succeeded");
    await pump();
    const production = await row("production", SHA_A);
    expect(production.status).toBe("pending_approval");

    // Signed, well-formed, and for a row still waiting for a person.
    const outcome = await report(production, "succeeded");
    expect(outcome.kind).toBe("conflict");
    expect((await row("production", SHA_A)).status).toBe("pending_approval");
  });

  it("records a version and URL only when they are a plain label and an https link", async () => {
    await run(merge(SHA_A, "chg_a", 15));
    await report(await row("staging", SHA_A), "succeeded", {
      version: "<script>alert(1)</script>",
      url: "javascript:alert(1)",
    });
    const done = await row("staging", SHA_A);
    expect(done.status).toBe("succeeded");
    expect(done.version).toBeUndefined();
    expect(done.url).toBeUndefined();

    await run(merge(SHA_B, "chg_b", 16));
    await report(await row("staging", SHA_B), "succeeded", {
      version: "0f1e2d3c-aaaa-bbbb-cccc-000000000000",
      url: "https://app-staging.example.workers.dev",
    });
    expect(await row("staging", SHA_B)).toMatchObject({
      version: "0f1e2d3c-aaaa-bbbb-cccc-000000000000",
      url: "https://app-staging.example.workers.dev/",
    });
  });

  it("is refused when the instance has no executor secret to verify it with", async () => {
    await run(merge(SHA_A, "chg_a", 15));
    const staging = await row("staging", SHA_A);
    const outcome = await report(staging, "succeeded", {}, makeEnv({ CI_EXECUTOR_SECRET: "" }));
    expect(outcome.kind).toBe("unauthenticated");
  });
});

describe("an executor that never reports", () => {
  it("has its deployment failed when the lease runs out, and the environment released", async () => {
    await run(merge(SHA_A, "chg_a", 15));
    await run(merge(SHA_B, "chg_b", 16));
    const staging = await row("staging", SHA_A);

    // Before the lease runs out, nothing happens.
    expect(await sweepOverdueDeployments(makeEnv(), logger, new Date(clock + 60_000))).toBe(0);
    expect((await row("staging", SHA_A)).status).toBe("running");

    // 20 minute job + 15 minutes to wait for a slot + 2 for the report.
    const lease = Date.parse(staging.leaseExpiresAt ?? "");
    expect(lease - clock).toBe((20 + 15 + 2) * 60_000);
    clock = lease + 1000;
    expect(await sweepOverdueDeployments(makeEnv(), logger, new Date(clock))).toBe(1);

    const failed = await row("staging", SHA_A);
    expect(failed.status).toBe("failed");
    expect(failed.reason).toBe(NO_REPORT_REASON);
    // Not promoted, and not re-run.
    expect(await rows("production")).toEqual([]);

    await pump();
    expect((await row("staging", SHA_B)).status).toBe("running");
    expect(dispatched.map((entry) => entry.body.commitSha)).toEqual([SHA_A, SHA_B]);
  });

  it("loses to a report that arrives first, and a report after the sweep is a conflict", async () => {
    await run(merge(SHA_A, "chg_a", 15));
    const staging = await row("staging", SHA_A);
    clock = Date.parse(staging.leaseExpiresAt ?? "") + 1000;
    await sweepOverdueDeployments(makeEnv(), logger, new Date(clock));

    expect((await report(staging, "succeeded")).kind).toBe("conflict");
    expect((await row("staging", SHA_A)).status).toBe("failed");
  });

  it("leaves a static target's running row alone", async () => {
    const inserted = await insertDeployment(db, logger, {
      projectId: PROJECT_ID,
      project: PROJECT.name,
      commitSha: SHA_A,
      name: "site",
      target: "vercel",
      status: "queued",
      requestedByType: "system",
    });
    if (!inserted.success || !inserted.data.inserted) throw new Error("fixture");
    raw
      .prepare("UPDATE deployments SET status = 'running', lease_expires_at = ? WHERE id = ?")
      .run("2026-09-04T00:00:00.000Z", inserted.data.deployment.id);

    expect(await sweepOverdueDeployments(makeEnv(), logger, new Date(clock))).toBe(0);
  });
});

describe("rollback", () => {
  /** Two production deployments, A then B, both succeeded; A's version is known. */
  async function twoProductionDeploys(): Promise<{ a: Deployment; b: Deployment }> {
    trees.set(SHA_A, treeOf(UNGATED));
    trees.set(SHA_B, treeOf(UNGATED));
    for (const [sha, change, minutes, version] of [
      [SHA_A, "chg_a", 15, "ver-a"],
      [SHA_B, "chg_b", 16, "ver-b"],
    ] as const) {
      await run(merge(sha, change, minutes));
      await report(await row("staging", sha), "succeeded", { version: `staging-${version}` });
      await pump();
      await report(await row("production", sha), "succeeded", { version });
      await pump();
    }
    dispatched.length = 0;
    return { a: await row("production", SHA_A), b: await row("production", SHA_B) };
  }

  /** What the rollback route inserts, then the message it enqueues. */
  async function rollBackTo(target: Deployment): Promise<Deployment> {
    // Later than every merge, and well inside any running deployment's lease.
    clock += 5 * 60_000;
    const inserted = await insertDeployment(db, logger, {
      projectId: PROJECT_ID,
      project: PROJECT.name,
      changeId: target.changeId ?? null,
      commitSha: target.commitSha,
      name: target.name,
      target: target.target,
      attempt: target.attempt + 1,
      status: "queued",
      requestedByType: "user",
      requestedById: "usr_alice",
      approvedBy: "usr_alice",
      rollbackOf: target.id,
      now: new Date(clock).toISOString(),
    });
    if (!inserted.success || !inserted.data.inserted) throw new Error("fixture");
    await run({
      kind: "deployment",
      projectId: PROJECT_ID,
      deploymentId: inserted.data.deployment.id,
    });
    return inserted.data.deployment;
  }

  it("redeploys the recorded version, with the environment's rollback steps", async () => {
    const { a } = await twoProductionDeploys();
    expect(a.version).toBe("ver-a");

    const rollback = await rollBackTo(a);

    expect(dispatched).toHaveLength(1);
    const { body } = dispatched[0] ?? {};
    expect(body).toMatchObject({
      deploymentId: rollback.id,
      environment: "production",
      commitSha: SHA_A,
      rollback: { version: "ver-a" },
    });
    expect(body?.job.steps.map((step) => step.name)).toEqual(["rollback"]);
    expect(body?.job.steps[0]?.run).toContain("wrangler rollback");
    // No migration step runs: a rollback does not touch the schema.
    expect(JSON.stringify(body?.job.steps)).not.toContain("migrations apply");
  });

  it("records the version it put back, and does not promote", async () => {
    const { a } = await twoProductionDeploys();
    const rollback = await rollBackTo(a);
    // `wrangler rollback` records no new version of its own.
    await report({ ...rollback, status: "running" }, "succeeded");
    await pump();

    const done = (await rows("production")).find((entry) => entry.id === rollback.id);
    expect(done).toMatchObject({ status: "succeeded", version: "ver-a", rollbackOf: a.id });
    expect(dispatched).toHaveLength(1);
  });

  it("re-runs the environment's steps at the earlier commit when no version was recorded", async () => {
    const { a } = await twoProductionDeploys();
    raw.prepare("UPDATE deployments SET version = NULL WHERE id = ?").run(a.id);

    await rollBackTo(a);

    const { body } = dispatched[0] ?? {};
    expect(body?.commitSha).toBe(SHA_A);
    expect(body?.rollback).toEqual({});
    expect(body?.job.steps.map((step) => step.name)).toEqual(["migrate", "deploy"]);
  });

  it("re-runs the steps for an environment that declares no rollback steps", async () => {
    trees.set(SHA_A, treeOf(UNGATED));
    await run(merge(SHA_A, "chg_a", 15));
    await report(await row("staging", SHA_A), "succeeded", { version: "staging-ver-a" });
    await pump();
    dispatched.length = 0;

    await rollBackTo(await row("staging", SHA_A));

    expect(dispatched[0]?.body.rollback).toEqual({ version: "staging-ver-a" });
    expect(dispatched[0]?.body.job.steps.map((step) => step.name)).toEqual(["migrate", "deploy"]);
  });

  it("waits its turn for the environment like any deployment", async () => {
    const { a } = await twoProductionDeploys();
    trees.set(SHA_C, treeOf(UNGATED));
    await run(merge(SHA_C, "chg_c", 17));
    await report(await row("staging", SHA_C), "succeeded");
    await pump();
    expect((await row("production", SHA_C)).status).toBe("running");
    dispatched.length = 0;

    const rollback = await rollBackTo(a);
    expect(dispatched).toEqual([]);
    expect((await rows("production")).find((entry) => entry.id === rollback.id)?.status).toBe(
      "queued",
    );

    await report(await row("production", SHA_C), "succeeded");
    await pump();
    expect(dispatched.map((entry) => entry.body.deploymentId)).toEqual([rollback.id]);
  });

  it("is the newest intent: a deployment still waiting for approval is superseded by it", async () => {
    trees.set(SHA_A, treeOf(UNGATED));
    await run(merge(SHA_A, "chg_a", 15));
    await report(await row("staging", SHA_A), "succeeded");
    await pump();
    await report(await row("production", SHA_A), "succeeded", { version: "ver-a" });
    await pump();
    // B is gated, and is left waiting for approval.
    await run(merge(SHA_B, "chg_b", 16));
    await report(await row("staging", SHA_B), "succeeded");
    await pump();
    expect((await row("production", SHA_B)).status).toBe("pending_approval");

    await rollBackTo(await row("production", SHA_A));

    expect((await row("production", SHA_B)).status).toBe("superseded");
  });

  it("is refused when the deployment it points at did not succeed", async () => {
    const { a } = await twoProductionDeploys();
    raw.prepare("UPDATE deployments SET status = 'failed' WHERE id = ?").run(a.id);

    const rollback = await rollBackTo(a);

    const refused = (await rows("production")).find((entry) => entry.id === rollback.id);
    expect(refused?.status).toBe("failed");
    expect(refused?.reason).toContain("nothing was rolled back");
    expect(dispatched).toEqual([]);
  });
});
