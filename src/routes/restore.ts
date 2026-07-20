import { Hono } from "hono";
import { planRestore } from "../backup/plan-restore";
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

// GET /api/admin/restore/:runTs/plan — dry-run "is this backup restorable?" check.
// Reads and decrypts every blob in the run and verifies it against the manifest.
// Read-only: never writes. The actual apply/restore path is a separate gated op.
app.get("/:runTs/plan", async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return forbidden("Administrator access required");
  if (!c.env.BACKUPS) return internalError("Backups bucket not configured");

  const plan = await planRestore(c.env, c.req.param("runTs"), auth.logger);
  if (!plan.success) return internalError(plan.error.message);
  return ok({ plan: plan.data });
});

export { app as restoreRouter };
