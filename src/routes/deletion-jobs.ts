import { Hono } from "hono";
import { redriveDeletionJob } from "../queue/deletion-runner";
import { recordAudit } from "../storage/audit";
import { getDeletionJob } from "../storage/deletion-jobs";
import type { Env } from "../types";
import { isAdminRequest } from "../utils/admin";
import { createLogger } from "../utils/logger";
import { forbidden, internalError, notFound, ok } from "../utils/response";

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

// POST /api/admin/deletion-jobs/:id/redrive — operator re-drive of a deletion
// job that finished `incomplete` (transient fault, or a fault the operator has
// since fixed). Resets the attempt budget and drives once; idempotent.
app.post("/:id/redrive", async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return forbidden("Administrator access required");
  const { logger } = auth;
  const id = c.req.param("id");

  const result = await redriveDeletionJob(c.env, id, logger);
  if (!result.success) return internalError(result.error.message);

  if (!result.data.reopened) {
    const existing = await getDeletionJob(c.env.DB, logger, id);
    if (existing.success && !existing.data) return notFound("Deletion job", id);
    return c.json(
      { error: "Deletion job is not in the incomplete state", code: "NOT_REDRIVABLE" },
      409,
    );
  }

  await recordAudit(c.env.DB, logger, {
    action: "deletion.redrive",
    actorType: c.get("userId") ? "user" : "system",
    ...(c.get("userId") !== undefined ? { actorId: c.get("userId") } : {}),
    subject: id,
  });

  const refreshed = await getDeletionJob(c.env.DB, logger, id);
  return ok({ job: refreshed.success ? refreshed.data : null });
});

export { app as deletionJobsRouter };
