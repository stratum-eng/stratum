import { describe, expect, it, vi } from "vitest";
import { checkMergeProtection } from "../src/merge/protection";
import { sweepStuckEvaluations } from "../src/services/evaluation-run";
import {
  beginEvaluationRun,
  failEvaluationRun,
  finalizeEvaluationRun,
} from "../src/storage/change-evaluation";
import { createChange, getChange, updateChangeStatus } from "../src/storage/changes";
import type { Env } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

const logger: Logger = {
  trace: vi.fn(),
  fatal: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

const passing = {
  status: "accepted" as const,
  opts: { evalScore: 1, evalPassed: true, evalReason: "ok", evaluatedSha: "sha-new" },
  evalRuns: [{ evaluatorType: "secret_scan", result: { score: 1, passed: true, reason: "ok" } }],
  dismissApprovals: false,
};

async function queuedChange(db: D1Database, runId = "erun_first") {
  const created = await createChange(db, logger, {
    project: "p",
    projectId: "prj_1",
    workspace: "ws",
    createdByUserId: "usr_author",
    evaluation: { runId, requestedBy: "usr_author" },
  });
  if (!created.success) throw created.error;
  return created.data;
}

function evalRunCount(raw: ReturnType<typeof makeSqliteD1>["raw"], changeId: string): number {
  const row = raw
    .prepare("SELECT COUNT(*) AS n FROM eval_runs WHERE change_id = ?")
    .get(changeId) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

describe("run-keyed evaluation writes (#412)", () => {
  it("creates a queued change in `evaluating`, waiting on its run", async () => {
    const { db } = makeSqliteD1();
    const change = await queuedChange(db);
    expect(change.status).toBe("evaluating");
    const read = await getChange(db, logger, change.id);
    expect(read.success && read.data.status).toBe("evaluating");
    expect(read.success && read.data.evalRunId).toBe("erun_first");
    expect(read.success && read.data.evalRequestedAt).toBe(change.createdAt);
  });

  it("records the current run's verdict into the same eval records as inline evaluation", async () => {
    const { db, raw } = makeSqliteD1();
    const change = await queuedChange(db);

    const result = await finalizeEvaluationRun(db, logger, {
      changeId: change.id,
      runId: "erun_first",
      ...passing,
    });

    expect(result.success && result.data.applied).toBe(true);
    const read = await getChange(db, logger, change.id);
    expect(read.success && read.data.status).toBe("accepted");
    expect(read.success && read.data.evaluatedSha).toBe("sha-new");
    expect(evalRunCount(raw, change.id)).toBe(1);
  });

  it("never lets a superseded run overwrite a newer revision's run", async () => {
    const { db, raw } = makeSqliteD1();
    const change = await queuedChange(db);
    // A re-evaluation supersedes the first run before it reports back.
    const begun = await beginEvaluationRun(db, logger, {
      changeId: change.id,
      runId: "erun_second",
    });
    expect(begun.success && begun.data.started).toBe(true);

    const stale = await finalizeEvaluationRun(db, logger, {
      changeId: change.id,
      runId: "erun_first",
      ...passing,
    });

    expect(stale.success && stale.data.applied).toBe(false);
    const read = await getChange(db, logger, change.id);
    expect(read.success && read.data.status).toBe("evaluating");
    expect(read.success && read.data.evalRunId).toBe("erun_second");
    // Not even the rows land: the stale round must not become the newest round
    // the merge gate reads.
    expect(evalRunCount(raw, change.id)).toBe(0);

    const current = await finalizeEvaluationRun(db, logger, {
      changeId: change.id,
      runId: "erun_second",
      ...passing,
      status: "needs_changes",
      opts: { evalScore: 0, evalPassed: false, evalReason: "nope" },
    });
    expect(current.success && current.data.applied).toBe(true);
    const after = await getChange(db, logger, change.id);
    expect(after.success && after.data.status).toBe("needs_changes");
  });

  it("does not resurrect a change rejected while its run was pending", async () => {
    const { db } = makeSqliteD1();
    const change = await queuedChange(db);
    await updateChangeStatus(db, logger, change.id, "rejected");

    const result = await finalizeEvaluationRun(db, logger, {
      changeId: change.id,
      runId: "erun_first",
      ...passing,
    });

    expect(result.success && result.data.applied).toBe(false);
    const read = await getChange(db, logger, change.id);
    expect(read.success && read.data.status).toBe("rejected");
  });

  it("dismisses approvals only when the run's verdict lands", async () => {
    const { db, raw } = makeSqliteD1();
    const change = await queuedChange(db);
    raw
      .prepare(
        "INSERT INTO change_reviews (id, change_id, reviewer_id, verdict, created_at) VALUES ('rev_1', ?, 'usr_rev', 'approve', '2026-01-01T00:00:00.000Z')",
      )
      .run(change.id);

    const stale = await finalizeEvaluationRun(db, logger, {
      changeId: change.id,
      runId: "erun_other",
      ...passing,
      dismissApprovals: true,
    });
    expect(stale.success && stale.data.dismissedReviewerIds).toEqual([]);

    const current = await finalizeEvaluationRun(db, logger, {
      changeId: change.id,
      runId: "erun_first",
      ...passing,
      dismissApprovals: true,
    });
    expect(current.success && current.data.dismissedReviewerIds).toEqual(["usr_rev"]);
  });

  it("refuses to begin a run on a terminal change", async () => {
    const { db } = makeSqliteD1();
    const change = await queuedChange(db);
    await updateChangeStatus(db, logger, change.id, "rejected");

    const begun = await beginEvaluationRun(db, logger, { changeId: change.id, runId: "erun_x" });
    expect(begun.success && begun.data.started).toBe(false);
  });

  it("fails a run closed, but only the run the change still waits on", async () => {
    const { db } = makeSqliteD1();
    const change = await queuedChange(db);

    const stale = await failEvaluationRun(db, logger, {
      changeId: change.id,
      runId: "erun_other",
      reason: "x",
    });
    expect(stale.success && stale.data.applied).toBe(false);

    const failed = await failEvaluationRun(db, logger, {
      changeId: change.id,
      runId: "erun_first",
      reason: "Evaluation did not complete",
    });
    expect(failed.success && failed.data.applied).toBe(true);
    const read = await getChange(db, logger, change.id);
    expect(read.success && read.data.status).toBe("needs_changes");
    expect(read.success && read.data.evalPassed).toBe(false);
    expect(read.success && read.data.evalScore).toBe(0);
  });

  it("keeps an approval from making a pending change mergeable", async () => {
    const { db } = makeSqliteD1();
    const change = await queuedChange(db);

    // The review route, and a promotion, read the status before a
    // re-evaluation moved it to `evaluating`; their write must not land.
    await updateChangeStatus(db, logger, change.id, "approved");
    await updateChangeStatus(db, logger, change.id, "promoted");

    const read = await getChange(db, logger, change.id);
    expect(read.success && read.data.status).toBe("evaluating");
  });
});

describe("merge protection while evaluation is pending (#412)", () => {
  it("refuses an evaluating change even when the policy has no merge rules", async () => {
    const { db } = makeSqliteD1();
    const change = await queuedChange(db);

    const verdict = await checkMergeProtection(db, logger, change, { evaluators: [] });

    expect(verdict.success && verdict.data).toEqual({
      allowed: false,
      reasons: ["Evaluation is still pending"],
    });
  });

  it("behaves exactly as before once the result exists", async () => {
    const { db } = makeSqliteD1();
    const change = await queuedChange(db);
    await finalizeEvaluationRun(db, logger, {
      changeId: change.id,
      runId: "erun_first",
      ...passing,
    });
    const read = await getChange(db, logger, change.id);
    if (!read.success) throw read.error;

    const verdict = await checkMergeProtection(db, logger, read.data, {
      evaluators: [],
      merge: { requiredEvaluators: ["secret_scan"] },
    });

    expect(verdict.success && verdict.data).toEqual({ allowed: true, reasons: [] });
  });
});

describe("sweepStuckEvaluations (#412)", () => {
  const T0 = new Date("2026-11-01T00:00:00.000Z");
  const LATER = new Date(T0.getTime() + 21 * 60_000);

  function envWith(db: D1Database, queue?: { send: ReturnType<typeof vi.fn> }): Env {
    return {
      DB: db,
      STATE: {} as KVNamespace,
      ARTIFACTS: {} as Env["ARTIFACTS"],
      ...(queue ? { EVALUATION_QUEUE: queue as unknown as Env["EVALUATION_QUEUE"] } : {}),
    };
  }

  function backdate(raw: ReturnType<typeof makeSqliteD1>["raw"], changeId: string) {
    raw
      .prepare("UPDATE changes SET eval_requested_at = ? WHERE id = ?")
      .run(T0.toISOString(), changeId);
  }

  it("leaves a run inside its window alone", async () => {
    const { db } = makeSqliteD1();
    await queuedChange(db);
    const send = vi.fn(async () => undefined);

    const result = await sweepStuckEvaluations(envWith(db, { send }), logger, T0);

    expect(result).toEqual({ redispatched: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("re-dispatches a stuck run under a fresh run id", async () => {
    const { db, raw } = makeSqliteD1();
    const change = await queuedChange(db);
    backdate(raw, change.id);
    const send = vi.fn(async () => undefined);

    const result = await sweepStuckEvaluations(envWith(db, { send }), logger, LATER);

    expect(result).toEqual({ redispatched: 1, failed: 0 });
    const read = await getChange(db, logger, change.id);
    if (!read.success) throw read.error;
    expect(read.data.status).toBe("evaluating");
    expect(read.data.evalRunId).not.toBe("erun_first");
    expect(send).toHaveBeenCalledWith({
      type: "change.evaluate",
      changeId: change.id,
      runId: read.data.evalRunId,
    });
  });

  it("fails a run closed once its re-dispatches are spent", async () => {
    const { db, raw } = makeSqliteD1();
    const change = await queuedChange(db);
    backdate(raw, change.id);
    raw.prepare("UPDATE changes SET eval_attempts = 2 WHERE id = ?").run(change.id);
    const send = vi.fn(async () => undefined);

    const result = await sweepStuckEvaluations(envWith(db, { send }), logger, LATER);

    expect(result).toEqual({ redispatched: 0, failed: 1 });
    expect(send).not.toHaveBeenCalled();
    const read = await getChange(db, logger, change.id);
    expect(read.success && read.data.status).toBe("needs_changes");
    expect(read.success && read.data.evalReason).toMatch(/never reported back/);
  });

  it("fails a stuck run closed when no evaluation queue is bound", async () => {
    const { db, raw } = makeSqliteD1();
    const change = await queuedChange(db);
    backdate(raw, change.id);

    const result = await sweepStuckEvaluations(envWith(db), logger, LATER);

    expect(result).toEqual({ redispatched: 0, failed: 1 });
    const read = await getChange(db, logger, change.id);
    expect(read.success && read.data.status).toBe("needs_changes");
  });
});
