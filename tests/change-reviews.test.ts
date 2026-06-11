import { describe, expect, it, vi } from "vitest";
import {
  addComment,
  countApprovals,
  listComments,
  listReviews,
  submitReview,
} from "../src/storage/change-reviews";
import type { Logger } from "../src/utils/logger";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

interface CommentRow {
  id: string;
  change_id: string;
  author_type: string;
  author_id: string;
  body: string;
  created_at: string;
}

interface ReviewRow {
  id: string;
  change_id: string;
  reviewer_id: string;
  verdict: string;
  comment: string | null;
  created_at: string;
}

function makeReviewsD1(): { db: D1Database; comments: CommentRow[]; reviews: ReviewRow[] } {
  const comments: CommentRow[] = [];
  const reviews: ReviewRow[] = [];

  function makeStmt(sql: string, bindings: unknown[]) {
    const upper = sql.trim().toUpperCase().replace(/\s+/g, " ");
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => {
        if (upper.startsWith("INSERT INTO CHANGE_COMMENTS")) {
          comments.push({
            id: bindings[0] as string,
            change_id: bindings[1] as string,
            author_type: bindings[2] as string,
            author_id: bindings[3] as string,
            body: bindings[4] as string,
            created_at: bindings[5] as string,
          });
        } else if (upper.startsWith("INSERT INTO CHANGE_REVIEWS")) {
          // Emulate ON CONFLICT(change_id, reviewer_id) DO UPDATE.
          const existing = reviews.find(
            (r) => r.change_id === bindings[1] && r.reviewer_id === bindings[2],
          );
          if (existing) {
            existing.verdict = bindings[3] as string;
            existing.comment = bindings[4] as string | null;
            existing.created_at = bindings[5] as string;
          } else {
            reviews.push({
              id: bindings[0] as string,
              change_id: bindings[1] as string,
              reviewer_id: bindings[2] as string,
              verdict: bindings[3] as string,
              comment: bindings[4] as string | null,
              created_at: bindings[5] as string,
            });
          }
        }
        return { success: true, meta: {} };
      },
      first: async <T>() => {
        if (upper.includes("COUNT(*)")) {
          const approvals = reviews.filter(
            (r) => r.change_id === bindings[0] && r.verdict === "approve",
          ).length;
          return { approvals } as T;
        }
        return null;
      },
      all: async <T>() => {
        let results: unknown[] = [];
        if (upper.includes("FROM CHANGE_COMMENTS")) {
          results = comments
            .filter((r) => r.change_id === bindings[0])
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
        } else if (upper.includes("FROM CHANGE_REVIEWS")) {
          results = reviews
            .filter((r) => r.change_id === bindings[0])
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
        }
        return { results: results as T[], success: true, meta: {} };
      },
    };
  }

  const db = { prepare: (sql: string) => makeStmt(sql, []) } as unknown as D1Database;
  return { db, comments, reviews };
}

describe("change comments", () => {
  it("adds and lists comments in chronological order", async () => {
    const { db } = makeReviewsD1();
    await addComment(db, mockLogger, {
      changeId: "chg_1",
      authorType: "user",
      authorId: "user_1",
      body: "First",
    });
    await addComment(db, mockLogger, {
      changeId: "chg_1",
      authorType: "agent",
      authorId: "agent_1",
      body: "Second",
    });
    await addComment(db, mockLogger, {
      changeId: "chg_other",
      authorType: "user",
      authorId: "user_1",
      body: "Elsewhere",
    });

    const result = await listComments(db, mockLogger, "chg_1");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.map((c) => c.body)).toEqual(["First", "Second"]);
    expect(result.data[1]?.authorType).toBe("agent");
  });
});

describe("change reviews", () => {
  it("records review verdicts per reviewer", async () => {
    const { db } = makeReviewsD1();
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "approve",
    });
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_2",
      verdict: "request_changes",
      comment: "Needs tests",
    });

    const result = await listReviews(db, mockLogger, "chg_1");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(2);
    expect(result.data.find((r) => r.reviewerId === "user_2")?.comment).toBe("Needs tests");
  });

  it("replaces a reviewer's previous verdict on re-review", async () => {
    const { db, reviews } = makeReviewsD1();
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "request_changes",
    });
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "approve",
    });

    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.verdict).toBe("approve");
  });

  it("counts only approvals", async () => {
    const { db } = makeReviewsD1();
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "approve",
    });
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_2",
      verdict: "request_changes",
    });
    await submitReview(db, mockLogger, {
      changeId: "chg_1",
      reviewerId: "user_3",
      verdict: "approve",
    });

    const count = await countApprovals(db, mockLogger, "chg_1");
    expect(count.success).toBe(true);
    if (!count.success) return;
    expect(count.data).toBe(2);
  });
});
