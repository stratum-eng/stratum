import { Hono } from "hono";
import { recordAudit } from "../storage/audit";
import { backfillWebhookProjectIds, computeBackfillPlan } from "../storage/backfill-plan";
import type { Env } from "../types";
import { resolveAdminAuth } from "../utils/admin";
import { createLogger } from "../utils/logger";
import { forbidden, internalError, ok } from "../utils/response";

const app = new Hono<{ Bindings: Env }>();

/**
 * Accepts either the X-Admin-API-Key header or an authenticated admin user,
 * deliberately matching /plan's contract: an operator running the dry-run and
 * the apply back-to-back should not need two different credentials.
 *
 * Carries `via` out alongside `ok` so callers that write an audit entry can
 * attribute the action to whichever credential actually authorized it,
 * rather than to a `userId` that merely happened to be attached to the
 * request (see resolveAdminAuth).
 */
async function requireAdmin(c: {
  env: Env;
  req: { header: (n: string) => string | undefined; path: string; method: string };
  get: (k: "userId") => string | undefined;
}): Promise<
  { ok: true; logger: ReturnType<typeof createLogger>; via: "api-key" | "user" } | { ok: false }
> {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });
  const auth = await resolveAdminAuth(
    c.env,
    {
      ...(c.req.header("X-Admin-API-Key") !== undefined
        ? { adminApiKeyHeader: c.req.header("X-Admin-API-Key") }
        : {}),
      ...(c.get("userId") !== undefined ? { userId: c.get("userId") } : {}),
    },
    logger,
  );
  return auth.authorized && auth.via ? { ok: true, logger, via: auth.via } : { ok: false };
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

// Only a name resolving to exactly one project across all namespaces is
// stamped. Ambiguous and unresolved rows are left NULL and reported rather
// than guessed: a bare project name can collide across tenants, so a guess
// here would hand a legacy webhook (and its deliveries) to the wrong tenant.
// `remainingNullRows` is reported because it is the step-2 verification for
// issue #235 — it should read 0 after a clean run.
//
// This is step 1-2 of the 3-step coordinated fix for issue #235. Step 3 has
// since landed: `webhookBelongsToProject` and `listWebhooks` scope on
// project_id alone, so a row this run leaves NULL (ambiguous or unresolved) is
// no longer reachable by name — it is invisible to management and receives no
// deliveries. `remainingNullRows` is therefore the count of webhooks that were
// orphaned, and resolving them means giving the colliding projects distinct
// names and re-running, or deleting the rows.
app.post("/webhooks/apply", async (c) => {
  const auth = await requireAdmin(c);
  if (!auth.ok) return forbidden("Administrator access required");
  const { logger } = auth;

  // Attribute the audit entry to whichever credential actually authorized
  // this run, not to whatever `userId` happens to be attached to the
  // request. `requireAdmin` checks the API-key branch first, so a run
  // authorized purely by X-Admin-API-Key must record as "system" even when a
  // non-admin user session also rode along on the same request — crediting
  // that user would be misattribution in an audit trail, which is worse than
  // an absent actorId.
  const actor: { actorType: "user" | "system"; actorId?: string } =
    auth.via === "user"
      ? {
          actorType: "user",
          ...(c.get("userId") !== undefined ? { actorId: c.get("userId") } : {}),
        }
      : { actorType: "system" };

  const report = await backfillWebhookProjectIds(c.env, logger);
  if (!report.success) {
    // D1 auto-commits each row's UPDATE independently, so a throw partway
    // through the backfill can leave earlier rows already stamped even
    // though this call reports failure. backfillWebhookProjectIds carries
    // that partial progress out on the error's context; record it here,
    // before returning the error, so a partially-applied privileged mutation
    // never lands with zero provenance. This audit write is best-effort like
    // the success-path one below -- if it also fails, log it and still
    // return the original error untouched.
    const failureAudit = await recordAudit(c.env.DB, logger, {
      action: "webhook.project_id_backfilled",
      ...actor,
      detail: {
        failed: true,
        updated: report.error.context?.updated ?? 0,
        skipped: report.error.context?.skipped ?? 0,
        error: report.error.message,
      },
    });
    if (!failureAudit.success) {
      logger.error(
        "Backfill failed and its failure-path audit entry also failed to persist",
        failureAudit.error,
        { updated: report.error.context?.updated ?? 0 },
      );
    }
    return internalError(report.error.message);
  }

  const auditResult = await recordAudit(c.env.DB, logger, {
    action: "webhook.project_id_backfilled",
    ...actor,
    detail: {
      updated: report.data.updated,
      skipped: report.data.skipped.length,
      remainingNullRows: report.data.remainingNullRows,
    },
  });
  if (!auditResult.success) {
    // The rows are already stamped by this point and nothing here can unwind
    // them, so a failed audit write is a partial success, not a failure: the
    // mutation landed, its provenance record did not. Deliberately NOT a 500
    // — that would tell an operator the backfill did not happen when it did,
    // and would throw away the `remainingNullRows` count this endpoint exists
    // to report (the step-2 verification for #235), pushing them toward a
    // re-run to recover numbers they already earned. Instead the gap is made
    // explicit in the log and in `audited` below, so it can neither be missed
    // nor mistaken for a clean run. (Auditing before the mutation, the
    // deletion-runner's fail-hard order, isn't available here: the entry's
    // detail is the run's own counts.)
    logger.error("Backfill applied but its audit entry failed to persist", auditResult.error, {
      updated: report.data.updated,
      remainingNullRows: report.data.remainingNullRows,
    });
  }

  return ok({ report: report.data, audited: auditResult.success });
});

export { app as backfillRouter };
