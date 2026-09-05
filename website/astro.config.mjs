// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import starlightLlmsTxt from "starlight-llms-txt";
import { readPostHogProjectKey } from "./analytics-key.mjs";

const SITE = "https://docs.usestratum.dev";

/**
 * Browser analytics for the docs site, off unless a project key is supplied at
 * build time. A fork, a PR preview, or anyone running `npm run build` without
 * the variable produces a site that sends nothing — the build must not depend
 * on it.
 *
 * Unlike the app, docs URLs are public content and are sent as-is: which page
 * someone read is the entire question. For the same reason `mask_all_text` and
 * `mask_all_element_attributes` are deliberately NOT set here, though they are
 * on the app: the link text and hrefs on this site are published documentation,
 * so masking them would cost the answer to "which doc did they click" and
 * protect nothing. There is no session here, so every visitor is anonymous and
 * `respect_dnt` is their only control — in posthog-js 1.427.2 it honours
 * `navigator.globalPrivacyControl` as well as the legacy DNT header. Session
 * replay is not loaded on either property.
 */
// Same name as the app's var, deliberately: two switches for one feature that
// differ only by word order would be a trap. Read at build time via
// `process.env` and inlined below, so Astro's `PUBLIC_` prefix convention —
// which exists to expose a variable through `import.meta.env` — does not apply.
const POSTHOG_KEY = readPostHogProjectKey(process.env.POSTHOG_PUBLIC_KEY);
const SDK_VERSION = "1.427.2";
/** @type {import("astro").AstroUserConfig["integrations"] extends any ? Array<{tag: "script", attrs?: Record<string, string | boolean | undefined>, content?: string}> : never} */
const analyticsHead = POSTHOG_KEY
  ? [
      {
        tag: /** @type {const} */ ("script"),
        attrs: { src: `/_ph/static/${SDK_VERSION}/array.js`, defer: true },
      },
      {
        tag: /** @type {const} */ ("script"),
        attrs: { defer: true },
        content: `(function () {
  // \`defer\` is ignored on an inline script, and these tags sit in <head>, so
  // calling init here would run before the deferred bundle defines \`posthog\`.
  // Deferred scripts run before DOMContentLoaded, so this orders us after it.
  function start() {
    if (typeof posthog === "undefined") return;
    posthog.init(${JSON.stringify(POSTHOG_KEY)}, {
  api_host: "/_ph",
  ui_host: "https://us.posthog.com",
  person_profiles: "identified_only",
  disable_session_recording: true,
  disable_external_dependency_loading: true,
  respect_dnt: true,
  capture_pageview: true,
  capture_pageleave: true,
  autocapture: true,
  loaded: function (ph) { ph.register({ environment: "docs" }); },
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();`,
      },
    ]
  : [];
const DESCRIPTION =
  "The governance layer for AI-written code — evaluation-gated merges, provenance, and agent identities, built on Cloudflare Workers.";

export default defineConfig({
  site: SITE,
  integrations: [
    // Emits sitemap-index.xml, which robots.txt and the Worker's RFC 8288 Link
    // header both advertise. Without a producer those two point at a 404.
    sitemap(),
    starlight({
      title: "Stratum",
      description: DESCRIPTION,
      // The header is the app's, not Starlight's — see src/components/Header.astro.
      // It renders the wordmark itself, so no `logo` is configured here.
      components: {
        Header: "./src/components/Header.astro",
      },
      // header.css is generated from the app's stylesheet by
      // scripts/mirror-header.mjs; theme.css maps the rest of the brand onto
      // Starlight's own custom properties and adapts the header to the light
      // theme, so it has to load second.
      customCss: ["./src/styles/header.css", "./src/styles/theme.css"],
      plugins: [
        starlightLlmsTxt({
          projectName: "Stratum",
          description: DESCRIPTION,
          details: [
            "Stratum is the control plane that decides what agent output is allowed to merge.",
            "Humans and AI agents are both first-class identities; agents can never approve a change.",
            "Merge gates are policy-as-code in .stratum/policy.yaml and a malformed policy fails closed.",
            "It runs either as a layer over GitHub or as a standalone forge on Cloudflare Workers.",
          ].join(" "),
          optionalLinks: [
            {
              label: "OpenAPI specification",
              url: `${SITE}/openapi.yml`,
              description: "Complete machine-readable REST API contract",
            },
            {
              label: "Source repository",
              url: "https://github.com/stratum-eng/stratum",
              description: "MIT-licensed, self-hostable on your own Cloudflare account",
            },
          ],
        }),
      ],
      head: [
        ...analyticsHead,
        // JetBrains Mono, matching the app's typography.
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: true },
        },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap",
          },
        },
        // Social cards. Starlight sets twitter:card=summary_large_image, which
        // needs a real image or the card renders empty.
        { tag: "meta", attrs: { property: "og:image", content: `${SITE}/og.png` } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        { tag: "meta", attrs: { property: "og:image:alt", content: "Stratum — documentation" } },
        { tag: "meta", attrs: { name: "twitter:image", content: `${SITE}/og.png` } },
        // WebMCP: exposes docs search, page source, and the API contract as
        // callable tools to an agent driving the browser. Deferred and
        // self-disabling when `navigator.modelContext` is absent, which is every
        // browser that has not enabled the origin trial.
        { tag: "script", attrs: { src: "/webmcp.js", defer: true } },
        // ARD manifest, advertised in-page as well as at the well-known path so
        // an agent that already has the HTML does not need a second discovery
        // round-trip.
        {
          tag: "link",
          attrs: {
            rel: "ai-catalog",
            type: "application/json",
            href: "/.well-known/ai-catalog.json",
          },
        },
        // Icons and browser chrome.
        { tag: "meta", attrs: { name: "theme-color", content: "#0a0a0a" } },
        { tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" } },
        {
          tag: "link",
          attrs: { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon-32.png" },
        },
      ],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/stratum-eng/stratum" },
      ],
      editLink: {
        baseUrl: "https://github.com/stratum-eng/stratum/edit/main/website/",
      },
      sidebar: [
        // The home page is a normal doc page, not a splash, so it needs a sidebar
        // entry of its own — the wordmark now leaves for the marketing site.
        { label: "Overview", link: "/" },
        {
          label: "Guides",
          items: [
            { label: "Getting started", slug: "guides/getting-started" },
            { label: "Importing from GitHub", slug: "guides/importing" },
            { label: "Code review", slug: "guides/code-review" },
            { label: "Issues", slug: "guides/issues" },
            { label: "CI integration", slug: "guides/ci-integration" },
            { label: "Deployments", slug: "guides/deployments" },
            { label: "CLI", slug: "guides/cli" },
            { label: "MCP server", slug: "guides/mcp" },
            { label: "Troubleshooting", slug: "guides/troubleshooting" },
            { label: "FAQ", slug: "guides/faq" },
          ],
        },
        {
          label: "API reference",
          items: [
            { label: "Authentication", slug: "reference/authentication" },
            { label: "Endpoints", slug: "reference/endpoints" },
            { label: "Error codes", slug: "reference/errors" },
            { label: "OpenAPI specification", slug: "reference/openapi" },
            { label: "Agent discovery", slug: "reference/agent-discovery" },
          ],
        },
      ],
    }),
  ],
});
