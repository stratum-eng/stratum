import { describe, expect, it, vi } from "vitest";
import { checkMergeProtection } from "../src/merge/protection";
import { sweepStuckEvaluations } from "../src/services/evaluation-run";
import {
  beginEvaluationRun,
  failEvaluationRun,
  finalizeEvaluationRun,
} from "../src/storage/change-evaluation";
import {
  applyExternalChangesRequested,
  listReviews,
  submitApproval,
  submitChangesRequested,
} from "../src/storage/change-reviews";
import {
  createChange,
  getChange,
  recordGithubPrLink,
  updateChangeStatus,
} from "../src/storage/changes";
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

  it("reports a status write the pending run held back instead of answering success", async () => {
    const { db } = makeSqliteD1();
    const change = await queuedChange(db);

    const held = await updateChangeStatus(db, logger, change.id, "promoted", {
      githubPrNumber: 7,
    });

    expect(held.success).toBe(false);
    expect(!held.success && held.error.code).toBe("EVALUATION_PENDING");
    expect(!held.success && held.error.statusCode).toBe(409);
  });

  it("records a PR link on an evaluating change without touching its status", async () => {
    const { db } = makeSqliteD1();
    const change = await queuedChange(db);

    const linked = await recordGithubPrLink(db, logger, change.id, {
      githubPrNumber: 7,
      githubPrUrl: "https://github.com/o/r/pull/7",
      githubHeadSha: "sha-pushed",
    });

    expect(linked.success).toBe(true);
    const read = await getChange(db, logger, change.id);
    expect(read.success && read.data.status).toBe("evaluating");
    expect(read.success && read.data.githubPrNumber).toBe(7);
    expect(read.success && read.data.githubHeadSha).toBe("sha-pushed");
  });
});

describe("review verdicts against a pending run (#412)", () => {
  async function acceptedChange(db: D1Database) {
    const change = await queuedChange(db);
    const done = await finalizeEvaluationRun(db, logger, {
      changeId: change.id,
      runId: "erun_first",
      ...passing,
    });
    if (!done.success) throw done.error;
    const read = await getChange(db, logger, change.id);
    if (!read.success) throw read.error;
    return read.data;
  }

  function seenFrom(change: Awaited<ReturnType<typeof acceptedChange>>) {
    return {
      status: change.status,
      ...(change.evalRunId !== undefined ? { evalRunId: change.evalRunId } : {}),
      ...(change.evaluatedSha !== undefined ? { evaluatedSha: change.evaluatedSha } : {}),
      ...(change.baseSha !== undefined ? { baseSha: change.baseSha } : {}),
    };
  }

  it("records an approval of the state the reviewer saw, and approves the change", async () => {
    const { db } = makeSqliteD1();
    const change = await acceptedChange(db);

    const approved = await submitApproval(db, logger, {
      changeId: change.id,
      reviewerId: "usr_reviewer",
      seen: seenFrom(change),
    });

    expect(approved.success && approved.data.applied).toBe(true);
    const read = await getChange(db, logger, change.id);
    expect(read.success && read.data.status).toBe("approved");
  });

  it("refuses an approval when a re-evaluation began after the reviewer loaded the change", async () => {
    const { db } = makeSqliteD1();
    const change = await acceptedChange(db);
    // The route read `accepted`; a re-evaluation starts before the write.
    await beginEvaluationRun(db, logger, { changeId: change.id, runId: "erun_second" });

    const approved = await submitApproval(db, logger, {
      changeId: change.id,
      reviewerId: "usr_reviewer",
      seen: seenFrom(change),
    });

    expect(approved.success && approved.data.applied).toBe(false);
    const reviews = await listReviews(db, logger, change.id);
    expect(reviews.success && reviews.data).toEqual([]);
    const read = await getChange(db, logger, change.id);
    expect(read.success && read.data.status).toBe("evaluating");
  });

  it("refuses an approval of a revision the reviewer never saw", async () => {
    const { db } = makeSqliteD1();
    const change = await acceptedChange(db);
    // A whole re-evaluation runs and pins a new revision between read and write.
    await beginEvaluationRun(db, logger, { changeId: change.id, runId: "erun_second" });
    await finalizeEvaluationRun(db, logger, {
      changeId: change.id,
      runId: "erun_second",
      ...passing,
      opts: { ...passing.opts, evaluatedSha: "sha-newer" },
    });

    const approved = await submitApproval(db, logger, {
      changeId: change.id,
      reviewerId: "usr_reviewer",
      seen: seenFrom(change),
    });

    expect(approved.success && approved.data.applied).toBe(false);
    const read = await getChange(db, logger, change.id);
    expect(read.success && read.data.status).toBe("accepted");
  });

  it("keeps a request for changes made while the run was pending over a passing verdict", async () => {
    const { db } = makeSqliteD1();
    const change = await queuedChange(db);

    const requested = await submitChangesRequested(db, logger, {
      changeId: change.id,
      reviewerId: "usr_reviewer",
      comment: "rename this",
    });
    expect(requested.success && requested.data.status).toBe("evaluating");

    const done = await finalizeEvaluationRun(db, logger, {
      changeId: change.id,
      runId: "erun_first",
      ...passing,
    });

    expect(done.success && done.data.status).toBe("needs_changes");
    const read = await getChange(db, logger, change.id);
    expect(read.success && read.data.status).toBe("needs_changes");
    // The verdict itself is still recorded.
    expect(read.success && read.data.evalPassed).toBe(true);
  });

  it("holds a GitHub changes-requested review across a pending run, like a Stratum one", async () => {
    const { db } = makeSqliteD1();
    const change = await queuedChange(db);

    const held = await applyExternalChangesRequested(db, logger, change.id);
    expect(held.success && held.data).toBe("evaluating");

    const done = await finalizeEvaluationRun(db, logger, {
      changeId: change.id,
      runId: "erun_first",
      ...passing,
    });
    expect(done.success && done.data.status).toBe("needs_changes");
  });

  it("moves a settled change to needs_changes on a GitHub changes-requested review", async () => {
    const { db } = makeSqliteD1();
    const change = await queuedChange(db);
    await finalizeEvaluationRun(db, logger, {
      changeId: change.id,
      runId: "erun_first",
      ...passing,
    });

    const held = await applyExternalChangesRequested(db, logger, change.id);
    expect(held.success && held.data).toBe("needs_changes");
  });

  it("lets a later re-evaluation pass, as a re-evaluation after a request always has", async () => {
    const { db } = makeSqliteD1();
    const change = await queuedChange(db);
    await submitChangesRequested(db, logger, { changeId: change.id, reviewerId: "usr_reviewer" });
    await finalizeEvaluationRun(db, logger, {
      changeId: change.id,
      runId: "erun_first",
      ...passing,
    });

    // The author addresses it and re-evaluates.
    await beginEvaluationRun(db, logger, { changeId: change.id, runId: "erun_second" });
    const done = await finalizeEvaluationRun(db, logger, {
      changeId: change.id,
      runId: "erun_second",
      ...passing,
    });

    expect(done.success && done.data.status).toBe("accepted");
  });

  it("moves a change that is not evaluating straight to needs_changes", async () => {
    const { db } = makeSqliteD1();
    const change = await acceptedChange(db);

    const requested = await submitChangesRequested(db, logger, {
      changeId: change.id,
      reviewerId: "usr_reviewer",
    });

    expect(requested.success && requested.data.status).toBe("needs_changes");
    const read = await getChange(db, logger, change.id);
    expect(read.success && read.data.status).toBe("needs_changes");
  });

  it("records nothing on a change that is no longer reviewable", async () => {
    const { db } = makeSqliteD1();
    const change = await acceptedChange(db);
    await updateChangeStatus(db, logger, change.id, "rejected");

    const requested = await submitChangesRequested(db, logger, {
      changeId: change.id,
      reviewerId: "usr_reviewer",
    });

    expect(requested.success && requested.data.applied).toBe(false);
    const read = await getChange(db, logger, change.id);
    expect(read.success && read.data.status).toBe("rejected");
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
