/**
 * Cleanup script for old completed/failed/cancelled imports
 * Deletes import jobs completed more than N days ago
 * Run with: npx tsx scripts/cleanup-old-imports.ts [days]
 * Default: 7 days
 */

import { getPlatformProxy } from "wrangler";

async function cleanupOldImports() {
  const days = Number.parseInt(process.argv[2], 10) || 7;

  if (days < 1) {
    console.error("❌ Days must be at least 1");
    process.exit(1);
  }

  console.log(`🧹 Cleaning up imports completed more than ${days} days ago...\n`);

  const { env } = await getPlatformProxy<{
    DB: D1Database;
  }>({
    configPath: "./wrangler.toml",
  });

  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    // First, count how many will be deleted
    const countResult = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM import_jobs 
       WHERE completed_at IS NOT NULL 
       AND completed_at < ?`,
    )
      .bind(cutoffDate.toISOString())
      .first<{ count: number }>();

    const toDelete = countResult?.count || 0;

    if (toDelete === 0) {
      console.log("✅ No old imports to clean up");
      process.exit(0);
    }

    console.log(`Found ${toDelete} import(s) to delete...`);

    // Delete old imports
    const deleteResult = await env.DB.prepare(
      `DELETE FROM import_jobs 
       WHERE completed_at IS NOT NULL 
       AND completed_at < ?`,
    )
      .bind(cutoffDate.toISOString())
      .run();

    const deletedCount = deleteResult.meta?.changes ?? 0;

    console.log(`✅ Deleted ${deletedCount} old import(s)`);
  } catch (err) {
    console.error("Error cleaning up imports:", err);
    process.exit(1);
  }

  process.exit(0);
}

cleanupOldImports().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
