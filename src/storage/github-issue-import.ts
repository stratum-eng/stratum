/**
 * Storage for the GitHub issue importer (#421), migration 064.
 *
 * Three concerns live here: the run log (`github_issue_imports`), the number
 * map that makes a re-run update rather than duplicate (`github_issue_map`,
 * `github_issue_comment_map`), and the writes that create or refresh an
 * imported issue. Each write that creates something also records its mapping in
 * the same D1 batch — a batch is one transaction — so an issue can never exist
 * without the mapping that stops the next run from creating it again.
 */

import { AppError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export type IssueImportStatus = "queued" | "running" | "completed" | "failed";

export interface IssueImportResume {
  /** GitHub number of the issue to resume at. */
  issue: number;
  /** Page of its comments to resume at; 1 means the issue itself is still to do. */
  commentPage: number;
}

export interface IssueImportRun {
  id: string;
  projectId: string;
  /** `owner/repo` of the GitHub source. */
  githubRepo: string;
  status: IssueImportStatus;
  initiatedBy: string;
  nextPage: number;
  /** Where the current page resumes after running out of its per-message budget. */
  resume?: IssueImportResume;
  issuesCreated: number;
  issuesUpdated: number;
  commentsImported: number;
  pullsSkipped: number;
  /** Progress or failure detail for people, e.g. a rate-limit wait. */
  message?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

interface IssueImportRunRow {
  id: string;
  project_id: string;
  github_repo: string;
  status: string;
  initiated_by: string;
  next_page: number;
  resume_issue: number | null;
  resume_comment_page: number | null;
  issues_created: number;
  issues_updated: number;
  comments_imported: number;
  pulls_skipped: number;
  message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/**
 * How long an active run may go without progress before a new one may replace
 * it. Generous on purpose: a run legitimately sits idle while it waits out a
 * GitHub rate limit, which resets hourly. Without this, a run whose queue
 * message was lost would block every future import for the project.
 */
export const STALE_RUN_MS = 2 * 60 * 60 * 1000;

function rowToRun(row: IssueImportRunRow): IssueImportRun {
  const run: IssueImportRun = {
    id: row.id,
    projectId: row.project_id,
    githubRepo: row.github_repo,
    status: row.status as IssueImportStatus,
    initiatedBy: row.initiated_by,
    nextPage: row.next_page,
    issuesCreated: row.issues_created,
    issuesUpdated: row.issues_updated,
    commentsImported: row.comments_imported,
    pullsSkipped: row.pulls_skipped,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.resume_issue !== null && row.resume_comment_page !== null) {
    run.resume = { issue: row.resume_issue, commentPage: row.resume_comment_page };
  }
  if (row.message !== null) run.message = row.message;
  if (row.completed_at !== null) run.completedAt = row.completed_at;
  return run;
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

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

/**
 * Open a new run for a project, or refuse with `IMPORT_ACTIVE` (409) when one
 * is already queued or running. An active run that has made no progress for
 * {@link STALE_RUN_MS} is failed first so it cannot block the project forever.
 */
export async function createIssueImportRun(
  db: D1Database,
  logger: Logger,
  opts: { projectId: string; githubRepo: string; initiatedBy: string },
): Promise<Result<IssueImportRun, AppError>> {
  const now = new Date();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - STALE_RUN_MS).toISOString();
  const id = newId("ghi");
  try {
    await db
      .prepare(
        `UPDATE github_issue_imports
            SET status = 'failed', message = 'Abandoned: no progress for two hours', updated_at = ?, completed_at = ?
          WHERE project_id = ? AND status IN ('queued','running') AND updated_at < ?`,
      )
      .bind(nowIso, nowIso, opts.projectId, staleBefore)
      .run();
    const row = await db
      .prepare(
        `INSERT INTO github_issue_imports (id, project_id, github_repo, status, initiated_by, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?)
         RETURNING *`,
      )
      .bind(id, opts.projectId, opts.githubRepo, opts.initiatedBy, nowIso, nowIso)
      .first<IssueImportRunRow>();
    if (!row) {
      return err(new AppError("Import run insert returned no row", "DATABASE_ERROR", 500));
    }
    logger.info("GitHub issue import queued", { runId: id, projectId: opts.projectId });
    return ok(rowToRun(row));
  } catch (error) {
    // The partial unique index allows one queued/running run per project.
    if (isUniqueViolation(error)) {
      return err(
        new AppError(
          "An issue import is already in progress for this project",
          "IMPORT_ACTIVE",
          409,
        ),
      );
    }
    const appError = toAppError(error, "createIssueImportRun", { projectId: opts.projectId });
    logger.error("Failed to create issue import run", appError);
    return err(appError);
  }
}

export async function getIssueImportRun(
  db: D1Database,
  logger: Logger,
  runId: string,
): Promise<Result<IssueImportRun | null, AppError>> {
  try {
    const row = await db
      .prepare("SELECT * FROM github_issue_imports WHERE id = ?")
      .bind(runId)
      .first<IssueImportRunRow>();
    return ok(row ? rowToRun(row) : null);
  } catch (error) {
    const appError = toAppError(error, "getIssueImportRun", { runId });
    logger.error("Failed to load issue import run", appError);
    return err(appError);
  }
}

/** The project's most recent run, or null when it has never imported. */
export async function getLatestIssueImportRun(
  db: D1Database,
  logger: Logger,
  projectId: string,
): Promise<Result<IssueImportRun | null, AppError>> {
  try {
    const row = await db
      .prepare(
        "SELECT * FROM github_issue_imports WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .bind(projectId)
      .first<IssueImportRunRow>();
    return ok(row ? rowToRun(row) : null);
  } catch (error) {
    const appError = toAppError(error, "getLatestIssueImportRun", { projectId });
    logger.error("Failed to load latest issue import run", appError);
    return err(appError);
  }
}

export interface IssueImportProgress {
  status?: IssueImportStatus;
  nextPage?: number;
  /** `null` means the next message starts its page from the top. */
  resume?: IssueImportResume | null;
  /** Added to the run's running totals, not assigned. */
  issuesCreated?: number;
  issuesUpdated?: number;
  commentsImported?: number;
  pullsSkipped?: number;
  /** `null` clears a previous message. */
  message?: string | null;
}

/** Advance a run: bump its counters, and set its status/page/message. */
export async function recordIssueImportProgress(
  db: D1Database,
  logger: Logger,
  runId: string,
  progress: IssueImportProgress,
): Promise<Result<void, AppError>> {
  const now = new Date().toISOString();
  const assignments = [
    "updated_at = ?",
    "issues_created = issues_created + ?",
    "issues_updated = issues_updated + ?",
    "comments_imported = comments_imported + ?",
    "pulls_skipped = pulls_skipped + ?",
  ];
  const binds: unknown[] = [
    now,
    progress.issuesCreated ?? 0,
    progress.issuesUpdated ?? 0,
    progress.commentsImported ?? 0,
    progress.pullsSkipped ?? 0,
  ];
  if (progress.status !== undefined) {
    assignments.push("status = ?");
    binds.push(progress.status);
    if (progress.status === "completed" || progress.status === "failed") {
      assignments.push("completed_at = ?");
      binds.push(now);
    }
  }
  if (progress.nextPage !== undefined) {
    assignments.push("next_page = ?");
    binds.push(progress.nextPage);
  }
  if (progress.resume !== undefined) {
    assignments.push("resume_issue = ?", "resume_comment_page = ?");
    binds.push(progress.resume?.issue ?? null, progress.resume?.commentPage ?? null);
  }
  if (progress.message !== undefined) {
    assignments.push("message = ?");
    binds.push(progress.message);
  }
  binds.push(runId);
  try {
    await db
      .prepare(`UPDATE github_issue_imports SET ${assignments.join(", ")} WHERE id = ?`)
      .bind(...binds)
      .run();
    return ok(undefined);
  } catch (error) {
    const appError = toAppError(error, "recordIssueImportProgress", { runId });
    logger.error("Failed to record issue import progress", appError);
    return err(appError);
  }
}

/** GitHub issue number → Stratum issue number, for one project and source repo. */
export async function loadIssueNumberMap(
  db: D1Database,
  logger: Logger,
  projectId: string,
  githubRepo: string,
): Promise<Result<Map<number, { issueId: string; number: number }>, AppError>> {
  try {
    const result = await db
      .prepare(
        "SELECT github_number, issue_id, stratum_number FROM github_issue_map WHERE project_id = ? AND github_repo = ?",
      )
      .bind(projectId, githubRepo)
      .all<{ github_number: number; issue_id: string; stratum_number: number }>();
    return ok(
      new Map(
        result.results.map((row) => [
          row.github_number,
          { issueId: row.issue_id, number: row.stratum_number },
        ]),
      ),
    );
  } catch (error) {
    const appError = toAppError(error, "loadIssueNumberMap", { projectId });
    logger.error("Failed to load GitHub issue number map", appError);
    return err(appError);
  }
}

/**
 * The Stratum user linked to a GitHub account, by GitHub's numeric id. The id,
 * not the login: a login can be renamed and re-registered by someone else, and
 * attributing an issue to the wrong person is worse than showing a login.
 */
export async function findUserByGitHubId(
  db: D1Database,
  logger: Logger,
  githubId: string,
): Promise<Result<string | null, AppError>> {
  try {
    const row = await db
      .prepare("SELECT id FROM users WHERE github_id = ?")
      .bind(githubId)
      .first<{ id: string }>();
    return ok(row?.id ?? null);
  } catch (error) {
    const appError = toAppError(error, "findUserByGitHubId", {});
    logger.error("Failed to look up user by GitHub id", appError);
    return err(appError);
  }
}

export interface ImportedIssueFields {
  projectId: string;
  /** The project's free-form name, written to the legacy `issues.project` column. */
  projectName: string;
  githubRepo: string;
  githubNumber: number;
  githubUrl: string;
  title: string;
  body: string | null;
  status: "open" | "closed";
  labels: string[];
  /** Author for a new issue: a matched Stratum user, or the importer. */
  authorId: string;
  /** GitHub login when the author has no Stratum account; null when matched. */
  externalAuthor: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/** Who an imported issue reads as closed by. Not a user id; never resolved as one. */
export const IMPORTED_CLOSED_BY = "github-import";

function labelStatements(db: D1Database, issueId: string, labels: string[], now: string) {
  return [
    db.prepare("DELETE FROM issue_labels WHERE issue_id = ?").bind(issueId),
    ...labels.map((label) =>
      db
        .prepare("INSERT INTO issue_labels (issue_id, label, created_at) VALUES (?, ?, ?)")
        .bind(issueId, label, now),
    ),
  ];
}

/**
 * Create the Stratum issue for a GitHub issue, or refresh the one a previous
 * run created. `existing` comes from {@link loadIssueNumberMap}.
 *
 * A refresh overwrites title, body, state, labels and timestamps with GitHub's
 * current values — the importer exists to catch up before a cutover, so GitHub
 * is the source of truth until then — but leaves authorship alone, so re-running
 * as a different admin does not re-attribute issues.
 */
export async function upsertImportedIssue(
  db: D1Database,
  logger: Logger,
  fields: ImportedIssueFields,
  existing: { issueId: string; number: number } | undefined,
): Promise<Result<{ issueId: string; number: number; created: boolean }, AppError>> {
  const now = new Date().toISOString();
  const closedBy = fields.status === "closed" ? IMPORTED_CLOSED_BY : null;
  try {
    if (existing) {
      await db.batch([
        db
          .prepare(
            `UPDATE issues
                SET title = ?, body = ?, status = ?, closed_at = ?, closed_by = ?,
                    external_url = ?, updated_at = ?
              WHERE id = ?`,
          )
          .bind(
            fields.title,
            fields.body,
            fields.status,
            fields.closedAt,
            closedBy,
            fields.githubUrl,
            fields.updatedAt,
            existing.issueId,
          ),
        ...labelStatements(db, existing.issueId, fields.labels, now),
        db
          .prepare(
            "UPDATE github_issue_map SET github_url = ?, updated_at = ? WHERE project_id = ? AND github_repo = ? AND github_number = ?",
          )
          .bind(fields.githubUrl, now, fields.projectId, fields.githubRepo, fields.githubNumber),
      ]);
      return ok({ ...existing, created: false });
    }

    const issueId = newId("iss");
    // Numbered exactly as createIssue numbers a native issue (see the comment
    // there for why the values are bound twice rather than reused by index).
    // The mapping row is written in the same batch from the inserted row, so it
    // carries the number SQLite actually assigned, and the composite primary key
    // makes a concurrent duplicate of this GitHub issue roll the whole batch back.
    await db.batch([
      db
        .prepare(
          `INSERT INTO issues (id, project, project_id, number, title, body, status, author_type, author_id,
                               closed_at, closed_by, external_author, external_url, created_at, updated_at)
           VALUES (?, ?, ?,
                   (SELECT COALESCE(MAX(number), 0) + 1 FROM issues
                     WHERE (project_id = ? OR (project_id IS NULL AND project = ?))),
                   ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          issueId,
          fields.projectName,
          fields.projectId,
          fields.projectId,
          fields.projectName,
          fields.title,
          fields.body,
          fields.status,
          fields.authorId,
          fields.closedAt,
          closedBy,
          fields.externalAuthor,
          fields.githubUrl,
          fields.createdAt,
          fields.updatedAt,
        ),
      db
        .prepare(
          `INSERT INTO github_issue_map (project_id, github_repo, github_number, issue_id, stratum_number, github_url, created_at, updated_at)
           SELECT ?, ?, ?, id, number, ?, ?, ? FROM issues WHERE id = ?`,
        )
        .bind(
          fields.projectId,
          fields.githubRepo,
          fields.githubNumber,
          fields.githubUrl,
          now,
          now,
          issueId,
        ),
      ...labelStatements(db, issueId, fields.labels, now),
    ]);
    const row = await db
      .prepare("SELECT number FROM issues WHERE id = ?")
      .bind(issueId)
      .first<{ number: number }>();
    if (!row) {
      return err(new AppError("Imported issue vanished after insert", "DATABASE_ERROR", 500));
    }
    return ok({ issueId, number: row.number, created: true });
  } catch (error) {
    const appError = toAppError(error, "upsertImportedIssue", {
      projectId: fields.projectId,
      githubNumber: fields.githubNumber,
    });
    logger.error("Failed to write imported issue", appError);
    return err(appError);
  }
}

/** GitHub comment id → Stratum comment id, for one imported issue. */
export async function loadCommentMap(
  db: D1Database,
  logger: Logger,
  issueId: string,
): Promise<Result<Map<number, string>, AppError>> {
  try {
    const result = await db
      .prepare(
        "SELECT github_comment_id, comment_id FROM github_issue_comment_map WHERE issue_id = ?",
      )
      .bind(issueId)
      .all<{ github_comment_id: number; comment_id: string }>();
    return ok(new Map(result.results.map((row) => [row.github_comment_id, row.comment_id])));
  } catch (error) {
    const appError = toAppError(error, "loadCommentMap", { issueId });
    logger.error("Failed to load GitHub comment map", appError);
    return err(appError);
  }
}

export interface ImportedCommentFields {
  issueId: string;
  githubCommentId: number;
  githubUrl: string;
  body: string;
  authorId: string;
  externalAuthor: string | null;
  createdAt: string;
}

/**
 * Create an imported comment (and its mapping, atomically), or refresh the body
 * of one a previous run created. A comment deleted on GitHub is left in place:
 * the importer adds and updates, it never deletes.
 */
export async function upsertImportedComment(
  db: D1Database,
  logger: Logger,
  fields: ImportedCommentFields,
  existingCommentId: string | undefined,
): Promise<Result<{ commentId: string; created: boolean }, AppError>> {
  try {
    if (existingCommentId !== undefined) {
      await db
        .prepare("UPDATE issue_comments SET body = ?, external_url = ? WHERE id = ?")
        .bind(fields.body, fields.githubUrl, existingCommentId)
        .run();
      return ok({ commentId: existingCommentId, created: false });
    }
    const commentId = newId("icm");
    await db.batch([
      db
        .prepare(
          `INSERT INTO issue_comments (id, issue_id, author_type, author_id, body, external_author, external_url, created_at)
           VALUES (?, ?, 'user', ?, ?, ?, ?, ?)`,
        )
        .bind(
          commentId,
          fields.issueId,
          fields.authorId,
          fields.body,
          fields.externalAuthor,
          fields.githubUrl,
          fields.createdAt,
        ),
      db
        .prepare(
          "INSERT INTO github_issue_comment_map (issue_id, github_comment_id, comment_id, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(fields.issueId, fields.githubCommentId, commentId, new Date().toISOString()),
    ]);
    return ok({ commentId, created: true });
  } catch (error) {
    const appError = toAppError(error, "upsertImportedComment", {
      issueId: fields.issueId,
      githubCommentId: fields.githubCommentId,
    });
    logger.error("Failed to write imported comment", appError);
    return err(appError);
  }
}
