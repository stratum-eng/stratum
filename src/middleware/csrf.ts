import type { Context, MiddlewareHandler } from "hono";
import { isGitHttpPath } from "../routes/git-http";
import type { Env } from "../types";
import { type Logger, createLogger } from "../utils/logger";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Reject a state-changing request whose Origin/Referer doesn't match the request
 * host (or is absent). Returns a 403 Response to return as-is, or `null` when the
 * request is same-origin and may proceed. Exported so unauthenticated endpoints
 * that `csrfMiddleware` skips (it only guards session-cookie auth) can enforce
 * same-origin themselves — e.g. the magic-link verify POST, which has no session
 * yet but must not be forgeable cross-site (login CSRF).
 */
export function enforceSameOrigin(c: Context<{ Bindings: Env }>, logger: Logger): Response | null {
  const requestHost = new URL(c.req.url).host;

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
    return null;
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
    return null;
  }

  logger.warn("CSRF rejected - no Origin or Referer on state-changing request", {});
  return c.json({ error: "Cross-site request rejected", code: "CSRF" }, 403);
}

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
  // Git smart-HTTP is Basic/token-authenticated (not session cookies) and owns
  // its own access checks — exempt by path to be robust to future changes.
  if (isGitHttpPath(c.req.path)) {
    await next();
    return;
  }
  // Only session-cookie auth is forgeable cross-site.
  if (c.get("authVia") !== "session") {
    await next();
    return;
  }

  const logger = c.get("logger") ?? createLogger({ path: c.req.path, method: c.req.method });
  const rejected = enforceSameOrigin(c, logger);
  if (rejected) return rejected;
  await next();
};
