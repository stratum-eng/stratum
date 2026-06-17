import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { githubWebhookRouter } from "./github/webhooks";
import { analyticsMiddleware } from "./middleware/analytics";
import { authMiddleware } from "./middleware/auth";
import { csrfMiddleware } from "./middleware/csrf";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { handleEventQueue, sweepStaleEvents } from "./queue/event-consumer";
import type { EventQueueMessage } from "./queue/events";
import { handleImportQueue } from "./queue/import-queue";
import { runTtlSweep } from "./queue/ttl-sweep";
import { agentsRouter } from "./routes/agents";
import { auditRouter } from "./routes/audit";
import { authRouter } from "./routes/auth";
import { bulkImportRouter } from "./routes/bulk-import";
import { changesRouter } from "./routes/changes";
import { emailAuthRouter } from "./routes/email-auth";
import { healthRouter } from "./routes/health";
import { issuesRouter } from "./routes/issues";
import { loginRouter } from "./routes/login";
import { metricsRouter } from "./routes/metrics";
import { orgsRouter } from "./routes/orgs";
import { projectsRouter } from "./routes/projects";
import { reviewsRouter } from "./routes/reviews";
import { sessionRouter } from "./routes/sessions";
import { signupRouter } from "./routes/signup";
import { syncAllProjects, syncRouter } from "./routes/sync";
import { syncManagementRouter } from "./routes/sync-management";
import { uiRouter } from "./routes/ui";
import { usersRouter } from "./routes/users";
import { webhooksRouter } from "./routes/webhooks";
import { workspacesRouter } from "./routes/workspaces";
import { createSession } from "./storage/sessions";
import { createUser, getUserByEmail } from "./storage/users";
import type { Env, ImportJobMessage, MessageBatch, SyncJobMessage } from "./types";
import { CSS } from "./ui/styles";
import { createLogger } from "./utils/logger";
export { MergeQueue } from "./queue/merge-queue";
export { RepoDO } from "./queue/repo-do";

const app = new Hono<{ Bindings: Env }>();

app.use("*", analyticsMiddleware);
app.use("*", authMiddleware);
app.use("*", csrfMiddleware);
app.use("*", rateLimitMiddleware());

app.get("/health", (c) => c.json({ status: "ok", service: "stratum" }));

// DEV ONLY: Quick login for local development
app.get("/dev-login", async (c) => {
  const logger = createLogger({ path: c.req.path, method: c.req.method });

  try {
    // Only allow in local development
    const url = new URL(c.req.url);
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      return c.json({ error: "Dev login only available in local development" }, 403);
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

app.get("/ui.css", (c) => {
  return c.text(CSS, 200, { "Content-Type": "text/css; charset=UTF-8" });
});

// Health check endpoint
app.route("/api/health", healthRouter);

// Admin metrics endpoint
app.route("/api/admin/metrics", metricsRouter);

// Admin audit trail endpoint
app.route("/api/admin/audit", auditRouter);

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
app.route("/auth/sessions", sessionRouter);
app.route("/api/projects", webhooksRouter);
app.route("/api/projects", issuesRouter);
app.route("/api/projects", projectsRouter);
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
// Mount the UI router last: its /:namespace/:slug catch-all would otherwise
// shadow two-segment API paths like GET /api/projects.
app.route("/", uiRouter);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  const logger = c.get("logger") || createLogger({ path: c.req.path, method: c.req.method });
  logger.error(`Unhandled error: ${err.message}`, err instanceof Error ? err : undefined, {
    path: c.req.path,
    method: c.req.method,
  });
  return c.json({ error: "Internal server error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const logger = createLogger({ component: "scheduled" });
    if (event.cron === "*/5 * * * *") {
      ctx.waitUntil(sweepStaleEvents(env, logger));
      return;
    }
    ctx.waitUntil(Promise.all([runTtlSweep(env, logger), syncAllProjects(env)]));
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const logger = createLogger({ component: "queue" });

    // Determine which queue this is based on the queue name
    const queueName = batch.queue;

    if (queueName === "stratum-imports") {
      // Handle import queue messages
      logger.info("Processing import queue batch", {
        queue: queueName,
        messageCount: batch.messages.length,
      });
      await handleImportQueue(batch as MessageBatch<ImportJobMessage | SyncJobMessage>, env);
    } else if (queueName === "stratum-events") {
      await handleEventQueue(batch as MessageBatch<EventQueueMessage>, env);
    } else {
      // Unknown queue - ack all messages to prevent retries
      logger.warn("Unknown queue", { queue: queueName });
      batch.ackAll();
    }
  },
};
