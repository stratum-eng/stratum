# AGENTS.md

Guidance for AI coding agents (and the humans reviewing them) working in this repository.
Stratum treats agents as first-class contributors — this file is the contract.

## What this project is

Stratum is the open-source, agent-first code forge, built on Cloudflare
Workers (Hono), Durable Objects (SQLite), D1, KV, R2, Queues, and Cloudflare Artifacts for
serverless Git. The web UI is **server-rendered JSX**: every page must work with JavaScript
disabled. A few inline scripts exist purely as progressive enhancement — never add a
client-side framework or a build step.

**The one exception is product analytics**, which loads PostHog's SDK in the browser. It has
**two** bootstraps, and an audit that reads only the first has read half of it:
`src/analytics/web-snippet.ts` for the app, which redacts every URL, title and element it
sends, and an inline one in `website/astro.config.mjs` for the docs site, which does not — docs
URLs are public content, and which page someone read is the whole question there. It is bound by the rule it is an exception to: no framework, no
build step, no application content or behaviour rendered or gated by it, and every page still
works with it blocked or absent. (The script itself is of course rendered, and gated on
`POSTHOG_PUBLIC_KEY` — that is the exception. What must never depend on it is anything a user
came here to do.) Two things earned the exception and are the terms of keeping it. The bundle is
**version-pinned and served from our own origin**, so third-party code cannot change size or
behaviour in a release nobody here chose — an unpinned CDN script on pages that render private
repositories under an authenticated session is the risk this rule exists to prevent, and
"it's only analytics" is not an answer to it. And it is **off unless `POSTHOG_PUBLIC_KEY` is
set**, separately from server-side telemetry, so a self-hoster never gets browser JavaScript
they did not ask for. Do not widen this into a precedent for shipping client-side JS
generally: the next thing that wants to be an exception needs its own argument, not this one.

## How changes reach `main`: through Stratum

This repository is developed on Stratum itself, in layer mode (tracker #423). The project is
`@stratum/stratum` on `https://app.usestratum.dev`. GitHub (`stratum-eng/stratum`) is still where
`main` lives and where pull requests are reviewed and merged, but **Stratum opens those pull
requests. Do not open one yourself, and do not push a branch to GitHub** (`gh pr create`,
`git push origin`). Every change goes this way, with the Stratum MCP tools:

1. **Sync first.** `stratum_sync_project`, then `stratum_get_sync_status` until it has finished.
   Auto-sync is off, so the project's `main` is only as new as its last sync, and a workspace forked
   from a stale one is evaluated against the wrong base.
2. **Fork a workspace**: `stratum_create_workspace`. Work in a local git worktree as usual, then
   push it with the remote and short-lived token from `stratum_workspace_remote`
   (`git push <remote> HEAD:main`). That token is a secret: never write it to a file or a commit.
3. **Open a change**: `stratum_create_change`, with a `title` and a `description` (they become
   the pull request's). Poll `stratum_get_change` until its status leaves `evaluating`. On
   `needs_changes`, fix, push to the workspace again, and `stratum_evaluate_change`.
4. **Promote** an `accepted` change: `stratum_promote_change`. That pushes the branch
   `stratum/<change id>` to GitHub and opens the pull request, as a draft, with the change's
   title and description (see "Commit & PR conventions" for what they should say). The pull
   request is opened as the person promoting if they have connected GitHub under Settings, and
   as the Stratum app otherwise; review tools may skip one opened by the app.
5. **Review, CI and merge happen on that pull request**, as before.

The connection must act as a person for steps 1 and 4 (`stratum_whoami` reports
`actingAs: "user"`); an agent-bound connection is refused there.

What still needs GitHub directly, because Stratum does not do it yet. `gh` is fine for these and
only these:

- reading a pull request's CI results and review comments, and replying on review threads;
- marking a draft pull request ready, and merging it;
- **a follow-up commit to a pull request that is already open.** A promoted change cannot be
  re-evaluated (Stratum issue #2), so push the fix to the pull request's `stratum/<change id>`
  branch. A review that *requests changes* is the exception: it moves the change to
  `needs_changes`, and then the fix goes workspace → `stratum_evaluate_change` → promote again,
  which updates the same pull request;
- the release pull request, which Release Autopilot opens;
- a pull request that was opened on GitHub before this rule: finish it where it is.

If Stratum itself is what is broken (a change will not evaluate, the project will not sync), say
so to the person you are working for before going around it, and fix Stratum in the same piece of
work where you can. Anything else that made you leave Stratum is a finding: add it to
`docs/developer/dogfooding-friction-log.md`.

## Repository layout

| Path | What it is |
|------|------------|
| `src/` | The Worker: routes, middleware, storage, queue consumers, evaluation engine, UI, and the remote MCP server (`src/mcp/`, served at `/mcp`) |
| `cli/` | `@stratum-eng/cli` — standalone publishable package |
| `agent/` | `@stratum-eng/agent` — reference agent, standalone publishable package |
| `ci-executor/` | The first-party CI executor — a **separate Worker** with its own `package.json`, Wrangler config, tests and container image (`docs/adr/012-ci-executor-runtime.md`). Not published; AGPL like the server. It runs unreviewed code, so it must never gain a binding to D1, KV, Artifacts or the main Worker |
| `tests/` | Vitest suites: unit (`tests/*.test.ts`), `tests/integration/`, `tests/smoke/` |
| `migrations/` | D1 SQL migrations |
| `docs/` | User, API, developer docs, ADRs (`docs/adr/`), and runbooks (`docs/runbooks/`) |
| `scripts/` | Benchmark and operational scripts |
| `website/` | Docs site (own build; deployed by `docs.yml` on every push to `main` that touches it — `deploy-docs.yml` is the manual redeploy). Its guide and reference pages are **generated** from `docs/` by `website/scripts/mirror-docs.mjs` — edit `docs/`, not `website/src/content/docs/`. Its header is **generated** from the app's, by `website/scripts/mirror-header.mjs` — edit `src/ui/nav-css.ts`, not `website/src/styles/header.css` |

## Commands

Run from the repo root unless noted. `cli/`, `agent/` and `ci-executor/` have their own `package.json`.

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
npm run release:pr      # cut a release by hand, only when asked; Autopilot normally does this daily
```

`npm run test:smoke` hits a **live deployed instance** (set `STAGING_URL` + `TEST_AUTH_TOKEN`);
it is network-dependent and not part of the offline gate.

## Quality gates (must pass before a PR is mergeable)

CI (`pr-checks.yml`) runs **lint, typecheck, unit tests, and the `cli/`/`agent/`/`ci-executor/`
package suites in parallel**, then integration tests. It deliberately deploys nothing —
staging and production deploy only from `ci.yml` on `main`; PRs get an isolated per-PR
preview Worker from `pr-preview.yml` instead.
Mirror lint → typecheck → test locally before pushing to a workspace: passing Stratum's evaluation gates
does not mean this suite passes.

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
- **Every user-visible change gets a changelog entry**, in the same PR: add one new file under
  `changelog.d/` (see `changelog.d/README.md`) rather than editing `CHANGELOG.md`'s `Unreleased`
  section directly — two PRs editing `Unreleased` at once is the single most common source of PR
  conflicts in this repo, and two PRs adding two different files can't collide. Use a Keep a
  Changelog group heading; that text ships verbatim as release notes, and `release:prepare` infers
  the version bump from which groups are present across all fragments (`docs/developer/releasing.md`).
- **The "Docs & Changelog" PR check enforces this rule and the docs rule below.** A change under
  `src/`, `cli/src/`, `agent/src/` or `migrations/` needs a `changelog.d/` fragment, and a change to
  API routes, MCP, the evaluator or the CLI also needs `docs/user-guide/` or `docs/api/` updated.
  When one genuinely isn't needed, put `No docs needed: <why>` or `No changelog: <why>` on its own
  line in the PR description. The reason is the audit trail, so make it specific.
  `scripts/pr-docs.ts` holds the exact rules.
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

## Releasing

Releases cut themselves: Release Autopilot runs daily and needs only the changelog fragment
in your PR (`docs/developer/releasing.md`). Don't run `release:pr` unless asked. Two things
do need attention:

- An open `release-blocked` issue means releases have stopped. Fix the cause it links to; don't
  merge a release PR by hand to get past a failed gate.
- A PR labelled `release-hold` announces breaking or removed behaviour and waits for a person.
  Don't merge it unless a person has told you to.

A release is finished when `gh release view vX.Y.Z` succeeds, not when a workflow run is green.

## Commit & PR conventions

- End every commit message with a `Co-Authored-By` trailer naming the model that actually
  wrote the change, e.g.:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```
- Commit or push only when asked; if on `main`, branch first. "Push" means to a Stratum
  workspace: see "How changes reach `main`" above.
- Keep PRs focused; describe what changed and how it was verified (which gates ran). The
  description is the change's `description` in Stratum.
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
