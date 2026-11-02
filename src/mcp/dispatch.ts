/**
 * Runs an MCP tool's API call against the real route handlers, in-process.
 *
 * The alternative designs were both worse. Calling the storage layer directly
 * would mean reimplementing every route's authorization, validation and
 * evaluation-gate wiring, and then keeping two copies in agreement forever —
 * the exact drift that lets an MCP client do something the REST API forbids.
 * Re-entering the *main* app would work, but re-runs the whole outer middleware
 * chain per tool call: the request would be counted twice in product analytics
 * and metered twice by the rate limiter, so a single MCP call would cost a
 * caller two requests' worth of budget.
 *
 * So: the same routers, mounted here, behind the one middleware that a
 * sub-request genuinely needs.
 *
 * `authMiddleware` is that one. It is not a formality — the inbound
 * `Authorization` header is replayed verbatim on every sub-request and
 * re-resolved here, so a credential revoked mid-conversation stops working on
 * the next tool call, and a read-only grant is refused at exactly the same
 * point it would be over HTTP. Everything the tools reach is therefore governed
 * by the same checks a curl against the public API would meet.
 */
import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";
import { changesRouter } from "../routes/changes";
import { issuesRouter } from "../routes/issues";
import { projectsRouter } from "../routes/projects";
import { reviewsRouter } from "../routes/reviews";
import { usersRouter } from "../routes/users";
import { workspacesRouter } from "../routes/workspaces";
import type { Env } from "../types";

const api = new Hono<{ Bindings: Env }>();

api.use("*", authMiddleware);

// Mount order mirrors src/index.ts exactly. It matters: `issuesRouter` and
// `projectsRouter` share the `/api/projects` prefix, and swapping them lets a
// project route's parameterised path shadow `/issues`.
api.route("/api/projects", issuesRouter);
api.route("/api/projects", projectsRouter);
api.route("/api/workspaces", workspacesRouter);
api.route("/api/users", usersRouter);
api.route("/api", changesRouter);
api.route("/api", reviewsRouter);

// JSON, not the HTML error pages the outer app serves: the only consumer is
// `StratumClient`, which reads `{error}` out of the body to build the tool's
// error text. An HTML 404 here would surface to a model as an unparseable blob.
api.notFound((c) => c.json({ error: `No such Stratum API route: ${c.req.path}` }, 404));
api.onError((error, c) => {
  c.get("logger")?.error("MCP sub-request failed", error instanceof Error ? error : undefined, {
    path: c.req.path,
  });
  // A fixed message, never `error.message`. `StratumClient` lifts `{error}`
  // straight into the tool's result text, so an unhandled exception here would
  // put D1 or SQL internals in front of a language model and into the client's
  // transcript. The detail stays in the log line above, where an operator can
  // read it and a caller cannot.
  return c.json({ error: "Internal error" }, 500);
});

/**
 * Dispatch one API sub-request.
 *
 * `ctx` is threaded through so `waitUntil` still works for the background
 * writes routes schedule (audit entries, `last_used_at` touches, event queue
 * publishes). Passing `undefined` is supported because `app.fetch(request,
 * env)` in tests supplies no execution context — the same accommodation
 * `getWaitUntil` makes elsewhere.
 */
export async function dispatchApiRequest(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  return api.fetch(request, env, ctx);
}
