import type { MiddlewareHandler } from "hono";
import { isGitHttpPath } from "../routes/git-http";
import type { Env } from "../types";

/**
 * Response security headers for the server-rendered UI and API.
 *
 * The CSP is deliberately limited to directives that do NOT restrict inline
 * scripts: the UI ships inline `onclick` handlers and inline `<script>` blocks
 * (file-tree, conflict-resolution, import-progress), and inline event-handler
 * attributes cannot be nonce'd — a `script-src` policy would break them. So we
 * ship the safe subset (`frame-ancestors`/`object-src`/`base-uri`) now;
 * tightening `script-src` is deferred behind an inline-handler refactor.
 *
 * Git smart-HTTP responses are left untouched — they are not HTML and must not
 * carry frame/CSP headers that could confuse git clients or proxies.
 */
export const securityHeadersMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  // Register headers BEFORE next() so they survive on the response even if a
  // downstream handler throws and the error boundary produces the 500.
  if (isGitHttpPath(c.req.path)) {
    await next();
    return;
  }

  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");

  // HSTS only over HTTPS (a plain-HTTP response with HSTS is ignored by browsers
  // and pointless; local http dev must stay usable).
  if (new URL(c.req.url).protocol === "https:") {
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  await next();
};
