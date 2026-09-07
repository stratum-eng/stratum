import { Hono } from "hono";
import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import { routePath } from "hono/route";
import { trackerForRequest } from "./analytics/tracker";
import { githubWebhookRouter } from "./github/webhooks";
import { analyticsMiddleware } from "./middleware/analytics";
import { authMiddleware } from "./middleware/auth";
import { configGuardMiddleware } from "./middleware/config-guard";
import { csrfMiddleware } from "./middleware/csrf";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { securityHeadersMiddleware, setHtmlSecurityHeaders } from "./middleware/security-headers";
import { sourceOfferMiddleware } from "./middleware/source-offer";
import { webAnalyticsMiddleware } from "./middleware/web-analytics";
import { handleDeployQueue } from "./queue/deploy-queue";
import { handleEventQueue } from "./queue/event-consumer";
import type { EventQueueMessage } from "./queue/events";
import { handleImportQueue } from "./queue/import-queue";
import { agentsRouter } from "./routes/agents";
import { auditRouter } from "./routes/audit";
import { authRouter } from "./routes/auth";
import { backfillRouter } from "./routes/backfill";
import { backupRouter } from "./routes/backup";
import { bulkImportRouter } from "./routes/bulk-import";
import { changesRouter } from "./routes/changes";
import { cspReportRouter } from "./routes/csp-report";
import { deletionJobsRouter } from "./routes/deletion-jobs";
import { deploymentsRouter, projectDeploymentsRouter } from "./routes/deployments";
import { emailAuthRouter } from "./routes/email-auth";
import { gitHttpRouter } from "./routes/git-http";
import { healthRouter } from "./routes/health";
import { issuesRouter } from "./routes/issues";
import { loginRouter } from "./routes/login";
import { mcpRouter } from "./routes/mcp";
import { mcpOAuthRouter } from "./routes/mcp-oauth";
import { metricsRouter } from "./routes/metrics";
import { oauthSignupRouter } from "./routes/oauth-signup";
import { orgsRouter } from "./routes/orgs";
import { posthogProxyRouter } from "./routes/posthog-proxy";
import { projectsRouter } from "./routes/projects";
import { restoreRouter } from "./routes/restore";
import { reviewsRouter } from "./routes/reviews";
import { sessionRouter } from "./routes/sessions";
import { signupRouter } from "./routes/signup";
import { syncRouter } from "./routes/sync";
import { syncManagementRouter } from "./routes/sync-management";
import { uiRouter } from "./routes/ui";
import { usersRouter } from "./routes/users";
import { webhooksRouter } from "./routes/webhooks";
import { workspacesRouter } from "./routes/workspaces";
import { runScheduledJobs } from "./scheduled";
import { createSession } from "./storage/sessions";
import { createUser, getUserByEmail } from "./storage/users";
import type { Env, ImportJobMessage, MessageBatch, SyncJobMessage } from "./types";
import { notFoundResponse, serverErrorResponse } from "./ui/pages/error";
import { CSS } from "./ui/styles";
import { createLogger } from "./utils/logger";
export { MergeQueue } from "./queue/merge-queue";
export { MagicLinkRateLimiter } from "./queue/magic-link-limiter";
export { RepoDO } from "./queue/repo-do";
export { UsageMeter } from "./queue/usage-meter";

const app = new Hono<{ Bindings: Env }>();

/**
 * The matched route pattern for an error, or `"*"` when there is none.
 *
 * `routePath` reads the matched-route registry, which a failure raised before
 * routing (a middleware throwing) never populated. Falling back to the literal
 * `"*"` keeps the concrete path — namespaces, slugs, file paths — out of the
 * export, which is the same guarantee `analyticsMiddleware` makes.
 */
function errorRoute(c: Context<{ Bindings: Env }>): string {
  try {
    // Defaults to `c.req.routeIndex` — the responding handler. See the note in
    // `analyticsMiddleware`: the `-1` form reports the last *registered*
    // matching route, which the `/:namespace/:slug` catch-all always wins.
    return routePath(c) || "*";
  } catch {
    return "*";
  }
}

app.use("*", securityHeadersMiddleware);
// Registered early so its post-`next()` work sees the final response, after
// every other middleware has had its say. It reads `userId`/`telemetryOptOut`,
// which `authMiddleware` below publishes before this runs. Outermost of the two
// response rewriters, so it builds its replacement `Response` from headers
// `sourceOfferMiddleware` has already set rather than racing it.
app.use("*", webAnalyticsMiddleware);
app.use("*", sourceOfferMiddleware);
app.use("*", configGuardMiddleware);
app.use("*", analyticsMiddleware);
app.use("*", authMiddleware);
app.use("*", csrfMiddleware);
app.use("*", rateLimitMiddleware());

app.get("/health", (c) => c.json({ status: "ok", service: "stratum" }));

// DEV ONLY: Quick login for local development
app.get("/dev-login", async (c) => {
  const logger = createLogger({ path: c.req.path, method: c.req.method });

  try {
    // Gated on an explicit opt-in flag AND a localhost request host, in a single
    // condition so neither gate can be bypassed independently. The route is inert
    // in staging/production (where DEV_LOGIN_ENABLED is unset) even if a request
    // somehow presents a localhost authority.
    const host = new URL(c.req.url).hostname;
    if (c.env.DEV_LOGIN_ENABLED !== "true" || (host !== "localhost" && host !== "127.0.0.1")) {
      return c.json({ error: "Dev login is not available" }, 403);
    }

    const email = c.req.query("email") || "dev@example.com";

    // Get or create user
    const userResult = await getUserByEmail(c.env.DB, email, logger);
    let userId: string;

    if (!userResult.success) {
      const createResult = await createUser(c.env.DB, email, logger);
      if (!createResult.success) {
        logger.error("Failed to create user", undefined, { email });
        return c.json({ error: "Failed to create user" }, 500);
      }
      userId = createResult.data.user.id;
      logger.info("Dev login: Created new user", { userId });
    } else {
      userId = userResult.data.id;
      logger.info("Dev login: Using existing user", { userId });
    }

    // Create session
    const sessionResult = await createSession(c.env.DB, userId, logger);
    if (!sessionResult.success) {
      logger.error("Failed to create session", sessionResult.error, { userId });
      return c.json({ error: "Failed to create session" }, 500);
    }

    // Set cookie
    setCookie(c, "stratum_session", sessionResult.data.id, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 2592000,
      path: "/",
    });

    // Redirect to home or specified redirect URL
    const redirectTo = c.req.query("redirect") || "/";
    return c.redirect(redirectTo);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error("Dev login error", error);
    return c.json({ error: "Dev login failed", details: error.message }, 500);
  }
});

// Mounted before uiRouter, whose `/:namespace/:slug` catch-all is registered
// last and would otherwise swallow these paths.
app.route("/_ph", posthogProxyRouter);

app.get("/ui.css", (c) => {
  return c.text(CSS, 200, { "Content-Type": "text/css; charset=UTF-8" });
});

// Browsers request /favicon.ico on pages with no <link rel="icon"> (raw JSON
// responses, redirects); serve the same S-mark the layout inlines.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0d0d0d"/><text x="16" y="23" font-family="monospace" font-size="20" font-weight="700" fill="#7ca9f7" text-anchor="middle">S</text></svg>`;
app.get("/favicon.ico", (c) =>
  c.body(FAVICON_SVG, 200, {
    "Content-Type": "image/svg+xml",
    "Cache-Control": "public, max-age=86400",
  }),
);

// Health check endpoint
app.route("/api/health", healthRouter);

// Admin metrics endpoint
app.route("/api/admin/metrics", metricsRouter);

// Admin audit trail endpoint
app.route("/api/admin/audit", auditRouter);
app.route("/api/admin/backup", backupRouter);
app.route("/api/admin/restore", restoreRouter);
app.route("/api/admin/deletion-jobs", deletionJobsRouter);
app.route("/api/admin/backfill-project-id", backfillRouter);

// Redirects from old /ui/* URLs to new paths (backward compatibility)
app.get("/ui", (c) => c.redirect("/", 301));
app.get("/ui/projects", (c) => c.redirect("/", 301));
app.get("/ui/projects/:name", (c) => {
  const name = c.req.param("name");
  return c.redirect(`/p/${name}`, 301);
});
app.get("/ui/projects/:name/changes", (c) => {
  const name = c.req.param("name");
  return c.redirect(`/p/${name}/changes`, 301);
});
app.get("/ui/projects/:name/workspaces", (c) => {
  const name = c.req.param("name");
  return c.redirect(`/p/${name}/workspaces`, 301);
});
app.get("/ui/changes/:id", (c) => {
  const id = c.req.param("id");
  return c.redirect(`/changes/${id}`, 301);
});

app.route("/auth", authRouter);
app.route("/auth/email", emailAuthRouter);
app.route("/auth/login", loginRouter);
app.route("/auth/signup", signupRouter);
app.route("/auth/signup/complete", oauthSignupRouter);
app.route("/auth/sessions", sessionRouter);
app.route("/api/projects", webhooksRouter);
app.route("/api/projects", issuesRouter);
// Ahead of projectsRouter: both claim /api/projects, and Hono matches in mount
// order, so the narrower :namespace/:slug/{secrets,deployments} paths have to be
// offered first or the broader project routes shadow them.
app.route("/api/projects", projectDeploymentsRouter);
app.route("/api/projects", projectsRouter);
app.route("/api/deployments", deploymentsRouter);
app.route("/api/workspaces", workspacesRouter);
app.route("/api/users", usersRouter);
app.route("/api/agents", agentsRouter);
app.route("/api", changesRouter);
app.route("/api", reviewsRouter);
app.route("/api/orgs", orgsRouter);
app.route("/api", syncRouter);
app.route("/api", syncManagementRouter);
app.route("/api/bulk-import", bulkImportRouter);
app.route("/api/webhooks/github", githubWebhookRouter);

// The remote MCP endpoint and the OAuth 2.1 authorization server that fronts it
// (#349). Both own absolute paths (/mcp, /oauth/*, /.well-known/oauth-*), so
// they mount at the root — before the UI catch-all, whose /:namespace/:slug
// route would otherwise swallow /.well-known/oauth-protected-resource.
app.route("/", mcpOAuthRouter);
app.route("/", mcpRouter);

// Browsers POST CSP violation reports here; every page's policy names it.
app.route("/", cspReportRouter);

// Git smart-HTTP proxy (clone/fetch). Mount before the UI catch-all so its
// /@ns/slug/{info/refs,git-upload-pack,git-receive-pack} paths resolve here.
app.route("/", gitHttpRouter);

// Mount the UI router last: its /:namespace/:slug catch-all would otherwise
// shadow two-segment API paths like GET /api/projects.
app.route("/", uiRouter);

// Browsers get a real 404 page; API paths and non-HTML clients keep the JSON contract.
app.notFound((c) => notFoundResponse(c));
app.onError((err, c) => {
  const logger = c.get("logger") || createLogger({ path: c.req.path, method: c.req.method });
  logger.error(`Unhandled error: ${err.message}`, err instanceof Error ? err : undefined, {
    path: c.req.path,
    method: c.req.method,
  });
  // An unhandled exception never reaches `analyticsMiddleware`'s post-`next()`
  // body — the rejection propagates straight past it to here — so a 500 born
  // this way is invisible in `api_request` entirely. That is the gap this
  // fills, and why it is a distinct event rather than a status code.
  //
  // The message is deliberately absent: exception messages quote their input,
  // which on this codebase means SQL fragments, tokens, and file paths. The
  // constructor name is the bounded part, and the message stays in the log
  // line above where an operator can read it and a third party cannot.
  trackerForRequest(c).capture("error_occurred", {
    route: errorRoute(c),
    method: c.req.method,
    error_type: err instanceof Error ? err.constructor.name : "unknown",
  });
  // Belt-and-suspenders: the middleware registers headers before next(), but the
  // error boundary builds a fresh response, so re-assert the full set here via the
  // shared helper (keeps the 500's CSP identical to the middleware's).
  setHtmlSecurityHeaders(c);
  return serverErrorResponse(c);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const logger = createLogger({ component: "scheduled" });
    runScheduledJobs(event.cron, env, logger, (promise) => ctx.waitUntil(promise));
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const logger = createLogger({ component: "queue" });

    // Route by queue-name prefix: Cloudflare queues are account-level, so each
    // environment gets its own instance ("stratum-events", "stratum-events-staging")
    // while this one codebase consumes them all.
    const queueName = batch.queue;

    if (queueName.startsWith("stratum-imports")) {
      logger.info("Processing import queue batch", {
        queue: queueName,
        messageCount: batch.messages.length,
      });
      await handleImportQueue(batch as MessageBatch<ImportJobMessage | SyncJobMessage>, env);
    } else if (queueName.startsWith("stratum-events")) {
      await handleEventQueue(batch as MessageBatch<EventQueueMessage>, env);
    } else if (queueName.startsWith("stratum-deploys")) {
      await handleDeployQueue(batch, env);
    } else {
      // Unknown queue - ack all messages to prevent retries
      logger.warn("Unknown queue", { queue: queueName });
      batch.ackAll();
    }
  },
};
