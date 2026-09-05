import { readPostHogProjectKey } from "../analytics-key.mjs";

/**
 * Docs site Worker.
 *
 * The site is still a static build; this Worker only adds what static assets
 * cannot do on their own:
 *
 *   1. RFC 8288 `Link` headers pointing agents at the machine-readable entry
 *      points (llms.txt, the OpenAPI spec, the catalogues, auth.md, the sitemap).
 *   2. Markdown content negotiation — a request for a page with
 *      `Accept: text/markdown` gets the Markdown source instead of HTML.
 *   3. CORS on the agent-facing metadata, so a browser agent on another origin
 *      can read it (the ARD spec requires this on the catalogue).
 *   4. A content type for `/.well-known/` documents that RFC convention leaves
 *      extensionless, which the assets binding would otherwise mislabel.
 *
 * Everything else falls straight through to the assets binding.
 */

const LINK_HEADER = [
  '</llms.txt>; rel="alternate"; type="text/plain"; title="Documentation index for language models"',
  '</llms-full.txt>; rel="alternate"; type="text/plain"; title="Complete documentation for language models"',
  '</openapi.yml>; rel="service-desc"; type="application/yaml"; title="Stratum REST API"',
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  '</.well-known/ai-catalog.json>; rel="ai-catalog"; type="application/json"; title="Agentic Resource Discovery manifest"',
  '</.well-known/agent-skills/index.json>; rel="agent-skills"; type="application/json"; title="Agent Skills discovery index"',
  '</auth.md>; rel="auth"; type="text/markdown"; title="Agent registration contract"',
  '</sitemap-index.xml>; rel="sitemap"; type="application/xml"',
].join(", ");

/** Paths whose content type the assets binding cannot infer from the extension. */
const CONTENT_TYPES = {
  "/.well-known/api-catalog": "application/linkset+json",
};

/**
 * True for the machine-readable metadata an agent may fetch cross-origin.
 *
 * These documents exist to be read by code running on someone else's page — the
 * ARD spec requires `Access-Control-Allow-Origin: *` on the catalogue outright —
 * and every one of them is already public, so a wildcard grants nothing that a
 * plain GET does not. The docs site has no cookies or credentialed endpoints for
 * a wildcard to expose.
 */
const isPublicMetadata = (pathname) =>
  pathname.startsWith("/.well-known/") ||
  pathname === "/auth.md" ||
  pathname === "/openapi.yml" ||
  pathname === "/llms.txt" ||
  pathname === "/llms-small.txt" ||
  pathname === "/llms-full.txt" ||
  // The index alone is not readable content — it holds only <loc> pointers to
  // the numbered files (sitemap-0.xml, ...) that Astro's sitemap plugin emits
  // alongside it, which is where the actual page URLs live.
  /^\/sitemap-(?:index|\d+)\.xml$/.test(pathname);

/**
 * True when the client actually accepts Markdown.
 *
 * Parses each Accept entry rather than prefix-matching it: `startsWith` would
 * also match an unrelated `text/markdownish`, and — more importantly — would
 * treat `text/markdown;q=0` as acceptance when q=0 is how a client says it does
 * NOT want that representation.
 */
const wantsMarkdown = (accept) =>
  accept.split(",").some((part) => {
    const [mediaType, ...params] = part.split(";");
    if (mediaType.trim().toLowerCase() !== "text/markdown") return false;
    const q = params
      .map((p) => p.trim().toLowerCase())
      .find((p) => p.startsWith("q="))
      ?.slice(2);
    if (q === undefined) return true;
    // Validate the whole token before converting. `Number.parseFloat` stops at
    // the first non-numeric character, so it reads `q=0bogus` as 0 — refusing a
    // malformed value that the policy below accepts, purely because the garbage
    // happened to start with a digit. The pattern is RFC 9110's qvalue grammar.
    if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q)) return true;
    // A malformed q is not a refusal, so only a well-formed zero excludes.
    return Number(q) > 0;
  });

/** PostHog ingestion paths this site will relay, and nothing else. */
const INGEST_PREFIXES = ["/e", "/i/v0/e", "/decide", "/flags", "/batch"];
/** Matches src/routes/posthog-proxy.ts: without a cap this is a relay billed to us. */
const MAX_BODY_BYTES = 1_000_000;
const PROXY_PREFIX = "/_ph";
const SDK_VERSION = "1.427.2";

/**
 * Read a request body, refusing anything over the cap without buffering it.
 *
 * Mirrors readBoundedBody in src/routes/posthog-proxy.ts. Content-Length alone
 * is not enough: a chunked request declares no length, which is the shape an
 * abusive caller would send, so the running total is checked as the stream is
 * consumed and the reader cancelled the moment it is exceeded.
 *
 * Returns null when the body is too large.
 */
async function readBoundedBody(request) {
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

/**
 * Same-origin reverse proxy for analytics, mirroring `src/routes/posthog-proxy.ts`.
 *
 * Must run before the Markdown branch below, which would otherwise rewrite
 * `/_ph/e` to `/_ph/e.md`, and before the assets binding, which would 404 it.
 * Returns 204 rather than an error on any refusal: a telemetry beacon must
 * never surface as a failure on the page.
 */
async function handleAnalyticsProxy(request, url, env) {
  // The same gate the app proxy carries. Without it a docs deployment built
  // with no key — the default for a fork, and for any PR build — still relays
  // to PostHog, which contradicts the "off unless POSTHOG_PUBLIC_KEY is set"
  // promise the FAQ makes and burns Worker time on traffic nobody asked for.
  // The build bakes the key into the HTML; this var is what tells the Worker
  // the same deployment has analytics on, and it is set by the deploy workflow.
  if (!readPostHogProjectKey(env.POSTHOG_PUBLIC_KEY)) return new Response(null, { status: 204 });

  const suffix = url.pathname.slice(PROXY_PREFIX.length) || "/";
  const noContent = () => new Response(null, { status: 204 });

  // Before the SDK branch, not after: `caches.default.put` throws for a
  // non-GET request, so a POST to the bundle path would have become a 500 on a
  // path whose entire contract is that a beacon never surfaces as a failure.
  if (!["GET", "POST", "OPTIONS"].includes(request.method)) return noContent();
  if (request.headers.get("X-Stratum-Proxy")) return noContent();

  const sdkMatch = /^\/static\/(\d+\.\d+\.\d+)\/array\.js$/.exec(suffix);
  if (sdkMatch) {
    // Only the pinned version: serving any semver would make this a general
    // jsDelivr proxy and defeat the pinning guarantee.
    if (request.method !== "GET" || sdkMatch[1] !== SDK_VERSION) return noContent();
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;
    const upstream = await fetch(
      `https://cdn.jsdelivr.net/npm/posthog-js@${sdkMatch[1]}/dist/array.js`,
    ).catch(() => null);
    if (!upstream?.ok) return noContent();
    const response = new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": "application/javascript; charset=UTF-8",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
    try {
      await caches.default.put(cacheKey, response.clone());
    } catch {
      // An uncacheable upstream response must not turn the bundle into a 500.
    }
    return response;
  }

  if (!INGEST_PREFIXES.some((p) => suffix === p || suffix.startsWith(`${p}/`))) return noContent();

  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  headers.delete("referer");
  headers.delete("host");
  headers.delete("x-forwarded-for");
  headers.set("X-Stratum-Proxy", "1");
  const clientIp = request.headers.get("CF-Connecting-IP");
  if (clientIp) headers.set("X-Forwarded-For", clientIp);

  let body;
  if (request.method === "POST") {
    body = await readBoundedBody(request);
    if (body === null) return noContent();
  }

  const upstream = await fetch(`https://us.i.posthog.com${suffix}${url.search}`, {
    method: request.method,
    headers,
    ...(body !== undefined ? { body } : {}),
  }).catch(() => null);
  if (!upstream) return noContent();

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("set-cookie");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const publicMetadata = isPublicMetadata(url.pathname);

    if (url.pathname === PROXY_PREFIX || url.pathname.startsWith(`${PROXY_PREFIX}/`)) {
      return handleAnalyticsProxy(request, url, env);
    }

    // A preflight only ever reaches these paths, and answering it here keeps the
    // assets binding from returning a 405 that reads to an agent as "gone".
    if (request.method === "OPTIONS" && publicMetadata) {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-allow-headers": "accept, content-type",
          "access-control-max-age": "86400",
        },
      });
    }

    if (request.method === "GET" && wantsMarkdown(request.headers.get("accept") ?? "")) {
      const path = url.pathname.replace(/\/+$/, "");
      // Set `pathname` on a copy rather than resolving a relative URL against
      // `url`: a request path can begin with `//` (e.g. `//example.com/x`), and
      // `new URL("//example.com/x.md", url)` is protocol-relative, so it would
      // resolve to a different origin entirely. Assigning `pathname` cannot
      // change the origin, so the lookup always stays on this site.
      const markdownUrl = new URL(url);
      markdownUrl.pathname = `${path === "" ? "/index" : path}.md`;
      markdownUrl.search = "";
      markdownUrl.hash = "";
      const markdown = await env.ASSETS.fetch(new Request(markdownUrl, { method: "GET" }));
      if (markdown.ok) {
        const headers = new Headers(markdown.headers);
        headers.set("content-type", "text/markdown; charset=utf-8");
        headers.set("link", LINK_HEADER);
        headers.set("vary", "Accept");
        // The Markdown twin is the agent-facing representation of the page, so
        // it is readable cross-origin for the same reason the metadata is.
        headers.set("access-control-allow-origin", "*");
        return new Response(markdown.body, { status: 200, headers });
      }
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    const contentType = headers.get("content-type") ?? "";

    if (contentType.includes("text/html")) {
      headers.set("link", LINK_HEADER);
      headers.set("vary", "Accept");
    }
    const override = CONTENT_TYPES[url.pathname];
    if (override) headers.set("content-type", override);
    if (publicMetadata) headers.set("access-control-allow-origin", "*");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
