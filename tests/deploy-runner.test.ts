/**
 * The deploy runner.
 *
 * The assertions that matter are about *honesty and containment*, not about
 * whether a happy path works:
 *
 * - `skipped` appears only when nothing was configured. Every operator error —
 *   a missing secret, an unset `DEPLOY_SECRET_KEY`, a rejected config entry, an
 *   unreadable tree — has to land as `failed` with a reason naming the cause,
 *   because reporting one as a calm grey state is failing open.
 * - A message with no `projectId` resolves nothing. Project names are not
 *   globally unique, so a name-based fallback would hand a deploy another
 *   tenant's credentials.
 * - A reverted change or a deleting project stops the deploy *before* the
 *   provider is called, and a target that throws still leaves a terminal row.
 * - No secret value reaches a persisted `reason` or `log_tail`, including on the
 *   path where the provider's own error is what carries it.
 *
 * The runner's three seams (`readFiles`, `now`, `fetch`) are injected, so none
 * of this needs git, a clock, or a provider account. D1 is real SQLite with the
 * production migrations applied.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeployFilesReader,
  type DeployQueueMessage,
  type DeployRunnerDeps,
  runDeployMessage,
} from "../src/deploy/runner";
import type { DeployFetch } from "../src/deploy/targets/index";
import { type Deployment, insertDeployment } from "../src/storage/deployments";
import { putSecret } from "../src/storage/project-secrets";
import { setProject } from "../src/storage/state";
import type { Env, ProjectEntry } from "../src/types";
import { AppError } from "../src/utils/errors";
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

const PROJECT_ID = "prj_deployrunner";
const PROJECT_NAME = "api";
const CHANGE_ID = "chg_deployrunner";
const SHA = "a".repeat(40);
const OLD_SHA = "b".repeat(40);
const NEWER_SHA = "c".repeat(40);
const REMOTE = "https://acct.artifacts.cloudflare.net/git/acct/api.git";

const VERCEL_TOKEN = "vercel-token-super-secret-value";
const VERCEL_PROJECT = "prj_vercel_abc123";
const DEPLOY_SECRET_KEY = "a-test-deploy-secret-key";

/** `now` for the run itself; every fixture row is stamped earlier than this. */
const T1 = Date.parse("2026-09-04T01:00:00.000Z");
const T1_ISO = "2026-09-04T01:00:00.000Z";
const T0 = "2026-09-04T00:00:00.000Z";

/** A merge time between the fixtures and the run, for the ordering cases. */
const MERGED_AT = "2026-09-04T00:15:00.000Z";

const PROJECT: ProjectEntry = {
  id: PROJECT_ID,
  name: PROJECT_NAME,
  slug: "api",
  namespace: "@alice",
  ownerId: "usr_alice",
  ownerType: "org",
  remote: REMOTE,
  createdAt: T0,
};

const VERCEL_POLICY = `evaluators:
  - type: diff

deploys:
  - name: production
    target: vercel
    secrets: [VERCEL_TOKEN, VERCEL_PROJECT_ID]
`;

let db: D1Database;
let raw: ReturnType<typeof makeSqliteD1>["raw"];
let kv: KVNamespace;

beforeEach(async () => {
  const made = makeSqliteD1();
  db = made.db;
  raw = made.raw;
  kv = makeFakeKV();
  vi.clearAllMocks();

  const stored = await setProject(kv, PROJECT, logger);
  if (!stored.success) throw stored.error;

  raw
    .prepare(
      "INSERT INTO changes (id, project, project_id, workspace, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(CHANGE_ID, PROJECT_NAME, PROJECT_ID, "ws1", "merged", T0);
});

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    STATE: kv,
    ARTIFACTS: {
      get: async () => ({ createToken: async () => ({ plaintext: "repo-token" }) }),
    },
    DEPLOY_SECRET_KEY,
    ...overrides,
  } as unknown as Env;
}

function tree(policy: string | null = VERCEL_POLICY): Map<string, Uint8Array> {
  const encoder = new TextEncoder();
  const files = new Map<string, Uint8Array>([["index.html", encoder.encode("<h1>hi</h1>")]]);
  if (policy !== null) files.set(".stratum/policy.yaml", encoder.encode(policy));
  return files;
}

function readsTree(files: Map<string, Uint8Array>): DeployFilesReader {
  return vi.fn(async () => ok(files));
}

const unreadableTree: DeployFilesReader = vi.fn(async () => ({
  success: false as const,
  error: new AppError("commit not found after deepening", "EXTERNAL_SERVICE_ERROR", 502),
}));

/** A Vercel create-deployment response: accepted for build, not yet live. */
function vercelAccepts(): DeployFetch {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({ id: "dpl_abc", url: "api-abc123.vercel.app", readyState: "QUEUED" }),
        { status: 200 },
      ),
  );
}

/** A provider that answers 4xx with the caller's own token echoed back at it. */
function vercelRejectsEchoingTheToken(): DeployFetch {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "forbidden",
            message: `token ${VERCEL_TOKEN} cannot deploy ${VERCEL_PROJECT}`,
          },
        }),
        { status: 403 },
      ),
  );
}

async function storeSecrets(names: Record<string, string>): Promise<void> {
  for (const [name, value] of Object.entries(names)) {
    const result = await putSecret(
      db,
      logger,
      { DEPLOY_SECRET_KEY },
      {
        projectId: PROJECT_ID,
        name,
        value,
        actorId: "usr_alice",
      },
    );
    if (!result.success) throw result.error;
  }
}

/** Insert a deployment row directly, for fixtures the runner is expected to find. */
async function insertFixture(
  overrides: Partial<Parameters<typeof insertDeployment>[2]> = {},
): Promise<Deployment> {
  const result = await insertDeployment(db, logger, {
    projectId: PROJECT_ID,
    project: PROJECT_NAME,
    commitSha: SHA,
    name: "production",
    target: "vercel",
    requestedByType: "system",
    now: T0,
    ...overrides,
  });
  if (!result.success) throw result.error;
  if (!result.data.inserted) throw new Error("fixture insert lost the unique index race");
  return result.data.deployment;
}

const MERGE_MESSAGE: DeployQueueMessage = {
  kind: "merge",
  projectId: PROJECT_ID,
  changeId: CHANGE_ID,
  commitSha: SHA,
};

async function run(
  message: DeployQueueMessage = MERGE_MESSAGE,
  deps: DeployRunnerDeps = {},
  env: Env = makeEnv(),
) {
  return runDeployMessage(env, message, logger, {
    readFiles: readsTree(tree()),
    now: () => T1,
    fetch: vercelAccepts(),
    ...deps,
  });
}

interface Row {
  id: string;
  name: string;
  target: string;
  status: string;
  reason: string | null;
  url: string | null;
  log_tail: string | null;
  commit_sha: string;
  duration_ms: number | null;
  completed_at: string | null;
  lease_expires_at: string | null;
}

function rows(): Row[] {
  return raw
    .prepare("SELECT * FROM deployments ORDER BY created_at ASC, id ASC")
    .all() as unknown as Row[];
}

function onlyRow(): Row {
  const all = rows();
  expect(all).toHaveLength(1);
  return all[0] as Row;
}

describe("the happy path", () => {
  it("publishes the tree and records what the provider actually promised", async () => {
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });
    const fetch = vercelAccepts();

    const result = await run(MERGE_MESSAGE, { fetch });

    expect(result.success).toBe(true);
    const row = onlyRow();
    expect(row.status).toBe("succeeded");
    expect(row.name).toBe("production");
    expect(row.target).toBe("vercel");
    expect(row.url).toBe("https://api-abc123.vercel.app");
    expect(row.commit_sha).toBe(SHA);
    expect(row.lease_expires_at).toBeNull();
    expect(row.completed_at).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("qualifies a succeeded row with the provider's own readyState", async () => {
    // Vercel returns as soon as it has *accepted* the deployment and builds
    // afterwards; the runner does not poll. A bare `succeeded` would claim the
    // commit is live when it may still be building.
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });

    await run();

    const row = onlyRow();
    expect(row.status).toBe("succeeded");
    expect(row.reason).toContain("QUEUED");
    expect(row.reason).toContain("does not poll");
  });

  it("reads the tree at the pinned commit, never at a branch tip", async () => {
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });
    const readFiles = readsTree(tree());

    await run(MERGE_MESSAGE, { readFiles });

    expect(readFiles).toHaveBeenCalledWith(REMOTE, "repo-token", logger, SHA, "main");
  });

  it("records the git cost of reading the tree", async () => {
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });

    await run();

    const costs = raw
      .prepare("SELECT kind, quantity, project_id, change_id FROM cost_records")
      .all() as unknown as Array<{
      kind: string;
      quantity: number;
      project_id: string;
      change_id: string;
    }>;
    expect(costs).toEqual([
      { kind: "git_ops", quantity: 1, project_id: PROJECT_ID, change_id: CHANGE_ID },
    ]);
  });

  it("emits deployment.requested and deployment.succeeded", async () => {
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });

    await run();

    const events = raw
      .prepare("SELECT type FROM events ORDER BY created_at ASC, id ASC")
      .all() as unknown as Array<{ type: string }>;
    expect(events.map((event) => event.type)).toEqual([
      "deployment.requested",
      "deployment.succeeded",
    ]);
  });
});

describe("operator errors are failures, never 'skipped'", () => {
  it("names the missing secret", async () => {
    await storeSecrets({ VERCEL_TOKEN });
    const fetch = vercelAccepts();

    await run(MERGE_MESSAGE, { fetch });

    const row = onlyRow();
    expect(row.status).toBe("failed");
    expect(row.reason).toContain("VERCEL_PROJECT_ID");
    // Nothing may be uploaded when a credential is missing.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("names an unset DEPLOY_SECRET_KEY rather than reporting a quiet skip", async () => {
    const env = makeEnv({ DEPLOY_SECRET_KEY: undefined });

    await run(MERGE_MESSAGE, {}, env);

    const row = onlyRow();
    expect(row.status).toBe("failed");
    expect(row.reason).toContain("DEPLOY_SECRET_KEY");
  });

  it("fails a secret that exists but will not decrypt", async () => {
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });
    // The remedy differs from a missing secret: this is a rotated key, so the
    // reason has to say so rather than telling the owner to add a value they
    // already added.
    const env = makeEnv({ DEPLOY_SECRET_KEY: "a-different-deploy-secret-key" });

    await run(MERGE_MESSAGE, {}, env);

    const row = onlyRow();
    expect(row.status).toBe("failed");
    expect(row.reason).toContain("rotated");
  });

  it("persists a failed row when the tree cannot be read at the merge commit", async () => {
    await run(MERGE_MESSAGE, { readFiles: unreadableTree });

    const row = onlyRow();
    expect(row.status).toBe("failed");
    expect(row.reason).toContain("Could not read the tree");
    expect(row.reason).toContain(SHA.slice(0, 7));
  });

  it("persists a rejected deploys entry as a failed row naming it", async () => {
    const policy = `evaluators:
  - type: diff

deploys:
  - name: production
    target: netlify
`;

    await run(MERGE_MESSAGE, { readFiles: readsTree(tree(policy)) });

    const row = onlyRow();
    expect(row.status).toBe("failed");
    expect(row.name).toBe("production");
    expect(row.reason).toContain("netlify");
  });

  it("persists a failed row when the policy file itself is malformed", async () => {
    // A YAML typo must not silently disable deploys — the quietest possible
    // way for production to stop updating.
    await run(MERGE_MESSAGE, { readFiles: readsTree(tree("deploys: [:::\n")) });

    const row = onlyRow();
    expect(row.status).toBe("failed");
    expect(row.reason).toContain(".stratum/policy.yaml");
  });
});

describe("'skipped' means only that nothing was configured", () => {
  it("skips when no policy file exists at the commit", async () => {
    await run(MERGE_MESSAGE, { readFiles: readsTree(tree(null)) });

    const row = onlyRow();
    expect(row.status).toBe("skipped");
    expect(row.reason).toContain("no deploy is configured");
  });

  it("skips when the policy declares no deploys", async () => {
    await run(MERGE_MESSAGE, { readFiles: readsTree(tree("evaluators:\n  - type: diff\n")) });

    const row = onlyRow();
    expect(row.status).toBe("skipped");
  });
});

describe("cost attribution", () => {
  it("bills the tree read to the project's owner", async () => {
    // `readTree` records a git op whether or not the read succeeds, so the
    // attribution has to be on it either way — this is a metered path that
    // never goes near an evaluator.
    await run(MERGE_MESSAGE, { readFiles: readsTree(tree(null)) });

    const costs = raw
      .prepare("SELECT owner_id, owner_type, source, kind, change_id FROM cost_records")
      .all() as unknown as Array<Record<string, unknown>>;
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({
      kind: "git_ops",
      // PROJECT is org-owned: the org is the payer, not the user who merged.
      owner_id: "usr_alice",
      owner_type: "org",
      source: "platform",
      change_id: CHANGE_ID,
    });
  });

  it("still records the read when the tree could not be read", async () => {
    await run(MERGE_MESSAGE, { readFiles: unreadableTree });

    const costs = raw.prepare("SELECT owner_id FROM cost_records").all() as unknown as Array<{
      owner_id: string | null;
    }>;
    expect(costs).toHaveLength(1);
    expect(costs[0]?.owner_id).toBe("usr_alice");
  });
});

describe("tenant scoping", () => {
  it("fails closed when the message carries no projectId", async () => {
    const readFiles = readsTree(tree());
    const message = { kind: "merge", projectId: "", changeId: CHANGE_ID, commitSha: SHA } as const;

    const result = await run(message, { readFiles });

    expect(result.success).toBe(true);
    if (!result.success) throw result.error;
    expect(result.data.aborted).toContain("projectId");
    expect(result.data.deployments).toEqual([]);
    // Nothing was resolved by name, so nothing was read and nothing was written.
    expect(readFiles).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  it("refuses a change that belongs to another project", async () => {
    raw.prepare("UPDATE changes SET project_id = ? WHERE id = ?").run("prj_someoneelse", CHANGE_ID);
    const readFiles = readsTree(tree());

    const result = await run(MERGE_MESSAGE, { readFiles });

    if (!result.success) throw result.error;
    expect(result.data.aborted).toContain("different project");
    expect(readFiles).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });
});

describe("aborting before the provider is called", () => {
  it("does not deploy a change that was reverted after it was enqueued", async () => {
    // The exact bug this guards: `runPostMergeCheck` auto-reverts, and the
    // queue promises nothing about when the message arrives.
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });
    raw.prepare("UPDATE changes SET status = 'reverted' WHERE id = ?").run(CHANGE_ID);
    const fetch = vercelAccepts();
    const readFiles = readsTree(tree());

    const result = await run(MERGE_MESSAGE, { fetch, readFiles });

    if (!result.success) throw result.error;
    expect(result.data.aborted).toContain("reverted");
    expect(fetch).not.toHaveBeenCalled();
    expect(readFiles).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  it("does not deploy while the project is being deleted", async () => {
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });
    raw
      .prepare(
        "INSERT INTO deletion_jobs (id, kind, target, state, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("del_1", "project", JSON.stringify({ projectId: PROJECT_ID }), "running", T0);
    const fetch = vercelAccepts();

    const result = await run(MERGE_MESSAGE, { fetch });

    if (!result.success) throw result.error;
    expect(result.data.aborted).toContain("deleted");
    expect(fetch).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });
});

describe("ordering and leases", () => {
  it("supersedes an older queued deployment of the same name", async () => {
    // Two merges in quick succession arrive in whatever order the queue
    // chooses; without this the older commit can be the one left in production.
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });
    const older = await insertFixture({ commitSha: OLD_SHA });

    await run();

    const all = rows();
    expect(all).toHaveLength(2);
    const supersededRow = all.find((row) => row.id === older.id);
    expect(supersededRow?.status).toBe("superseded");
    expect(all.find((row) => row.commit_sha === SHA)?.status).toBe("succeeded");
  });

  // The bug this stamping exists to close: `created_at` used to be written when
  // the *message* was processed. Cloudflare Queues promise no ordering and a
  // retry reorders outright, so an older merge delivered second was stamped
  // newer than the merge that beat it — and then published over it.
  it("stamps rows with the merge time, not the time the message was processed", async () => {
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });

    await run({ ...MERGE_MESSAGE, mergedAt: MERGED_AT });

    const row = raw.prepare("SELECT * FROM deployments").get() as unknown as Row & {
      created_at: string;
    };
    expect(row.created_at).toBe(MERGED_AT);
    // The clock still owns everything that really is about this run.
    expect(row.completed_at).toBe(T1_ISO);
  });

  // Compatibility. A `merge` message enqueued by the previous deployment of the
  // Worker carries no `mergedAt` at all, and losing a real deploy over a schema
  // change is worse than losing the ordering guarantee for one message.
  it("still deploys a legacy message that carries no merge time", async () => {
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });
    const fetch = vercelAccepts();

    await run(MERGE_MESSAGE, { fetch });

    const row = raw.prepare("SELECT * FROM deployments").get() as unknown as Row & {
      created_at: string;
    };
    expect(row.status).toBe("succeeded");
    expect(fetch).toHaveBeenCalledTimes(1);
    // Fell back to processing time, which is what the row was stamped with
    // before this field existed.
    expect(row.created_at).toBe(T1_ISO);
  });

  // The half `supersedeOlder` cannot cover: it only touches rows that have not
  // started, so once the newer merge is `succeeded` there is nothing left for it
  // to retire and the late older message would deploy straight over the top.
  it("refuses to publish over a newer commit that already succeeded", async () => {
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });
    const newer = await insertFixture({
      commitSha: NEWER_SHA,
      status: "succeeded",
      now: "2026-09-04T00:30:00.000Z",
    });
    const fetch = vercelAccepts();

    // The older merge, delivered second.
    await run({ ...MERGE_MESSAGE, mergedAt: MERGED_AT }, { fetch });

    const older = rows().find((row) => row.commit_sha === SHA) as Row;
    expect(older.status).toBe("superseded");
    expect(older.reason).toContain(NEWER_SHA.slice(0, 7));
    expect(older.completed_at).not.toBeNull();
    // The newer commit is untouched, and nothing was published over it.
    expect(rows().find((row) => row.id === newer.id)?.status).toBe("succeeded");
    expect(fetch).not.toHaveBeenCalled();
  });

  // A retry is the deliberate exception: it stamps the current time, so an
  // operator re-running an older commit is not refused by the guard above.
  it("lets a retry of an older commit through, because it is the newest intent", async () => {
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });
    await insertFixture({
      commitSha: NEWER_SHA,
      status: "succeeded",
      now: "2026-09-04T00:30:00.000Z",
    });
    // What `POST .../retry` inserts: the same old commit, attempt 2, stamped now.
    const retry = await insertFixture({ attempt: 2, now: T1_ISO });
    const fetch = vercelAccepts();

    await run({ kind: "deployment", projectId: PROJECT_ID, deploymentId: retry.id }, { fetch });

    expect(rows().find((row) => row.id === retry.id)?.status).toBe("succeeded");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // Unlike the `supersedeOlder` bookkeeping, this check is the only thing
  // standing between a reordered message and an older commit going live, so an
  // unreadable answer fails the row rather than assuming the best.
  it("fails the deploy rather than guessing when the ordering check cannot be read", async () => {
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });
    const fetch = vercelAccepts();
    const broken = {
      prepare: (sql: string) => {
        if (sql.includes("status = 'succeeded' AND created_at >")) {
          throw new Error("D1 unavailable");
        }
        return db.prepare(sql);
      },
    } as unknown as D1Database;

    await run({ ...MERGE_MESSAGE, mergedAt: MERGED_AT }, { fetch }, makeEnv({ DB: broken }));

    const row = onlyRow();
    expect(row.status).toBe("failed");
    expect(row.reason).toContain("newer deployment");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reclaims a running deployment whose lease has expired", async () => {
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });
    const { id } = await insertFixture({ changeId: CHANGE_ID });
    // A consumer that died mid-deploy: still `running`, lease long gone.
    raw
      .prepare("UPDATE deployments SET status = 'running', lease_expires_at = ? WHERE id = ?")
      .run("2026-09-04T00:30:00.000Z", id);

    const result = await run({ kind: "deployment", projectId: PROJECT_ID, deploymentId: id });

    if (!result.success) throw result.error;
    expect(result.data.deployments).toHaveLength(1);
    const row = onlyRow();
    expect(row.status).toBe("succeeded");
    expect(row.lease_expires_at).toBeNull();
  });

  it("leaves a pending_approval row alone — it is not claimable", async () => {
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });
    const pending = await insertFixture({ changeId: CHANGE_ID, status: "pending_approval" });
    const fetch = vercelAccepts();

    await run({ kind: "deployment", projectId: PROJECT_ID, deploymentId: pending.id }, { fetch });

    expect(onlyRow().status).toBe("pending_approval");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("containment", () => {
  it("writes a terminal row even when the target throws", async () => {
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });
    // A provider response the target does not expect: reading `ok` throws, and
    // that happens outside the target's own transport try/catch.
    const exploding: DeployFetch = vi.fn(
      async () =>
        ({
          get ok(): boolean {
            throw new Error("kaboom");
          },
        }) as unknown as Response,
    );

    const result = await run(MERGE_MESSAGE, { fetch: exploding });

    expect(result.success).toBe(true);
    const row = onlyRow();
    expect(row.status).toBe("failed");
    expect(row.reason).toContain("kaboom");
    // The row must not be left running with a live lease.
    expect(row.lease_expires_at).toBeNull();
    expect(row.completed_at).not.toBeNull();
    expect(row.duration_ms).not.toBeNull();
  });

  it("keeps secret values out of every persisted reason and log tail", async () => {
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });

    await run(MERGE_MESSAGE, { fetch: vercelRejectsEchoingTheToken() });

    const row = onlyRow();
    expect(row.status).toBe("failed");
    expect(row.reason).toContain("403");
    for (const value of [row.reason, row.log_tail, JSON.stringify(rows())]) {
      expect(value ?? "").not.toContain(VERCEL_TOKEN);
      expect(value ?? "").not.toContain(VERCEL_PROJECT);
    }
  });

  it("redacts a secret that escaped through a thrown error", async () => {
    // The values are captured the moment they resolve, before anything can
    // throw with one in hand, so the `finally` can redact a throw as well as a
    // clean return.
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });
    const leaky: DeployFetch = vi.fn(
      async () =>
        ({
          get ok(): boolean {
            throw new Error(`upstream rejected ${VERCEL_TOKEN}`);
          },
        }) as unknown as Response,
    );

    await run(MERGE_MESSAGE, { fetch: leaky });

    const row = onlyRow();
    expect(row.status).toBe("failed");
    expect(row.reason).not.toContain(VERCEL_TOKEN);
    expect(row.reason).toContain("[redacted]");
  });
});

describe("approval", () => {
  it("creates a pending_approval row and does not run it", async () => {
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });
    const policy = `evaluators:
  - type: diff

deploys:
  - name: production
    target: vercel
    requiresApproval: true
`;
    const fetch = vercelAccepts();

    await run(MERGE_MESSAGE, { readFiles: readsTree(tree(policy)), fetch });

    expect(onlyRow().status).toBe("pending_approval");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the wall-clock deadline that keeps the lease honest", () => {
  // The runner has to give up before `DEFAULT_DEPLOY_LEASE_MS` can expire.
  // Otherwise the lease lapses under a live upload and `claimDeployment` hands
  // the row to a second consumer — the same commit deployed twice.
  it("abandons a provider that never answers, leaving a terminal row", async () => {
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });
    let seen: RequestInit | undefined;
    const hangs: DeployFetch = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init;
          init.signal?.addEventListener("abort", () => reject(new Error("cut off")));
        }),
    );

    // Long enough that the run is certainly inside the provider call when the
    // deadline fires, short enough not to slow the suite down.
    await run(MERGE_MESSAGE, { fetch: hangs, deadlineMs: 200 });

    const row = onlyRow();
    expect(row.status).toBe("failed");
    expect(row.reason).toContain("did not finish");
    // Terminal *and* unlocked: nothing is left for a reclaim to race.
    expect(row.lease_expires_at).toBeNull();
    expect(row.completed_at).not.toBeNull();
    // The upload is genuinely cut off rather than left running behind a
    // resolved race, so it cannot land after the row says it failed.
    expect(seen?.signal?.aborted).toBe(true);
  });

  it("does not disturb a provider that answers in time", async () => {
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });

    await run(MERGE_MESSAGE, { deadlineMs: 60_000 });

    expect(onlyRow().status).toBe("succeeded");
  });
});

describe("every rejected deploys entry keeps its own row", () => {
  // The PRD asks for one persisted `failed` row per rejected entry, each naming
  // its entry and reason — that is the whole point of `sanitizeDeploys`
  // returning rejections instead of dropping them. Two unnamed entries used to
  // collapse into a single row on the unique index, and one reason was lost.
  it("persists one failed row per rejection", async () => {
    const policy = `evaluators:
  - type: diff

deploys:
  - target: vercel
  - target: netlify
`;

    await run(MERGE_MESSAGE, { readFiles: readsTree(tree(policy)) });

    const all = rows();
    expect(all).toHaveLength(2);
    expect(all.every((row) => row.status === "failed")).toBe(true);
    expect(new Set(all.map((row) => row.name)).size).toBe(2);

    const reasons = all.map((row) => row.reason ?? "");
    expect(reasons.some((reason) => reason.includes("deploys[0]"))).toBe(true);
    expect(reasons.some((reason) => reason.includes("deploys[1]"))).toBe(true);
    expect(reasons.some((reason) => reason.includes("netlify"))).toBe(true);
  });

  // The sharper case: a duplicate name is rejected *because* another entry is
  // legitimately using it, so the rejection row and the accepted row want the
  // same (project, name, commit, attempt) key. The rejection must not take it —
  // the accepted deploy would then never be created, and never run.
  it("never takes the row an accepted deploy of the same name needs", async () => {
    await storeSecrets({ VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT });
    const policy = `evaluators:
  - type: diff

deploys:
  - name: production
    target: vercel
  - name: production
    target: vercel
`;
    const fetch = vercelAccepts();

    await run(MERGE_MESSAGE, { readFiles: readsTree(tree(policy)), fetch });

    const all = rows();
    expect(all).toHaveLength(2);

    const accepted = all.find((row) => row.name === "production");
    expect(accepted?.status).toBe("succeeded");
    expect(fetch).toHaveBeenCalledTimes(1);

    const rejected = all.find((row) => row.name !== "production");
    expect(rejected?.status).toBe("failed");
    expect(rejected?.reason).toContain("duplicate deploy name");
  });
});
