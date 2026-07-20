/**
 * Cleanup script for imports stuck in "cancelling" status
 * Run with: npx tsx scripts/cleanup-stuck-imports.ts
 */

import { getPlatformProxy } from "wrangler";

interface ImportJobRow {
  id: string;
  namespace: string;
  slug: string;
  status: string;
  started_at: string;
  updated_at: string;
}

async function cleanupStuckImports() {
  console.log("🔍 Looking for imports stuck in 'cancelling' status...\n");

  const { env } = await getPlatformProxy<{
    DB: D1Database;
  }>({
    configPath: "./wrangler.toml",
  });

  try {
    // Find imports stuck in cancelling status
    const { results } = await env.DB.prepare(
      `SELECT id, namespace, slug, status, started_at, updated_at 
       FROM import_jobs 
       WHERE status = 'cancelling'`,
    ).all<ImportJobRow>();

    let stuckCount = 0;

    for (const row of results || []) {
      stuckCount++;
      console.log(`Found stuck import: ${row.namespace}/${row.slug}`);
      console.log(`  ID: ${row.id}`);
      console.log(`  Started: ${row.started_at}`);
      console.log(`  Last updated: ${row.updated_at || "unknown"}`);

      // Update to cancelled status
      await env.DB.prepare(
        `UPDATE import_jobs 
         SET status = 'cancelled', 
             completed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
        .bind(row.id)
        .run();

      console.log(`  → Updated to 'cancelled' status\n`);
    }

    if (stuckCount === 0) {
      console.log("✅ No stuck imports found!");
    } else {
      console.log(`✅ Cleaned up ${stuckCount} stuck import(s)`);
    }
  } catch (err) {
    console.error("Error querying database:", err);
    process.exit(1);
  }

  process.exit(0);
}

cleanupStuckImports().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
