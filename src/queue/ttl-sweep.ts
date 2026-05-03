import type { Env } from "../types";
import type { WorkspaceEntry } from "../types";
import type { Logger } from "../utils/logger";
import { createLogger } from "../utils/logger";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function runTtlSweep(
  env: Env,
  logger: Logger = createLogger({ component: "TtlSweep" }),
): Promise<{ deleted: number }> {
  logger.info("Starting TTL sweep");

  let deleted = 0;
  let processed = 0;
  let cursor: string | null = null;

  while (true) {
    const listOpts: KVNamespaceListOptions = { prefix: "workspace:" };
    if (cursor !== null) listOpts.cursor = cursor;

    const result: KVNamespaceListResult<unknown> = await env.STATE.list(listOpts);

    for (const key of result.keys) {
      processed++;
      try {
        const raw = await env.STATE.get(key.name);
        if (!raw) continue;

        const workspace = JSON.parse(raw) as WorkspaceEntry;
        const createdAt = new Date(workspace.createdAt).getTime();
        if (Date.now() - createdAt < THIRTY_DAYS_MS) continue;

        const workspaceId = key.name.replace(/^workspace:/, "");

        const queryResult = await env.DB.prepare(
          "SELECT COUNT(*) as count FROM changes WHERE workspace = ? AND status = ?",
        )
          .bind(workspaceId, "open")
          .first<{ count: number }>();

        if ((queryResult?.count ?? 0) !== 0) continue;

        try {
          await env.ARTIFACTS.delete(workspace.name);
          logger.debug("Deleted artifact", { workspace: workspace.name });
        } catch {
          // Missing artifact — proceed with KV cleanup
        }

        await env.STATE.delete(key.name);
        deleted++;
        logger.info("Deleted expired workspace", {
          workspaceId,
          workspace: workspace.name,
          createdAt: workspace.createdAt,
        });
      } catch (err) {
        logger.warn("Error processing workspace during sweep", {
          key: key.name,
          error: err instanceof Error ? err.message : String(err),
        });
        // Per-item error — continue sweep
      }
    }

    if (result.list_complete) break;
    cursor = result.cursor;
  }

  logger.info("TTL sweep completed", { processed, deleted });
  return { deleted };
}
