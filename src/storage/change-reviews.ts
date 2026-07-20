import { AppError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export interface ChangeComment {
  id: string;
  changeId: string;
  authorType: "user" | "agent";
  authorId: string;
  body: string;
  createdAt: string;
}

export type ReviewVerdict = "approve" | "request_changes";

export interface ChangeReview {
  id: string;
  changeId: string;
  reviewerId: string;
  verdict: ReviewVerdict;
  comment?: string;
  createdAt: string;
}

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

function rowToComment(row: CommentRow): ChangeComment {
  return {
    id: row.id,
    changeId: row.change_id,
    authorType: row.author_type as ChangeComment["authorType"],
    authorId: row.author_id,
    body: row.body,
    createdAt: row.created_at,
  };
}

function rowToReview(row: ReviewRow): ChangeReview {
  const review: ChangeReview = {
    id: row.id,
    changeId: row.change_id,
    reviewerId: row.reviewer_id,
    verdict: row.verdict as ReviewVerdict,
    createdAt: row.created_at,
  };
  if (row.comment !== null) review.comment = row.comment;
  return review;
}

function toAppError(error: unknown, operation: string, context: Record<string, unknown>) {
  return error instanceof AppError
    ? error
    : new AppError(
        error instanceof Error ? error.message : `Failed in ${operation}`,
        "DATABASE_ERROR",
        500,
        { operation, ...context },
      );
}

export async function addComment(
  db: D1Database,
  logger: Logger,
  opts: { changeId: string; authorType: "user" | "agent"; authorId: string; body: string },
): Promise<Result<ChangeComment, AppError>> {
  const id = newId("cmt");
  const createdAt = new Date().toISOString();

  try {
    await db
      .prepare(
        "INSERT INTO change_comments (id, change_id, author_type, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(id, opts.changeId, opts.authorType, opts.authorId, opts.body, createdAt)
      .run();

    logger.info("Comment added", { commentId: id, changeId: opts.changeId });
    return ok({
      id,
      changeId: opts.changeId,
      authorType: opts.authorType,
      authorId: opts.authorId,
      body: opts.body,
      createdAt,
    });
  } catch (error) {
    const appError = toAppError(error, "addComment", { changeId: opts.changeId });
    logger.error("Failed to add comment", appError, { changeId: opts.changeId });
    return err(appError);
  }
}

export async function listComments(
  db: D1Database,
  logger: Logger,
  changeId: string,
): Promise<Result<ChangeComment[], AppError>> {
  try {
    const result = await db
      .prepare("SELECT * FROM change_comments WHERE change_id = ? ORDER BY created_at ASC")
      .bind(changeId)
      .all<CommentRow>();
    return ok(result.results.map(rowToComment));
  } catch (error) {
    const appError = toAppError(error, "listComments", { changeId });
    logger.error("Failed to list comments", appError, { changeId });
    return err(appError);
  }
}

/** Submit (or replace) a reviewer's verdict on a change. */
export async function submitReview(
  db: D1Database,
  logger: Logger,
  opts: { changeId: string; reviewerId: string; verdict: ReviewVerdict; comment?: string },
): Promise<Result<ChangeReview, AppError>> {
  const id = newId("rev");
  const createdAt = new Date().toISOString();

  try {
    await db
      .prepare(
        `INSERT INTO change_reviews (id, change_id, reviewer_id, verdict, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(change_id, reviewer_id)
         DO UPDATE SET verdict = excluded.verdict, comment = excluded.comment, created_at = excluded.created_at`,
      )
      .bind(id, opts.changeId, opts.reviewerId, opts.verdict, opts.comment ?? null, createdAt)
      .run();

    logger.info("Review submitted", {
      changeId: opts.changeId,
      reviewerId: opts.reviewerId,
      verdict: opts.verdict,
    });
    return ok({
      id,
      changeId: opts.changeId,
      reviewerId: opts.reviewerId,
      verdict: opts.verdict,
      ...(opts.comment !== undefined ? { comment: opts.comment } : {}),
      createdAt,
    });
  } catch (error) {
    const appError = toAppError(error, "submitReview", { changeId: opts.changeId });
    logger.error("Failed to submit review", appError, { changeId: opts.changeId });
    return err(appError);
  }
}

export async function listReviews(
  db: D1Database,
  logger: Logger,
  changeId: string,
): Promise<Result<ChangeReview[], AppError>> {
  try {
    const result = await db
      .prepare("SELECT * FROM change_reviews WHERE change_id = ? ORDER BY created_at ASC")
      .bind(changeId)
      .all<ReviewRow>();
    return ok(result.results.map(rowToReview));
  } catch (error) {
    const appError = toAppError(error, "listReviews", { changeId });
    logger.error("Failed to list reviews", appError, { changeId });
    return err(appError);
  }
}

/** Current approval count for a change (one vote per reviewer). */
export async function countApprovals(
  db: D1Database,
  logger: Logger,
  changeId: string,
  /** The change author (createdByUserId): their own approval must not count
   * toward requiredApprovals — otherwise a lone writer self-approves and merges. */
  excludeUserId?: string,
): Promise<Result<number, AppError>> {
  try {
    // change_reviews keys the approver on reviewer_id (author_type/author_id are on
    // change_comments, a different table) — filter on the column that actually exists.
    const sql = excludeUserId
      ? "SELECT COUNT(*) AS approvals FROM change_reviews WHERE change_id = ? AND verdict = 'approve' AND reviewer_id != ?"
      : "SELECT COUNT(*) AS approvals FROM change_reviews WHERE change_id = ? AND verdict = 'approve'";
    const stmt = excludeUserId
      ? db.prepare(sql).bind(changeId, excludeUserId)
      : db.prepare(sql).bind(changeId);
    const row = await stmt.first<{ approvals: number }>();
    return ok(row?.approvals ?? 0);
  } catch (error) {
    const appError = toAppError(error, "countApprovals", { changeId });
    logger.error("Failed to count approvals", appError, { changeId });
    return err(appError);
  }
}
