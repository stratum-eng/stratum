/**
 * WebMCP tools for the Stratum documentation site.
 *
 * Exposes the site's real capabilities — search, page source, API contract — to
 * an agent driving the browser, so it can answer questions about Stratum without
 * scraping rendered HTML.
 *
 * Registration is declarative via `navigator.modelContext.provideContext()`,
 * with a fall-back to the imperative `registerTool()` shape for user agents that
 * only implement that half of the draft. Both are no-ops when the API is absent,
 * which is every browser today that has not enabled the origin trial.
 *
 * Spec: https://webmachinelearning.github.io/webmcp/
 */
(() => {
  const SITE = "https://docs.usestratum.dev";

  /**
   * Pages the site publishes, reported by `list_stratum_docs`.
   *
   * `tests/agent-discovery-metadata.test.ts` fails if this drifts from the pages
   * in `src/content/docs/`, because an agent that trusts the listing would
   * otherwise never learn a new page exists. `read_stratum_doc` does not consult
   * this list — it fetches the Markdown twin and reports the status it gets — so
   * a page missing here is unlisted, not unreachable.
   */
  const PAGES = [
    ["/", "Stratum documentation home"],
    ["/guides/getting-started/", "From zero to a merged, evaluation-gated change"],
    ["/guides/importing/", "Importing a repository from GitHub"],
    ["/guides/code-review/", "Comment threads, line anchors, and review verdicts"],
    ["/guides/issues/", "The built-in issue tracker"],
    ["/guides/ci-integration/", "Bring your own CI via the webhook evaluator"],
    ["/guides/deployments/", "Post-merge deploys to Cloudflare and Vercel"],
    ["/guides/cli/", "The Stratum CLI — the change flow from the terminal"],
    ["/guides/mcp/", "The MCP server — the eval-gated change flow for any MCP client"],
    ["/guides/troubleshooting/", "Troubleshooting"],
    ["/guides/faq/", "FAQ"],
    ["/reference/authentication/", "Bearer tokens, sessions, and the admin API key"],
    ["/reference/endpoints/", "REST API endpoint reference"],
    ["/reference/errors/", "Error codes"],
    ["/reference/openapi/", "OpenAPI specification"],
    ["/reference/agent-discovery/", "Every machine-readable entry point, and how an agent walks them"],
  ];

  const text = (value) => ({ content: [{ type: "text", text: value }] });

  /** Every tool returns text rather than throwing, so a failure is legible to the agent. */
  const guard = (fn) => async (args) => {
    try {
      return await fn(args ?? {});
    } catch (error) {
      return text(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /**
   * Resolves a caller-supplied docs path against this origin.
   *
   * Assigning `pathname` rather than resolving a relative URL keeps the origin
   * fixed: a path beginning with `//` would otherwise resolve to a different
   * host entirely, turning a docs tool into an open fetch proxy.
   */
  const onSite = (path, suffix = "") => {
    const url = new URL(location.origin);
    url.pathname = `${path.startsWith("/") ? "" : "/"}${path}`;
    return `${url.href.replace(/\/$/, "")}${suffix}`;
  };

  let pagefind;
  const loadPagefind = async () => {
    // Pagefind's index only exists in a production build, so this legitimately
    // fails under `astro dev`.
    pagefind ??= await import("/pagefind/pagefind.js");
    return pagefind;
  };

  const tools = [
    {
      name: "search_stratum_docs",
      description:
        "Full-text search across the Stratum documentation — merge gates, evaluation policy, agent identities, the REST API, and the MCP server. Returns the best-matching pages with excerpts.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search terms, e.g. 'requiredEvaluators' or 'agent token'." },
          limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
        },
        required: ["query"],
      },
      execute: guard(async ({ query, limit = 5 }) => {
        const pf = await loadPagefind();
        const search = await pf.search(String(query));
        const hits = await Promise.all(search.results.slice(0, limit).map((r) => r.data()));
        if (hits.length === 0) return text(`No documentation matched "${query}".`);
        return text(
          hits
            .map((h) => `## ${h.meta?.title ?? h.url}\n${SITE}${h.url}\n\n${h.excerpt.replace(/<[^>]+>/g, "")}`)
            .join("\n\n---\n\n"),
        );
      }),
    },
    {
      name: "read_stratum_doc",
      description:
        "Read the full Markdown source of a Stratum documentation page. Prefer this over scraping the rendered HTML — it is the same prose without the site chrome.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Site-relative path, e.g. '/guides/getting-started/'. Use list_stratum_docs for the full set.",
          },
        },
        required: ["path"],
      },
      execute: guard(async ({ path }) => {
        // The build emits a .md twin of every page; the Worker also honours
        // `Accept: text/markdown`, but asking for the twin directly avoids
        // depending on content negotiation surviving an intermediary cache.
        const slug = String(path).replace(/\/+$/, "") || "/index";
        const response = await fetch(onSite(slug, ".md"), { headers: { accept: "text/markdown" } });
        if (!response.ok) return text(`No page at ${path} (HTTP ${response.status}). Try list_stratum_docs.`);
        return text(await response.text());
      }),
    },
    {
      name: "list_stratum_docs",
      description: "List every page of the Stratum documentation with a one-line summary of each.",
      inputSchema: { type: "object", properties: {} },
      execute: guard(async () => text(PAGES.map(([path, summary]) => `- ${path} — ${summary}`).join("\n"))),
    },
    {
      name: "get_stratum_api_spec",
      description:
        "Fetch the Stratum REST API contract as an OpenAPI 3.1 YAML document — every endpoint, request and response schema, and per-endpoint security requirement.",
      inputSchema: { type: "object", properties: {} },
      execute: guard(async () => {
        const response = await fetch(onSite("/openapi.yml"));
        if (!response.ok) return text(`Could not fetch the OpenAPI specification (HTTP ${response.status}).`);
        return text(await response.text());
      }),
    },
    {
      name: "get_stratum_agent_auth",
      description:
        "Explain how an AI agent obtains and uses a Stratum API credential: the delegated registration flow, the bearer header, revocation, and the limits an agent credential carries.",
      inputSchema: { type: "object", properties: {} },
      execute: guard(async () => {
        const response = await fetch(onSite("/auth.md"), { headers: { accept: "text/markdown" } });
        if (!response.ok) return text(`Could not fetch /auth.md (HTTP ${response.status}).`);
        return text(await response.text());
      }),
    },
  ];

  const ctx = navigator.modelContext;
  if (!ctx) return;

  if (typeof ctx.provideContext === "function") {
    ctx.provideContext({ tools });
  } else if (typeof ctx.registerTool === "function") {
    for (const tool of tools) ctx.registerTool(tool);
  }
})();
