/**
 * Injects the browser analytics bootstrap into server-rendered pages.
 *
 * ## Why a middleware and not a prop on `Layout`
 *
 * Twenty-one `<Layout>` call sites would each have to remember to pass an
 * analytics prop, and six HTML responses do not go through `Layout` at all.
 * That is the shape of bug `AnalyticsTracker`'s docblock exists to prevent: a
 * rule every call site must remember is a rule some call site will forget.
 * Injecting here means no page needs to know analytics exists.
 *
 * ## The cost of that, and what pays it
 *
 * The same property makes the injector indiscriminate, and some of this app's
 * pages render secrets — a webhook signing secret beside a Copy button, a
 * freshly minted API token, an OAuth consent screen whose query string carries
 * `client_id`, `redirect_uri`, `state` and `code_challenge`. "No page knows
 * analytics exists" is exactly why nobody would notice those were instrumented.
 *
 * So there are two ways off: `DENIED_ROUTES` for the cases known today, and the
 * `X-Stratum-No-Analytics` response header for any handler that renders
 * something sensitive later. The header is the important half — it is local to
 * the page that knows it has a secret, so a future author does not have to
 * discover a central list in another directory.
 */
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { SDK_PATH, webAnalyticsConfig } from "../analytics/web";
import { bootstrapScript } from "../analytics/web-snippet";
import { isGitHttpPath } from "../routes/git-http";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";

const logger = createLogger({ component: "WebAnalytics" });

/**
 * Any handler may set this to keep analytics off its response. Stripped before
 * the response leaves, so it never reaches the client.
 */
export const NO_ANALYTICS_HEADER = "X-Stratum-No-Analytics";

/**
 * Prefixes never instrumented, matched against both the route pattern and the
 * concrete path.
 *
 * Matched by PREFIX, not equality. `/settings` alone would have covered only
 * `GET /settings`, which renders nothing secret — while `POST /settings/tokens`,
 * `/settings/rotate-token` and `/settings/agents` are the three that return a
 * plaintext credential, and every one of them would have been instrumented.
 *
 * `/oauth/authorize` is a consent screen running under a deliberately different
 * CSP, whose query string carries `client_id`, `redirect_uri`, `state` and
 * `code_challenge`. `/api` is not a UI surface, and the webhook-created page —
 * which prints a signing secret beside a Copy button — is served from under it.
 * `/_ph` is the analytics proxy, which must not instrument itself.
 */
const DENIED_PREFIXES = ["/oauth/authorize", "/settings", "/api", "/_ph"] as const;

/**
 * Is this response barred from carrying analytics?
 *
 * Checked against BOTH the matched route pattern and the concrete path,
 * because a handler can be reached by either shape and a deny list that
 * consults only one of them has a hole. Prefix rather than equality: the
 * version of this that matched exactly covered `GET /settings`, which renders
 * nothing secret, and missed the three `POST /settings/*` handlers that return
 * a plaintext credential.
 */
function isDenied(route: string, path: string): boolean {
  return DENIED_PREFIXES.some(
    (prefix) =>
      route === prefix ||
      route.startsWith(`${prefix}/`) ||
      path === prefix ||
      path.startsWith(`${prefix}/`),
  );
}

/**
 * Is this a response we can safely rewrite?
 *
 * `Content-Encoding` is the subtle one: the proxy relays compressed bodies from
 * PostHog, and running `HTMLRewriter` over a body whose declared encoding is
 * still on the response mangles it.
 */
function isInjectableResponse(response: Response, method: string): boolean {
  if (method === "HEAD") return false;
  if (response.status === 304 || (response.status >= 300 && response.status < 400)) return false;
  // Server-side, `analyticsMiddleware` drops 404s and the FAQ documents that.
  // Injecting here would fire a browser $pageview for the same request and put
  // the two surfaces permanently out of agreement.
  if (response.status === 404) return false;
  if (response.headers.has("Content-Encoding")) return false;
  if (!response.body) return false;
  return (response.headers.get("Content-Type") ?? "").toLowerCase().includes("text/html");
}

/**
 * Place the tags immediately before the closing body tag, or at the end of the
 * document when there is not one.
 *
 * The fallback is the point. Anchoring on a `</body>` match alone means a
 * document without it silently receives nothing — and silent absence of
 * analytics is the exact failure this whole change exists to fix, so it must
 * not be reintroduced by the mechanism that fixes it.
 *
 * `HTMLRewriter` would stream rather than buffer and is the idiomatic Workers
 * answer, but it does not exist outside workerd and this repo's suite runs on
 * node. Using it would leave the only production path untested in CI —
 * including the branch that decides whether a page rendering a secret gets
 * instrumented. These pages are server-rendered and already fully materialised
 * in memory by `renderToString`, so buffering costs nothing that was not
 * already spent.
 */
export function injectBeforeBodyEnd(html: string, tags: string): string {
  const index = html.toLowerCase().lastIndexOf("</body>");
  if (index === -1) return html + tags;
  return html.slice(0, index) + tags + html.slice(index);
}

export const webAnalyticsMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next();

  const path = c.req.path;
  // Git smart-HTTP responses are not HTML and must stay untouched, matching
  // `securityHeadersMiddleware`.
  if (isGitHttpPath(path)) return;

  if (c.res.headers.has(NO_ANALYTICS_HEADER)) {
    try {
      c.res.headers.delete(NO_ANALYTICS_HEADER);
    } catch {
      // A response derived from `fetch` has immutable headers. Failing to strip
      // an internal marker is cosmetic; failing to honour the opt-out it
      // signals is not, so the return below happens either way.
      logger.debug("Could not strip the no-analytics marker from an immutable response");
    }
    return;
  }

  if (!isInjectableResponse(c.res, c.req.method)) return;

  // `routePath(c)` defaults to `c.req.routeIndex` — the handler that actually
  // answered. NOT `routePath(c, -1)`, which returns the last *registered*
  // route that matched the path: `uiRouter`'s `/:namespace/:slug` catch-all is
  // mounted last, so it shadows every earlier route and would report
  // `/auth/signup` as `/:namespace/:slug`.
  const route = routePath(c);
  if (isDenied(route, path)) return;

  const nonce = c.get("cspNonce");
  // Without a nonce the injected tags would be blocked by `script-src`, so the
  // only thing injecting would achieve is a pair of CSP violation reports.
  if (!nonce) return;

  const config = webAnalyticsConfig({
    publicKey: c.env.POSTHOG_PUBLIC_KEY,
    host: c.env.POSTHOG_HOST,
    telemetryDisabled: c.env.STRATUM_TELEMETRY_DISABLED,
    environment: c.env.STRATUM_ENVIRONMENT,
    route,
    userId: c.get("userId"),
    optedOut: c.get("telemetryOptOut") === true,
  });
  if (!config) return;

  const sdkTag = `<script nonce="${nonce}" src="${SDK_PATH}" defer></script>`;
  const bootstrapTag = `<script nonce="${nonce}" defer>${bootstrapScript(config)}</script>`;
  // The page is already rendered and valid at this point. Analytics must never
  // be able to turn a successful response into an error, so a failed read is
  // logged and the original response is left exactly as the handler built it.
  let html: string;
  try {
    html = await c.res.text();
  } catch (err) {
    logger.warn("Could not read the response body for analytics injection", {
      error: String(err),
    });
    return;
  }

  c.res = new Response(injectBeforeBodyEnd(html, `${sdkTag}${bootstrapTag}`), {
    status: c.res.status,
    headers: c.res.headers,
  });

  // Set AFTER the assignment, not before. Hono's `set res` copies every header
  // from the outgoing response onto the replacement (see its context.js), so
  // anything set on the `Headers` passed to the constructor is immediately
  // overwritten by the handler's own value.
  //
  // Both of these matter. The injected script carries a per-request nonce and
  // most UI pages set no cache header, so any CDN or operator "cache
  // everything" rule would serve a stale nonce and the script would be blocked
  // with no error anyone sees. And the body just grew, so a Content-Length
  // inherited from the pre-injection response describes a shorter document than
  // the one being sent.
  c.res.headers.set("Cache-Control", "no-store");
  c.res.headers.delete("Content-Length");
};
