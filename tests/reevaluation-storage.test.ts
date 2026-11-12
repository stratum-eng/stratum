import { describe, expect, it, vi } from "vitest";
import { listReviews } from "../src/storage/change-reviews";
import {
  createChange,
  getChange,
  recordReevaluation,
  updateChangeStatus,
} from "../src/storage/changes";
import type { Change } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

// Inline re-evaluation records its runs, any approval dismissal and its verdict
// as one guarded batch (Stratum issue #5).

const logger: Logger = {
  trace: vi.fn(),
  fatal: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

const verdict = {
  evalRuns: [
    { evaluatorType: "secret_scan", result: { score: 1, passed: true, reason: "ok" } },
    { evaluatorType: "llm", result: { score: 0.9, passed: true, reason: "fine" } },
  ],
  status: "accepted" as const,
  opts: { evalScore: 0.95, evalPassed: true, evalReason: "ok", evaluatedSha: "sha-new" },
};

async function settledChange(db: D1Database): Promise<Change> {
  const created = await createChange(db, logger, {
    project: "p",
    projectId: "prj_1",
    workspace: "ws",
    createdByUserId: "usr_author",
  });
  if (!created.success) throw created.error;
  const settled = await updateChangeStatus(db, logger, created.data.id, "needs_changes", {
    evalScore: 0.2,
    evalPassed: false,
    evaluatedSha: "sha-old",
  });
  if (!settled.success) throw settled.error;
  return created.data;
}

function approve(raw: ReturnType<typeof makeSqliteD1>["raw"], changeId: string): void {
  raw
    .prepare(
      "INSERT INTO change_reviews (id, change_id, reviewer_id, verdict, created_at) VALUES ('rev_1', ?, 'usr_rev', 'approve', '2026-01-01T00:00:00.000Z')",
    )
    .run(changeId);
}

function evalRunCount(raw: ReturnType<typeof makeSqliteD1>["raw"], changeId: string): number {
  const row = raw
    .prepare("SELECT COUNT(*) AS n FROM eval_runs WHERE change_id = ?")
    .get(changeId) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

describe("recordReevaluation", () => {
  it("records the runs, the dismissal and the verdict together", async () => {
    const { db, raw } = makeSqliteD1();
    const change = await settledChange(db);
    approve(raw, change.id);

    const result = await recordReevaluation(db, logger, {
      changeId: change.id,
      ...verdict,
      dismissApprovals: true,
    });

    expect(result.success && result.data.applied).toBe(true);
    expect(result.success && result.data.runs).toHaveLength(2);
    expect(result.success && result.data.dismissedReviewerIds).toEqual(["usr_rev"]);
    expect(evalRunCount(raw, change.id)).toBe(2);
    const read = await getChange(db, logger, change.id);
    expect(read.success && read.data).toMatchObject({
      status: "accepted",
      evalPassed: true,
      evaluatedSha: "sha-new",
    });
  });

  it.each(["promoted", "merged", "rejected", "reverted"] as const)(
    "writes nothing to a change %s while it was being evaluated",
    async (finalStatus) => {
      const { db, raw } = makeSqliteD1();
      const change = await settledChange(db);
      approve(raw, change.id);
      const finalized = await updateChangeStatus(db, logger, change.id, finalStatus);
      expect(finalized.success).toBe(true);

      const result = await recordReevaluation(db, logger, {
        changeId: change.id,
        ...verdict,
        dismissApprovals: true,
      });

      expect(result.success && result.data).toEqual({
        applied: false,
        runs: [],
        dismissedReviewerIds: [],
      });
      // No orphan round for the merge gate or the change page to pick up.
      expect(evalRunCount(raw, change.id)).toBe(0);
      // The approval stands, and so does the final decision and its verdict.
      const reviews = await listReviews(db, logger, change.id);
      expect(reviews.success && reviews.data.map((r) => r.verdict)).toEqual(["approve"]);
      const read = await getChange(db, logger, change.id);
      expect(read.success && read.data).toMatchObject({
        status: finalStatus,
        evaluatedSha: "sha-old",
      });
    },
  );

  it("replaces `evaluating`, with its rows and its verdict agreeing", async () => {
    // A change queued on an instance whose evaluation queue was since unbound:
    // re-evaluating inline is how it gets a verdict.
    const { db, raw } = makeSqliteD1();
    const change = await settledChange(db);
    raw.prepare("UPDATE changes SET status = 'evaluating' WHERE id = ?").run(change.id);
    approve(raw, change.id);

    const result = await recordReevaluation(db, logger, {
      changeId: change.id,
      ...verdict,
      dismissApprovals: true,
    });

    expect(result.success && result.data.applied).toBe(true);
    expect(evalRunCount(raw, change.id)).toBe(2);
    expect(result.success && result.data.dismissedReviewerIds).toEqual(["usr_rev"]);
    const read = await getChange(db, logger, change.id);
    expect(read.success && read.data.status).toBe("accepted");
  });

  it("writes nothing to a change that no longer exists", async () => {
    const { db, raw } = makeSqliteD1();

    const result = await recordReevaluation(db, logger, {
      changeId: "chg_gone",
      ...verdict,
      dismissApprovals: true,
    });

    expect(result.success && result.data.applied).toBe(false);
    expect(evalRunCount(raw, "chg_gone")).toBe(0);
  });

  it("keeps approvals when not asked to dismiss them", async () => {
    const { db, raw } = makeSqliteD1();
    const change = await settledChange(db);
    approve(raw, change.id);

    const result = await recordReevaluation(db, logger, {
      changeId: change.id,
      ...verdict,
      dismissApprovals: false,
    });

    expect(result.success && result.data.dismissedReviewerIds).toEqual([]);
    const reviews = await listReviews(db, logger, change.id);
    expect(reviews.success && reviews.data).toHaveLength(1);
  });
});
