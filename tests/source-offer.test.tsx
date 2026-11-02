/// <reference types="vite/client" />
import { Hono } from "hono";
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { sourceOfferMiddleware } from "../src/middleware/source-offer";
import type { Env } from "../src/types";
import {
  LICENSE_NAME,
  SOURCE_FOOTER_HTML,
  SOURCE_FOOTER_HTML_INLINE,
  SourceFooter,
} from "../src/ui/components/source-footer";
import { Layout } from "../src/ui/layout";
import { CSS } from "../src/ui/styles";
import { STRATUM_SOURCE_URL, STRATUM_VERSION } from "../src/version";

/**
 * AGPL-3.0 §13 asks an operator running a modified Stratum to prominently
 * offer that version's source to everyone who reaches the instance over the
 * network. The offer lives in the shared page chrome, which means it is one
 * component away from being deleted by a layout refactor and nobody noticing
 * until it matters. This suite is the thing that notices.
 */
const PACKAGE_JSON = (
  import.meta.glob("../package.json", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>
)["../package.json"] as string;

const render = (): string =>
  renderToString(
    <Layout title="Test" user={{ id: "u1", email: "a@b.test", username: "someone" }}>
      <p>body</p>
    </Layout>,
  );

describe("AGPL §13 source offer", () => {
  it("offers the source on a signed-in page", () => {
    const html = render();
    expect(html).toContain(`href="${STRATUM_SOURCE_URL}"`);
    expect(html).toContain(">source<");
  });

  it("offers it to anonymous visitors too — §13 is not scoped to accounts", () => {
    const html = renderToString(
      <Layout title="Test">
        <p>body</p>
      </Layout>,
    );
    expect(html).toContain(`href="${STRATUM_SOURCE_URL}"`);
  });

  it("names the license and links its text", () => {
    const html = render();
    expect(html).toContain("AGPL-3.0");
    expect(html).toContain("https://www.gnu.org/licenses/agpl-3.0.html");
  });

  it("states which version the offer is for", () => {
    expect(render()).toContain(`stratum v${STRATUM_VERSION}`);
  });

  it("keeps the offer readable: muted text, not the decorative token", () => {
    // --text-faint is documented in styles.ts as decorative-only (it does not
    // meet the contrast floor). A legal notice rendered in it would be
    // "prominent" in markup and invisible in practice.
    const footer = CSS.slice(CSS.indexOf(".site-footer {"));
    const rule = footer.slice(0, footer.indexOf("}"));
    expect(rule).toContain("var(--text-muted)");
    expect(rule).not.toContain("var(--text-faint)");
  });

  it("points somewhere a visitor can actually fetch the source", () => {
    expect(STRATUM_SOURCE_URL).toMatch(/^https:\/\//);
    // A tag-pinned URL would 404 until the tag exists; the repository root is
    // always resolvable, and the version renders beside it.
    expect(STRATUM_SOURCE_URL).not.toContain("/tree/v");
  });

  /**
   * Every document Stratum serves has to carry the offer, so this sweeps all of
   * `src/` rather than a list of files someone has to remember to extend. The
   * first version of this test did hardcode five paths, and PR-Agent was right
   * that it could not catch what it existed to catch: two template-string
   * documents (the magic-link verify page and the webhook-created page) were
   * already missing the offer and the suite stayed green.
   *
   * A "document" is a file emitting `</body>` — JSX or template string alike.
   * The two exemptions are not pages Stratum serves: `src/email/templates.ts`
   * is email bodies, and `src/templates/index.ts` is scaffolding written into
   * projects *users* create. Both are listed explicitly so adding a third is a
   * decision someone makes on purpose.
   */
  const NOT_SERVED_PAGES = [
    "../src/email/templates.ts", // emails, not pages served over the network
    "../src/templates/index.ts", // scaffolding for user-created projects
    "../src/ui/components/source-footer.tsx", // defines the offer; its `</body>` is prose
    "../src/middleware/web-analytics.ts", // rewrites a rendered page; its `</body>` is a search marker
  ];

  it("appears on every document Stratum serves", () => {
    const sources = import.meta.glob(["../src/**/*.ts", "../src/**/*.tsx"], {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;

    const documents = Object.entries(sources).filter(
      ([path, contents]) => contents.includes("</body>") && !NOT_SERVED_PAGES.includes(path),
    );

    // If this drops to zero the sweep has stopped sweeping, not passed.
    expect(documents.length).toBeGreaterThanOrEqual(6);

    for (const [path, contents] of documents) {
      const bodies = contents.split("</body>").length - 1;
      const offers =
        contents.split("<SourceFooter />").length -
        1 +
        (contents.split("${SOURCE_FOOTER_HTML}").length - 1) +
        (contents.split("${SOURCE_FOOTER_HTML_INLINE}").length - 1);
      expect(offers, `${path} renders ${bodies} document(s) but ${offers} source offer(s)`).toBe(
        bodies,
      );
    }
  });

  it("carries the same four facts in every rendering", () => {
    const renderings = [
      renderToString(<SourceFooter />),
      SOURCE_FOOTER_HTML,
      SOURCE_FOOTER_HTML_INLINE,
    ];
    for (const html of renderings) {
      expect(html).toContain(`stratum v${STRATUM_VERSION}`);
      expect(html).toContain("AGPL-3.0");
      expect(html).toContain("https://www.gnu.org/licenses/agpl-3.0.html");
      expect(html).toContain(STRATUM_SOURCE_URL);
    }
  });

  /**
   * The version beside the license is a claim about which release is running,
   * and the licensing docs say releases through v0.2.0 are MIT. Those two can
   * only stay coherent if the footer's version tracks the manifest and the
   * footer's license name *is* the manifest's license. `src/version.ts` claimed
   * a test enforced the first half; none did until this one.
   */
  it("keeps the footer's version and license pinned to package.json", () => {
    const manifest = JSON.parse(PACKAGE_JSON) as { version: string; license: string };
    expect(STRATUM_VERSION).toBe(manifest.version);
    expect(LICENSE_NAME).toBe(manifest.license);
    // Belt and braces: the rendered notice, not just the constant.
    expect(renderToString(<SourceFooter />)).toContain(manifest.license);
  });

  /**
   * §13 reaches everyone interacting with the program over a network, not only
   * the people receiving markup. An agent driving Stratum entirely over `/mcp`
   * never sees the footer, so the offer also rides on response headers.
   */
  it("offers the source to callers who never receive HTML", async () => {
    const json = new Hono<{ Bindings: Env }>();
    json.use("*", sourceOfferMiddleware);
    json.get("/api/anything", (c) => c.json({ ok: true }));
    json.get("/mcp", (c) => c.json({ jsonrpc: "2.0" }));

    for (const path of ["/api/anything", "/mcp"]) {
      const res = await json.request(path);
      expect(res.headers.get("X-Source-Code"), path).toBe(STRATUM_SOURCE_URL);
      expect(res.headers.get("Link"), path).toContain('rel="license"');
    }
  });

  /**
   * A handler returning a raw `new Response(...)` replaces the context response
   * wholesale, and Hono does not merge `c.header()`'s buffered values into it.
   * `src/routes/mcp.ts` returns raw 202s and 204s on its main paths, so setting
   * the headers only before `next()` left the one interface this offer most
   * needed to reach without it.
   */
  it("reaches handlers that return a raw Response", async () => {
    const raw = new Hono<{ Bindings: Env }>();
    raw.use("*", sourceOfferMiddleware);
    raw.get("/mcp-post", () => new Response(null, { status: 202 }));
    raw.get("/mcp-delete", () => new Response(null, { status: 204 }));
    raw.get("/with-body", () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    for (const path of ["/mcp-post", "/mcp-delete", "/with-body"]) {
      const res = await raw.request(path);
      expect(res.headers.get("X-Source-Code"), path).toBe(STRATUM_SOURCE_URL);
      expect(res.headers.get("Link"), path).toContain('rel="license"');
    }
  });

  it("still offers the source on an error response", async () => {
    const boom = new Hono<{ Bindings: Env }>();
    boom.use("*", sourceOfferMiddleware);
    boom.get("/boom", () => {
      throw new Error("boom");
    });
    boom.onError((err, c) => c.json({ error: err.message }, 500));

    const res = await boom.request("/boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom" });
    expect(res.headers.get("X-Source-Code")).toBe(STRATUM_SOURCE_URL);
  });

  it("leaves git smart-HTTP responses alone", async () => {
    // git clients and proxies get exactly the bytes they expect, and a clone is
    // already receiving the source.
    const git = new Hono<{ Bindings: Env }>();
    git.use("*", sourceOfferMiddleware);
    git.get("/@me/repo/info/refs", (c) => c.text("001e# service=git-upload-pack"));

    const res = await git.request("/@me/repo/info/refs");
    expect(res.headers.get("X-Source-Code")).toBeNull();
  });

  it("keeps the raw-HTML rendering identical to the JSX one", () => {
    // Same markup, not merely the same facts: the two class-based renderings
    // sit next to each other in the same chrome, so a divergence would show.
    expect(renderToString(<SourceFooter />)).toBe(SOURCE_FOOTER_HTML);
  });
});
