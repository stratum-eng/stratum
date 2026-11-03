import { type Context, Hono } from "hono";
import {
  AUDIT_PAGE_MAX,
  type AuditQuery,
  decodeAuditCursor,
  queryAuditLog,
} from "../storage/audit";
import type { Env } from "../types";
import { isAdminRequest } from "../utils/admin";
import { type Logger, createLogger } from "../utils/logger";
import { badRequest, forbidden, internalError, ok } from "../utils/response";
import { requireOrgAdmin } from "./org-admin-access";

/** Longest window one export may span. Bounds the work a single request can ask for. */
export const AUDIT_EXPORT_MAX_RANGE_DAYS = 90;
/** Window an export covers when the caller gives no `since`. */
export const AUDIT_EXPORT_DEFAULT_RANGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type AuditContext = Context<{ Bindings: Env }>;

/** Accepts any Date-parseable timestamp; normalizes to the ISO form rows are stored in. */
function parseTimestamp(raw: string | undefined): string | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * The filters shared by every audit read: `action`, `since` (inclusive),
 * `until` (exclusive), `cursor`, `limit`. A 400 Response for malformed input —
 * a bad timestamp or cursor silently ignored would return the wrong rows.
 */
function parseAuditFilters(c: AuditContext): Omit<AuditQuery, "orgId" | "actorId"> | Response {
  const filters: Omit<AuditQuery, "orgId" | "actorId"> = {};
  const action = c.req.query("action");
  if (action) filters.action = action;

  const since = parseTimestamp(c.req.query("since"));
  if (since === null) return badRequest("since must be an ISO-8601 timestamp");
  if (since !== undefined) filters.since = since;
  const until = parseTimestamp(c.req.query("until"));
  if (until === null) return badRequest("until must be an ISO-8601 timestamp");
  if (until !== undefined) filters.until = until;
  if (since !== undefined && until !== undefined && since >= until) {
    return badRequest("since must be earlier than until");
  }

  const cursor = c.req.query("cursor");
  if (cursor !== undefined) {
    if (decodeAuditCursor(cursor) === null) return badRequest("cursor is invalid");
    filters.cursor = cursor;
  }

  const limitRaw = c.req.query("limit");
  if (limitRaw !== undefined) {
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) {
      return badRequest("limit must be a positive integer");
    }
    filters.limit = Math.min(limit, AUDIT_PAGE_MAX);
  }
  return filters;
}

const app = new Hono<{ Bindings: Env }>();

// GET /api/admin/audit — Query the instance-wide audit trail (instance admins only)
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

  const filters = parseAuditFilters(c);
  if (filters instanceof Response) return filters;
  const actorId = c.req.query("actor");
  const orgId = c.req.query("org");

  const result = await queryAuditLog(c.env.DB, logger, {
    ...filters,
    ...(actorId ? { actorId } : {}),
    ...(orgId ? { orgId } : {}),
  });
  if (!result.success) {
    return internalError(result.error.message);
  }

  return ok(result.data);
});

/**
 * Stream an org's audit rows in [since, until) as NDJSON, newest first, one
 * entry per line. Walks keyset pages of AUDIT_PAGE_MAX so memory stays flat
 * however many rows the window holds; the window itself is capped at
 * AUDIT_EXPORT_MAX_RANGE_DAYS so one request cannot ask for the org's whole
 * history. The first page is read BEFORE the response starts, so a storage
 * failure there is a clean 500; a failure on a later page aborts the stream
 * (the client sees a truncated, errored download rather than a short file
 * that looks complete).
 */
async function exportOrgAudit(
  c: AuditContext,
  orgId: string,
  slug: string,
  logger: Logger,
): Promise<Response> {
  const filters = parseAuditFilters(c);
  if (filters instanceof Response) return filters;

  const until = filters.until ?? new Date().toISOString();
  const since =
    filters.since ??
    new Date(Date.parse(until) - AUDIT_EXPORT_DEFAULT_RANGE_DAYS * DAY_MS).toISOString();
  if (Date.parse(until) - Date.parse(since) > AUDIT_EXPORT_MAX_RANGE_DAYS * DAY_MS) {
    return badRequest(
      `export range must not exceed ${AUDIT_EXPORT_MAX_RANGE_DAYS} days; narrow since/until`,
    );
  }

  // Every filter the JSON read honours (except paging) applies here too, so
  // `?format=ndjson` is the same query, not a broader one.
  const actorId = c.req.query("actor");
  const base: AuditQuery = {
    orgId,
    since,
    until,
    limit: AUDIT_PAGE_MAX,
    ...(filters.action !== undefined ? { action: filters.action } : {}),
    ...(actorId ? { actorId } : {}),
  };
  const first = await queryAuditLog(c.env.DB, logger, base);
  if (!first.success) return internalError(first.error.message);

  const encoder = new TextEncoder();
  let page = first.data;
  let exhausted = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (exhausted) {
        controller.close();
        return;
      }
      const lines = page.entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
      if (lines) controller.enqueue(encoder.encode(lines));
      if (page.nextCursor === undefined) {
        exhausted = true;
        return;
      }
      const next = await queryAuditLog(c.env.DB, logger, { ...base, cursor: page.nextCursor });
      if (!next.success) {
        logger.error("Audit export aborted mid-stream", next.error, { orgId });
        controller.error(next.error);
        return;
      }
      page = next.data;
    },
  });

  const stamp = (iso: string) => iso.replace(/[:.]/g, "-");
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-${slug}-${stamp(since)}-${stamp(until)}.ndjson"`,
      "Cache-Control": "no-store",
    },
  });
}

const orgAudit = new Hono<{ Bindings: Env }>();

// GET /api/orgs/:slug/audit — one page of the org's trail (org admins/owner).
// `?format=ndjson` is the same as /export.
orgAudit.get("/:slug/audit", async (c) => {
  const ctx = await requireOrgAdmin(c);
  if (ctx instanceof Response) return ctx;
  const { org, logger } = ctx;

  if (c.req.query("format") === "ndjson") {
    return exportOrgAudit(c, org.id, org.slug, logger);
  }
  const format = c.req.query("format");
  if (format !== undefined && format !== "json") {
    return badRequest("format must be json or ndjson");
  }

  const filters = parseAuditFilters(c);
  if (filters instanceof Response) return filters;
  const actorId = c.req.query("actor");

  const result = await queryAuditLog(c.env.DB, logger, {
    ...filters,
    ...(actorId ? { actorId } : {}),
    orgId: org.id,
  });
  if (!result.success) return internalError(result.error.message);
  return ok(result.data);
});

// GET /api/orgs/:slug/audit/export — NDJSON download of a bounded window.
orgAudit.get("/:slug/audit/export", async (c) => {
  const ctx = await requireOrgAdmin(c);
  if (ctx instanceof Response) return ctx;
  return exportOrgAudit(c, ctx.org.id, ctx.org.slug, ctx.logger);
});

export { app as auditRouter, orgAudit as orgAuditRouter };
