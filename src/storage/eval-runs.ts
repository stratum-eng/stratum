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
  /**
   * Which evaluation pass wrote this row. Shared by every row from one
   * `runEvaluation`, and sortable as a string (see {@link recordEvalRuns}).
   *
   * Absent on rows written before migration 048, where the merge gate falls
   * back to grouping by `ranAt`.
   */
  roundId?: string;
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
  round_id: string | null;
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
  if (typeof row.round_id === "string") run.roundId = row.round_id;
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
      "INSERT INTO eval_runs (id, change_id, evaluator_type, score, passed, reason, issues, ran_at, round_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );

    const runs: EvalRun[] = [];
    const statements: D1PreparedStatement[] = [];

    // One timestamp for the whole batch, not one per row: every run here came
    // from a single `runEvaluation` pass, and rows from one pass must agree on
    // when it happened. Stamping rows individually let a batch straddle a
    // millisecond boundary (#336).
    const ranAt = new Date().toISOString();

    // What actually identifies the round, because equal timestamps do not: two
    // passes can land in the same millisecond (an initial evaluation and a
    // re-evaluation, or two concurrent POST /changes/:id/evaluate calls — that
    // route takes no lock), and the merge gate folding them into one round can
    // block a change on a verdict a later round already superseded.
    //
    // Timestamp-prefixed so it sorts chronologically as a plain string — the
    // prefix is a fixed-width ISO 8601 UTC instant — which lets the gate pick
    // the newest round without a second ordering column.
    //
    // The ordering between two rounds that share a millisecond is stable but
    // arbitrary: the prefixes tie and the random suffix decides. That is a
    // deliberate stopping point rather than an oversight. The gate then applies
    // ONE round's verdict whole instead of mixing two, which is the property
    // that matters; picking the truly later of two sub-millisecond passes would
    // need a shared sequence no isolate can provide, and a pass takes orders of
    // magnitude longer than a millisecond to produce, so the tie needs two
    // concurrent re-evaluations to arise at all.
    const roundId = `${ranAt}#${newId("evr")}`;

    for (const { evaluatorType, result } of results) {
      const id = newId("evl");
      const run: EvalRun = {
        id,
        changeId,
        evaluatorType,
        score: result.score,
        passed: result.passed,
        reason: result.reason,
        ranAt,
        roundId,
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
          roundId,
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
