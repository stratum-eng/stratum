import { AppError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export type CostKind = "llm_tokens" | "sandbox_ms" | "git_ops";

export interface CostSample {
  kind: CostKind;
  quantity: number;
  /** True when the quantity is an estimate (e.g. character-based token counts). */
  estimated?: boolean;
}

export interface CostSummaryEntry {
  kind: CostKind;
  total: number;
  estimated: boolean;
}

interface SummaryRow {
  kind: string;
  total: number;
  any_estimated: number;
}

/**
 * Record cost samples for a change. Best-effort: failures are logged and
 * reported, but callers treat cost recording as non-blocking.
 */
export async function recordCosts(
  db: D1Database,
  logger: Logger,
  opts: { project: string; changeId?: string; workspace?: string },
  samples: CostSample[],
): Promise<Result<void, AppError>> {
  if (samples.length === 0) return ok(undefined);
  const createdAt = new Date().toISOString();

  try {
    const stmt = db.prepare(
      "INSERT INTO cost_records (id, project, change_id, workspace, kind, quantity, estimated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    await db.batch(
      samples.map((sample) =>
        stmt.bind(
          newId("cost"),
          opts.project,
          opts.changeId ?? null,
          opts.workspace ?? null,
          sample.kind,
          sample.quantity,
          sample.estimated ? 1 : 0,
          createdAt,
        ),
      ),
    );
    logger.debug("Cost samples recorded", {
      project: opts.project,
      changeId: opts.changeId,
      count: samples.length,
    });
    return ok(undefined);
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to record costs",
            "DATABASE_ERROR",
            500,
            { operation: "recordCosts", project: opts.project },
          );
    logger.error("Failed to record cost samples", appError, { project: opts.project });
    return err(appError);
  }
}

export async function getChangeCostSummary(
  db: D1Database,
  logger: Logger,
  changeId: string,
): Promise<Result<CostSummaryEntry[], AppError>> {
  try {
    const result = await db
      .prepare(
        "SELECT kind, SUM(quantity) AS total, MAX(estimated) AS any_estimated FROM cost_records WHERE change_id = ? GROUP BY kind",
      )
      .bind(changeId)
      .all<SummaryRow>();
    return ok(
      result.results.map((row) => ({
        kind: row.kind as CostKind,
        total: row.total,
        estimated: row.any_estimated === 1,
      })),
    );
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to summarize costs",
            "DATABASE_ERROR",
            500,
            { operation: "getChangeCostSummary", changeId },
          );
    logger.error("Failed to get change cost summary", appError, { changeId });
    return err(appError);
  }
}

export async function getProjectCostSummary(
  db: D1Database,
  logger: Logger,
  project: string,
): Promise<Result<CostSummaryEntry[], AppError>> {
  try {
    const result = await db
      .prepare(
        "SELECT kind, SUM(quantity) AS total, MAX(estimated) AS any_estimated FROM cost_records WHERE project = ? GROUP BY kind",
      )
      .bind(project)
      .all<SummaryRow>();
    return ok(
      result.results.map((row) => ({
        kind: row.kind as CostKind,
        total: row.total,
        estimated: row.any_estimated === 1,
      })),
    );
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to summarize costs",
            "DATABASE_ERROR",
            500,
            { operation: "getProjectCostSummary", project },
          );
    logger.error("Failed to get project cost summary", appError, { project });
    return err(appError);
  }
}
