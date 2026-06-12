import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF protection for cookie-authenticated requests.
 *
 * Bearer-token requests are immune (cross-site attackers cannot set the
 * Authorization header), so only session-cookie auth is checked. The session
 * cookie is SameSite=Lax — this middleware is the defense-in-depth layer:
 * state-changing requests must present an Origin (or Referer) matching the
 * request host. Requests with neither header are rejected; every modern
 * browser sends Origin on cross-origin POSTs and form submissions.
 */
export const csrfMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!STATE_CHANGING_METHODS.has(c.req.method)) {
    await next();
    return;
  }
  // Only session-cookie auth is forgeable cross-site.
  if (c.get("authVia") !== "session") {
    await next();
    return;
  }

  const requestHost = new URL(c.req.url).host;
  const logger = c.get("logger") ?? createLogger({ path: c.req.path, method: c.req.method });

  const origin = c.req.header("Origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      logger.warn("CSRF rejected - malformed Origin header", { origin });
      return c.json({ error: "Cross-site request rejected", code: "CSRF" }, 403);
    }
    if (originHost !== requestHost) {
      logger.warn("CSRF rejected - Origin mismatch", { origin, requestHost });
      return c.json({ error: "Cross-site request rejected", code: "CSRF" }, 403);
    }
    await next();
    return;
  }

  const referer = c.req.header("Referer");
  if (referer) {
    let refererHost: string;
    try {
      refererHost = new URL(referer).host;
    } catch {
      logger.warn("CSRF rejected - malformed Referer header", {});
      return c.json({ error: "Cross-site request rejected", code: "CSRF" }, 403);
    }
    if (refererHost !== requestHost) {
      logger.warn("CSRF rejected - Referer mismatch", { requestHost });
      return c.json({ error: "Cross-site request rejected", code: "CSRF" }, 403);
    }
    await next();
    return;
  }

  logger.warn("CSRF rejected - no Origin or Referer on session-authenticated mutation", {});
  return c.json({ error: "Cross-site request rejected", code: "CSRF" }, 403);
};
