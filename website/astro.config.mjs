// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLlmsTxt from "starlight-llms-txt";

const SITE = "https://docs.usestratum.dev";
const DESCRIPTION =
  "The governance layer for AI-written code — evaluation-gated merges, provenance, and agent identities, built on Cloudflare Workers.";

export default defineConfig({
  site: SITE,
  integrations: [
    starlight({
      title: "Stratum",
      description: DESCRIPTION,
      logo: {
        src: "./src/assets/stratum-mark.svg",
        alt: "Stratum",
      },
      customCss: ["./src/styles/theme.css"],
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
        {
          label: "Guides",
          items: [
            { label: "Getting started", slug: "guides/getting-started" },
            { label: "Importing from GitHub", slug: "guides/importing" },
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
          ],
        },
      ],
    }),
  ],
});
