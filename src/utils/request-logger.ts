/**
 * The per-request logger, carrying the request id `authMiddleware` minted.
 *
 * Every route used to build its own logger from the path and method, which
 * dropped the request id: a middleware warning and the route's own line for
 * the same request could not be joined in Workers Logs, so "auth rejected the
 * token" and "the token endpoint answered 401" looked like unrelated events.
 * The middleware stores its logger on the context before it does anything
 * else, so routes read that one. The fallback exists for routers mounted in
 * tests without the middleware; it carries the same path and method fields,
 * minus the id.
 */
import type { Context } from "hono";
import type { Env } from "../types";
import { type Logger, type LoggerContext, createLogger } from "./logger";

/** Use this instead of `createLogger` in a route so its lines share the middleware's
 * request id and can be joined with the middleware's own warnings. `extra` narrows
 * the logger with route-specific fields without losing that correlation. */
export function requestLogger(c: Context<{ Bindings: Env }>, extra: LoggerContext = {}): Logger {
  const base = c.get("logger") ?? createLogger({ path: c.req.path, method: c.req.method });
  return Object.keys(extra).length === 0 ? base : base.child(extra);
}
