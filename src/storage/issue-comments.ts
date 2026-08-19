import { AppError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/**
 * Append-only discussion on issues, mirroring change_comments (migration 019).
 * Comments are keyed by the issue's globally-unique id, not its per-project
 * number, so they never cross tenants even for same-named projects.
 */
export interface IssueComment {
  id: string;
  issueId: string;
  authorType: "user" | "agent";
  authorId: string;
  body: string;
  createdAt: string;
}

interface IssueCommentRow {
  id: string;
  issue_id: string;
  author_type: string;
  author_id: string;
  body: string;
  created_at: string;
}

function rowToComment(row: IssueCommentRow): IssueComment {
  return {
    id: row.id,
    issueId: row.issue_id,
    authorType: row.author_type as IssueComment["authorType"],
    authorId: row.author_id,
    body: row.body,
    createdAt: row.created_at,
  };
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

export async function addIssueComment(
  db: D1Database,
  logger: Logger,
  opts: { issueId: string; authorType: "user" | "agent"; authorId: string; body: string },
): Promise<Result<IssueComment, AppError>> {
  const id = newId("icm");
  const createdAt = new Date().toISOString();

  try {
    await db
      .prepare(
        "INSERT INTO issue_comments (id, issue_id, author_type, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(id, opts.issueId, opts.authorType, opts.authorId, opts.body, createdAt)
      .run();

    logger.info("Issue comment added", { commentId: id, issueId: opts.issueId });
    return ok({
      id,
      issueId: opts.issueId,
      authorType: opts.authorType,
      authorId: opts.authorId,
      body: opts.body,
      createdAt,
    });
  } catch (error) {
    const appError = toAppError(error, "addIssueComment", { issueId: opts.issueId });
    logger.error("Failed to add issue comment", appError, { issueId: opts.issueId });
    return err(appError);
  }
}

export async function listIssueComments(
  db: D1Database,
  logger: Logger,
  issueId: string,
  /** LIMIT/OFFSET pagination in chronological (created ASC) order. */
  opts?: { limit?: number; offset?: number },
): Promise<Result<IssueComment[], AppError>> {
  try {
    // rowid is the ORDER BY tiebreaker: created_at has millisecond precision,
    // so two fast comments can share a timestamp and would otherwise paginate
    // non-deterministically. rowid preserves insertion order.
    let sql = "SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at ASC, rowid ASC";
    const binds: unknown[] = [issueId];
    if (opts?.limit !== undefined) {
      sql += " LIMIT ?";
      binds.push(opts.limit);
    } else if (opts?.offset !== undefined) {
      sql += " LIMIT -1";
    }
    if (opts?.offset !== undefined) {
      sql += " OFFSET ?";
      binds.push(opts.offset);
    }
    const result = await db
      .prepare(sql)
      .bind(...binds)
      .all<IssueCommentRow>();
    return ok(result.results.map(rowToComment));
  } catch (error) {
    const appError = toAppError(error, "listIssueComments", { issueId });
    logger.error("Failed to list issue comments", appError, { issueId });
    return err(appError);
  }
}
