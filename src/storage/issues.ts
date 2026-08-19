import { AppError, NotFoundError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export type IssueStatus = "open" | "closed";

export interface Issue {
  id: string;
  project: string;
  /** Globally-unique project UUID; NULL on rows written before dual-write. */
  projectId?: string;
  number: number;
  title: string;
  body?: string;
  status: IssueStatus;
  authorType: "user" | "agent";
  authorId: string;
  /** Single assignee (a user id) — one assignee per issue by design (#198). */
  assignee?: string;
  linkedChangeId?: string;
  closedAt?: string;
  closedBy?: string;
  createdAt: string;
  updatedAt: string;
}

interface IssueRow {
  id: string;
  project: string;
  project_id: string | null;
  number: number;
  title: string;
  body: string | null;
  status: string;
  author_type: string;
  author_id: string;
  /** Absent (undefined) when a pre-036 stub row omits the column. */
  assignee?: string | null;
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
  if (row.project_id !== null) issue.projectId = row.project_id;
  if (row.body !== null) issue.body = row.body;
  if (row.assignee != null) issue.assignee = row.assignee;
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
    projectId?: string;
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
    // insert as one serialized statement. Numbering is scoped by the canonical
    // project_id (migration 035), with a legacy name fallback so a project that
    // already has pre-migration (NULL project_id) issues keeps counting up from
    // its highest existing number instead of restarting at 1.
    const row = await db
      .prepare(
        `INSERT INTO issues (id, project, project_id, number, title, body, status, author_type, author_id, linked_change_id, created_at, updated_at)
         VALUES (?1, ?2, ?9, (SELECT COALESCE(MAX(number), 0) + 1 FROM issues WHERE (project_id = ?9 OR (project_id IS NULL AND project = ?2))), ?3, ?4, 'open', ?5, ?6, ?7, ?8, ?8)
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
        opts.projectId ?? null,
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
  opts?: { projectId?: string },
): Promise<Result<Issue, NotFoundError | AppError>> {
  try {
    // Scope by the canonical project_id when known, falling back to the free-form
    // name only for legacy rows whose project_id wasn't backfilled. Matching purely
    // on `project` would return a same-named project's issue in ANOTHER namespace.
    const row = opts?.projectId
      ? await db
          .prepare(
            "SELECT * FROM issues WHERE (project_id = ? OR (project_id IS NULL AND project = ?)) AND number = ?",
          )
          .bind(opts.projectId, project, number)
          .first<IssueRow>()
      : await db
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

/**
 * Escape `%`, `_`, and `\` in user text so it matches literally inside a
 * `LIKE ? ESCAPE '\'` pattern.
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function listIssues(
  db: D1Database,
  logger: Logger,
  project: string,
  status?: IssueStatus,
  opts?: {
    projectId?: string;
    limit?: number;
    /** Rows to skip (LIMIT/OFFSET pagination); only meaningful with results ordered by number DESC. */
    offset?: number;
    /** Only issues carrying this exact label. */
    label?: string;
    /** Only issues assigned to this user id. */
    assignee?: string;
    /** Case-insensitive substring match over title + body (SQL LIKE; % and _ are escaped). */
    search?: string;
  },
): Promise<Result<Issue[], AppError>> {
  try {
    // project_id-first with a legacy name fallback (see getIssueByNumber).
    const scope = opts?.projectId
      ? {
          clause: "(project_id = ? OR (project_id IS NULL AND project = ?))",
          binds: [opts.projectId, project],
        }
      : { clause: "project = ?", binds: [project] };

    const conditions = [scope.clause];
    const binds: unknown[] = [...scope.binds];
    if (status) {
      conditions.push("status = ?");
      binds.push(status);
    }
    if (opts?.label !== undefined) {
      conditions.push("id IN (SELECT issue_id FROM issue_labels WHERE label = ?)");
      binds.push(opts.label);
    }
    if (opts?.assignee !== undefined) {
      conditions.push("assignee = ?");
      binds.push(opts.assignee);
    }
    if (opts?.search !== undefined) {
      // LIKE over title+body is fine at D1 scale; escape the pattern metachars
      // so user text always matches literally. body is nullable — COALESCE keeps
      // the OR two-valued instead of NULL when only the title matches.
      conditions.push("(title LIKE ? ESCAPE '\\' OR COALESCE(body, '') LIKE ? ESCAPE '\\')");
      const pattern = `%${escapeLike(opts.search)}%`;
      binds.push(pattern, pattern);
    }

    // Bound the response when asked (the API route does); internal callers that
    // omit `limit` still get every row. OFFSET needs a LIMIT clause in SQLite,
    // so an offset without a limit rides on LIMIT -1 (unlimited).
    let pageClause = "";
    if (opts?.limit !== undefined) {
      pageClause = " LIMIT ?";
      binds.push(opts.limit);
    } else if (opts?.offset !== undefined) {
      pageClause = " LIMIT -1";
    }
    if (opts?.offset !== undefined) {
      pageClause += " OFFSET ?";
      binds.push(opts.offset);
    }

    const result = await db
      .prepare(
        `SELECT * FROM issues WHERE ${conditions.join(" AND ")} ORDER BY number DESC${pageClause}`,
      )
      .bind(...binds)
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
    /** Set (string) or clear (null) the single assignee. */
    assignee?: string | null;
    actorId: string;
    projectId?: string;
  },
): Promise<Result<Issue, NotFoundError | AppError>> {
  try {
    const scope = opts.projectId !== undefined ? { projectId: opts.projectId } : undefined;
    const existing = await getIssueByNumber(db, logger, project, number, scope);
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
    if (opts.assignee !== undefined) {
      assignments.push("assignee = ?");
      bindings.push(opts.assignee);
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

    // Scope the write by project_id too, so a same-named project in another
    // namespace can never be updated through this path.
    if (scope) {
      bindings.push(scope.projectId, project, number);
      await db
        .prepare(
          `UPDATE issues SET ${assignments.join(", ")} WHERE (project_id = ? OR (project_id IS NULL AND project = ?)) AND number = ?`,
        )
        .bind(...bindings)
        .run();
    } else {
      bindings.push(project, number);
      await db
        .prepare(`UPDATE issues SET ${assignments.join(", ")} WHERE project = ? AND number = ?`)
        .bind(...bindings)
        .run();
    }

    const updated = await getIssueByNumber(db, logger, project, number, scope);
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
