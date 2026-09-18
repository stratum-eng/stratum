import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/**
 * Every D1 table to back up, in FK-dependency order (parents first) so a restore
 * into fresh tables can run top-to-bottom without dangling references. This is a
 * fixed allow-list — table names are NEVER taken from request input, so the
 * interpolation into SQL below is safe.
 */
export const BACKUP_TABLES: readonly string[] = [
  "users",
  // Which namespaces each account has ever created a project under (migration
  // 046). Small, but it is the record that fixes a username; a restore without
  // it would let an account rename over a namespace its projects still use.
  "namespace_claims",
  // After `users`: the list is FK-ordered and api_tokens.user_id references it.
  // Included rather than excluded (unlike `magic_links`) because a restore that
  // silently invalidated every API credential is a worse failure than holding
  // token hashes a backup already carries on `users.token_hash`.
  "api_tokens",
  // MCP OAuth (#349), FK-ordered: `oauth_clients` has no parent, and
  // `oauth_tokens` references both it and `users`. Included for the same reason
  // as `api_tokens` — these are live credentials held by editors the user has
  // connected, and a restore that silently disconnected all of them (with no
  // way to tell the user which) is worse than holding their hashes.
  "oauth_clients",
  "oauth_tokens",
  "orgs",
  "agents",
  "teams",
  "org_members",
  "team_members",
  "sessions",
  "import_jobs",
  "changes",
  "eval_runs",
  "provenance",
  "change_comments",
  "change_reviews",
  "webhooks",
  "webhook_deliveries",
  "import_metrics",
  "failed_imports",
  "cost_records",
  // The owner-scoped usage aggregate (migration 049). Backed up rather than
  // excluded, and NOT recoverable from `cost_records` above: the project
  // cascade hard-deletes cost rows while this table survives, so replaying the
  // ledger after a restore would rebuild only the usage of projects that still
  // exist and hand everybody else their month back. Declares no foreign keys,
  // so its position here is only to sit beside the ledger it derives from.
  "usage_periods",
  "events",
  "sync_history",
  "issues",
  // Issue discussion + labels (migration 036) reference issues.id, so they
  // restore after their parent table.
  "issue_comments",
  "issue_labels",
  "audit_log",
  "deletion_jobs",
  "commit_metrics",
  // Post-merge deployments (migration 047). `project_secrets` holds the
  // encrypted provider credentials and is the only copy that exists — the
  // plaintext was never stored and no route can read one back, so a restore
  // without it means every deploying project is silently broken until each
  // token is re-pasted by hand. Both declare no foreign keys, so order is free.
  //
  // RESTORE DEPENDENCY: these rows are ciphertext only. They are decryptable
  // *solely* by the `DEPLOY_SECRET_KEY` in force when they were written — that
  // key is a Wrangler secret and is NOT in any backup. Restoring these rows
  // into an instance with a different (or missing) key yields rows that look
  // present in the UI but fail every deploy with "Could not decrypt project
  // secret…". Preserve `DEPLOY_SECRET_KEY` alongside the backups, or plan on
  // every project re-entering its secrets after the restore. See
  // `docs/runbooks/backup-restore.md`.
  "project_secrets",
  "deployments",
];

/**
 * D1 tables intentionally NOT backed up, with the reason each is safe to omit.
 * Every table created by a migration must be in `BACKUP_TABLES` or here —
 * `tests/backup-coverage.test.ts` enforces that so a new table holding real
 * user data can't be silently dropped from every backup.
 */
export const BACKUP_EXCLUDED_TABLES: readonly string[] = [
  // Ephemeral, single-use, short-TTL login tokens (stored hashed). They expire
  // in minutes, so a backup would only ever hold dead rows — nothing to restore.
  "magic_links",
  // The backup orchestrator's own per-repo rotation cursor. It describes backup
  // progress, not user data; restoring it into a fresh DB would be meaningless.
  "backup_state",
  // In-flight OAuth authorization codes (#349): single-use and 60 seconds long.
  // Every row in a backup is already dead by the time it is written, and a
  // restored one could not be redeemed even if it weren't. Same reasoning as
  // `magic_links` above.
  "oauth_auth_codes",
];

const PAGE_SIZE = 500;
const ROWID = "__rowid";

type Row = Record<string, unknown>;

/** A serialized value in NDJSON must round-trip; reject anything that wouldn't. */
function assertSerializable(table: string, row: Row): void {
  for (const [col, value] of Object.entries(row)) {
    if (value === null) continue;
    const t = typeof value;
    if (t !== "string" && t !== "number" && t !== "boolean") {
      // Catches BLOB/ArrayBuffer columns added to an allow-listed table later —
      // fail loudly rather than silently serialize them to `{}`.
      throw new AppError(
        `Column ${table}.${col} has a non-JSON-serializable type; backup cannot represent it`,
        "BACKUP_ERROR",
        500,
      );
    }
  }
}

export interface TableDump {
  ndjson: Uint8Array;
  rowCount: number;
  columns: string[];
}

/**
 * Export a table to NDJSON (one JSON object per line), reading in keyset-paginated
 * pages by rowid so a single query never trips D1's result-size cap. The first
 * line of the returned blob is a header: `{"__table":name,"__columns":[...]}`.
 */
export async function exportTable(
  db: D1Database,
  table: string,
  logger: Logger,
): Promise<Result<TableDump, AppError>> {
  try {
    const lines: string[] = [];
    let columns: string[] = [];
    let lastRowid = 0;
    let rowCount = 0;

    for (;;) {
      const page = await db
        .prepare(`SELECT rowid AS ${ROWID}, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`)
        .bind(lastRowid, PAGE_SIZE)
        .all<Row>();
      const rows = page.results ?? [];
      if (rows.length === 0) break;

      for (const row of rows) {
        lastRowid = row[ROWID] as number;
        const { [ROWID]: _omit, ...data } = row;
        if (columns.length === 0) columns = Object.keys(data);
        assertSerializable(table, data);
        lines.push(JSON.stringify(data));
        rowCount++;
      }
      if (rows.length < PAGE_SIZE) break;
    }

    const header = JSON.stringify({ __table: table, __columns: columns });
    const ndjson = new TextEncoder().encode([header, ...lines].join("\n"));
    logger.debug("Exported table", { table, rowCount });
    return ok({ ndjson, rowCount, columns });
  } catch (error) {
    if (error instanceof AppError) return err(error);
    logger.error("Failed to export table", error instanceof Error ? error : undefined, { table });
    return err(new AppError(`Failed to export table ${table}`, "DATABASE_ERROR", 500));
  }
}

/**
 * Parse + validate a table dump WITHOUT writing anything — the dry-run half of
 * `restoreTable`. Confirms the blob decodes to text, the header names the
 * expected table, and every row line is valid JSON, returning the row count so a
 * caller can cross-check it against the manifest (catches silent truncation).
 * A decrypt/decode failure surfaces upstream in `getBlob`; this sees plaintext.
 */
export function verifyTableDump(
  table: string,
  ndjson: Uint8Array,
): Result<{ table: string; rowCount: number; columns: string[] }, AppError> {
  try {
    const text = new TextDecoder().decode(ndjson).trim();
    if (text === "") return ok({ table, rowCount: 0, columns: [] });
    const [headerLine, ...rowLines] = text.split("\n");
    const header = JSON.parse(headerLine ?? "{}") as { __table?: string; __columns?: string[] };
    if (header.__table !== table) {
      return err(
        new AppError(
          `Dump table mismatch: expected ${table}, got ${header.__table}`,
          "BACKUP_ERROR",
          500,
        ),
      );
    }
    let rowCount = 0;
    for (const line of rowLines) {
      if (line.length === 0) continue;
      JSON.parse(line); // throws on a corrupt/truncated row line
      rowCount++;
    }
    return ok({ table, rowCount, columns: header.__columns ?? [] });
  } catch (error) {
    if (error instanceof AppError) return err(error);
    return err(new AppError(`Failed to verify dump for ${table}`, "BACKUP_ERROR", 500));
  }
}

const MAX_D1_BINDS = 100;

/**
 * Restore a table from its NDJSON dump into a FRESH table (plain INSERT; the
 * caller restores tables in BACKUP_TABLES order so parents land first). Verifies
 * the dump's column set matches the header before inserting.
 */
export async function restoreTable(
  db: D1Database,
  table: string,
  ndjson: Uint8Array,
  logger: Logger,
): Promise<Result<{ inserted: number }, AppError>> {
  try {
    const text = new TextDecoder().decode(ndjson).trim();
    if (text === "") return ok({ inserted: 0 });
    const [headerLine, ...rowLines] = text.split("\n");
    const header = JSON.parse(headerLine ?? "{}") as { __table?: string; __columns?: string[] };
    if (header.__table !== table) {
      return err(
        new AppError(
          `Dump table mismatch: expected ${table}, got ${header.__table}`,
          "BACKUP_ERROR",
          500,
        ),
      );
    }
    const columns = header.__columns ?? [];
    if (columns.length === 0 || rowLines.length === 0) return ok({ inserted: 0 });

    const rowsPerStatement = Math.max(1, Math.floor(MAX_D1_BINDS / columns.length));
    const colList = columns.join(", ");
    let inserted = 0;

    for (let i = 0; i < rowLines.length; i += rowsPerStatement) {
      const chunk = rowLines.slice(i, i + rowsPerStatement).filter((l) => l.length > 0);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
      const binds: unknown[] = [];
      for (const line of chunk) {
        const row = JSON.parse(line) as Row;
        for (const col of columns) binds.push(row[col] ?? null);
      }
      await db
        .prepare(`INSERT INTO ${table} (${colList}) VALUES ${placeholders}`)
        .bind(...binds)
        .run();
      inserted += chunk.length;
    }
    logger.debug("Restored table", { table, inserted });
    return ok({ inserted });
  } catch (error) {
    if (error instanceof AppError) return err(error);
    logger.error("Failed to restore table", error instanceof Error ? error : undefined, { table });
    return err(new AppError(`Failed to restore table ${table}`, "DATABASE_ERROR", 500));
  }
}
