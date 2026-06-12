import { AppError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/** Sensitive operations worth an audit trail. */
export type AuditAction =
  | "session.created"
  | "token.rotated"
  | "agent.created"
  | "agent.revoked"
  | "webhook.created"
  | "webhook.toggled"
  | "webhook.deleted"
  | "merge.forced";

export interface AuditEntry {
  id: string;
  action: AuditAction | string;
  actorType: "user" | "agent" | "system";
  actorId?: string;
  subject?: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

interface AuditRow {
  id: string;
  action: string;
  actor_type: string;
  actor_id: string | null;
  subject: string | null;
  detail: string;
  created_at: string;
}

function rowToEntry(row: AuditRow): AuditEntry {
  let detail: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.detail);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      detail = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed detail renders as empty; the row itself is still useful.
  }
  const entry: AuditEntry = {
    id: row.id,
    action: row.action,
    actorType: row.actor_type as AuditEntry["actorType"],
    detail,
    createdAt: row.created_at,
  };
  if (row.actor_id !== null) entry.actorId = row.actor_id;
  if (row.subject !== null) entry.subject = row.subject;
  return entry;
}

/**
 * Record an audit entry. Best-effort by contract: failures are logged and
 * returned, but audited operations must not fail because auditing did.
 */
export async function recordAudit(
  db: D1Database,
  logger: Logger,
  opts: {
    action: AuditAction;
    actorType: "user" | "agent" | "system";
    actorId?: string;
    subject?: string;
    detail?: Record<string, unknown>;
  },
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare(
        "INSERT INTO audit_log (id, action, actor_type, actor_id, subject, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        newId("aud"),
        opts.action,
        opts.actorType,
        opts.actorId ?? null,
        opts.subject ?? null,
        JSON.stringify(opts.detail ?? {}),
        new Date().toISOString(),
      )
      .run();
    return ok(undefined);
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to record audit entry",
            "DATABASE_ERROR",
            500,
            { operation: "recordAudit", action: opts.action },
          );
    logger.error("Failed to record audit entry", appError, { action: opts.action });
    return err(appError);
  }
}

export async function listAuditLog(
  db: D1Database,
  logger: Logger,
  opts: { action?: string; actorId?: string; limit?: number } = {},
): Promise<Result<AuditEntry[], AppError>> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  try {
    const conditions: string[] = [];
    const bindings: unknown[] = [];
    if (opts.action) {
      conditions.push("action = ?");
      bindings.push(opts.action);
    }
    if (opts.actorId) {
      conditions.push("actor_id = ?");
      bindings.push(opts.actorId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    bindings.push(limit);

    const result = await db
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ?`)
      .bind(...bindings)
      .all<AuditRow>();
    return ok(result.results.map(rowToEntry));
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to list audit log",
            "DATABASE_ERROR",
            500,
            { operation: "listAuditLog" },
          );
    logger.error("Failed to list audit log", appError);
    return err(appError);
  }
}
