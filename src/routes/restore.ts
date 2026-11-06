import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { applyRepoRestore } from "../backup/apply-repo-restore";
import { planRestore } from "../backup/plan-restore";
import { recordAudit } from "../storage/audit";
import type { Env } from "../types";
import { isAdminRequest } from "../utils/admin";
import { createLogger } from "../utils/logger";
import { badRequest, forbidden, internalError, ok } from "../utils/response";

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
// Read-only: never writes. Applying a repository is POST .../repos/:projectId.
app.get("/:runTs/plan", async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return forbidden("Administrator access required");
  if (!c.env.BACKUPS) return internalError("Backups bucket not configured");

  const plan = await planRestore(c.env, c.req.param("runTs"), auth.logger);
  if (!plan.success) return internalError(plan.error.message);
  return ok({ plan: plan.data });
});

/** Backup keys are built from these, so they must not carry a path of their own. */
const RUN_TS = /^[0-9TZ:.-]{1,40}$/;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_RESTORE_BODY_BYTES = 1024;

function parseRestoreBody(raw: string): { force: boolean; drill: boolean } | string {
  if (raw.trim() === "") return { force: false, drill: false };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return "Request body must be JSON";
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Request body must be a JSON object";
  }
  const { force, drill } = body as { force?: unknown; drill?: unknown };
  // Strict: the string "false" must not read as permission to overwrite.
  if (force !== undefined && typeof force !== "boolean") return "force must be a boolean";
  if (drill !== undefined && typeof drill !== "boolean") return "drill must be a boolean";
  if (force === true && drill === true) {
    return "force and drill cannot be combined: a drill never overwrites anything";
  }
  return { force: force === true, drill: drill === true };
}

// POST /api/admin/restore/:runTs/repos/:projectId — apply one backed-up repo.
// `{ "drill": true }` restores to a scratch repo, verifies it and deletes it;
// otherwise it restores to the project's own repo, and `{ "force": true }` is
// required if that repo exists.
const restoreBodyLimit = bodyLimit({
  maxSize: MAX_RESTORE_BODY_BYTES,
  onError: (c) => c.json({ error: "Request body is too large" }, 413),
});

app.post("/:runTs/repos/:projectId", restoreBodyLimit, async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return forbidden("Administrator access required");
  const { logger } = auth;
  if (!c.env.BACKUPS) return internalError("Backups bucket not configured");

  const runTs = c.req.param("runTs");
  const projectId = c.req.param("projectId");
  if (!RUN_TS.test(runTs)) return badRequest("Invalid backup run");
  if (!PROJECT_ID.test(projectId)) return badRequest("Invalid project id");
  const opts = parseRestoreBody(await c.req.text());
  if (typeof opts === "string") return badRequest(opts);

  const userId = c.get("userId");
  const audit = (stage: "started" | "finished", detail: Record<string, unknown>) =>
    recordAudit(c.env.DB, logger, {
      action: "backup.repo_restore",
      actorType: userId ? "user" : "system",
      ...(userId !== undefined ? { actorId: userId } : {}),
      subject: projectId,
      detail: { stage, runTs, ...opts, ...detail },
    });

  await audit("started", {});
  const restored = await applyRepoRestore(c.env, runTs, projectId, opts, logger);
  if (!restored.success) {
    const { code, message, statusCode } = restored.error;
    await audit("finished", { outcome: "failed", code });
    // A timed-out push may still land, so this is "unknown", not "failed".
    if (code === "PUSH_TIMEOUT") {
      return c.json(
        { error: `${message}. The outcome is unknown: check the repo before retrying.`, code },
        504,
      );
    }
    if (statusCode === 404 || statusCode === 409) {
      return c.json({ error: message, code }, statusCode);
    }
    logger.error("Repo restore failed", restored.error, { runTs, projectId });
    return internalError(message);
  }

  await audit("finished", {
    outcome: restored.data.verification.ok ? "verified" : "unverified",
    checked: restored.data.verification.checked,
    mismatches: restored.data.verification.mismatches.length,
    ...(restored.data.scratchDeleted !== undefined
      ? { scratchDeleted: restored.data.scratchDeleted }
      : {}),
  });
  return ok({ restore: restored.data });
});

export { app as restoreRouter };
