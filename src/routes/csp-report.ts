/**
 * Where browsers report Content Security Policy violations.
 *
 * The CSP is enforced by the browser, so a violation is invisible to the
 * server unless the browser is told where to send a report. Every page's
 * policy names this endpoint (see `CSP_REPORT_PATH` in the security-headers
 * middleware for the story of the bug this would have caught). Reports arrive
 * in one of two wire formats and are normalised into one warning per
 * violation, with the blocked URL, the directive, and the user agent.
 *
 * This endpoint is unauthenticated by nature and answers 204 to anything it
 * can parse and to anything it cannot: a browser that gets an error from a
 * report endpoint may retry, and there is nothing useful a retry would add.
 */
import { Hono } from "hono";
import { CSP_REPORT_PATH } from "../middleware/security-headers";
import type { Env } from "../types";
import { readTextWithLimit } from "../utils/request-body";
import { requestLogger } from "../utils/request-logger";

/** Reports are a few hundred bytes each; the Reporting API batches a handful. */
const MAX_REPORT_BYTES = 16 * 1024;

/** A page that trips the same rule repeatedly produces a burst; log the first
 * few and drop the rest of the batch rather than flood the log. */
const MAX_REPORTS_PER_REQUEST = 10;

export interface CspViolation {
  documentUri: string | undefined;
  blockedUri: string | undefined;
  effectiveDirective: string | undefined;
  violatedDirective: string | undefined;
  disposition: string | undefined;
  sourceFile: string | undefined;
  lineNumber: number | undefined;
  statusCode: number | undefined;
}

/**
 * Reduce a reported URL to scheme, host and path.
 *
 * A blocked redirect target can carry an authorization code (`…?code=…`), and
 * a URL can carry credentials in its authority (`user:secret@host`). Browsers
 * already strip cross-origin URLs to their origin before reporting, but this
 * endpoint must not rely on that for what ends up in the log. A value that is
 * not a URL (`inline`, `eval`, `data`) is kept as is, minus anything after a
 * `?` or `#`.
 */
function stripQuery(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.split(/[?#]/)[0];
  }
}

/** A non-empty string, or nothing. Report fields are untyped on the wire. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A finite number, or nothing. */
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** First present value among the candidate keys (Reporting API camelCase and
 * legacy kebab-case name the same field differently). */
function pick(body: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = body[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Normalise both wire formats to one shape.
 *
 * `report-uri` (CSP level 2) POSTs `{"csp-report": {"document-uri": …}}` with
 * kebab-case keys as `application/csp-report`. The Reporting API POSTs an
 * array of `{"type": "csp-violation", "body": {"documentURL": …}}` with
 * camelCase keys as `application/reports+json`. Entries of any other `type`
 * are not ours and are ignored.
 */
export function parseCspReports(payload: unknown): CspViolation[] {
  const bodies: Record<string, unknown>[] = [];
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (item === null || typeof item !== "object") continue;
      const report = item as { type?: unknown; body?: unknown };
      if (report.type !== "csp-violation") continue;
      if (report.body !== null && typeof report.body === "object") {
        bodies.push(report.body as Record<string, unknown>);
      }
    }
  } else if (payload !== null && typeof payload === "object") {
    const legacy = (payload as Record<string, unknown>)["csp-report"];
    if (legacy !== null && typeof legacy === "object") {
      bodies.push(legacy as Record<string, unknown>);
    }
  }
  return bodies.slice(0, MAX_REPORTS_PER_REQUEST).map((body) => ({
    documentUri: stripQuery(pick(body, "documentURL", "document-uri")),
    blockedUri: stripQuery(pick(body, "blockedURL", "blocked-uri")),
    effectiveDirective: asString(pick(body, "effectiveDirective", "effective-directive")),
    violatedDirective: asString(pick(body, "violatedDirective", "violated-directive")),
    disposition: asString(pick(body, "disposition")),
    sourceFile: stripQuery(pick(body, "sourceFile", "source-file")),
    lineNumber: asNumber(pick(body, "lineNumber", "line-number")),
    statusCode: asNumber(pick(body, "statusCode", "status-code")),
  }));
}

const app = new Hono<{ Bindings: Env }>();

app.post(CSP_REPORT_PATH, async (c) => {
  const logger = requestLogger(c);

  const body = await readTextWithLimit(c, MAX_REPORT_BYTES, logger);
  if (body.tooLarge) return new Response(null, { status: 413 });

  let payload: unknown;
  try {
    payload = JSON.parse(body.text);
  } catch {
    logger.debug("CSP report body was not JSON");
    return new Response(null, { status: 204 });
  }

  const reports = parseCspReports(payload);
  if (reports.length === 0) {
    logger.debug("CSP report carried no csp-violation entries");
    return new Response(null, { status: 204 });
  }

  const userAgent = c.req.header("User-Agent");
  for (const report of reports) {
    logger.warn("CSP violation reported", { ...report, userAgent });
  }
  return new Response(null, { status: 204 });
});

export { app as cspReportRouter };
