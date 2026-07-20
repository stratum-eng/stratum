import type { Env } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { listProjects } from "./state";

/**
 * The seven project-scoped tables that gained a nullable `project_id` in
 * migration 025. Rows written before that migration keep `project_id` NULL and
 * are what a backfill would stamp. This is a FIXED allow-list — never user input
 * — so interpolating a name into the COUNT query below is safe.
 */
export const PROJECT_ID_TABLES = [
  "changes",
  "events",
  "provenance",
  "cost_records",
  "commit_metrics",
  "issues",
  "webhooks",
] as const;

export interface BackfillPlan {
  /** Per-table count of rows still missing a project_id (backfill candidates). */
  tables: { table: string; nullRows: number }[];
  totalNullRows: number;
  projects: {
    total: number;
    /** Projects whose NAME is unique — their legacy rows can be stamped safely
     *  by name, because no other project shares the name. */
    backfillable: number;
    /** Names shared by >1 project: their legacy rows can't be attributed by name
     *  alone and need manual resolution before a backfill touches them. */
    collisions: { name: string; projectIds: string[] }[];
  };
}

/**
 * DRY-RUN diagnostic for the KV→D1 project_id backfill. Reads only: reports how
 * much legacy (NULL project_id) data exists per table and which project names
 * are safe to backfill vs. which collide across namespaces and need manual
 * resolution. Mutates nothing — this is the "plan" half; the actual stamping is
 * a separate, deliberate operation.
 */
export async function computeBackfillPlan(
  env: Pick<Env, "DB" | "STATE">,
  logger: Logger,
): Promise<Result<BackfillPlan, AppError>> {
  try {
    const tables: { table: string; nullRows: number }[] = [];
    let totalNullRows = 0;
    for (const table of PROJECT_ID_TABLES) {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM ${table} WHERE project_id IS NULL`,
      ).first<{ n: number }>();
      const nullRows = row?.n ?? 0;
      tables.push({ table, nullRows });
      totalNullRows += nullRows;
    }

    const projectsResult = await listProjects(env.STATE, logger);
    if (!projectsResult.success) return err(projectsResult.error);

    const idsByName = new Map<string, string[]>();
    for (const project of projectsResult.data) {
      const ids = idsByName.get(project.name) ?? [];
      ids.push(project.id);
      idsByName.set(project.name, ids);
    }
    const collisions: { name: string; projectIds: string[] }[] = [];
    let backfillable = 0;
    for (const [name, ids] of idsByName) {
      if (ids.length === 1) backfillable++;
      else collisions.push({ name, projectIds: ids });
    }

    return ok({
      tables,
      totalNullRows,
      projects: { total: projectsResult.data.length, backfillable, collisions },
    });
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to compute backfill plan",
            "DATABASE_ERROR",
            500,
            { operation: "computeBackfillPlan" },
          );
    logger.error("Failed to compute backfill plan", appError);
    return err(appError);
  }
}
