import { describe, expect, it, vi } from "vitest";
import {
  redriveDeletionJob,
  runDeletionJob,
  sweepDeletionJobs,
} from "../src/queue/deletion-runner";
import type { DeletionTarget } from "../src/storage/deletion";
import {
  acquireLease,
  createDeletionJob,
  finishJob,
  getDeletionJob,
  heartbeat,
  listRetryableIncompleteJobs,
  listUnfinishedJobs,
  reopenIncompleteJob,
} from "../src/storage/deletion-jobs";
import type { Env } from "../src/types";
import type { Logger } from "../src/utils/logger";
import {
  type JobsD1Stub,
  makeArtifactsStub,
  makeJobsD1,
  makeKvStub,
} from "./helpers/deletion-stubs";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

const PAST = "2026-01-01T00:00:00.000Z";

function makeTarget(overrides: Partial<DeletionTarget> = {}): DeletionTarget {
  return {
    projectId: "proj_1",
    namespace: "@alice",
    slug: "api",
    name: "api",
    workspaceNames: [],
    forkRepoNames: [],
    projectRepoName: "alice__api",
    changeIds: ["chg_1"],
    webhookIds: [],
    nameCollision: false,
    ...overrides,
  };
}

function makeEnv(stub: JobsD1Stub, artifacts?: Env["ARTIFACTS"]): Env {
  return {
    DB: stub.db,
    STATE: makeKvStub().kv,
    ARTIFACTS: artifacts ?? makeArtifactsStub().artifacts,
  } as Env;
}

async function createProjectJob(stub: JobsD1Stub, projectId = "proj_1"): Promise<string> {
  // Distinct projectId per call: the partial unique index (enforced by the stub)
  // rejects two active jobs for the SAME project, so tests that need several
  // concurrent jobs must target different projects.
  const target = makeTarget({ projectId });
  const created = await createDeletionJob(stub.db, mockLogger, {
    kind: "project",
    target,
    targetId: target.projectId,
  });
  expect(created.success).toBe(true);
  if (!created.success) throw new Error("job creation failed");
  return created.data.job.id;
}

describe("deletion job CRUD + lease", () => {
  it("creates and fetches a pending job with its target JSON", async () => {
    const stub = makeJobsD1();
    const jobId = await createProjectJob(stub);

    const fetched = await getDeletionJob(stub.db, mockLogger, jobId);
    expect(fetched.success).toBe(true);
    if (!fetched.success) return;
    expect(fetched.data?.state).toBe("pending");
    expect(fetched.data?.kind).toBe("project");
    expect(JSON.parse(fetched.data?.target ?? "{}")).toMatchObject({ projectId: "proj_1" });
  });

  it("grants the lease once and again only after expiry", async () => {
    const stub = makeJobsD1();
    const jobId = await createProjectJob(stub);

    const first = await acquireLease(stub.db, mockLogger, jobId, "driver-a", 600_000);
    expect(first.success && first.data).toBe(true);

    const second = await acquireLease(stub.db, mockLogger, jobId, "driver-b", 600_000);
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data).toBe(false);

    // Simulate expiry; the next driver may steal the lease.
    const row = stub.jobs.get(jobId);
    expect(row).toBeDefined();
    if (row) row.lease_expires_at = PAST;
    const third = await acquireLease(stub.db, mockLogger, jobId, "driver-b", 600_000);
    expect(third.success && third.data).toBe(true);
    expect(stub.jobs.get(jobId)?.lease_owner).toBe("driver-b");
  });

  it("heartbeats record checkpoints and finish releases the lease", async () => {
    const stub = makeJobsD1();
    const jobId = await createProjectJob(stub);
    await acquireLease(stub.db, mockLogger, jobId, "driver-a", 600_000);

    const beat = await heartbeat(stub.db, mockLogger, jobId, "driver-a", 600_000, "cascade");
    expect(beat.success && beat.data).toBe(true);
    expect(stub.jobs.get(jobId)?.checkpoint).toBe("cascade");

    // A checkpoint-less heartbeat must not erase the recorded checkpoint.
    await heartbeat(stub.db, mockLogger, jobId, "driver-a", 600_000);
    expect(stub.jobs.get(jobId)?.checkpoint).toBe("cascade");

    // Fencing: a non-owner heartbeat changes nothing and reports lease loss.
    const stolen = await heartbeat(stub.db, mockLogger, jobId, "driver-b", 600_000, "hijack");
    expect(stolen.success && stolen.data).toBe(false);
    expect(stub.jobs.get(jobId)?.checkpoint).toBe("cascade");

    const finished = await finishJob(stub.db, mockLogger, jobId, "driver-a", "incomplete", [
      "artifacts:x",
    ]);
    expect(finished.success && finished.data).toBe(true);
    const row = stub.jobs.get(jobId);
    expect(row?.state).toBe("incomplete");
    expect(row?.residuals).toBe(JSON.stringify(["artifacts:x"]));
    expect(row?.lease_owner).toBeNull();
    expect(row?.finished_at).not.toBeNull();
  });

  it("dedups a second active job for the same target (created: false)", async () => {
    const stub = makeJobsD1();
    const target = makeTarget({ projectId: "proj_dupe" });
    const first = await createDeletionJob(stub.db, mockLogger, {
      kind: "project",
      target,
      targetId: "proj_dupe",
    });
    expect(first.success && first.data.created).toBe(true);

    // The partial unique index rejects the concurrent insert; createDeletionJob
    // returns the winning job with created: false instead of an error.
    const second = await createDeletionJob(stub.db, mockLogger, {
      kind: "project",
      target,
      targetId: "proj_dupe",
    });
    expect(second.success).toBe(true);
    if (!second.success || !first.success) return;
    expect(second.data.created).toBe(false);
    expect(second.data.job.id).toBe(first.data.job.id);
  });

  it("lists only unfinished jobs with stale or missing heartbeats", async () => {
    const stub = makeJobsD1();
    const staleId = await createProjectJob(stub, "proj_a");
    const freshId = await createProjectJob(stub, "proj_b");
    const doneId = await createProjectJob(stub, "proj_c");
    const staleRow = stub.jobs.get(staleId);
    const freshRow = stub.jobs.get(freshId);
    const doneRow = stub.jobs.get(doneId);
    if (staleRow) staleRow.heartbeat_at = PAST;
    if (freshRow) freshRow.heartbeat_at = new Date().toISOString();
    if (doneRow) doneRow.state = "completed";

    const staleBefore = new Date(Date.now() - 60_000).toISOString();
    const listed = await listUnfinishedJobs(stub.db, mockLogger, staleBefore);
    expect(listed.success).toBe(true);
    if (!listed.success) return;
    expect(listed.data.map((job) => job.id)).toEqual([staleId]);
  });
});

describe("runDeletionJob", () => {
  it("drives a clean project job to completed with a started/completed audit pair", async () => {
    const stub = makeJobsD1();
    const jobId = await createProjectJob(stub);

    const result = await runDeletionJob(makeEnv(stub), jobId, mockLogger);

    expect(result.success).toBe(true);
    const row = stub.jobs.get(jobId);
    expect(row?.state).toBe("completed");
    expect(row?.residuals).toBe("[]");
    expect(row?.started_at).not.toBeNull();
    expect(row?.finished_at).not.toBeNull();
    expect(stub.audits.map((a) => a.action)).toEqual(["deletion.started", "deletion.completed"]);
    expect(stub.audits[0]?.subject).toBe(jobId);
  });

  it("finishes incomplete when the cascade leaves residuals", async () => {
    const stub = makeJobsD1();
    const jobId = await createProjectJob(stub);
    const failing = makeArtifactsStub(() => {
      throw new Error("upstream 500");
    });

    const result = await runDeletionJob(makeEnv(stub, failing.artifacts), jobId, mockLogger);

    expect(result.success).toBe(true);
    const row = stub.jobs.get(jobId);
    expect(row?.state).toBe("incomplete");
    expect(JSON.parse(row?.residuals ?? "[]")).toContain("artifacts:alice__api");
    expect(stub.audits.map((a) => a.action)).toEqual(["deletion.started", "deletion.incomplete"]);
  });

  it("a re-enqueued job converges to completed once the transient fault clears", async () => {
    // `incomplete` is terminal; recovery is a FRESH job for the same target.
    // The first attempt fails on Artifacts; a re-enqueue after recovery completes.
    const stub = makeJobsD1();
    const firstId = await createProjectJob(stub);
    const failing = makeArtifactsStub(() => {
      throw new Error("upstream 500");
    });
    await runDeletionJob(makeEnv(stub, failing.artifacts), firstId, mockLogger);
    expect(stub.jobs.get(firstId)?.state).toBe("incomplete");

    // Operator re-enqueues; Artifacts now healthy (default stub tolerates all).
    const secondId = await createProjectJob(stub);
    const result = await runDeletionJob(makeEnv(stub), secondId, mockLogger);

    expect(result.success).toBe(true);
    const row = stub.jobs.get(secondId);
    expect(row?.state).toBe("completed");
    expect(JSON.parse(row?.residuals ?? "[]")).toEqual([]);
  });

  it("runs the account cascade to completion when there is nothing residual", async () => {
    // No owned projects, no owned orgs (the JobsD1 stub returns [] for the
    // cascade's SELECTs), so the account cascade drains clean and the job
    // finishes `completed`.
    const stub = makeJobsD1();
    const created = await createDeletionJob(stub.db, mockLogger, {
      kind: "account",
      target: { userId: "user_1" },
      targetId: "user_1",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const result = await runDeletionJob(makeEnv(stub), created.data.job.id, mockLogger);

    expect(result.success).toBe(true);
    const row = stub.jobs.get(created.data.job.id);
    expect(row?.state).toBe("completed");
    expect(JSON.parse(row?.residuals ?? "[]")).toEqual([]);
  });

  it("skips when another driver holds a live lease", async () => {
    const stub = makeJobsD1();
    const jobId = await createProjectJob(stub);
    const row = stub.jobs.get(jobId);
    if (row) {
      row.lease_owner = "other-driver";
      row.lease_expires_at = new Date(Date.now() + 600_000).toISOString();
    }

    const result = await runDeletionJob(makeEnv(stub), jobId, mockLogger);

    expect(result.success).toBe(true);
    expect(stub.jobs.get(jobId)?.state).toBe("pending");
    expect(stub.audits).toEqual([]);
  });

  it("resumes a crashed job without duplicating the started audit", async () => {
    const stub = makeJobsD1();
    const jobId = await createProjectJob(stub);
    // Simulated crash: driver died mid-cascade, leaving a running job with a
    // recorded checkpoint, a dead lease, and a stale heartbeat.
    const row = stub.jobs.get(jobId);
    if (row) {
      row.state = "running";
      row.checkpoint = "cascade";
      row.lease_owner = "dead-driver";
      row.lease_expires_at = PAST;
      row.heartbeat_at = PAST;
      row.started_at = PAST;
    }

    const result = await runDeletionJob(makeEnv(stub), jobId, mockLogger);

    expect(result.success).toBe(true);
    const after = stub.jobs.get(jobId);
    expect(after?.state).toBe("completed");
    // The first drive already audited `started`; the re-drive must not repeat it.
    expect(stub.audits.map((a) => a.action)).toEqual(["deletion.completed"]);
  });

  it("is a no-op for already-finished jobs", async () => {
    const stub = makeJobsD1();
    const jobId = await createProjectJob(stub);
    const row = stub.jobs.get(jobId);
    if (row) row.state = "completed";

    const result = await runDeletionJob(makeEnv(stub), jobId, mockLogger);
    expect(result.success).toBe(true);
    expect(stub.audits).toEqual([]);
  });
});

describe("attempt budget", () => {
  it("finishJob increments attempts only when the drive ends incomplete", async () => {
    const stub = makeJobsD1();
    const badId = await createProjectJob(stub, "proj_bad");
    const goodId = await createProjectJob(stub, "proj_good");
    await acquireLease(stub.db, mockLogger, badId, "d", 600_000);
    await acquireLease(stub.db, mockLogger, goodId, "d", 600_000);

    await finishJob(stub.db, mockLogger, badId, "d", "incomplete", ["artifacts:x"]);
    await finishJob(stub.db, mockLogger, goodId, "d", "completed", []);

    expect(stub.jobs.get(badId)?.attempts).toBe(1);
    expect(stub.jobs.get(goodId)?.attempts).toBe(0);
  });

  it("listRetryableIncompleteJobs returns incomplete jobs under the cap only", async () => {
    const stub = makeJobsD1();
    const underId = await createProjectJob(stub, "proj_under");
    const atCapId = await createProjectJob(stub, "proj_cap");
    const pendingId = await createProjectJob(stub, "proj_pending");
    const under = stub.jobs.get(underId);
    const atCap = stub.jobs.get(atCapId);
    if (under) {
      under.state = "incomplete";
      under.attempts = 1;
    }
    if (atCap) {
      atCap.state = "incomplete";
      atCap.attempts = 3;
    }

    const listed = await listRetryableIncompleteJobs(stub.db, mockLogger, 3);
    expect(listed.success).toBe(true);
    if (!listed.success) return;
    // atCap (attempts == cap) and the still-pending job are both excluded.
    expect(listed.data.map((job) => job.id)).toEqual([underId]);
    expect(pendingId).toBeDefined();
  });

  it("reopenIncompleteJob only reopens incomplete jobs and can clear attempts", async () => {
    const stub = makeJobsD1();
    const jobId = await createProjectJob(stub);

    // Pending, not incomplete: nothing to reopen.
    const noop = await reopenIncompleteJob(stub.db, mockLogger, jobId);
    expect(noop.success && noop.data).toBe(false);
    expect(stub.jobs.get(jobId)?.state).toBe("pending");

    const row = stub.jobs.get(jobId);
    if (row) {
      row.state = "incomplete";
      row.attempts = 2;
      row.finished_at = PAST;
      row.lease_owner = "stale";
    }
    const reopened = await reopenIncompleteJob(stub.db, mockLogger, jobId, { resetAttempts: true });
    expect(reopened.success && reopened.data).toBe(true);
    const after = stub.jobs.get(jobId);
    expect(after?.state).toBe("pending");
    expect(after?.attempts).toBe(0);
    expect(after?.finished_at).toBeNull();
    expect(after?.lease_owner).toBeNull();
  });
});

describe("redriveDeletionJob (operator)", () => {
  it("reopens an incomplete job, resets the budget, and drives it to completed", async () => {
    const stub = makeJobsD1();
    const jobId = await createProjectJob(stub);
    const row = stub.jobs.get(jobId);
    if (row) {
      // Budget exhausted by the auto-sweep; operator forces one more drive.
      row.state = "incomplete";
      row.residuals = JSON.stringify(["artifacts:x"]);
      row.attempts = 3;
      row.checkpoint = "cascade";
      row.finished_at = PAST;
    }

    const result = await redriveDeletionJob(makeEnv(stub), jobId, mockLogger);

    expect(result.success && result.data.reopened).toBe(true);
    const after = stub.jobs.get(jobId);
    expect(after?.state).toBe("completed");
    expect(after?.attempts).toBe(0);
    // checkpoint was already set, so the re-drive must not re-audit the start.
    expect(stub.audits.map((a) => a.action)).toEqual(["deletion.completed"]);
  });

  it("returns reopened:false for a job that is not incomplete", async () => {
    const stub = makeJobsD1();
    const jobId = await createProjectJob(stub); // pending

    const result = await redriveDeletionJob(makeEnv(stub), jobId, mockLogger);

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reopened).toBe(false);
    expect(stub.jobs.get(jobId)?.state).toBe("pending");
  });

  it("returns reopened:false for a missing job", async () => {
    const stub = makeJobsD1();
    const result = await redriveDeletionJob(makeEnv(stub), "del_missing", mockLogger);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reopened).toBe(false);
  });
});

describe("sweepDeletionJobs", () => {
  it("re-drives stale jobs and leaves fresh ones alone", async () => {
    const stub = makeJobsD1();
    const staleId = await createProjectJob(stub, "proj_a");
    const freshId = await createProjectJob(stub, "proj_b");
    const staleRow = stub.jobs.get(staleId);
    const freshRow = stub.jobs.get(freshId);
    if (staleRow) {
      staleRow.state = "running";
      staleRow.heartbeat_at = PAST;
      staleRow.lease_owner = "dead-driver";
      staleRow.lease_expires_at = PAST;
      staleRow.checkpoint = "started";
    }
    if (freshRow) {
      freshRow.state = "running";
      freshRow.heartbeat_at = new Date().toISOString();
    }

    await sweepDeletionJobs(makeEnv(stub), mockLogger);

    expect(stub.jobs.get(staleId)?.state).toBe("completed");
    expect(stub.jobs.get(freshId)?.state).toBe("running");
  });

  it("auto-re-drives a transiently-incomplete job to completed within the cap", async () => {
    const stub = makeJobsD1();
    const jobId = await createProjectJob(stub);
    const failing = makeArtifactsStub(() => {
      throw new Error("upstream 500");
    });
    // First drive fails on Artifacts, landing the job incomplete with attempts=1.
    await runDeletionJob(makeEnv(stub, failing.artifacts), jobId, mockLogger);
    expect(stub.jobs.get(jobId)?.state).toBe("incomplete");
    expect(stub.jobs.get(jobId)?.attempts).toBe(1);

    // Sweep with healthy Artifacts: incomplete jobs are swept by state (not
    // heartbeat staleness), so it reopens and re-drives to completion.
    await sweepDeletionJobs(makeEnv(stub), mockLogger);

    expect(stub.jobs.get(jobId)?.state).toBe("completed");
  });

  it("does not auto-retry a job whose residual can never clear", async () => {
    const stub = makeJobsD1();
    const jobId = await createProjectJob(stub);
    const row = stub.jobs.get(jobId);
    if (row) {
      row.state = "incomplete";
      row.residuals = JSON.stringify(["target:unparseable"]);
      row.attempts = 1;
      row.finished_at = PAST;
    }

    await sweepDeletionJobs(makeEnv(stub), mockLogger);

    // A terminal residual is skipped even with budget remaining.
    expect(stub.jobs.get(jobId)?.state).toBe("incomplete");
    expect(stub.jobs.get(jobId)?.attempts).toBe(1);
  });

  it("does not re-drive a job in the same sweep that just drove it incomplete", async () => {
    const stub = makeJobsD1();
    const jobId = await createProjectJob(stub);
    // Stale, crashed running job: the stale-heartbeat pass drives it first.
    const row = stub.jobs.get(jobId);
    if (row) {
      row.state = "running";
      row.heartbeat_at = PAST;
      row.lease_owner = "dead-driver";
      row.lease_expires_at = PAST;
      row.checkpoint = "started";
    }
    const failing = makeArtifactsStub(() => {
      throw new Error("upstream 500");
    });

    await sweepDeletionJobs(makeEnv(stub, failing.artifacts), mockLogger);

    const after = stub.jobs.get(jobId);
    expect(after?.state).toBe("incomplete");
    // Phase 1 drove it (attempts=1); the retry pass must skip it this sweep so a
    // single fault costs one attempt per cycle, not two.
    expect(after?.attempts).toBe(1);
  });

  it("stops auto-retrying once the attempt cap is reached", async () => {
    const stub = makeJobsD1();
    const jobId = await createProjectJob(stub);
    const row = stub.jobs.get(jobId);
    if (row) {
      row.state = "incomplete";
      row.residuals = JSON.stringify(["artifacts:x"]);
      row.attempts = 3;
      row.finished_at = PAST;
    }

    await sweepDeletionJobs(makeEnv(stub), mockLogger);

    expect(stub.jobs.get(jobId)?.state).toBe("incomplete");
    expect(stub.jobs.get(jobId)?.attempts).toBe(3);
  });
});
