# AGENTS.md

Guidance for AI coding agents (and the humans reviewing them) working in this repository.
Stratum treats agents as first-class contributors — this file is the contract.

## What this project is

Stratum is a code-collaboration platform for the AI engineering era, built on Cloudflare
Workers (Hono), Durable Objects (SQLite), D1, KV, R2, Queues, and Cloudflare Artifacts for
serverless Git. The web UI is server-rendered JSX with **no client-side JavaScript**.

## Repository layout

| Path | What it is |
|------|------------|
| `src/` | The Worker: routes, middleware, storage, queue consumers, evaluation engine, UI |
| `cli/` | `@stratum/cli` — standalone publishable package |
| `agent/` | `@stratum/agent` — reference agent, standalone publishable package |
| `tests/` | Vitest suites: unit (`tests/*.test.ts`), `tests/integration/`, `tests/smoke/` |
| `migrations/` | D1 SQL migrations |
| `docs/` | User, API, developer docs, and ADRs (`docs/adr/`) |
| `scripts/` | Benchmark and operational scripts |

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
```

`npm run test:smoke` hits a **live deployed instance** (set `STAGING_URL` + `TEST_AUTH_TOKEN`);
it is network-dependent and not part of the offline gate.

## Quality gates (must pass before a PR is mergeable)

CI runs, in order: **lint → typecheck → test:coverage**. Mirror that locally.

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
- **Server-rendered only.** Do not introduce client-side JS into the UI.
- Highlight.js / type gotchas and the full ship flow live in `docs/developer/`.

## Operational rules (do not violate)

- **Benchmarks and write-heavy load tests run against STAGING only.** A production token must
  never be used for throughput/load testing.
- **`REPO_DO_ENABLED` is a kill switch** — `true` on staging, `false` in production. Respect it
  when touching the Durable-Object hot-index / merge paths.
- Secrets live in `.dev.vars` (gitignored) and Wrangler secrets — never commit credentials.

## Commit & PR conventions

- End every commit message with a trailer:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```
- Commit or push only when asked; if on `main`, branch first.
- Keep PRs focused; describe what changed and how it was verified (which gates ran).

See `CONTRIBUTING.md` for the human-facing version of all of this.
