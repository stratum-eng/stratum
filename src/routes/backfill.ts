import { Hono } from "hono";
import { computeBackfillPlan } from "../storage/backfill-plan";
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

// GET /api/admin/backfill-project-id/plan — DRY-RUN: how much legacy (NULL
// project_id) data exists per table, and which project names are safe to
// backfill vs. collide and need manual resolution. Read-only; mutates nothing.
app.get("/plan", async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return forbidden("Administrator access required");

  const plan = await computeBackfillPlan(c.env, auth.logger);
  if (!plan.success) return internalError(plan.error.message);
  return ok({ plan: plan.data });
});

export { app as backfillRouter };
