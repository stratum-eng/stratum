/**
 * #355: the CSP violation-report endpoint.
 *
 * Both wire formats normalise to one shape, the URL fields are stripped of
 * anything that could be a credential, the body is capped, and — the part the
 * middleware stack has to get right — a report that arrives with a session
 * cookie and no matching Origin is accepted, because that is how browsers send
 * them.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { csrfMiddleware } from "../src/middleware/csrf";
import { securityHeadersMiddleware } from "../src/middleware/security-headers";
import { cspReportRouter, parseCspReports } from "../src/routes/csp-report";
import { createSession } from "../src/storage/sessions";
import type { Env } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import type { Logger } from "../src/utils/logger";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

describe("parseCspReports", () => {
  it("reads the legacy report-uri envelope", () => {
    const reports = parseCspReports({
      "csp-report": {
        "document-uri": "https://stratum.test/oauth/authorize?client_id=abc",
        "blocked-uri": "https://claude.ai/api/mcp/auth_callback?code=stratum_mcpac_secret&state=x",
        "effective-directive": "form-action",
        "violated-directive": "form-action 'self'",
        disposition: "enforce",
        "status-code": 200,
      },
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.effectiveDirective).toBe("form-action");
    // Query strings never reach the log: the blocked URL of a refused redirect
    // is the one carrying the authorization code.
    expect(reports[0]?.blockedUri).toBe("https://claude.ai/api/mcp/auth_callback");
    expect(reports[0]?.documentUri).toBe("https://stratum.test/oauth/authorize");
    expect(reports[0]?.statusCode).toBe(200);
  });

  it("drops credentials from the authority as well as the query", () => {
    const reports = parseCspReports({
      "csp-report": {
        "blocked-uri": "https://user:secret@evil.example/path?x=1#frag",
        "source-file": "https://alice:pw@stratum.test/app.js",
      },
    });
    expect(reports[0]?.blockedUri).toBe("https://evil.example/path");
    expect(reports[0]?.sourceFile).toBe("https://stratum.test/app.js");
  });

  it("reads the Reporting API array and ignores entries of other types", () => {
    const reports = parseCspReports([
      { type: "deprecation", body: { id: "whatever" } },
      {
        type: "csp-violation",
        body: {
          documentURL: "https://stratum.test/settings",
          blockedURL: "inline",
          effectiveDirective: "script-src",
          disposition: "enforce",
          sourceFile: "https://stratum.test/settings?x=1",
          lineNumber: 12,
        },
      },
    ]);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.blockedUri).toBe("inline");
    expect(reports[0]?.sourceFile).toBe("https://stratum.test/settings");
    expect(reports[0]?.lineNumber).toBe(12);
  });

  it("caps a batch and tolerates junk", () => {
    const many = Array.from({ length: 25 }, () => ({
      type: "csp-violation",
      body: { documentURL: "https://stratum.test/" },
    }));
    expect(parseCspReports(many)).toHaveLength(10);
    expect(parseCspReports("nope")).toEqual([]);
    expect(parseCspReports(null)).toEqual([]);
    expect(parseCspReports({ "csp-report": 7 })).toEqual([]);
  });
});

describe("POST /csp-report", () => {
  let app: Hono<{ Bindings: Env }>;
  let env: Env;
  let sessionCookie: string;

  beforeEach(async () => {
    const { db } = makeSqliteD1();
    env = { DB: db } as unknown as Env;
    app = new Hono<{ Bindings: Env }>();
    app.use("*", securityHeadersMiddleware);
    app.use("*", authMiddleware);
    app.use("*", csrfMiddleware);
    app.route("/", cspReportRouter);
    await db
      .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
      .bind("usr_1", "u@test", "alice", await hashToken("legacy"))
      .run();
    const session = await createSession(db, "usr_1", logger);
    if (!session.success) throw new Error("session setup failed");
    sessionCookie = `stratum_session=${session.data.id}`;
  });

  async function post(body: string, headers: Record<string, string> = {}): Promise<Response> {
    return await app.fetch(
      new Request("https://stratum.test/csp-report", {
        method: "POST",
        headers: { "Content-Type": "application/csp-report", ...headers },
        body,
      }),
      env,
    );
  }

  it("accepts a report delivered with the session cookie and a foreign Origin", async () => {
    // Browsers send reports as bare POSTs that carry cookies; under the
    // Reporting API there is no Origin at all. The CSRF check must not eat them.
    const response = await post(
      JSON.stringify({
        "csp-report": { "blocked-uri": "https://claude.ai/", "effective-directive": "form-action" },
      }),
      { Cookie: sessionCookie, Origin: "https://claude.ai" },
    );
    expect(response.status).toBe(204);
  });

  it("answers 204 to a body it cannot parse, so the browser does not retry", async () => {
    expect((await post("not json")).status).toBe(204);
    expect((await post(JSON.stringify({ unrelated: true }))).status).toBe(204);
  });

  it("refuses an oversized body", async () => {
    const response = await post(`{"csp-report":{"blocked-uri":"${"x".repeat(20_000)}"}}`);
    expect(response.status).toBe(413);
  });
});
