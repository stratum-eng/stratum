# Stratum docs site

The public documentation site for [Stratum](https://github.com/stratum-eng/stratum),
built with [Astro Starlight](https://starlight.astro.build/) and served at
[docs.usestratum.dev](https://docs.usestratum.dev).

## Development

```bash
cd website
npm install
npm run dev      # http://localhost:4321
```

## Build

```bash
npm run build    # static output in dist/
npm run preview  # serve the built site locally
```

Both `dev` and `build` first copy `docs/api/openapi.yml` into `public/openapi.yml`
(via the `sync:openapi` script) so the published spec always matches the
repository's source of truth. The copy is gitignored — edit the spec only at
`docs/api/openapi.yml`.

## Content

Pages live in `src/content/docs/` as Markdown/MDX with Starlight frontmatter
(`title`, `description`). The sidebar is configured in `astro.config.mjs`.

- `guides/` — user-facing guides (getting started, importing, troubleshooting, FAQ)
- `reference/` — API reference (authentication, endpoints, errors, OpenAPI)

Internal repo documentation (ADRs, runbooks, developer docs) intentionally stays
in `docs/` as plain Markdown and is not published here.

## Branding

The site uses the same mark and palette as the app (`src/ui/layout.tsx`,
`src/ui/styles.ts`): the `S` tile in `#7ca9f7` on `#0d0d0d`, and `#0a0a0a` /
`#0d0d0d` / `#1e1e1e` / `#f0f0f0` surfaces. Those are mapped onto Starlight's own
CSS custom properties in `src/styles/theme.css` — the app's stylesheet is
deliberately *not* imported, since it targets app chrome and would break on
Starlight upgrades.

Raster assets (`favicon-32.png`, `apple-touch-icon.png`, `og.png`) are generated
from the mark and committed, so the site build never depends on font
availability in CI. Regenerate after changing the mark:

```bash
npm run brand
```

## Agent-facing surfaces

The docs are built to be readable by agents as well as people:

| Path | Purpose |
|------|---------|
| `/llms.txt` | Index of documentation sets |
| `/llms-small.txt`, `/llms-full.txt` | Abridged and complete corpora |
| `/openapi.yml` | REST API contract |
| `/.well-known/api-catalog` | RFC 9727 linkset pointing at the spec and reference |
| `/.well-known/mcp/server-card.json` | Discovery card for the `@stratum/mcp` server |
| `/robots.txt` | Crawl rules and content signals |

`worker/index.js` adds the two things static assets cannot do alone: RFC 8288
`Link` headers advertising those entry points, and Markdown content negotiation
(`Accept: text/markdown` on any page returns its Markdown source). The Markdown
twins are emitted into `dist/` by `scripts/emit-markdown.mjs` during the build;
the landing page's twin is maintained by hand at `public/index.md` because its
source is `.mdx`.

## Deployment

The site is a static build (`dist/`) served by a Cloudflare Worker
(`stratum-docs`, configured in `wrangler.toml`) on the custom domain
`docs.usestratum.dev`. It deploys automatically on every push to `main` that
touches `website/` or the OpenAPI spec (`.github/workflows/docs.yml`; PRs get a
build-only check). For an out-of-band redeploy, use the `Deploy Docs` workflow
(`.github/workflows/deploy-docs.yml`, manual dispatch) or deploy by hand:

```bash
npm run deploy   # builds, then wrangler deploy
```
