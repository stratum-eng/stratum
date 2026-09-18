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

- `guides/` — user-facing guides (getting started, importing, code review, issues,
  CI integration, deployments, CLI, MCP server, troubleshooting, FAQ)
- `reference/` — API reference (authentication, endpoints, errors, OpenAPI, agent discovery)

**Do not hand-edit the guide and reference pages.** They are generated from the
repository's `docs/` tree by `scripts/mirror-docs.mjs` (`npm run sync:guides`), and CI
runs `npm run check:guides` to catch drift. Edit `docs/user-guide/*` or `docs/api/*` at the
repository root, then regenerate. Only `index.mdx` and the pages `mirror-docs.mjs` lists as
site-owned are authored here.

Internal repo documentation (ADRs, runbooks, developer docs) intentionally stays
in `docs/` as plain Markdown and is not published here.

## Branding

The site uses the same mark and palette as the app (`src/ui/layout.tsx`,
`src/ui/styles.ts`): the `S` tile in `#7ca9f7` on `#0d0d0d`, and `#0a0a0a` /
`#0d0d0d` / `#1e1e1e` / `#f0f0f0` surfaces. Those are mapped onto Starlight's own
CSS custom properties in `src/styles/theme.css` — the rest of the app's
stylesheet is deliberately *not* imported, since it targets app chrome and would
break on Starlight upgrades.

### The header

The header is the exception: it is the app's, shared rather than reimplemented,
so `docs.usestratum.dev` and `app.usestratum.dev` cannot drift into two
different headers.

- `src/ui/nav-css.ts` in the repository root owns the rules. The app splices
  them into its stylesheet; `scripts/mirror-header.mjs` writes them, plus the
  design tokens they reference, into `src/styles/header.css`.
- `src/components/Header.astro` overrides Starlight's `Header` and renders the
  app's markup against them, adding only the controls a docs site needs —
  search, theme, social links — sized to sit on the app's chrome. It draws the
  wordmark itself, which is why no `logo` is configured in `astro.config.mjs`.
- `src/styles/header.css` is **generated — never edit it**. Run
  `npm run sync:header` after changing the header (`predev`/`prebuild` run it
  too), and commit the result. `npm run check:header` fails on a stale copy, in
  the docs workflow and in the repository's own test suite
  (`tests/shared-header.test.ts`).

The mirrored token values are the app's, and the app is dark-only; `theme.css`
repoints them at Starlight's light palette for the light theme.

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
| `/.well-known/mcp/server-card.json` | Discovery card for the remote MCP server at `app.usestratum.dev/mcp` |
| `/.well-known/ai-catalog.json` | ARD capability manifest — the entry point that names all the others |
| `/.well-known/agent-skills/index.json` | Agent Skills Discovery v0.2.0 index, with a `sha256` per skill |
| `/.well-known/agent-skills/<name>/SKILL.md` | The skill artifacts themselves |
| `/auth.md` | How an agent obtains a Stratum credential, in prose |
| `/webmcp.js` | WebMCP tools registered on page load |
| `/robots.txt` | Crawl rules, content signals, and an `Agentmap:` pointer |

`dns/agents.zone` holds the DNS-AID SVCB records that point agents at this origin
before any HTTP request. They are not applied by CI — see `dns/README.md` for how
to publish and verify them, and to sign the zone with DNSSEC.

**This site publishes no `/.well-known/openid-configuration`, no
`/.well-known/oauth-authorization-server`, and no
`/.well-known/oauth-protected-resource`** — and that is still correct even now
that Stratum *is* an OAuth authorization server.

The MCP endpoint at `app.usestratum.dev/mcp` is an OAuth 2.1 protected resource,
and the API origin serves both metadata documents for it (see
`src/routes/mcp-oauth.tsx`). RFC 9728 has a client derive the protected-resource
URL from that resource's own origin, and RFC 8414 has it follow the document
found there — so every agent that needs these lands on `app.usestratum.dev`
without ever asking this site. A copy served here would be found only by agents
that already knew where to look, and would go stale the moment the app origin
changed. It belongs on the API origin or nowhere.

`/auth.md` still carries the bearer-token registration flow, which is the path
for a headless agent with no browser to run a consent screen in.

`tests/agent-discovery-metadata.test.ts` asserts all three are absent **here**.
Update it only if this site itself starts serving them.

The skills index is generated, never hand-edited: `scripts/emit-agent-skills.mjs`
(wired into `predev`/`prebuild` as `sync:skills`) derives each entry from the
`SKILL.md` front matter and hashes the file. `tests/agent-discovery-metadata.test.ts`
fails if the committed index has drifted from the skills.

`worker/index.js` adds the things static assets cannot do alone: RFC 8288
`Link` headers advertising those entry points, `Access-Control-Allow-Origin: *`
on the metadata documents (the ARD spec requires it, and a browser agent on
another origin cannot read them otherwise), and Markdown content negotiation
(`Accept: text/markdown` returns a page's Markdown source). Negotiation applies
only to pages that have a Markdown twin — the Worker looks for the matching
`.md` asset and falls through to the normal response when there isn't one, so a
route without a twin is unaffected. The twins are emitted into `dist/` by
`scripts/emit-markdown.mjs` during the build; the landing page's is maintained
by hand at `public/index.md` because its source is `.mdx`.

## Deployment

The site is a static build (`dist/`) served by a Cloudflare Worker
(`stratum-docs`, configured in `wrangler.toml`) on the custom domain
`docs.usestratum.dev`. It deploys automatically on every push to `main` that
touches `website/`, `docs/`, or the app's header source (`.github/workflows/docs.yml`;
PRs get a build-only check, which also runs `npm run check:guides` and
`npm run check:header` to fail on a stale mirror). For an out-of-band redeploy, use the `Deploy Docs` workflow
(`.github/workflows/deploy-docs.yml`, manual dispatch) or deploy by hand:

```bash
npm run deploy   # builds, then wrangler deploy
```
