import { Hono } from "hono";
import { listAuditLog } from "../storage/audit";
import type { Env } from "../types";
import { isAdminRequest } from "../utils/admin";
import { createLogger } from "../utils/logger";
import { forbidden, internalError, ok } from "../utils/response";

const app = new Hono<{ Bindings: Env }>();

// GET /api/admin/audit — Query the audit trail (admins only)
app.get("/", async (c) => {
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
  if (!isAdmin) return forbidden("Administrator access required");

  const action = c.req.query("action");
  const actorId = c.req.query("actor");
  const limitParam = Number(c.req.query("limit"));
  const limit = Number.isInteger(limitParam) && limitParam > 0 ? limitParam : undefined;

  const result = await listAuditLog(c.env.DB, logger, {
    ...(action !== undefined ? { action } : {}),
    ...(actorId !== undefined ? { actorId } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  if (!result.success) {
    return internalError(result.error.message);
  }

  return ok({ entries: result.data });
});

export { app as auditRouter };
