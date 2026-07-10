import { describe, expect, it, vi } from "vitest";
import { runDeletionJob, sweepDeletionJobs } from "../src/queue/deletion-runner";
import type { DeletionTarget } from "../src/storage/deletion";
import {
  acquireLease,
  createDeletionJob,
  finishJob,
  getDeletionJob,
  heartbeat,
  listUnfinishedJobs,
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

async function createProjectJob(stub: JobsD1Stub): Promise<string> {
  const created = await createDeletionJob(stub.db, mockLogger, {
    kind: "project",
    target: makeTarget(),
  });
  expect(created.success).toBe(true);
  if (!created.success) throw new Error("job creation failed");
  return created.data.id;
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

  it("lists only unfinished jobs with stale or missing heartbeats", async () => {
    const stub = makeJobsD1();
    const staleId = await createProjectJob(stub);
    const freshId = await createProjectJob(stub);
    const doneId = await createProjectJob(stub);
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

  it("finishes an account job incomplete until Task 5 lands the cascade", async () => {
    const stub = makeJobsD1();
    const created = await createDeletionJob(stub.db, mockLogger, {
      kind: "account",
      target: { userId: "user_1" },
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const result = await runDeletionJob(makeEnv(stub), created.data.id, mockLogger);

    expect(result.success).toBe(true);
    const row = stub.jobs.get(created.data.id);
    expect(row?.state).toBe("incomplete");
    expect(JSON.parse(row?.residuals ?? "[]")).toEqual(["account:not-implemented"]);
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

  it("finishes incomplete with a target:unparseable residual on malformed JSON", async () => {
    const stub = makeJobsD1();
    const jobId = await createProjectJob(stub);
    const row = stub.jobs.get(jobId);
    if (row) row.target = "{not valid json";

    const result = await runDeletionJob(makeEnv(stub), jobId, mockLogger);

    expect(result.success).toBe(true);
    const after = stub.jobs.get(jobId);
    expect(after?.state).toBe("incomplete");
    expect(JSON.parse(after?.residuals ?? "[]")).toEqual(["target:unparseable"]);
    // The started audit still lands (it precedes target parsing); no cascade
    // or verification touches the DB/Artifacts for a job we can't resolve.
    expect(stub.audits.map((a) => a.action)).toEqual(["deletion.started", "deletion.incomplete"]);
  });

  it("finishes incomplete with a target:unparseable residual on structurally invalid JSON", async () => {
    const stub = makeJobsD1();
    const jobId = await createProjectJob(stub);
    const row = stub.jobs.get(jobId);
    // Valid JSON, but missing the required DeletionTarget fields (e.g. no
    // `nameCollision` boolean, no array fields).
    if (row) row.target = JSON.stringify({ projectId: "proj_1" });

    const result = await runDeletionJob(makeEnv(stub), jobId, mockLogger);

    expect(result.success).toBe(true);
    const after = stub.jobs.get(jobId);
    expect(after?.state).toBe("incomplete");
    expect(JSON.parse(after?.residuals ?? "[]")).toEqual(["target:unparseable"]);
  });
});

describe("sweepDeletionJobs", () => {
  it("re-drives stale jobs and leaves fresh ones alone", async () => {
    const stub = makeJobsD1();
    const staleId = await createProjectJob(stub);
    const freshId = await createProjectJob(stub);
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
});
