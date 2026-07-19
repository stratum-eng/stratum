import { AppError, NotFoundError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export interface ProvenanceRecord {
  id: string;
  commitSha: string;
  project: string;
  workspace: string;
  changeId: string;
  agentId?: string;
  evalScore?: number;
  /** The model that authored the change, snapshotted at change creation. */
  model?: string;
  /** The prompt hash that shaped the change, snapshotted at change creation. */
  promptHash?: string;
  mergedAt: string;
}

interface ProvenanceRow {
  id: string;
  commit_sha: string;
  project: string;
  workspace: string;
  change_id: string;
  agent_id: string | null;
  eval_score: number | null;
  model: string | null;
  prompt_hash: string | null;
  merged_at: string;
}

function rowToRecord(row: ProvenanceRow): ProvenanceRecord {
  const record: ProvenanceRecord = {
    id: row.id,
    commitSha: row.commit_sha,
    project: row.project,
    workspace: row.workspace,
    changeId: row.change_id,
    mergedAt: row.merged_at,
  };
  if (row.agent_id !== null) record.agentId = row.agent_id;
  if (row.eval_score !== null) record.evalScore = row.eval_score;
  if (row.model !== null) record.model = row.model;
  if (row.prompt_hash !== null) record.promptHash = row.prompt_hash;
  return record;
}

export async function recordProvenance(
  db: D1Database,
  logger: Logger,
  opts: {
    commitSha: string;
    project: string;
    workspace: string;
    changeId: string;
    agentId?: string;
    evalScore?: number;
    model?: string;
    promptHash?: string;
  },
): Promise<Result<ProvenanceRecord, AppError>> {
  try {
    const id = newId("prv");
    const mergedAt = new Date().toISOString();

    await db
      .prepare(
        "INSERT INTO provenance (id, commit_sha, project, workspace, change_id, agent_id, eval_score, model, prompt_hash, merged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        opts.commitSha,
        opts.project,
        opts.workspace,
        opts.changeId,
        opts.agentId ?? null,
        opts.evalScore ?? null,
        opts.model ?? null,
        opts.promptHash ?? null,
        mergedAt,
      )
      .run();

    const record: ProvenanceRecord = {
      id,
      commitSha: opts.commitSha,
      project: opts.project,
      workspace: opts.workspace,
      changeId: opts.changeId,
      mergedAt,
    };
    if (opts.agentId !== undefined) record.agentId = opts.agentId;
    if (opts.evalScore !== undefined) record.evalScore = opts.evalScore;
    if (opts.model !== undefined) record.model = opts.model;
    if (opts.promptHash !== undefined) record.promptHash = opts.promptHash;

    logger.debug("Provenance recorded", {
      provenanceId: id,
      changeId: opts.changeId,
      commitSha: opts.commitSha,
    });
    return ok(record);
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to record provenance",
            "DATABASE_ERROR",
            500,
            { operation: "recordProvenance", changeId: opts.changeId, commitSha: opts.commitSha },
          );
    logger.error("Failed to record provenance", appError, {
      changeId: opts.changeId,
      commitSha: opts.commitSha,
    });
    return err(appError);
  }
}

export async function getProvenance(
  db: D1Database,
  logger: Logger,
  changeId: string,
): Promise<Result<ProvenanceRecord, NotFoundError | AppError>> {
  try {
    const row = await db
      .prepare("SELECT * FROM provenance WHERE change_id = ?")
      .bind(changeId)
      .first<ProvenanceRow>();

    if (!row) {
      const notFoundError = new NotFoundError("Provenance", changeId);
      logger.debug("Provenance not found", { changeId });
      return err(notFoundError);
    }

    logger.debug("Provenance retrieved", { changeId, provenanceId: row.id });
    return ok(rowToRecord(row));
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to get provenance",
            "DATABASE_ERROR",
            500,
            { operation: "getProvenance", changeId },
          );
    logger.error("Failed to get provenance", appError, { changeId });
    return err(appError);
  }
}

export async function listProvenance(
  db: D1Database,
  logger: Logger,
  project: string,
  limit = 50,
): Promise<Result<ProvenanceRecord[], AppError>> {
  try {
    const result = await db
      .prepare("SELECT * FROM provenance WHERE project = ? ORDER BY merged_at DESC LIMIT ?")
      .bind(project, limit)
      .all<ProvenanceRow>();

    const records = result.results.map(rowToRecord);
    logger.debug("Provenance listed", { project, limit, count: records.length });
    return ok(records);
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to list provenance",
            "DATABASE_ERROR",
            500,
            { operation: "listProvenance", project, limit },
          );
    logger.error("Failed to list provenance", appError, { project, limit });
    return err(appError);
  }
}
