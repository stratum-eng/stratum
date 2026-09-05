# AGENTS.md

Guidance for AI coding agents (and the humans reviewing them) working in this repository.
Stratum treats agents as first-class contributors — this file is the contract.

## What this project is

Stratum is a code-collaboration platform for the AI engineering era, built on Cloudflare
Workers (Hono), Durable Objects (SQLite), D1, KV, R2, Queues, and Cloudflare Artifacts for
serverless Git. The web UI is **server-rendered JSX**: every page must work with JavaScript
disabled. A few inline scripts exist purely as progressive enhancement — never add a
client-side framework or a build step.

**The one exception is product analytics**, which loads PostHog's SDK in the browser. It has
**two** bootstraps, and an audit that reads only the first has read half of it:
`src/analytics/web-snippet.ts` for the app, which redacts every URL, title and element it
sends, and an inline one in `website/astro.config.mjs` for the docs site, which does not — docs
URLs are public content, and which page someone read is the whole question there. It is bound by the rule it is an exception to: no framework, no
build step, nothing rendered or gated by it, and every page still works with it blocked or
absent. Two things earned the exception and are the terms of keeping it. The bundle is
**version-pinned and served from our own origin**, so third-party code cannot change size or
behaviour in a release nobody here chose — an unpinned CDN script on pages that render private
repositories under an authenticated session is the risk this rule exists to prevent, and
"it's only analytics" is not an answer to it. And it is **off unless `POSTHOG_PUBLIC_KEY` is
set**, separately from server-side telemetry, so a self-hoster never gets browser JavaScript
they did not ask for. Do not widen this into a precedent for shipping client-side JS
generally: the next thing that wants to be an exception needs its own argument, not this one.

## Repository layout

| Path | What it is |
|------|------------|
| `src/` | The Worker: routes, middleware, storage, queue consumers, evaluation engine, UI, and the remote MCP server (`src/mcp/`, served at `/mcp`) |
| `cli/` | `@stratum/cli` — standalone publishable package |
| `agent/` | `@stratum/agent` — reference agent, standalone publishable package |
| `tests/` | Vitest suites: unit (`tests/*.test.ts`), `tests/integration/`, `tests/smoke/` |
| `migrations/` | D1 SQL migrations |
| `docs/` | User, API, developer docs, ADRs (`docs/adr/`), and runbooks (`docs/runbooks/`) |
| `scripts/` | Benchmark and operational scripts |
| `website/` | Docs site (own build; deployed by `docs.yml` on every push to `main` that touches it — `deploy-docs.yml` is the manual redeploy). Its guide and reference pages are **generated** from `docs/` by `website/scripts/mirror-docs.mjs` — edit `docs/`, not `website/src/content/docs/`. Its header is **generated** from the app's, by `website/scripts/mirror-header.mjs` — edit `src/ui/nav-css.ts`, not `website/src/styles/header.css` |

## Commands

Run from the repo root unless noted. `cli/` and `agent/` have their own `package.json`.

```bash
npm install          # install deps
npm run dev          # local dev server at http://localhost:8787
npm test             # full unit suite (vitest run)
npm run test:coverage  # with coverage; thresholds enforced in vitest.config.ts
npm run test:integration  # tests/integration/
npm run typecheck    # tsc --noEmit
npm run lint         # biome check src tests
npm run lint:fix     # biome check --write src tests
npm run release:check   # validate CHANGELOG.md against package.json
npm run release:prepare # cut a release from the Unreleased section (maintainers)
```

`npm run test:smoke` hits a **live deployed instance** (set `STAGING_URL` + `TEST_AUTH_TOKEN`);
it is network-dependent and not part of the offline gate.

## Quality gates (must pass before a PR is mergeable)

CI (`pr-checks.yml`) runs **lint, typecheck, unit tests, and the `cli/`/`agent/`
package suites in parallel**, then integration tests, then a staging deploy + smoke test.
Mirror lint → typecheck → test locally before pushing.

1. **Typecheck and tests must pass.** Never comment out, skip, or `.skip` a test to get green.
2. **Run lint last.** Biome autofixes formatting — running it before you finish editing just
   creates churn. Fix all lint errors; zero warnings tolerated in CI.
3. **No `any`.** `noExplicitAny` is an error. Use `Result`/typed unions (`src/utils/result.ts`).
4. **Coverage is a ratchet.** Thresholds in `vitest.config.ts` are a floor — raise them as
   coverage improves, never lower them to make a build pass.

## Conventions

- **TypeScript strict**, double quotes, 2-space indent, trailing commas, semicolons (Biome enforces).
- **Errors are values.** Prefer the `Result` type over throwing across module boundaries; never
  silently swallow an error — log it (see `src/utils/logger.ts`).
- **Comments explain *why*, not *what*.** Add one only for a non-obvious constraint, invariant, or
  workaround. JSDoc on public APIs is welcome.
- **Server-rendered only.** Do not introduce client-side JS into the UI. The single
  exception, its terms, and why it is not a precedent are described under "What this project
  is" above.
- **Every user-visible change gets a `CHANGELOG.md` entry** under `## [Unreleased]`, in the same
  PR, under a Keep a Changelog group. That text ships verbatim as the release notes; the release
  tooling infers the version bump from which groups are present (`docs/developer/releasing.md`).
- **A change to user-facing config, API shape, or evaluator/policy behavior also updates the public
  docs** (`docs.usestratum.dev`) in the same PR — not just `CHANGELOG.md`. What a self-hoster or
  agent operator reads to configure `.stratum/policy.yaml` or use the API is what must not go
  stale. The published pages are **generated**, so edit the canonical copy under `docs/user-guide/`
  or `docs/api/`, then `cd website && npm run sync:guides` and commit the regenerated mirrors —
  a direct edit to `website/src/content/docs/` is overwritten by the next sync. The rest of `docs/`
  (`developer/`, `adr/`, `runbooks/`) stays internal. This no longer goes stale silently:
  `docs.yml` watches `docs/**` and fails CI on drift via `npm run check:guides`.
- Highlight.js / type gotchas and the full ship flow live in `docs/developer/`.

## Operational rules (do not violate)

- **Benchmarks and write-heavy load tests run against STAGING only.** A production token must
  never be used for throughput/load testing.
- **`REPO_DO_ENABLED` is a kill switch** — `true` on staging, `false` in production. Respect it
  when touching the Durable-Object hot-index / merge paths.
- Secrets live in `.dev.vars` (gitignored) and Wrangler secrets — never commit credentials.

## Commit & PR conventions

- End every commit message with a `Co-Authored-By` trailer naming the model that actually
  wrote the change, e.g.:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```
- Commit or push only when asked; if on `main`, branch first.
- Keep PRs focused; describe what changed and how it was verified (which gates ran).
- Every PR receives an automated AI review (PR-Agent via Cloudflare AI Gateway — see
  `docs/runbooks/ai-review.md`). Its findings are advisory, never a merge gate; collaborators
  can run `/review`, `/improve`, or `/ask <question>` in PR comments.

## Licensing

- Two licenses, split by directory: `cli/` and `agent/` are **Apache-2.0**, everything else is
  **AGPL-3.0-or-later**, and the published agent skills under
  `website/public/.well-known/agent-skills/` are deliberately **MIT**. `LICENSING.md` is
  authoritative; don't restate the terms elsewhere.
- The `license: "MIT"` strings in `src/templates/index.ts` are scaffolding for projects *users*
  create through Stratum. They are not Stratum's license — leave them alone.
- `STRATUM_SOURCE_URL` in `src/version.ts` is what the page footer offers under AGPL §13. It
  is a per-deployment constant, not a config knob; changing its meaning is a licensing change.
- A human contributor's PR needs the CLA checkbox (`CLA.md`) confirmed before it merges.

See `CONTRIBUTING.md` for the human-facing version of all of this.
