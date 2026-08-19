import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/**
 * Free-form label strings per issue (migration 036). Deliberately a flat
 * (issue_id, label) table instead of a label catalog + join: at this scale the
 * only operations are set/remove/list/filter, and a catalog (colors,
 * descriptions) can layer on later without rewriting these rows.
 */

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

/**
 * Replace an issue's label set. The full set is written each time (a delete +
 * inserts in one atomic batch), which keeps "add" and "remove" a single
 * operation and makes the endpoint idempotent.
 */
export async function setIssueLabels(
  db: D1Database,
  logger: Logger,
  issueId: string,
  labels: string[],
): Promise<Result<string[], AppError>> {
  const createdAt = new Date().toISOString();
  // Dedupe exact strings; SQL would reject duplicates on the primary key.
  const unique = [...new Set(labels)];

  try {
    const statements = [
      db.prepare("DELETE FROM issue_labels WHERE issue_id = ?").bind(issueId),
      ...unique.map((label) =>
        db
          .prepare("INSERT INTO issue_labels (issue_id, label, created_at) VALUES (?, ?, ?)")
          .bind(issueId, label, createdAt),
      ),
    ];
    await db.batch(statements);
    logger.info("Issue labels set", { issueId, count: unique.length });
    return ok(unique);
  } catch (error) {
    const appError = toAppError(error, "setIssueLabels", { issueId });
    logger.error("Failed to set issue labels", appError, { issueId });
    return err(appError);
  }
}

/** Labels for one issue, sorted for stable display. */
export async function listIssueLabels(
  db: D1Database,
  logger: Logger,
  issueId: string,
): Promise<Result<string[], AppError>> {
  try {
    const result = await db
      .prepare("SELECT label FROM issue_labels WHERE issue_id = ? ORDER BY label ASC")
      .bind(issueId)
      .all<{ label: string }>();
    return ok(result.results.map((r) => r.label));
  } catch (error) {
    const appError = toAppError(error, "listIssueLabels", { issueId });
    logger.error("Failed to list issue labels", appError, { issueId });
    return err(appError);
  }
}

/**
 * Labels for many issues in one query (issue list rendering / API listing).
 * Returns a map of issue id → sorted labels; issues without labels are absent.
 */
export async function getLabelsForIssues(
  db: D1Database,
  logger: Logger,
  issueIds: string[],
): Promise<Result<Record<string, string[]>, AppError>> {
  if (issueIds.length === 0) return ok({});
  try {
    const placeholders = issueIds.map(() => "?").join(", ");
    const result = await db
      .prepare(
        `SELECT issue_id, label FROM issue_labels WHERE issue_id IN (${placeholders}) ORDER BY label ASC`,
      )
      .bind(...issueIds)
      .all<{ issue_id: string; label: string }>();
    const byIssue: Record<string, string[]> = {};
    for (const row of result.results) {
      const labels = byIssue[row.issue_id] ?? [];
      labels.push(row.label);
      byIssue[row.issue_id] = labels;
    }
    return ok(byIssue);
  } catch (error) {
    const appError = toAppError(error, "getLabelsForIssues", { count: issueIds.length });
    logger.error("Failed to load labels for issues", appError, {});
    return err(appError);
  }
}
