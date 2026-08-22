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
  /** Diff anchor: present on line comments, absent on change-level discussion. */
  file?: string;
  line?: number;
  /** Which half of the diff the line belongs to; only set with file+line. */
  side?: "old" | "new";
  /** Commit the anchor was recorded against, for later re-anchoring. */
  commitSha?: string;
  /** Thread root this comment replies to; absent on thread roots themselves. */
  parentCommentId?: string;
  /** Resolution state; meaningful on thread roots only. */
  resolved: boolean;
}

/** Anchor + threading options for a comment. */
export interface CommentAnchor {
  file?: string;
  line?: number;
  side?: "old" | "new";
  commitSha?: string;
  parentCommentId?: string;
}

/**
 * 'comment' is a comment-only review: it records that the reviewer looked
 * without approving or requesting changes. It never counts toward approvals
 * (countApprovals filters on verdict = 'approve') and never blocks a merge.
 */
export type ReviewVerdict = "approve" | "request_changes" | "comment";

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
  file?: string | null;
  line?: number | null;
  side?: string | null;
  commit_sha?: string | null;
  parent_comment_id?: string | null;
  resolved?: number | null;
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
    ...(row.file != null ? { file: row.file } : {}),
    ...(row.line != null ? { line: row.line } : {}),
    ...(row.side != null ? { side: row.side as ChangeComment["side"] } : {}),
    ...(row.commit_sha != null ? { commitSha: row.commit_sha } : {}),
    ...(row.parent_comment_id != null ? { parentCommentId: row.parent_comment_id } : {}),
    resolved: row.resolved === 1,
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
  opts: {
    changeId: string;
    authorType: "user" | "agent";
    authorId: string;
    body: string;
  } & CommentAnchor,
): Promise<Result<ChangeComment, AppError>> {
  const id = newId("cmt");
  const createdAt = new Date().toISOString();

  try {
    await db
      .prepare(
        "INSERT INTO change_comments (id, change_id, author_type, author_id, body, created_at, file, line, side, commit_sha, parent_comment_id, resolved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
      )
      .bind(
        id,
        opts.changeId,
        opts.authorType,
        opts.authorId,
        opts.body,
        createdAt,
        opts.file ?? null,
        opts.line ?? null,
        opts.side ?? null,
        opts.commitSha ?? null,
        opts.parentCommentId ?? null,
      )
      .run();

    logger.info("Comment added", { commentId: id, changeId: opts.changeId });
    return ok({
      id,
      changeId: opts.changeId,
      authorType: opts.authorType,
      authorId: opts.authorId,
      body: opts.body,
      createdAt,
      ...(opts.file !== undefined ? { file: opts.file } : {}),
      ...(opts.line !== undefined ? { line: opts.line } : {}),
      ...(opts.side !== undefined ? { side: opts.side } : {}),
      ...(opts.commitSha !== undefined ? { commitSha: opts.commitSha } : {}),
      ...(opts.parentCommentId !== undefined ? { parentCommentId: opts.parentCommentId } : {}),
      resolved: false,
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

/** Fetch a single comment by id (NOT_FOUND when it does not exist). */
export async function getComment(
  db: D1Database,
  logger: Logger,
  commentId: string,
): Promise<Result<ChangeComment, AppError>> {
  try {
    const row = await db
      .prepare("SELECT * FROM change_comments WHERE id = ?")
      .bind(commentId)
      .first<CommentRow>();
    if (!row) {
      return err(new AppError(`Comment '${commentId}' not found`, "NOT_FOUND", 404));
    }
    return ok(rowToComment(row));
  } catch (error) {
    const appError = toAppError(error, "getComment", { commentId });
    logger.error("Failed to get comment", appError, { commentId });
    return err(appError);
  }
}

/** Mark a thread-root comment resolved or unresolved. */
export async function setCommentResolved(
  db: D1Database,
  logger: Logger,
  commentId: string,
  resolved: boolean,
): Promise<Result<void, AppError>> {
  try {
    const result = await db
      .prepare("UPDATE change_comments SET resolved = ? WHERE id = ?")
      .bind(resolved ? 1 : 0, commentId)
      .run();
    if ((result.meta?.changes ?? 0) === 0) {
      return err(new AppError(`Comment '${commentId}' not found`, "NOT_FOUND", 404));
    }
    logger.info("Comment resolution updated", { commentId, resolved });
    return ok(undefined);
  } catch (error) {
    const appError = toAppError(error, "setCommentResolved", { commentId });
    logger.error("Failed to update comment resolution", appError, { commentId });
    return err(appError);
  }
}

/**
 * Submit (or replace) a reviewer's verdict on a change.
 *
 * A 'comment' verdict is deliberately non-destructive: it is inserted only
 * when the reviewer has no verdict row yet (recording "reviewed without a
 * verdict"); an existing approve/request_changes is never overwritten or
 * cleared by a later comment-only review. approve/request_changes keep the
 * original upsert semantics and replace whatever verdict came before.
 */
export async function submitReview(
  db: D1Database,
  logger: Logger,
  opts: { changeId: string; reviewerId: string; verdict: ReviewVerdict; comment?: string },
): Promise<Result<ChangeReview, AppError>> {
  const id = newId("rev");
  const createdAt = new Date().toISOString();

  try {
    if (opts.verdict === "comment") {
      // Only record 'comment' when no verdict exists; never clobber one.
      await db
        .prepare(
          `INSERT INTO change_reviews (id, change_id, reviewer_id, verdict, comment, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(change_id, reviewer_id) DO NOTHING`,
        )
        .bind(id, opts.changeId, opts.reviewerId, opts.verdict, opts.comment ?? null, createdAt)
        .run();

      const row = await db
        .prepare("SELECT * FROM change_reviews WHERE change_id = ? AND reviewer_id = ?")
        .bind(opts.changeId, opts.reviewerId)
        .first<ReviewRow>();

      logger.info("Comment-only review recorded", {
        changeId: opts.changeId,
        reviewerId: opts.reviewerId,
        existingVerdictKept: row !== null && row.id !== id,
      });
      // Return the row that is actually current: the fresh 'comment' row, or
      // the untouched pre-existing verdict.
      return ok(
        row
          ? rowToReview(row)
          : {
              id,
              changeId: opts.changeId,
              reviewerId: opts.reviewerId,
              verdict: opts.verdict,
              ...(opts.comment !== undefined ? { comment: opts.comment } : {}),
              createdAt,
            },
      );
    }

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

/**
 * Dismiss every 'approve' verdict on a change because its evaluated revision
 * changed (#193) — those approvals were given for different code and must not
 * count toward requiredApprovals. 'request_changes' verdicts are kept, matching
 * GitHub's dismiss-stale-approvals-on-push semantics. Returns the reviewer IDs
 * whose approvals were dismissed, so callers can record who was dismissed.
 */
export async function dismissApprovals(
  db: D1Database,
  logger: Logger,
  changeId: string,
): Promise<Result<string[], AppError>> {
  try {
    const result = await db
      .prepare(
        "DELETE FROM change_reviews WHERE change_id = ? AND verdict = 'approve' RETURNING reviewer_id",
      )
      .bind(changeId)
      .all<{ reviewer_id: string }>();
    const dismissedReviewerIds = result.results.map((row) => row.reviewer_id);
    if (dismissedReviewerIds.length > 0) {
      logger.info("Stale approvals dismissed", {
        changeId,
        dismissed: dismissedReviewerIds.length,
      });
    }
    return ok(dismissedReviewerIds);
  } catch (error) {
    const appError = toAppError(error, "dismissApprovals", { changeId });
    logger.error("Failed to dismiss approvals", appError, { changeId });
    return err(appError);
  }
}

/** Current approval count for a change (one vote per reviewer). Only
 * verdict = 'approve' rows count — 'request_changes' and comment-only
 * ('comment') reviews never contribute toward requiredApprovals. */
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
