/**
 * Backfill notes for the project-identity unification (branch feat/deletion-cascade).
 *
 * Migration 025 added a nullable `project_id` column to seven project-scoped D1
 * tables (changes, events, provenance, cost_records, commit_metrics, issues,
 * webhooks) and every INSERT now dual-writes it. NEW rows carry `project_id`.
 * ROWS WRITTEN BEFORE the migration keep `project_id` NULL.
 *
 * Why there is no automatic backfill here
 * ---------------------------------------
 * The `project` NAME -> `project.id` (UUID) mapping lives in the KV ProjectEntry
 * store, NOT in D1. So:
 *   - Pure SQL cannot resolve it (KV is unreachable from a D1 migration).
 *   - There is no admin arbitrary-SQL / D1-UPDATE HTTP endpoint to drive from a
 *     script, and this PR intentionally does not add one.
 *
 * Consequence for the cascade-delete (the reason this column exists)
 * -----------------------------------------------------------------
 * The future cascade MUST treat NULL-`project_id` rows as pre-migration and fall
 * back to name-based scoping WITH a collision guard: because names are unique
 * only per namespace (`@alice/api` and `@bob/api` collide), a name-based delete
 * must additionally constrain by the tenant it already knows (e.g. join through
 * `changes`/`workspaces` that DO carry the id, or refuse to delete NULL rows when
 * more than one project shares the name). New rows are unambiguous via project_id.
 *
 * If/when an operational backfill is wanted
 * -----------------------------------------
 * It needs BOTH the KV name->id map AND a privileged D1 write path. The intended
 * shape (kept here as executable documentation, guarded so it never runs by
 * accident) is:
 *
 *   for each ProjectEntry in KV:
 *     UPDATE <table> SET project_id = :id WHERE project = :name AND project_id IS NULL
 *
 * run once per table, per project. Guard against the collision case above by
 * only updating rows whose name is unique, or by resolving ownership first.
 *
 * Usage (documentation-only today):
 *   STRATUM_URL=https://staging.app.usestratum.dev \
 *   STRATUM_TOKEN=stratum_user_... \
 *   npx tsx scripts/backfill-project-id.ts
 */

const BASE_URL = process.env.STRATUM_URL?.replace(/\/$/, "") ?? "http://localhost:8787";
const TOKEN = process.env.STRATUM_TOKEN;
const SESSION = process.env.STRATUM_SESSION;

// The seven tables that gained a nullable project_id in migration 025. Any
// operational backfill (see header) must cover all of them.
const TABLES = [
  "changes",
  "events",
  "provenance",
  "cost_records",
  "commit_metrics",
  "issues",
  "webhooks",
] as const;

function main(): void {
  if (!TOKEN && !SESSION) {
    console.error("Set STRATUM_TOKEN (stratum_user_...) or STRATUM_SESSION.");
    process.exit(1);
  }

  console.log("project_id backfill — DOCUMENTATION ONLY, this script performs no writes.");
  console.log(`Target: ${BASE_URL}`);
  console.log("");
  console.log("Historical rows in these tables keep project_id = NULL:");
  for (const table of TABLES) console.log(`  - ${table}`);
  console.log("");
  console.log("There is no admin D1-UPDATE endpoint, and the name->id map lives in KV, so no");
  console.log("automatic backfill runs. The cascade-delete must treat NULL rows as name-based");
  console.log("with a per-namespace collision guard. See this file's header for details.");
}

main();
