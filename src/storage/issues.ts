import { AppError, NotFoundError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export type IssueStatus = "open" | "closed";

export interface Issue {
  id: string;
  project: string;
  number: number;
  title: string;
  body?: string;
  status: IssueStatus;
  authorType: "user" | "agent";
  authorId: string;
  linkedChangeId?: string;
  closedAt?: string;
  closedBy?: string;
  createdAt: string;
  updatedAt: string;
}

interface IssueRow {
  id: string;
  project: string;
  number: number;
  title: string;
  body: string | null;
  status: string;
  author_type: string;
  author_id: string;
  linked_change_id: string | null;
  closed_at: string | null;
  closed_by: string | null;
  created_at: string;
  updated_at: string;
}

function rowToIssue(row: IssueRow): Issue {
  const issue: Issue = {
    id: row.id,
    project: row.project,
    number: row.number,
    title: row.title,
    status: row.status as IssueStatus,
    authorType: row.author_type as Issue["authorType"],
    authorId: row.author_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.body !== null) issue.body = row.body;
  if (row.linked_change_id !== null) issue.linkedChangeId = row.linked_change_id;
  if (row.closed_at !== null) issue.closedAt = row.closed_at;
  if (row.closed_by !== null) issue.closedBy = row.closed_by;
  return issue;
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

export async function createIssue(
  db: D1Database,
  logger: Logger,
  opts: {
    project: string;
    title: string;
    body?: string;
    authorType: "user" | "agent";
    authorId: string;
    linkedChangeId?: string;
  },
): Promise<Result<Issue, AppError>> {
  const id = newId("iss");
  const now = new Date().toISOString();

  try {
    // The per-project number is assigned inside the INSERT so concurrent
    // creates cannot race: SQLite executes the scalar subquery and the
    // insert as one serialized statement.
    const row = await db
      .prepare(
        `INSERT INTO issues (id, project, number, title, body, status, author_type, author_id, linked_change_id, created_at, updated_at)
         VALUES (?1, ?2, (SELECT COALESCE(MAX(number), 0) + 1 FROM issues WHERE project = ?2), ?3, ?4, 'open', ?5, ?6, ?7, ?8, ?8)
         RETURNING *`,
      )
      .bind(
        id,
        opts.project,
        opts.title,
        opts.body ?? null,
        opts.authorType,
        opts.authorId,
        opts.linkedChangeId ?? null,
        now,
      )
      .first<IssueRow>();

    if (!row) {
      return err(
        new AppError("Issue insert returned no row", "DATABASE_ERROR", 500, {
          operation: "createIssue",
        }),
      );
    }

    logger.info("Issue created", { issueId: id, project: opts.project, number: row.number });
    return ok(rowToIssue(row));
  } catch (error) {
    const appError = toAppError(error, "createIssue", { project: opts.project });
    logger.error("Failed to create issue", appError, { project: opts.project });
    return err(appError);
  }
}

export async function getIssueByNumber(
  db: D1Database,
  logger: Logger,
  project: string,
  number: number,
): Promise<Result<Issue, NotFoundError | AppError>> {
  try {
    const row = await db
      .prepare("SELECT * FROM issues WHERE project = ? AND number = ?")
      .bind(project, number)
      .first<IssueRow>();
    if (!row) {
      logger.debug("Issue not found", { project, number });
      return err(new NotFoundError("Issue", `${project}#${number}`));
    }
    return ok(rowToIssue(row));
  } catch (error) {
    const appError = toAppError(error, "getIssueByNumber", { project, number });
    logger.error("Failed to get issue", appError, { project, number });
    return err(appError);
  }
}

export async function listIssues(
  db: D1Database,
  logger: Logger,
  project: string,
  status?: IssueStatus,
): Promise<Result<Issue[], AppError>> {
  try {
    const result = status
      ? await db
          .prepare("SELECT * FROM issues WHERE project = ? AND status = ? ORDER BY number DESC")
          .bind(project, status)
          .all<IssueRow>()
      : await db
          .prepare("SELECT * FROM issues WHERE project = ? ORDER BY number DESC")
          .bind(project)
          .all<IssueRow>();
    return ok(result.results.map(rowToIssue));
  } catch (error) {
    const appError = toAppError(error, "listIssues", { project });
    logger.error("Failed to list issues", appError, { project });
    return err(appError);
  }
}

export async function updateIssue(
  db: D1Database,
  logger: Logger,
  project: string,
  number: number,
  opts: {
    title?: string;
    body?: string;
    status?: IssueStatus;
    linkedChangeId?: string | null;
    actorId: string;
  },
): Promise<Result<Issue, NotFoundError | AppError>> {
  try {
    const existing = await getIssueByNumber(db, logger, project, number);
    if (!existing.success) return existing;

    const now = new Date().toISOString();
    const assignments = ["updated_at = ?"];
    const bindings: unknown[] = [now];

    if (opts.title !== undefined) {
      assignments.push("title = ?");
      bindings.push(opts.title);
    }
    if (opts.body !== undefined) {
      assignments.push("body = ?");
      bindings.push(opts.body);
    }
    if (opts.linkedChangeId !== undefined) {
      assignments.push("linked_change_id = ?");
      bindings.push(opts.linkedChangeId);
    }
    if (opts.status !== undefined && opts.status !== existing.data.status) {
      assignments.push("status = ?");
      bindings.push(opts.status);
      if (opts.status === "closed") {
        assignments.push("closed_at = ?", "closed_by = ?");
        bindings.push(now, opts.actorId);
      } else {
        assignments.push("closed_at = NULL", "closed_by = NULL");
      }
    }

    bindings.push(project, number);
    await db
      .prepare(`UPDATE issues SET ${assignments.join(", ")} WHERE project = ? AND number = ?`)
      .bind(...bindings)
      .run();

    const updated = await getIssueByNumber(db, logger, project, number);
    if (!updated.success) return updated;
    logger.info("Issue updated", { project, number });
    return updated;
  } catch (error) {
    const appError = toAppError(error, "updateIssue", { project, number });
    logger.error("Failed to update issue", appError, { project, number });
    return err(appError);
  }
}

/** Open issues linked to a change — used by the merge auto-close handler. */
export async function listOpenIssuesByChange(
  db: D1Database,
  logger: Logger,
  changeId: string,
): Promise<Result<Issue[], AppError>> {
  try {
    const result = await db
      .prepare("SELECT * FROM issues WHERE linked_change_id = ? AND status = 'open'")
      .bind(changeId)
      .all<IssueRow>();
    return ok(result.results.map(rowToIssue));
  } catch (error) {
    const appError = toAppError(error, "listOpenIssuesByChange", { changeId });
    logger.error("Failed to list issues by change", appError, { changeId });
    return err(appError);
  }
}

/** Close an issue on behalf of the system (merge auto-close). */
export async function closeIssue(
  db: D1Database,
  logger: Logger,
  project: string,
  number: number,
  closedBy: string,
): Promise<Result<Issue, NotFoundError | AppError>> {
  return updateIssue(db, logger, project, number, { status: "closed", actorId: closedBy });
}
