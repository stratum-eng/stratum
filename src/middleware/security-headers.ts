import type { Context, MiddlewareHandler } from "hono";
import { isGitHttpPath } from "../routes/git-http";
import type { Env } from "../types";

declare module "hono" {
  interface ContextVariableMap {
    /**
     * Per-request CSP nonce (base64). Set by `setHtmlSecurityHeaders` (i.e. the
     * security-headers middleware) before route handlers run; pages thread it
     * onto every `<script nonce={...}>` they render so the `script-src` policy
     * admits exactly those scripts and nothing an injection could smuggle in.
     */
    cspNonce?: string;
  }
}

/**
 * Generate a fresh CSP nonce: 128 bits from the platform CSPRNG, base64-encoded
 * (the encoding the CSP spec recommends for nonce values).
 */
export function generateCspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

/**
 * CSP for the server-rendered UI and API, parameterized by the per-request
 * script nonce. Built in ONE place so the request middleware and the error
 * boundary (src/index.ts) share a single source of truth — a 500 response must
 * carry the same policy as a 200, and duplicating the string let them drift.
 *
 * `script-src 'nonce-…'` (issue #161): every inline `<script>` the UI renders
 * carries this request's nonce; the old inline `onclick=`/`onsubmit=` handlers
 * were refactored into nonce'd `addEventListener` blocks, so nothing else needs
 * to execute. Deliberately NO:
 * - `'unsafe-inline'` fallback — it only aids pre-2016 browsers that ignore
 *   nonces (CSP1-only), at the cost of advertising an inline-script escape
 *   hatch to every scanner; all supported browsers understand nonces.
 * - `'strict-dynamic'` — it exists to let nonce'd loaders inject further
 *   scripts; the UI loads no external scripts and injects none, so granting
 *   transitive trust would only widen the policy.
 */
export function contentSecurityPolicy(nonce: string): string {
  return `frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-src 'none'; script-src 'nonce-${nonce}'`;
}

/**
 * Apply the HTML security headers (content-type sniffing, framing, referrer,
 * CSP). Used by both the middleware and the error boundary so the two paths
 * stay identical. The CSP nonce is generated once per request and cached on the
 * context: the error boundary re-asserts headers on a context the middleware
 * already stamped, and both calls must emit the SAME policy string. HSTS is
 * applied separately — it is conditional on HTTPS.
 */
export function setHtmlSecurityHeaders(c: Context<{ Bindings: Env }>): void {
  let nonce = c.get("cspNonce");
  if (nonce === undefined) {
    nonce = generateCspNonce();
    c.set("cspNonce", nonce);
  }
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Content-Security-Policy", contentSecurityPolicy(nonce));
}

/**
 * Response security headers for the server-rendered UI and API.
 *
 * The CSP restricts script execution to `<script>` elements carrying this
 * request's nonce (stored on the context as `cspNonce`, threaded through page
 * props to every script tag the UI renders). `default-src` is still omitted on
 * purpose: adding it would (via fallback) govern style/img/connect/font, and
 * the UI relies on inline `style=` attributes, `<style>` blocks and `data:`
 * favicons — locking those down is a separate refactor.
 *
 * Git smart-HTTP responses are left untouched — they are not HTML and must not
 * carry frame/CSP headers that could confuse git clients or proxies.
 */
export const securityHeadersMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  // Register headers BEFORE next() so they survive on the response even if a
  // downstream handler throws and the error boundary produces the 500 (and so
  // route handlers can read the nonce off the context while rendering). Git
  // smart-HTTP responses are not HTML and must stay untouched, so they are
  // skipped — the single await next() below still runs for them.
  if (!isGitHttpPath(c.req.path)) {
    setHtmlSecurityHeaders(c);

    // HSTS only over HTTPS (a plain-HTTP response with HSTS is ignored by
    // browsers and pointless; local http dev must stay usable).
    if (new URL(c.req.url).protocol === "https:") {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  }

  await next();
};
