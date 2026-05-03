import type { EvalResult } from "../evaluation/types";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export interface EvalRun {
  id: string;
  changeId: string;
  evaluatorType: string;
  score: number;
  passed: boolean;
  reason: string;
  issues?: string[];
  ranAt: string;
}

interface EvalRunRow {
  id: string;
  change_id: string;
  evaluator_type: string;
  score: number;
  passed: number;
  reason: string;
  issues: string | null;
  ran_at: string;
}

function rowToEvalRun(row: EvalRunRow): EvalRun {
  const run: EvalRun = {
    id: row.id,
    changeId: row.change_id,
    evaluatorType: row.evaluator_type,
    score: row.score,
    passed: row.passed === 1,
    reason: row.reason,
    ranAt: row.ran_at,
  };
  if (row.issues !== null) {
    try {
      const parsed = JSON.parse(row.issues);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        run.issues = parsed as string[];
      }
    } catch {
      // ignore malformed issues
    }
  }
  return run;
}

export async function recordEvalRuns(
  db: D1Database,
  logger: Logger,
  changeId: string,
  results: Array<{ evaluatorType: string; result: EvalResult }>,
): Promise<Result<EvalRun[], Error>> {
  logger.info("Recording eval runs", { changeId, count: results.length });

  try {
    const stmt = db.prepare(
      "INSERT INTO eval_runs (id, change_id, evaluator_type, score, passed, reason, issues, ran_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );

    const runs: EvalRun[] = [];
    const statements: D1PreparedStatement[] = [];

    for (const { evaluatorType, result } of results) {
      const id = newId("evl");
      const ranAt = new Date().toISOString();
      const run: EvalRun = {
        id,
        changeId,
        evaluatorType,
        score: result.score,
        passed: result.passed,
        reason: result.reason,
        ranAt,
      };
      if (result.issues !== undefined) run.issues = result.issues;
      runs.push(run);

      statements.push(
        stmt.bind(
          id,
          changeId,
          evaluatorType,
          result.score,
          result.passed ? 1 : 0,
          result.reason,
          result.issues !== undefined ? JSON.stringify(result.issues) : null,
          ranAt,
        ),
      );
    }

    await db.batch(statements);
    logger.info("Eval runs recorded successfully", { changeId, count: runs.length });
    return ok(runs);
  } catch (error) {
    logger.error("Failed to record eval runs", error instanceof Error ? error : undefined, {
      changeId,
      count: results.length,
    });
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

export async function listEvalRuns(
  db: D1Database,
  logger: Logger,
  changeId: string,
): Promise<Result<EvalRun[], Error>> {
  logger.debug("Listing eval runs", { changeId });

  try {
    const result = await db
      .prepare("SELECT * FROM eval_runs WHERE change_id = ? ORDER BY ran_at ASC")
      .bind(changeId)
      .all<EvalRunRow>();

    logger.debug("Eval runs listed", { changeId, count: result.results.length });
    return ok(result.results.map(rowToEvalRun));
  } catch (error) {
    logger.error("Failed to list eval runs", error instanceof Error ? error : undefined, {
      changeId,
    });
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
