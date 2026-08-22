/**
 * Docs site Worker.
 *
 * The site is still a static build; this Worker only adds the two things static
 * assets cannot do on their own:
 *
 *   1. RFC 8288 `Link` headers pointing agents at the machine-readable entry
 *      points (llms.txt, the OpenAPI spec, the API catalogue, the sitemap).
 *   2. Markdown content negotiation — a request for a page with
 *      `Accept: text/markdown` gets the Markdown source instead of HTML.
 *
 * Everything else falls straight through to the assets binding.
 */

const LINK_HEADER = [
  '</llms.txt>; rel="alternate"; type="text/plain"; title="Documentation index for language models"',
  '</llms-full.txt>; rel="alternate"; type="text/plain"; title="Complete documentation for language models"',
  '</openapi.yml>; rel="service-desc"; type="application/yaml"; title="Stratum REST API"',
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  '</sitemap-index.xml>; rel="sitemap"; type="application/xml"',
].join(", ");

/** Paths whose content type the assets binding cannot infer from the extension. */
const CONTENT_TYPES = {
  "/.well-known/api-catalog": "application/linkset+json",
};

const wantsMarkdown = (accept) =>
  accept.split(",").some((part) => part.trim().toLowerCase().startsWith("text/markdown"));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && wantsMarkdown(request.headers.get("accept") ?? "")) {
      const path = url.pathname.replace(/\/+$/, "");
      const markdownUrl = new URL(`${path === "" ? "/index" : path}.md`, url);
      const markdown = await env.ASSETS.fetch(new Request(markdownUrl, { method: "GET" }));
      if (markdown.ok) {
        const headers = new Headers(markdown.headers);
        headers.set("content-type", "text/markdown; charset=utf-8");
        headers.set("link", LINK_HEADER);
        headers.set("vary", "Accept");
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

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
