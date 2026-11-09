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
import { contextStorage } from "hono/context-storage";
import { authMiddleware } from "../middleware/auth";
import { orgIpAllowlistMiddleware } from "../middleware/org-ip-allowlist";
import { orgSecondFactorMiddleware } from "../middleware/org-second-factor";
import { changesRouter } from "../routes/changes";
import { issuesRouter } from "../routes/issues";
import { orgsRouter } from "../routes/orgs";
import { projectsRouter } from "../routes/projects";
import { reviewsRouter } from "../routes/reviews";
import { usersRouter } from "../routes/users";
import { workspacesRouter } from "../routes/workspaces";
import type { Env } from "../types";

const api = new Hono<{ Bindings: Env }>();

/**
 * The original caller's address for each in-flight sub-request (#399).
 *
 * A sub-request is built by the server, not received from the edge, so it has
 * no `CF-Connecting-IP` of its own — judged naively, every tool call would
 * come from nowhere (or, worse, from the Worker). The address is therefore
 * handed over out of band, keyed by the very `Request` object, and published
 * as the `clientIp` context variable before anything else runs. Nothing a
 * client sends can reach this map: `StratumClient` replays only
 * `Authorization` and `Content-Type`, and this middleware sets `clientIp`
 * unconditionally, so even a header on the sub-request would never be read.
 */
const subRequestClientIps = new WeakMap<Request, string>();

// Its own context store, so the authz helpers' `tryGetContext` sees THIS
// sub-request (with its caller, binding and client address), not the outer
// `/mcp` request it was dispatched from.
api.use("*", contextStorage());
api.use("*", async (c, next) => {
  c.set("clientIp", subRequestClientIps.get(c.req.raw) ?? "");
  await next();
});
api.use("*", authMiddleware);
// An org's second-factor policy (#441). Authz already withholds the org's
// projects from a grant that was not minted with a second factor, but the
// org's own endpoints (members, teams) are refused only by this middleware,
// and `orgsRouter` is mounted below. Without it, a grant the policy refuses
// could still manage the org through the org tools. It also turns the
// refusal into `SECOND_FACTOR_REQUIRED` with a message the tool result can
// show. Same position relative to the allowlist as in src/index.ts.
api.use("*", orgSecondFactorMiddleware);
// Turns an IP-allowlist refusal into `IP_NOT_ALLOWED` with a message the tool
// result can show, instead of a bare "not found" for a project the caller can
// see from an allowed network.
api.use("*", orgIpAllowlistMiddleware);

// Mount order mirrors src/index.ts exactly. It matters: `issuesRouter` and
// `projectsRouter` share the `/api/projects` prefix, and swapping them lets a
// project route's parameterised path shadow `/issues`.
api.route("/api/projects", issuesRouter);
api.route("/api/projects", projectsRouter);
api.route("/api/workspaces", workspacesRouter);
api.route("/api/users", usersRouter);
api.route("/api", changesRouter);
api.route("/api", reviewsRouter);
// Only the org/member/team router. SSO, security policy and audit export stay
// off the MCP surface: they are administrative settings with no tool, and a
// route that is not mounted here cannot be reached by any tool call.
api.route("/api/orgs", orgsRouter);

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
 *
 * `clientIp` is the address of the client that called `/mcp` (its
 * `CF-Connecting-IP`), so org IP allowlists judge the tool call by where its
 * caller really is. "" (unknown) fails closed for a restricted org.
 */
export async function dispatchApiRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  clientIp: string,
): Promise<Response> {
  subRequestClientIps.set(request, clientIp);
  return api.fetch(request, env, ctx);
}
