import { Hono } from "hono";
import { runBackup } from "../backup/run-backup";
import { recordAudit } from "../storage/audit";
import { listRuns } from "../storage/backup-store";
import type { Env } from "../types";
import { isAdminRequest } from "../utils/admin";
import { createLogger } from "../utils/logger";
import { forbidden, internalError, ok } from "../utils/response";

const app = new Hono<{ Bindings: Env }>();

async function requireAdmin(c: {
  env: Env;
  req: { header: (n: string) => string | undefined; path: string; method: string };
  get: (k: "userId") => string | undefined;
}): Promise<{ ok: true; logger: ReturnType<typeof createLogger> } | { ok: false }> {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });
  const isAdmin = await isAdminRequest(
    c.env,
    {
      ...(c.req.header("X-Admin-API-Key") !== undefined
        ? { adminApiKeyHeader: c.req.header("X-Admin-API-Key") }
        : {}),
      ...(c.get("userId") !== undefined ? { userId: c.get("userId") } : {}),
    },
    logger,
  );
  return isAdmin ? { ok: true, logger } : { ok: false };
}

// GET /api/admin/backup — list backup runs (newest first), each flagged complete.
app.get("/", async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return forbidden("Administrator access required");
  if (!c.env.BACKUPS) return internalError("Backups bucket not configured");

  const runs = await listRuns(c.env.BACKUPS, auth.logger);
  if (!runs.success) return internalError(runs.error.message);
  return ok({ runs: runs.data });
});

// POST /api/admin/backup — trigger a backup run now (admins only, single-flight).
app.post("/", async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return forbidden("Administrator access required");
  const { logger } = auth;
  if (!c.env.BACKUPS) return internalError("Backups bucket not configured");

  // runBackup owns the single-flight lock, so cron and manual triggers share it.
  const summary = await runBackup(c.env, logger, new Date().toISOString());
  if (summary.skipped === "locked") {
    return c.json({ error: "A backup run is already in progress" }, 409);
  }

  await recordAudit(c.env.DB, logger, {
    action: "backup.run",
    actorType: c.get("userId") ? "user" : "system",
    ...(c.get("userId") !== undefined ? { actorId: c.get("userId") } : {}),
    subject: summary.runTs,
    detail: {
      trigger: "manual",
      repos: summary.repos.backedUp,
      deferred: summary.repos.deferred,
      failed: summary.repos.failed.length,
      bytes: summary.bytes,
    },
  });
  return ok({ summary });
});

export { app as backupRouter };
