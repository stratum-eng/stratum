/**
 * The deployment storage layer.
 *
 * The assertions that matter are the concurrency ones. `insertDeployment` and
 * `claimDeployment` are the two places a deploy can be run twice, so the tests
 * race them against a real SQLite engine rather than a stub: a duplicate insert
 * must come back as a *distinguishable* "someone else owns this" and not as a
 * database error, and a second claim of the same row must lose.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEPLOY_ATTEMPT_DEADLINE_MS } from "../src/deploy/limits";
import {
  DEFAULT_DEPLOY_LEASE_MS,
  type Deployment,
  approveDeployment,
  claimDeployment,
  completeDeployment,
  findDeploymentById,
  findNewerSucceededDeployment,
  getDeployment,
  insertDeployment,
  listDeployments,
  supersedeOlder,
} from "../src/storage/deployments";
import type { Logger } from "../src/utils/logger";
import { makeSqliteD1, makeThrowingD1 } from "./helpers/sqlite-d1";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

const PROJECT = "prj_aaaaaaaa";
const OTHER_PROJECT = "prj_bbbbbbbb";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const T0 = "2026-09-04T00:00:00.000Z";

let db: D1Database;
let raw: ReturnType<typeof makeSqliteD1>["raw"];

beforeEach(() => {
  const made = makeSqliteD1();
  db = made.db;
  raw = made.raw;
  vi.clearAllMocks();
});

type InsertOverrides = Partial<Parameters<typeof insertDeployment>[2]>;

async function insert(overrides: InsertOverrides = {}): Promise<Deployment> {
  const result = await insertDeployment(db, logger, {
    projectId: PROJECT,
    project: "api",
    changeId: "chg_1",
    commitSha: SHA,
    name: "production",
    target: "vercel",
    requestedByType: "user",
    requestedById: "usr_1",
    now: T0,
    ...overrides,
  });
  if (!result.success) throw result.error;
  if (!result.data.inserted) throw new Error("expected the insert to win");
  return result.data.deployment;
}

function readStatus(id: string): { status: string; lease_expires_at: string | null } {
  const row = raw
    .prepare("SELECT status, lease_expires_at FROM deployments WHERE id = ?")
    .get(id) as { status: string; lease_expires_at: string | null } | undefined;
  if (!row) throw new Error(`no deployment ${id}`);
  return row;
}

describe("insertDeployment", () => {
  it("writes a queued row with every field the caller supplied", async () => {
    const deployment = await insert();

    expect(deployment.status).toBe("queued");
    expect(deployment.attempt).toBe(1);
    expect(deployment.projectId).toBe(PROJECT);
    expect(deployment.project).toBe("api");
    expect(deployment.changeId).toBe("chg_1");
    expect(deployment.commitSha).toBe(SHA);
    expect(deployment.target).toBe("vercel");
    expect(deployment.requestedByType).toBe("user");
    expect(deployment.requestedById).toBe("usr_1");
    expect(deployment.createdAt).toBe(T0);
    expect(deployment.completedAt).toBeUndefined();

    const stored = await getDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
    });
    expect(stored.success && stored.data).toEqual(deployment);
  });

  // `created_at` is merge order, not write order — the queue promises neither,
  // and every ordering decision in this module reads that column.
  it("stamps created_at from the merge time while the clock owns completed_at", async () => {
    const deployment = await insert({
      createdAt: "2026-09-04T00:00:00.000Z",
      now: "2026-09-04T09:00:00.000Z",
      status: "failed",
    });

    expect(deployment.createdAt).toBe("2026-09-04T00:00:00.000Z");
    expect(deployment.completedAt).toBe("2026-09-04T09:00:00.000Z");
    const row = raw
      .prepare("SELECT created_at, completed_at FROM deployments WHERE id = ?")
      .get(deployment.id) as { created_at: string; completed_at: string };
    expect(row.created_at).toBe("2026-09-04T00:00:00.000Z");
    expect(row.completed_at).toBe("2026-09-04T09:00:00.000Z");
  });

  // A retry supplies no merge time on purpose: re-running an old commit is an
  // assertion that it is the newest intent, and the guard reads this column.
  it("falls back to the clock when no merge time is supplied", async () => {
    const deployment = await insert({ now: "2026-09-04T09:00:00.000Z" });
    expect(deployment.createdAt).toBe("2026-09-04T09:00:00.000Z");
  });

  it("rejects a non-ISO merge time", async () => {
    const result = await insertDeployment(db, logger, {
      projectId: PROJECT,
      project: "api",
      commitSha: SHA,
      name: "production",
      target: "vercel",
      requestedByType: "system",
      createdAt: "2026-09-04 00:00:00",
    });
    expect(result.success).toBe(false);
  });

  it("omits change_id for a deploy not traceable to a change", async () => {
    const deployment = await insert({ changeId: null });
    expect(deployment.changeId).toBeUndefined();
  });

  it("stamps completed_at when the row is born terminal", async () => {
    // A rejected `deploys:` entry is persisted as a failed row rather than
    // dropped, and such a row never runs, so it is complete on arrival.
    const deployment = await insert({
      status: "failed",
      reason: "unknown target 'netlify'",
    });
    expect(deployment.completedAt).toBe(T0);
    expect(deployment.reason).toBe("unknown target 'netlify'");
  });

  it("reports a duplicate attempt as a lost race, not an error", async () => {
    await insert();

    const second = await insertDeployment(db, logger, {
      projectId: PROJECT,
      project: "api",
      commitSha: SHA,
      name: "production",
      target: "vercel",
      requestedByType: "system",
      now: T0,
    });

    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data.inserted).toBe(false);
    if (second.data.inserted) return;
    expect(second.data.existing?.commitSha).toBe(SHA);
    expect(second.data.existing?.requestedByType).toBe("user");

    const count = raw.prepare("SELECT COUNT(*) AS n FROM deployments").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("distinguishes a genuine database failure from a duplicate", async () => {
    const result = await insertDeployment(makeThrowingD1("disk is on fire"), logger, {
      projectId: PROJECT,
      project: "api",
      commitSha: SHA,
      name: "production",
      target: "vercel",
      requestedByType: "system",
      now: T0,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("DATABASE_ERROR");
    expect(logger.error).toHaveBeenCalled();
  });

  it("admits attempt + 1 for the same commit", async () => {
    await insert();
    const retry = await insert({ attempt: 2 });
    expect(retry.attempt).toBe(2);

    const count = raw.prepare("SELECT COUNT(*) AS n FROM deployments").get() as { n: number };
    expect(count.n).toBe(2);
  });

  it("admits the same name and commit in another project", async () => {
    await insert();
    const other = await insert({ projectId: OTHER_PROJECT });
    expect(other.projectId).toBe(OTHER_PROJECT);
  });

  it("rejects a non-ISO timestamp rather than corrupting range comparisons", async () => {
    const result = await insertDeployment(db, logger, {
      projectId: PROJECT,
      project: "api",
      commitSha: SHA,
      name: "production",
      target: "vercel",
      requestedByType: "system",
      now: "2026-09-04 00:00:00",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("claimDeployment", () => {
  it("succeeds exactly once for two consumers racing the same row", async () => {
    const deployment = await insert();

    const first = await claimDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
      now: T0,
    });
    const second = await claimDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
      now: T0,
    });

    expect(first.success && first.data.claimed).toBe(true);
    expect(second.success && second.data.claimed).toBe(false);
    if (second.success && !second.data.claimed) {
      expect(second.data.reason).toBe("not_claimable");
    }
  });

  it("marks the row running with a lease and a start time", async () => {
    const deployment = await insert();
    const result = await claimDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
      leaseMs: 60_000,
      now: T0,
    });

    expect(result.success).toBe(true);
    if (!result.success || !result.data.claimed) throw new Error("expected a claim");
    expect(result.data.deployment.status).toBe("running");
    expect(result.data.deployment.startedAt).toBe(T0);
    expect(result.data.deployment.leaseExpiresAt).toBe("2026-09-04T00:01:00.000Z");
  });

  it("defaults the lease to DEFAULT_DEPLOY_LEASE_MS", async () => {
    const deployment = await insert();
    const result = await claimDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
      now: T0,
    });
    if (!result.success || !result.data.claimed) throw new Error("expected a claim");
    expect(result.data.deployment.leaseExpiresAt).toBe(
      new Date(Date.parse(T0) + DEFAULT_DEPLOY_LEASE_MS).toISOString(),
    );
  });

  it("reclaims a running row whose lease has passed", async () => {
    const deployment = await insert();
    const claimed = await claimDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
      leaseMs: 60_000,
      now: T0,
    });
    expect(claimed.success && claimed.data.claimed).toBe(true);

    const afterExpiry = "2026-09-04T00:02:00.000Z";
    const reclaimed = await claimDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
      leaseMs: 60_000,
      now: afterExpiry,
    });

    expect(reclaimed.success).toBe(true);
    if (!reclaimed.success || !reclaimed.data.claimed) throw new Error("expected a reclaim");
    expect(reclaimed.data.deployment.leaseExpiresAt).toBe("2026-09-04T00:03:00.000Z");
    // The original start time survives: the deployment did not restart, it changed hands.
    expect(reclaimed.data.deployment.startedAt).toBe(T0);
  });

  it("refuses a running row whose lease is still live", async () => {
    const deployment = await insert();
    await claimDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
      leaseMs: 60_000,
      now: T0,
    });

    const stillLive = await claimDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
      now: "2026-09-04T00:00:59.000Z",
    });

    expect(stillLive.success).toBe(true);
    if (!stillLive.success || stillLive.data.claimed) throw new Error("expected no claim");
    expect(stillLive.data.reason).toBe("not_claimable");
    expect(readStatus(deployment.id).lease_expires_at).toBe("2026-09-04T00:01:00.000Z");
  });

  // The double-deploy this lease exists to prevent. A runner gives up at
  // DEPLOY_ATTEMPT_DEADLINE_MS, so the whole window in which one can still be
  // uploading has to be a window in which nobody else can claim its row.
  it("cannot be reclaimed at any point where a runner may still hold it", async () => {
    const deployment = await insert();
    const claimed = await claimDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
      now: T0,
    });
    if (!claimed.success || !claimed.data.claimed) throw new Error("expected a claim");

    const start = Date.parse(T0);
    for (const elapsed of [0, 1, DEPLOY_ATTEMPT_DEADLINE_MS - 1, DEPLOY_ATTEMPT_DEADLINE_MS]) {
      const attempt = await claimDeployment(db, logger, {
        projectId: PROJECT,
        deploymentId: deployment.id,
        now: new Date(start + elapsed).toISOString(),
      });
      expect(attempt.success).toBe(true);
      if (!attempt.success || attempt.data.claimed) {
        throw new Error(`reclaimed a live deployment ${elapsed}ms in`);
      }
      expect(attempt.data.reason).toBe("not_claimable");
    }

    // …and the lease does eventually release, or a dead runner would strand it.
    const afterLease = await claimDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
      now: new Date(start + DEFAULT_DEPLOY_LEASE_MS).toISOString(),
    });
    expect(afterLease.success && afterLease.data.claimed).toBe(true);
  });

  it("refuses a pending_approval row", async () => {
    const deployment = await insert({ status: "pending_approval" });
    const result = await claimDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
      now: T0,
    });
    if (!result.success || result.data.claimed) throw new Error("expected no claim");
    expect(result.data.reason).toBe("not_claimable");
    expect(readStatus(deployment.id).status).toBe("pending_approval");
  });

  it("refuses a terminal row", async () => {
    const deployment = await insert({ status: "succeeded" });
    const result = await claimDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
      now: T0,
    });
    if (!result.success || result.data.claimed) throw new Error("expected no claim");
    expect(result.data.reason).toBe("not_claimable");
  });

  it("cannot claim a deployment belonging to another project", async () => {
    const deployment = await insert();
    const result = await claimDeployment(db, logger, {
      projectId: OTHER_PROJECT,
      deploymentId: deployment.id,
      now: T0,
    });
    if (!result.success || result.data.claimed) throw new Error("expected no claim");
    expect(result.data.reason).toBe("not_found");
    expect(readStatus(deployment.id).status).toBe("queued");
  });

  it("returns a database error rather than throwing", async () => {
    const result = await claimDeployment(makeThrowingD1(), logger, {
      projectId: PROJECT,
      deploymentId: "dep_missing",
      now: T0,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("DATABASE_ERROR");
  });
});

describe("completeDeployment", () => {
  it("writes the terminal status, its detail, and releases the lease", async () => {
    const deployment = await insert();
    await claimDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
      now: T0,
    });

    const written = await completeDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
      status: "succeeded",
      url: "https://api.example.com",
      durationMs: 4200,
      completedAt: "2026-09-04T00:00:05.000Z",
    });
    expect(written.success && written.data).toBe(true);

    const stored = await getDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
    });
    if (!stored.success || !stored.data) throw new Error("expected the deployment");
    expect(stored.data.status).toBe("succeeded");
    expect(stored.data.url).toBe("https://api.example.com");
    expect(stored.data.durationMs).toBe(4200);
    expect(stored.data.completedAt).toBe("2026-09-04T00:00:05.000Z");
    expect(stored.data.leaseExpiresAt).toBeUndefined();
  });

  it("records a failure with its reason and log tail", async () => {
    const deployment = await insert();
    await completeDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
      status: "failed",
      reason: "missing secret VERCEL_TOKEN",
      logTail: "401 Unauthorized",
      completedAt: T0,
    });

    const stored = await getDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
    });
    if (!stored.success || !stored.data) throw new Error("expected the deployment");
    expect(stored.data.status).toBe("failed");
    expect(stored.data.reason).toBe("missing secret VERCEL_TOKEN");
    expect(stored.data.logTail).toBe("401 Unauthorized");
  });

  it("will not overwrite a row that is already terminal", async () => {
    const deployment = await insert();
    await completeDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
      status: "succeeded",
      completedAt: T0,
    });

    // The consumer that lost its lease mid-deploy must not clobber the winner.
    const late = await completeDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
      status: "failed",
      reason: "lease expired",
      completedAt: "2026-09-04T00:10:00.000Z",
    });

    expect(late.success && late.data).toBe(false);
    expect(readStatus(deployment.id).status).toBe("succeeded");
  });

  it("will not complete a deployment in another project", async () => {
    const deployment = await insert();
    const result = await completeDeployment(db, logger, {
      projectId: OTHER_PROJECT,
      deploymentId: deployment.id,
      status: "failed",
      completedAt: T0,
    });
    expect(result.success && result.data).toBe(false);
    expect(readStatus(deployment.id).status).toBe("queued");
  });
});

describe("supersedeOlder", () => {
  const T1 = "2026-09-04T00:01:00.000Z";
  const T2 = "2026-09-04T00:02:00.000Z";

  it("supersedes only older queued and pending_approval rows of the same name", async () => {
    const olderQueued = await insert({ commitSha: SHA, now: T0 });
    const olderPending = await insert({
      commitSha: OTHER_SHA,
      now: T0,
      status: "pending_approval",
    });
    const olderRunning = await insert({ commitSha: "c".repeat(40), now: T0, status: "running" });
    const olderDone = await insert({ commitSha: "d".repeat(40), now: T0, status: "succeeded" });
    const otherName = await insert({ commitSha: SHA, name: "staging", now: T0 });
    const otherProject = await insert({ projectId: OTHER_PROJECT, commitSha: SHA, now: T0 });
    const newer = await insert({ commitSha: "e".repeat(40), now: T2 });

    const keeper = await insert({ commitSha: "f".repeat(40), now: T1 });

    const result = await supersedeOlder(db, logger, {
      projectId: PROJECT,
      name: "production",
      keepDeploymentId: keeper.id,
      createdAt: keeper.createdAt,
      now: T1,
    });

    expect(result.success && result.data).toBe(2);
    expect(readStatus(olderQueued.id).status).toBe("superseded");
    expect(readStatus(olderPending.id).status).toBe("superseded");
    expect(readStatus(olderRunning.id).status).toBe("running");
    expect(readStatus(olderDone.id).status).toBe("succeeded");
    expect(readStatus(otherName.id).status).toBe("queued");
    expect(readStatus(otherProject.id).status).toBe("queued");
    expect(readStatus(newer.id).status).toBe("queued");
    expect(readStatus(keeper.id).status).toBe("queued");
  });

  it("stamps a reason and a completion time on each superseded row", async () => {
    const older = await insert({ now: T0 });
    const keeper = await insert({ commitSha: OTHER_SHA, now: T1 });

    await supersedeOlder(db, logger, {
      projectId: PROJECT,
      name: "production",
      keepDeploymentId: keeper.id,
      createdAt: keeper.createdAt,
      now: T1,
    });

    const stored = await getDeployment(db, logger, { projectId: PROJECT, deploymentId: older.id });
    if (!stored.success || !stored.data) throw new Error("expected the deployment");
    expect(stored.data.reason).toMatch(/superseded/i);
    expect(stored.data.completedAt).toBe(T1);
  });

  it("supersedes nothing when the keeper is the only row", async () => {
    const keeper = await insert({ now: T1 });
    const result = await supersedeOlder(db, logger, {
      projectId: PROJECT,
      name: "production",
      keepDeploymentId: keeper.id,
      createdAt: keeper.createdAt,
      now: T1,
    });
    expect(result.success && result.data).toBe(0);
  });

  it("returns a database error rather than throwing", async () => {
    const result = await supersedeOlder(makeThrowingD1(), logger, {
      projectId: PROJECT,
      name: "production",
      keepDeploymentId: "dep_x",
      createdAt: T0,
      now: T0,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("DATABASE_ERROR");
  });
});

describe("findNewerSucceededDeployment", () => {
  const later = "2026-09-04T00:10:00.000Z";

  async function find(deployment: Deployment) {
    const result = await findNewerSucceededDeployment(db, logger, {
      projectId: PROJECT,
      name: deployment.name,
      createdAt: deployment.createdAt,
      excludeDeploymentId: deployment.id,
    });
    if (!result.success) throw result.error;
    return result.data;
  }

  // The case `supersedeOlder` cannot reach: by the time the older message is
  // delivered the newer deploy is already terminal, so nothing retires it and
  // the older commit would publish over the top.
  it("finds a newer succeeded deployment of the same name", async () => {
    const newer = await insert({ commitSha: OTHER_SHA, status: "succeeded", now: later });
    const older = await insert({ commitSha: SHA, now: T0 });

    expect((await find(older))?.id).toBe(newer.id);
  });

  it("ignores a newer deployment that has not succeeded", async () => {
    await insert({ commitSha: OTHER_SHA, status: "failed", now: later });
    await insert({ commitSha: "c".repeat(40), status: "running", now: later });
    const older = await insert({ commitSha: SHA, now: T0 });

    expect(await find(older)).toBeNull();
  });

  it("ignores an older succeeded deployment, which is what this one replaces", async () => {
    await insert({ commitSha: OTHER_SHA, status: "succeeded", now: T0 });
    const newer = await insert({ commitSha: SHA, now: later });

    expect(await find(newer)).toBeNull();
  });

  // Siblings of one merge share a timestamp but never a name, and a retry can
  // land in the same millisecond as the row it retries; refusing on equality
  // would make that retry unrunnable for nothing.
  it("ignores a deployment stamped at the same instant", async () => {
    await insert({ commitSha: OTHER_SHA, status: "succeeded", now: T0 });
    const same = await insert({ commitSha: SHA, now: T0 });

    expect(await find(same)).toBeNull();
  });

  it("ignores another deploy name and another project", async () => {
    await insert({ name: "staging", status: "succeeded", now: later });
    await insert({ projectId: OTHER_PROJECT, status: "succeeded", now: later });
    const older = await insert({ commitSha: SHA, now: T0 });

    expect(await find(older)).toBeNull();
  });

  it("never counts the deployment as its own superseder", async () => {
    const only = await insert({ status: "succeeded", now: T0 });
    const result = await findNewerSucceededDeployment(db, logger, {
      projectId: PROJECT,
      name: only.name,
      createdAt: "2025-01-01T00:00:00.000Z",
      excludeDeploymentId: only.id,
    });
    if (!result.success) throw result.error;
    expect(result.data).toBeNull();
  });

  it("rejects a non-ISO timestamp", async () => {
    const result = await findNewerSucceededDeployment(db, logger, {
      projectId: PROJECT,
      name: "production",
      createdAt: "2026-09-04 00:00:00",
      excludeDeploymentId: "dep_1",
    });
    expect(result.success).toBe(false);
  });

  it("returns a database error rather than throwing", async () => {
    const result = await findNewerSucceededDeployment(makeThrowingD1(), logger, {
      projectId: PROJECT,
      name: "production",
      createdAt: T0,
      excludeDeploymentId: "dep_1",
    });
    expect(result.success).toBe(false);
  });
});

describe("listDeployments", () => {
  it("returns a project's deployments newest first", async () => {
    const oldest = await insert({ commitSha: SHA, now: T0 });
    const middle = await insert({ commitSha: OTHER_SHA, now: "2026-09-04T00:01:00.000Z" });
    const newest = await insert({ commitSha: "c".repeat(40), now: "2026-09-04T00:02:00.000Z" });

    const result = await listDeployments(db, logger, { projectId: PROJECT });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.map((d) => d.id)).toEqual([newest.id, middle.id, oldest.id]);
  });

  // Deploys fanned out from one merge are stamped from that merge's timestamp,
  // so they always tie on `created_at`. Without `name` behind it a random hex id
  // decided the order and the page rendered differently on each request.
  it("orders siblings of one merge by name, not by their random ids", async () => {
    const siblings = ["staging", "production", "site"];
    for (const name of siblings) await insert({ name, now: T0 });

    const result = await listDeployments(db, logger, { projectId: PROJECT });
    if (!result.success) throw result.error;
    expect(result.data.map((d) => d.name)).toEqual(["production", "site", "staging"]);
  });

  it("still orders by merge time before it falls back to the name", async () => {
    await insert({ name: "alpha", now: T0 });
    await insert({ name: "zulu", now: "2026-09-04T00:05:00.000Z" });

    const result = await listDeployments(db, logger, { projectId: PROJECT });
    if (!result.success) throw result.error;
    expect(result.data.map((d) => d.name)).toEqual(["zulu", "alpha"]);
  });

  it("never returns another project's deployments", async () => {
    await insert({ projectId: OTHER_PROJECT });
    const mine = await insert();

    const result = await listDeployments(db, logger, { projectId: PROJECT });
    if (!result.success) throw result.error;
    expect(result.data.map((d) => d.id)).toEqual([mine.id]);
  });

  it("filters by deploy name and by status", async () => {
    const production = await insert({ name: "production" });
    const staging = await insert({ name: "staging", status: "failed" });

    const byName = await listDeployments(db, logger, { projectId: PROJECT, name: "staging" });
    if (!byName.success) throw byName.error;
    expect(byName.data.map((d) => d.id)).toEqual([staging.id]);

    const byStatus = await listDeployments(db, logger, { projectId: PROJECT, status: "queued" });
    if (!byStatus.success) throw byStatus.error;
    expect(byStatus.data.map((d) => d.id)).toEqual([production.id]);
  });

  it("pages with limit and offset", async () => {
    const first = await insert({ commitSha: SHA, now: "2026-09-04T00:02:00.000Z" });
    const second = await insert({ commitSha: OTHER_SHA, now: "2026-09-04T00:01:00.000Z" });

    const page1 = await listDeployments(db, logger, { projectId: PROJECT, limit: 1 });
    if (!page1.success) throw page1.error;
    expect(page1.data.map((d) => d.id)).toEqual([first.id]);

    const page2 = await listDeployments(db, logger, { projectId: PROJECT, limit: 1, offset: 1 });
    if (!page2.success) throw page2.error;
    expect(page2.data.map((d) => d.id)).toEqual([second.id]);
  });

  it("returns a database error rather than throwing", async () => {
    const result = await listDeployments(makeThrowingD1(), logger, { projectId: PROJECT });
    expect(result.success).toBe(false);
  });
});

describe("getDeployment", () => {
  it("returns null for a deployment in another project", async () => {
    const deployment = await insert();
    const result = await getDeployment(db, logger, {
      projectId: OTHER_PROJECT,
      deploymentId: deployment.id,
    });
    expect(result.success && result.data).toBeNull();
  });

  it("returns null for an unknown id", async () => {
    const result = await getDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: "dep_nope",
    });
    expect(result.success && result.data).toBeNull();
  });

  it("returns a database error rather than throwing", async () => {
    const result = await getDeployment(makeThrowingD1(), logger, {
      projectId: PROJECT,
      deploymentId: "dep_nope",
    });
    expect(result.success).toBe(false);
  });
});

describe("approveDeployment", () => {
  it("moves a pending row to queued and stamps the approver", async () => {
    const pending = await insert({ status: "pending_approval" });

    const result = await approveDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: pending.id,
      approvedBy: "usr_2",
    });

    expect(result.success && result.data.approved).toBe(true);
    if (result.success && result.data.approved) {
      expect(result.data.deployment.status).toBe("queued");
      expect(result.data.deployment.approvedBy).toBe("usr_2");
    }
    expect(readStatus(pending.id).status).toBe("queued");
  });

  it("closes the gap that would otherwise strand an approved deploy forever", async () => {
    // claimDeployment refuses pending_approval by design, so without the
    // transition this function performs the row is unreachable for good.
    const pending = await insert({ status: "pending_approval" });

    const before = await claimDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: pending.id,
      now: T0,
    });
    expect(before.success && before.data.claimed).toBe(false);

    await approveDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: pending.id,
      approvedBy: "usr_2",
    });

    const after = await claimDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: pending.id,
      now: T0,
    });
    expect(after.success && after.data.claimed).toBe(true);
  });

  it("lets only one of two concurrent approvals win, so a double-approve cannot enqueue twice", async () => {
    const pending = await insert({ status: "pending_approval" });

    const [first, second] = await Promise.all([
      approveDeployment(db, logger, {
        projectId: PROJECT,
        deploymentId: pending.id,
        approvedBy: "usr_2",
      }),
      approveDeployment(db, logger, {
        projectId: PROJECT,
        deploymentId: pending.id,
        approvedBy: "usr_3",
      }),
    ]);

    const outcomes = [first, second].map((r) => r.success && r.data.approved);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    // The loser is told why, so the route can answer 409 rather than enqueue.
    const loser = [first, second].find((r) => r.success && !r.data.approved);
    expect(loser?.success && !loser.data.approved && loser.data.reason).toBe("not_pending");
  });

  it.each(["queued", "running", "succeeded", "failed", "superseded", "skipped"] as const)(
    "refuses a %s row",
    async (status) => {
      const row = await insert({ status });

      const result = await approveDeployment(db, logger, {
        projectId: PROJECT,
        deploymentId: row.id,
        approvedBy: "usr_2",
      });

      expect(result.success && result.data.approved).toBe(false);
      expect(result.success && !result.data.approved && result.data.reason).toBe("not_pending");
      expect(readStatus(row.id).status).toBe(status);
    },
  );

  it("reports not_found for a row in another project", async () => {
    const pending = await insert({ status: "pending_approval" });

    const result = await approveDeployment(db, logger, {
      projectId: OTHER_PROJECT,
      deploymentId: pending.id,
      approvedBy: "usr_2",
    });

    expect(result.success && !result.data.approved && result.data.reason).toBe("not_found");
    expect(readStatus(pending.id).status).toBe("pending_approval");
  });

  it("rejects a non-ISO timestamp", async () => {
    const result = await approveDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: "dep_nope",
      approvedBy: "usr_2",
      now: "2026-09-04 00:00:00",
    });
    expect(result.success).toBe(false);
  });

  it("returns a database error rather than throwing", async () => {
    const result = await approveDeployment(makeThrowingD1(), logger, {
      projectId: PROJECT,
      deploymentId: "dep_nope",
      approvedBy: "usr_2",
    });
    expect(result.success).toBe(false);
  });
});

describe("findDeploymentById", () => {
  it("finds a row without knowing its project, so a route can authorize on the row's own project", async () => {
    const row = await insert();

    const result = await findDeploymentById(db, logger, row.id);

    expect(result.success && result.data?.projectId).toBe(PROJECT);
  });

  it("returns null for an unknown id", async () => {
    const result = await findDeploymentById(db, logger, "dep_nope");
    expect(result.success && result.data).toBeNull();
  });

  it("returns a database error rather than throwing", async () => {
    const result = await findDeploymentById(makeThrowingD1(), logger, "dep_nope");
    expect(result.success).toBe(false);
  });
});

/**
 * Every column in this module is compared as TEXT, so the storage layer has to
 * collapse the several spellings ISO 8601 allows for one instant down to a
 * single one. Left un-normalised, `2026-09-04T17:20:43-04:00` sorts *before*
 * the identical instant `2026-09-04T21:20:43.000Z` and `...:43Z` sorts *after*
 * `...:43.000Z` ('.' 0x2E < 'Z' 0x5A) — and both of the comparisons that stop a
 * commit deploying twice, or an older commit deploying over a newer one, read
 * that order.
 *
 * These cases exist because a merge time now reaches `created_at` over the
 * queue, from a producer that is not the code writing the rows it will be
 * compared against, so the spellings genuinely do meet inside one column.
 */
describe("timestamp canonicalisation", () => {
  /** The same instant, 2026-09-04T21:20:43Z, in every form the module accepts. */
  const SAME_INSTANT = [
    "2026-09-04T21:20:43.000Z",
    "2026-09-04T21:20:43Z",
    "2026-09-04T17:20:43-04:00",
    "2026-09-04T23:20:43+02:00",
  ];
  const CANONICAL = "2026-09-04T21:20:43.000Z";

  function readTimestamps(id: string): {
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
  } {
    const row = raw
      .prepare("SELECT created_at, started_at, completed_at FROM deployments WHERE id = ?")
      .get(id) as
      | { created_at: string; started_at: string | null; completed_at: string | null }
      | undefined;
    if (!row) throw new Error(`no deployment ${id}`);
    return row;
  }

  it("collapses equivalent instants to byte-identical strings", async () => {
    const written: string[] = [];
    for (const [index, form] of SAME_INSTANT.entries()) {
      const deployment = await insert({ commitSha: index.toString().repeat(40), createdAt: form });
      expect(deployment.createdAt).toBe(CANONICAL);
      written.push(readTimestamps(deployment.id).created_at);
    }
    // Byte identity, not just equal instants: TEXT ordering is what reads these.
    expect(new Set(written)).toEqual(new Set([CANONICAL]));
  });

  it("canonicalises every column it writes, not just created_at", async () => {
    const deployment = await insert({ createdAt: "2026-09-04T17:20:43-04:00" });
    const claimed = await claimDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
      leaseMs: 60_000,
      now: "2026-09-04T23:20:43+02:00",
    });
    expect(claimed.success && claimed.data.claimed).toBe(true);
    const written = await completeDeployment(db, logger, {
      projectId: PROJECT,
      deploymentId: deployment.id,
      status: "succeeded",
      completedAt: "2026-09-04T21:21:43Z",
    });
    expect(written.success && written.data).toBe(true);

    expect(readTimestamps(deployment.id)).toEqual({
      created_at: CANONICAL,
      started_at: CANONICAL,
      completed_at: "2026-09-04T21:21:43.000Z",
    });
  });

  describe("supersedeOlder", () => {
    it("keeps the newer commit when the older rows arrived in offset form", async () => {
      // Genuinely older than the keeper, and its string also sorts lower.
      const older = await insert({
        commitSha: "a".repeat(40),
        createdAt: "2026-09-04T13:20:43-04:00", // 17:20:43Z
      });
      // Genuinely *newer* than the keeper, but its unnormalised string sorts
      // lower ("18" < "21") — so without canonicalisation the keeper retires the
      // very commit it should be losing to.
      const newer = await insert({
        commitSha: "b".repeat(40),
        createdAt: "2026-09-04T18:20:43-04:00", // 22:20:43Z
      });
      const keeper = await insert({ commitSha: "c".repeat(40), createdAt: CANONICAL });

      const result = await supersedeOlder(db, logger, {
        projectId: PROJECT,
        name: "production",
        keepDeploymentId: keeper.id,
        createdAt: keeper.createdAt,
        now: CANONICAL,
      });

      expect(result.success && result.data).toBe(1);
      expect(readStatus(older.id).status).toBe("superseded");
      expect(readStatus(newer.id).status).toBe("queued");
    });

    it("supersedes an older Z row when the keeper's own merge time arrived in offset form", async () => {
      const older = await insert({ commitSha: "a".repeat(40), createdAt: CANONICAL });
      const keeper = await insert({
        commitSha: "b".repeat(40),
        createdAt: "2026-09-04T17:20:44-04:00", // 21:20:44Z, one second newer
      });

      const result = await supersedeOlder(db, logger, {
        projectId: PROJECT,
        name: "production",
        keepDeploymentId: keeper.id,
        createdAt: keeper.createdAt,
        now: keeper.createdAt,
      });

      expect(result.success && result.data).toBe(1);
      expect(readStatus(older.id).status).toBe("superseded");
    });

    it("orders a fraction-less timestamp against a fractional one by time, not by bytes", async () => {
      // 'Z' (0x5A) sorts after '.' (0x2E), so unnormalised the older row looks
      // newer than a keeper half a second after it.
      const older = await insert({ commitSha: "a".repeat(40), createdAt: "2026-09-04T21:20:43Z" });
      const keeper = await insert({
        commitSha: "b".repeat(40),
        createdAt: "2026-09-04T21:20:43.500Z",
      });

      const result = await supersedeOlder(db, logger, {
        projectId: PROJECT,
        name: "production",
        keepDeploymentId: keeper.id,
        createdAt: keeper.createdAt,
        now: keeper.createdAt,
      });

      expect(result.success && result.data).toBe(1);
      expect(readStatus(older.id).status).toBe("superseded");
    });
  });

  describe("findNewerSucceededDeployment", () => {
    it("finds a newer succeeded row that was written in offset form", async () => {
      const newer = await insert({
        commitSha: "b".repeat(40),
        status: "succeeded",
        createdAt: "2026-09-04T17:20:44-04:00", // 21:20:44Z
      });
      const candidate = await insert({ commitSha: "a".repeat(40), createdAt: CANONICAL });

      const result = await findNewerSucceededDeployment(db, logger, {
        projectId: PROJECT,
        name: "production",
        createdAt: candidate.createdAt,
        excludeDeploymentId: candidate.id,
      });

      expect(result.success && result.data?.id).toBe(newer.id);
    });

    it("finds a newer succeeded row when the candidate carries no fractional part", async () => {
      const newer = await insert({
        commitSha: "b".repeat(40),
        status: "succeeded",
        createdAt: "2026-09-04T21:20:43.500Z",
      });
      const candidate = await insert({
        commitSha: "a".repeat(40),
        createdAt: "2026-09-04T21:20:43Z",
      });

      const result = await findNewerSucceededDeployment(db, logger, {
        projectId: PROJECT,
        name: "production",
        createdAt: candidate.createdAt,
        excludeDeploymentId: candidate.id,
      });

      expect(result.success && result.data?.id).toBe(newer.id);
    });

    it("still finds nothing when the only other row is genuinely older in another form", async () => {
      await insert({
        commitSha: "b".repeat(40),
        status: "succeeded",
        createdAt: "2026-09-04T19:20:43+02:00", // 17:20:43Z, older
      });
      const candidate = await insert({ commitSha: "a".repeat(40), createdAt: CANONICAL });

      const result = await findNewerSucceededDeployment(db, logger, {
        projectId: PROJECT,
        name: "production",
        createdAt: candidate.createdAt,
        excludeDeploymentId: candidate.id,
      });

      expect(result.success && result.data).toBeNull();
    });
  });

  describe("claimDeployment", () => {
    /** Claims the row at 21:20:43Z with a one-minute lease, expiring 21:21:43Z. */
    async function claimAt(now: string): Promise<Deployment> {
      const deployment = await insert({ createdAt: CANONICAL });
      const claimed = await claimDeployment(db, logger, {
        projectId: PROJECT,
        deploymentId: deployment.id,
        leaseMs: 60_000,
        now,
      });
      if (!claimed.success || !claimed.data.claimed) throw new Error("expected a claim");
      expect(claimed.data.deployment.leaseExpiresAt).toBe("2026-09-04T21:21:43.000Z");
      return deployment;
    }

    it("does not reclaim a live lease when the clock arrives in offset form", async () => {
      // 06:21:13 on the 5th in +09:00 is 21:21:13Z on the 4th — thirty seconds
      // *before* the lease expires, but a later-sorting string than it.
      const deployment = await claimAt("2026-09-04T17:20:43-04:00");

      const result = await claimDeployment(db, logger, {
        projectId: PROJECT,
        deploymentId: deployment.id,
        now: "2026-09-05T06:21:13+09:00",
      });

      expect(result.success).toBe(true);
      if (!result.success || result.data.claimed) throw new Error("reclaimed a live lease");
      expect(result.data.reason).toBe("not_claimable");
      expect(readStatus(deployment.id).lease_expires_at).toBe("2026-09-04T21:21:43.000Z");
    });

    it("reclaims an expired lease when the clock arrives in offset form", async () => {
      // 13:22:43 in -08:00 is 21:22:43Z, a minute past expiry — but an
      // earlier-sorting string than the lease it must be allowed to reclaim.
      const deployment = await claimAt("2026-09-04T21:20:43Z");

      const result = await claimDeployment(db, logger, {
        projectId: PROJECT,
        deploymentId: deployment.id,
        leaseMs: 60_000,
        now: "2026-09-04T13:22:43-08:00",
      });

      expect(result.success).toBe(true);
      if (!result.success || !result.data.claimed) throw new Error("expected a reclaim");
      expect(result.data.deployment.leaseExpiresAt).toBe("2026-09-04T21:23:43.000Z");
      // The row changed hands rather than restarting.
      expect(result.data.deployment.startedAt).toBe(CANONICAL);
    });
  });
});
