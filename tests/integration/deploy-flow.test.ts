/**
 * Post-merge deployments, end to end.
 *
 * This suite deliberately starts one layer above `runDeployMessage`: the unit
 * tests in `tests/deploy-runner.test.ts` drive the runner directly with all
 * three seams injected, which proves the runner's own logic but says nothing
 * about the *wiring*. Everything that has actually gone wrong in this feature
 * lives in the wiring:
 *
 * - **The trigger is the post-merge result, not the `change.merged` event.**
 *   `change.merged` is emitted *before* `runPostMergeCheck` runs, and a failed
 *   check auto-reverts the merge. A deploy hung off that event would publish
 *   the exact commit Stratum had just decided to revert. The reverted-merge
 *   test below runs the real `runPostMergeCheck` against a failing sandbox and
 *   asserts that **no deployment row is created at all** — not a `failed` one,
 *   not a `skipped` one, none.
 * - **The consumer runs the real runner with its production defaults.** So the
 *   messages `enqueueMergeDeploy` produces are fed to `handleDeployQueue`
 *   verbatim, and nothing here passes `DeployRunnerDeps`. The two seams that
 *   would otherwise reach the network — the git remote and the provider — are
 *   replaced at the module and global boundary instead: `readRepoFiles` and the
 *   Artifacts token mint are mocked, and `fetch` is stubbed globally. `Date` is
 *   faked rather than injected for the same reason: `handleDeployQueue` has no
 *   `now` parameter, and a wall-clock-dependent assertion is not worth having.
 * - **Two provider shapes, because they fail differently.** `cloudflare-pages`
 *   is a three-phase upload (manifest session → asset buckets → script PUT)
 *   whose middle phase authenticates with a JWT the provider handed back, and
 *   `vercel` is a single inline POST. A stub that only ever answers one request
 *   would not notice a target that stopped making the other two.
 *
 * Every provider call goes through the stubbed `fetch`; nothing here touches
 * the network, and D1 is real SQLite with the production migrations applied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted above the imports by Vitest. Only the two functions that talk to a
// real git remote are replaced; the rest of the module is passed through
// because `state.ts`, `deletion.ts` and `policy-loader.ts` import from it too.
vi.mock("../../src/storage/git-ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/storage/git-ops")>();
  return {
    ...actual,
    freshRepoToken: vi.fn(),
    readRepoFiles: vi.fn(),
    getCommitParent: vi.fn(),
    revertToCommit: vi.fn(),
  };
});

import type { EvalPolicy } from "../../src/evaluation/types";
import { runPostMergeCheck } from "../../src/merge/post-merge";
import { enqueueMergeDeploy, handleDeployQueue } from "../../src/queue/deploy-queue";
import {
  SUPERSEDED_REASON,
  approveDeployment,
  listDeployments,
} from "../../src/storage/deployments";
import {
  freshRepoToken,
  getCommitParent,
  readRepoFiles,
  revertToCommit,
} from "../../src/storage/git-ops";
import { putSecret } from "../../src/storage/project-secrets";
import { setProject } from "../../src/storage/state";
import type {
  Env,
  Message,
  MessageBatch,
  ProjectEntry,
  Queue,
  SandboxBinding,
} from "../../src/types";
import type { Logger } from "../../src/utils/logger";
import { ok } from "../../src/utils/result";
import { makeFakeKV } from "../helpers/fake-kv";
import { makeSqliteD1 } from "../helpers/sqlite-d1";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

const PROJECT_ID = "prj_deployflow";
const PROJECT_NAME = "site";
const REMOTE = "https://acct.artifacts.cloudflare.net/git/acct/site.git";

const CHANGE_A = "chg_deployflow_a";
const CHANGE_B = "chg_deployflow_b";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const DEPLOY_SECRET_KEY = "an-integration-test-deploy-secret-key";

/**
 * Deliberately long, distinctive values. A short secret would match by accident
 * all over a JSON payload and make the redaction assertions meaningless.
 */
const SECRETS = {
  CLOUDFLARE_API_TOKEN: "cf-api-token-0123456789abcdef-super-secret",
  CLOUDFLARE_ACCOUNT_ID: "cfacct0123456789abcdef0123456789",
  CLOUDFLARE_WORKERS_SUBDOMAIN: "acme-team",
  VERCEL_TOKEN: "vercel-token-0123456789abcdef-super-secret",
  VERCEL_PROJECT_ID: "prj_vercel_0123456789abcdef",
} as const;

const SECRET_VALUES = Object.values(SECRETS);

/**
 * The subset that must never appear anywhere at all.
 *
 * `CLOUDFLARE_WORKERS_SUBDOMAIN` is stored as a project secret but is not a
 * credential — it is the public hostname the site is served from, and
 * `cloudflare-pages` builds the deployment's `url` out of it on purpose. Every
 * other value here is a bearer credential.
 */
const CREDENTIAL_VALUES = SECRET_VALUES.filter(
  (value) => value !== SECRETS.CLOUDFLARE_WORKERS_SUBDOMAIN,
);

/** Frozen clock. Every assertion that touches a timestamp derives from these. */
const T0_ISO = "2026-09-04T09:00:00.000Z";
const T1_ISO = "2026-09-04T09:05:00.000Z";
const T0 = Date.parse(T0_ISO);
const T1 = Date.parse(T1_ISO);

const PROJECT: ProjectEntry = {
  id: PROJECT_ID,
  name: PROJECT_NAME,
  slug: "site",
  namespace: "@acme",
  ownerId: "org_acme",
  // `org`, not `user`: `isTargetDeleting` only reads the `users` table for
  // user-owned projects, and this suite has no user rows.
  ownerType: "org",
  remote: REMOTE,
  createdAt: "2026-09-01T00:00:00.000Z",
};

/** Both targets in one policy, so a single merge exercises both provider shapes. */
const BOTH_TARGETS_POLICY = `evaluators:
  - type: diff

deploys:
  - name: site
    target: cloudflare-pages
    secrets: [CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID]
  - name: production
    target: vercel
    secrets: [VERCEL_TOKEN, VERCEL_PROJECT_ID]
`;

const VERCEL_ONLY_POLICY = `evaluators:
  - type: diff

deploys:
  - name: production
    target: vercel
    secrets: [VERCEL_TOKEN, VERCEL_PROJECT_ID]
`;

const GATED_POLICY = `evaluators:
  - type: diff

deploys:
  - name: production
    target: vercel
    secrets: [VERCEL_TOKEN, VERCEL_PROJECT_ID]
    requiresApproval: true
`;

let db: D1Database;
let raw: ReturnType<typeof makeSqliteD1>["raw"];
let kv: KVNamespace;
let sent: unknown[];
let env: Env;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tree(policy: string): Map<string, Uint8Array> {
  const encoder = new TextEncoder();
  return new Map<string, Uint8Array>([
    ["index.html", encoder.encode("<h1>hello</h1>")],
    ["assets/app.css", encoder.encode("body{margin:0}")],
    [".stratum/policy.yaml", encoder.encode(policy)],
  ]);
}

/** Serve one tree for every ref. */
function servesTree(policy: string): void {
  const files = tree(policy);
  vi.mocked(readRepoFiles).mockImplementation(async () => ok(new Map(files)));
}

/** Serve a different tree per commit, for the two-merge ordering cases. */
function servesTreePerCommit(byRef: Record<string, string>): void {
  vi.mocked(readRepoFiles).mockImplementation(async (_remote, _token, _log, ref) => {
    const policy = ref === undefined ? undefined : byRef[ref];
    if (policy === undefined) throw new Error(`no fixture tree for ref ${String(ref)}`);
    return ok(tree(policy));
  });
}

/**
 * `mergedAt` is what `enqueueMergeDeploy` stamps on the message and what every
 * deployment row is then ordered by, so the two-merge cases below set it
 * explicitly rather than leaning on the frozen clock.
 */
function insertChange(id: string, status: string, mergedAt?: string): void {
  raw
    .prepare(
      "INSERT INTO changes (id, project, project_id, workspace, status, created_at, merged_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, PROJECT_NAME, PROJECT_ID, "ws1", status, PROJECT.createdAt, mergedAt ?? null);
}

async function storeSecrets(): Promise<void> {
  for (const [name, value] of Object.entries(SECRETS)) {
    const result = await putSecret(
      db,
      logger,
      { DEPLOY_SECRET_KEY },
      { projectId: PROJECT_ID, name, value, actorId: "usr_admin" },
    );
    if (!result.success) throw result.error;
  }
}

// ---------------------------------------------------------------------------
// The stubbed provider
// ---------------------------------------------------------------------------

interface ProviderCall {
  url: string;
  method: string;
  authorization: string | null;
  /** Present only for the JSON-bodied calls; the multipart phases carry FormData. */
  jsonBody?: string;
}

interface ProviderStub {
  calls: ProviderCall[];
  /** Overrides the Vercel response, for the failure case. */
  vercelResponds: (response: Response) => void;
}

/** The upload token phase 1 hands out; phase 2 must authenticate with it, not the API token. */
const CF_UPLOAD_JWT = "cf-upload-jwt-phase-one";
const CF_COMPLETION_JWT = "cf-completion-jwt-phase-two";
const CF_WORKER_ID = "worker_abc123";
const VERCEL_DEPLOYMENT_ID = "dpl_abc123";
const VERCEL_HOST = "site-abc123.vercel.app";

function stubProvider(): ProviderStub {
  const calls: ProviderCall[] = [];
  let vercelResponse: Response | null = null;

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body;
    const call: ProviderCall = {
      url,
      method,
      authorization: new Headers(init?.headers ?? {}).get("authorization"),
    };
    if (typeof body === "string") call.jsonBody = body;
    calls.push(call);

    // Cloudflare phase 1: register the manifest, ask for every hash back so
    // phase 2 actually has to upload something.
    if (url.includes("/assets-upload-session")) {
      const manifest = JSON.parse(call.jsonBody ?? "{}").manifest as Record<
        string,
        { hash: string }
      >;
      const hashes = Object.values(manifest).map((entry) => entry.hash);
      return json({ success: true, result: { jwt: CF_UPLOAD_JWT, buckets: [hashes] } });
    }

    // Cloudflare phase 2: the bucket upload that completes the manifest.
    if (url.includes("/workers/assets/upload")) {
      return json({ success: true, result: { jwt: CF_COMPLETION_JWT } });
    }

    // Cloudflare phase 3: the script PUT that publishes the assets.
    if (url.includes("/workers/scripts/")) {
      return json({ success: true, result: { id: CF_WORKER_ID } });
    }

    if (url.startsWith("https://api.vercel.com/v13/deployments")) {
      return (
        vercelResponse ?? json({ id: VERCEL_DEPLOYMENT_ID, url: VERCEL_HOST, readyState: "QUEUED" })
      );
    }

    throw new Error(`the deploy path made an unexpected request: ${method} ${url}`);
  };

  vi.stubGlobal("fetch", vi.fn(handler));
  return {
    calls,
    vercelResponds: (response: Response) => {
      vercelResponse = response;
    },
  };
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

interface DrainResult {
  acked: number;
  retried: number;
}

/**
 * Hand everything `enqueueMergeDeploy` (or a test) has put on the queue to the
 * real consumer, exactly as the queue would.
 *
 * @param order - Delivery order. Cloudflare Queues promise none, and a retry
 *   reorders outright, so `"reversed"` is a routine delivery and not a
 *   contrived one.
 */
async function drainQueue(order: "sent" | "reversed" = "sent"): Promise<DrainResult> {
  const bodies = sent.splice(0, sent.length);
  if (order === "reversed") bodies.reverse();
  const ack = vi.fn();
  const retry = vi.fn();
  const messages = bodies.map(
    (body, index) =>
      ({
        id: `msg_${index}`,
        timestamp: new Date(),
        body,
        attempts: 1,
        ack,
        retry,
      }) as unknown as Message<unknown>,
  );

  await handleDeployQueue(
    {
      queue: "stratum-deploys",
      messages,
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch<unknown>,
    env,
  );

  return { acked: ack.mock.calls.length, retried: retry.mock.calls.length };
}

/** Merge one change: what `src/routes/changes.ts` does once the post-merge check has answered. */
async function mergeAndEnqueue(
  changeId: string,
  commitSha: string,
  postMergeStatus: "skipped" | "passed" | "failed" | "reverted",
): Promise<void> {
  await enqueueMergeDeploy(env, logger, {
    projectId: PROJECT_ID,
    changeId,
    commitSha,
    postMergeStatus,
  });
}

// ---------------------------------------------------------------------------
// Reading back what landed
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  name: string;
  target: string;
  status: string;
  reason: string | null;
  url: string | null;
  log_tail: string | null;
  commit_sha: string;
  change_id: string | null;
  approved_by: string | null;
  lease_expires_at: string | null;
  completed_at: string | null;
}

/**
 * Ordered by `name`, not by `created_at`.
 *
 * Two deploys fanned out from one merge are stamped from the same `Date.now()`
 * — certainly here, where the clock is frozen, and in production too when both
 * inserts land in the same millisecond — so `created_at` does not order
 * siblings and the row id (random hex) would decide. Sorting by name keeps the
 * assertions below about *what* landed rather than about which id sorted first.
 */
function rows(): Row[] {
  const all = raw.prepare("SELECT * FROM deployments").all() as unknown as Row[];
  return [...all].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function rowNamed(name: string): Row {
  const matching = rows().filter((row) => row.name === name);
  expect(matching).toHaveLength(1);
  return matching[0] as Row;
}

/**
 * The containment assertion this feature exists to keep true: nothing a
 * provider said, and nothing the runner wrote, may carry a credential into a
 * column the UI renders.
 */
function expectNoSecretsPersisted(): void {
  for (const row of rows()) {
    for (const value of SECRET_VALUES) {
      expect(row.reason ?? "").not.toContain(value);
      expect(row.log_tail ?? "").not.toContain(value);
    }
    for (const value of CREDENTIAL_VALUES) {
      expect(row.url ?? "").not.toContain(value);
    }
  }
}

// ---------------------------------------------------------------------------

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  // Only `Date` is faked: the runner and the storage layer stamp every row from
  // `Date.now()`, and faking timers wholesale would stall the awaits.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);

  const made = makeSqliteD1();
  db = made.db;
  raw = made.raw;
  kv = makeFakeKV();
  sent = [];

  vi.mocked(freshRepoToken).mockResolvedValue(ok("artifacts-repo-token"));
  servesTree(BOTH_TARGETS_POLICY);

  const stored = await setProject(kv, PROJECT, logger);
  if (!stored.success) throw stored.error;

  insertChange(CHANGE_A, "merged");
  insertChange(CHANGE_B, "merged");

  env = {
    DB: db,
    STATE: kv,
    ARTIFACTS: {} as unknown,
    DEPLOY_SECRET_KEY,
    DEPLOY_QUEUE: {
      send: async (body: unknown) => {
        sent.push(body);
      },
    } as unknown as Queue,
  } as unknown as Env;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 9.1 — the full path
// ---------------------------------------------------------------------------

describe("a clean merge deploys through the queue", () => {
  it("carries a merge from enqueue to a succeeded row on both provider shapes", async () => {
    await storeSecrets();
    const provider = stubProvider();

    await mergeAndEnqueue(CHANGE_A, SHA_A, "skipped");

    // The trigger produced exactly one message; it names the commit that merged
    // — not a branch the runner would have to resolve later — and the time the
    // merge happened, which is what the row is ordered by.
    expect(sent).toEqual([
      {
        kind: "merge",
        projectId: PROJECT_ID,
        changeId: CHANGE_A,
        commitSha: SHA_A,
        mergedAt: T0_ISO,
      },
    ]);

    const drained = await drainQueue();
    expect(drained).toEqual({ acked: 1, retried: 0 });

    // One row per declared deploy, both terminal, both holding no lease.
    expect(rows().map((row) => [row.name, row.status])).toEqual([
      ["production", "succeeded"],
      ["site", "succeeded"],
    ]);
    for (const row of rows()) {
      expect(row.lease_expires_at).toBeNull();
      expect(row.completed_at).not.toBeNull();
      expect(row.commit_sha).toBe(SHA_A);
      expect(row.change_id).toBe(CHANGE_A);
    }

    // Cloudflare's three phases each happened, in order, and the middle one
    // authenticated with the JWT phase 1 returned rather than the API token.
    const cloudflare = provider.calls.filter((call) =>
      call.url.startsWith("https://api.cloudflare.com/"),
    );
    expect(cloudflare.map((call) => call.method)).toEqual(["POST", "POST", "PUT"]);
    expect(cloudflare[0]?.url).toContain(
      `/accounts/${SECRETS.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/site/assets-upload-session`,
    );
    expect(cloudflare[0]?.authorization).toBe(`Bearer ${SECRETS.CLOUDFLARE_API_TOKEN}`);
    expect(cloudflare[1]?.url).toContain("/workers/assets/upload?base64=true");
    expect(cloudflare[1]?.authorization).toBe(`Bearer ${CF_UPLOAD_JWT}`);
    expect(cloudflare[2]?.authorization).toBe(`Bearer ${SECRETS.CLOUDFLARE_API_TOKEN}`);

    // Vercel is a single inline POST carrying the whole tree.
    const vercel = provider.calls.filter((call) => call.url.startsWith("https://api.vercel.com/"));
    expect(vercel).toHaveLength(1);
    expect(vercel[0]?.authorization).toBe(`Bearer ${SECRETS.VERCEL_TOKEN}`);
    const vercelBody = JSON.parse(vercel[0]?.jsonBody ?? "{}");
    expect(vercelBody.project).toBe(SECRETS.VERCEL_PROJECT_ID);
    expect(vercelBody.target).toBe("production");
    expect(vercelBody.gitMetadata.commitSha).toBe(SHA_A);
    expect(vercelBody.files.map((file: { file: string }) => file.file).sort()).toEqual([
      ".stratum/policy.yaml",
      "assets/app.css",
      "index.html",
    ]);

    // The optional secret is what produced the URL, so a row with it proves the
    // optional half of the secret set was resolved too.
    expect(rowNamed("site").url).toBe(
      `https://site.${SECRETS.CLOUDFLARE_WORKERS_SUBDOMAIN}.workers.dev`,
    );
    expect(rowNamed("production").url).toBe(`https://${VERCEL_HOST}`);
    // Vercel builds asynchronously; the row must not claim more than the
    // provider promised.
    expect(rowNamed("production").reason).toContain("provider state at hand-off: QUEUED");
    expect(rowNamed("production").reason).toContain(VERCEL_DEPLOYMENT_ID);

    expectNoSecretsPersisted();

    // The same rows through the storage layer the API reads them with.
    const listed = await listDeployments(db, logger, { projectId: PROJECT_ID });
    expect(listed.success).toBe(true);
    if (listed.success) {
      expect(listed.data.map((deployment) => deployment.status)).toEqual([
        "succeeded",
        "succeeded",
      ]);
    }
  });

  it("keeps a provider error that echoes the token out of the persisted row", async () => {
    await storeSecrets();
    const provider = stubProvider();
    provider.vercelResponds(
      new Response(
        JSON.stringify({
          error: {
            code: "forbidden",
            message: `token ${SECRETS.VERCEL_TOKEN} may not deploy ${SECRETS.VERCEL_PROJECT_ID}`,
          },
        }),
        { status: 403 },
      ),
    );
    servesTree(VERCEL_ONLY_POLICY);

    await mergeAndEnqueue(CHANGE_A, SHA_A, "passed");
    // A `failed` deployment is a result, not a delivery failure: the message is
    // acked, not retried, or the operator's fix would race the retry budget.
    expect(await drainQueue()).toEqual({ acked: 1, retried: 0 });

    const row = rowNamed("production");
    expect(row.status).toBe("failed");
    expect(row.reason).toContain("Vercel returned HTTP 403");
    expect(row.reason).toContain("[redacted]");
    expect(row.log_tail).toContain("[redacted]");
    expectNoSecretsPersisted();
  });
});

// ---------------------------------------------------------------------------
// 9.2 — the reverted merge
// ---------------------------------------------------------------------------

describe("a merge the post-merge check reverts", () => {
  /** A sandbox whose smoke command fails, which is what makes the check revert. */
  const failingSandbox = {
    create: async () => ({
      writeFile: async () => {},
      run: async () => ({ exitCode: 1, stdout: "smoke: 1 failing\n", stderr: "" }),
      destroy: async () => {},
    }),
  } as unknown as SandboxBinding;

  const POST_MERGE_POLICY: EvalPolicy = {
    evaluators: [],
    merge: { postMergeCommand: "./smoke.sh" },
  };

  it("creates no deployment at all", async () => {
    await storeSecrets();
    const provider = stubProvider();
    vi.mocked(getCommitParent).mockResolvedValue(ok("c".repeat(40)));
    vi.mocked(revertToCommit).mockResolvedValue(ok("d".repeat(40)));

    const postMerge = await runPostMergeCheck(
      { ...env, SANDBOX: failingSandbox } as Env,
      PROJECT,
      { changeId: CHANGE_A, mergeCommit: SHA_A, policy: POST_MERGE_POLICY },
      logger,
    );

    expect(postMerge.status).toBe("reverted");
    // The check reverted the merge and said so on the change itself.
    const change = raw.prepare("SELECT status FROM changes WHERE id = ?").get(CHANGE_A) as {
      status: string;
    };
    expect(change.status).toBe("reverted");

    await mergeAndEnqueue(CHANGE_A, SHA_A, postMerge.status);

    // The gate is the whole point: nothing is enqueued, so nothing runs, so no
    // row exists. Not a `failed` row, not a `skipped` one — none.
    expect(sent).toEqual([]);
    await drainQueue();
    expect(rows()).toEqual([]);
    expect(provider.calls).toEqual([]);
  });

  it("still refuses if a message for the reverted change reaches the consumer anyway", async () => {
    await storeSecrets();
    const provider = stubProvider();
    // The state an event-driven trigger would have left: `change.merged` is
    // emitted before the check, so a deploy wired to it would already have a
    // message in flight by the time the revert lands.
    raw.prepare("UPDATE changes SET status = 'reverted' WHERE id = ?").run(CHANGE_A);
    sent.push({ kind: "merge", projectId: PROJECT_ID, changeId: CHANGE_A, commitSha: SHA_A });

    // Acked, not retried: no redelivery can make a reverted change deployable.
    expect(await drainQueue()).toEqual({ acked: 1, retried: 0 });
    expect(rows()).toEqual([]);
    expect(provider.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The approval gate
// ---------------------------------------------------------------------------

describe("an approval-gated deploy", () => {
  it("lands pending_approval, runs nothing, and deploys only once approved", async () => {
    await storeSecrets();
    const provider = stubProvider();
    servesTree(GATED_POLICY);

    await mergeAndEnqueue(CHANGE_A, SHA_A, "passed");
    await drainQueue();

    const pending = rowNamed("production");
    expect(pending.status).toBe("pending_approval");
    expect(pending.approved_by).toBeNull();
    expect(provider.calls).toEqual([]);

    const approved = await approveDeployment(db, logger, {
      projectId: PROJECT_ID,
      deploymentId: pending.id,
      approvedBy: "usr_admin",
    });
    expect(approved.success).toBe(true);
    if (!approved.success || !approved.data.approved) throw new Error("approval did not take");

    // What the approve route enqueues: the row, not the merge — re-deriving it
    // from the policy could pick a different set of deploys.
    sent.push({ kind: "deployment", projectId: PROJECT_ID, deploymentId: pending.id });
    expect(await drainQueue()).toEqual({ acked: 1, retried: 0 });

    const done = rowNamed("production");
    expect(done.status).toBe("succeeded");
    expect(done.approved_by).toBe("usr_admin");
    expect(done.url).toBe(`https://${VERCEL_HOST}`);
    expect(provider.calls).toHaveLength(1);
    expectNoSecretsPersisted();
  });
});

// ---------------------------------------------------------------------------
// Ordering under out-of-order delivery
// ---------------------------------------------------------------------------

describe("two merges whose messages arrive out of order", () => {
  /** Stamp the change rows so the merges are unambiguously A-then-B. */
  function mergedAtInOrder(): void {
    raw.prepare("UPDATE changes SET merged_at = ? WHERE id = ?").run(T0_ISO, CHANGE_A);
    raw.prepare("UPDATE changes SET merged_at = ? WHERE id = ?").run(T1_ISO, CHANGE_B);
  }

  /**
   * The regression this whole task exists for.
   *
   * `created_at` used to be stamped when the *message* was processed. Cloudflare
   * Queues promise no ordering and a retry reorders outright, so B delivered
   * first meant B deployed, then A was created with a *later* `created_at`,
   * superseded nothing (B was already terminal, and `supersedeOlder` only
   * touches rows that have not started), and published the older commit over the
   * newer one.
   */
  it("lands the newer commit, not whichever message was delivered last", async () => {
    await storeSecrets();
    const provider = stubProvider();
    servesTreePerCommit({ [SHA_A]: VERCEL_ONLY_POLICY, [SHA_B]: VERCEL_ONLY_POLICY });
    mergedAtInOrder();

    // Merged A then B, and both messages carry the time their merge happened.
    await mergeAndEnqueue(CHANGE_A, SHA_A, "passed");
    vi.setSystemTime(T1);
    await mergeAndEnqueue(CHANGE_B, SHA_B, "passed");
    expect(sent.map((body) => (body as { mergedAt: string }).mergedAt)).toEqual([T0_ISO, T1_ISO]);

    // Delivered B first, A second — which is the whole problem.
    expect(await drainQueue("reversed")).toEqual({ acked: 2, retried: 0 });

    const newer = rows().find((row) => row.commit_sha === SHA_B) as Row;
    const older = rows().find((row) => row.commit_sha === SHA_A) as Row;
    expect(newer.status).toBe("succeeded");
    // Refused *before* the claim, so the older commit never reached a provider.
    expect(older.status).toBe("superseded");
    expect(older.reason).toContain(SUPERSEDED_REASON);
    expect(older.reason).toContain(SHA_B.slice(0, 7));
    expect(older.completed_at).not.toBeNull();

    // One publish, and it was the newer commit.
    const vercel = provider.calls.filter((call) => call.url.startsWith("https://api.vercel.com/"));
    expect(vercel).toHaveLength(1);
    expect(JSON.parse(vercel[0]?.jsonBody ?? "{}").gitMetadata.commitSha).toBe(SHA_B);

    // And the history reads in merge order, not delivery order — the row written
    // second is the one that sorts last.
    const listed = await listDeployments(db, logger, { projectId: PROJECT_ID });
    if (!listed.success) throw listed.error;
    expect(listed.data.map((deployment) => deployment.commitSha)).toEqual([SHA_B, SHA_A]);
  });

  // Compatibility: a message enqueued by the previous deployment of the Worker
  // is still in flight and carries no `mergedAt` at all. Dropping it would lose
  // a real deploy over a schema change.
  it("still deploys a legacy message that carries no merge time", async () => {
    await storeSecrets();
    const provider = stubProvider();
    servesTree(VERCEL_ONLY_POLICY);

    sent.push({ kind: "merge", projectId: PROJECT_ID, changeId: CHANGE_A, commitSha: SHA_A });
    expect(await drainQueue()).toEqual({ acked: 1, retried: 0 });

    const row = rowNamed("production");
    expect(row.status).toBe("succeeded");
    expect(provider.calls).not.toEqual([]);
  });

  // Siblings of one merge are stamped from that merge's timestamp, so they tie
  // on `created_at` and only `name` keeps the page from reshuffling per request.
  it("orders the deploys fanned out from one merge by name", async () => {
    await storeSecrets();
    stubProvider();

    await mergeAndEnqueue(CHANGE_A, SHA_A, "passed");
    await drainQueue();

    const listed = await listDeployments(db, logger, { projectId: PROJECT_ID });
    if (!listed.success) throw listed.error;
    expect(listed.data.map((deployment) => deployment.createdAt)).toEqual([T0_ISO, T0_ISO]);
    expect(listed.data.map((deployment) => deployment.name)).toEqual(["production", "site"]);
  });
});

// ---------------------------------------------------------------------------
// Supersession
// ---------------------------------------------------------------------------

describe("two merges in quick succession", () => {
  it("does not let the older commit be the one that lands", async () => {
    await storeSecrets();
    const provider = stubProvider();
    servesTreePerCommit({ [SHA_A]: GATED_POLICY, [SHA_B]: GATED_POLICY });

    await mergeAndEnqueue(CHANGE_A, SHA_A, "passed");
    await drainQueue();

    vi.setSystemTime(T1);
    await mergeAndEnqueue(CHANGE_B, SHA_B, "passed");
    await drainQueue();

    const older = rows().find((row) => row.commit_sha === SHA_A) as Row;
    const newer = rows().find((row) => row.commit_sha === SHA_B) as Row;
    expect(older.status).toBe("pending_approval");
    expect(newer.status).toBe("pending_approval");

    // Approve and run only the newer commit. Running it must retire the older
    // one, so a later delivery of the older message cannot publish it over the
    // top.
    const approved = await approveDeployment(db, logger, {
      projectId: PROJECT_ID,
      deploymentId: newer.id,
      approvedBy: "usr_admin",
    });
    if (!approved.success || !approved.data.approved) throw new Error("approval did not take");

    sent.push({ kind: "deployment", projectId: PROJECT_ID, deploymentId: newer.id });
    await drainQueue();

    expect(rows().find((row) => row.commit_sha === SHA_B)?.status).toBe("succeeded");
    const retired = rows().find((row) => row.commit_sha === SHA_A) as Row;
    expect(retired.status).toBe("superseded");
    expect(retired.reason).toBe(SUPERSEDED_REASON);
    expect(retired.completed_at).not.toBeNull();

    // Exactly one commit reached the provider, and it was the newer one.
    expect(provider.calls).toHaveLength(1);
    expect(JSON.parse(provider.calls[0]?.jsonBody ?? "{}").gitMetadata.commitSha).toBe(SHA_B);

    // The superseded row can never be claimed afterwards: replaying its message
    // leaves it exactly where it is.
    sent.push({ kind: "deployment", projectId: PROJECT_ID, deploymentId: retired.id });
    await drainQueue();
    expect(rows().find((row) => row.commit_sha === SHA_A)?.status).toBe("superseded");
    expect(provider.calls).toHaveLength(1);
  });
});
