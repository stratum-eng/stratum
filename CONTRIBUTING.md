# Contributing to Stratum

Thanks for your interest in contributing! Stratum is a code-collaboration platform for the AI
engineering era, where both humans and AI agents are first-class contributors. This guide covers
how to set up, make changes, and get them merged.

> Working with an AI coding agent? Point it at [`AGENTS.md`](AGENTS.md) — it's the agent-facing
> version of this document.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating, you agree
to uphold it. Report unacceptable behavior per the contact in that file.

## Getting started

**Prerequisites:** Node.js 20+ and a Cloudflare account (for full local dev against bindings).

```bash
git clone https://github.com/jlamoreaux/stratum.git
cd stratum
npm install
npm run dev        # local dev server at http://localhost:8787
```

For a deeper walkthrough see [`docs/developer/local-setup.md`](docs/developer/local-setup.md).
`cli/` and `agent/` are separate packages with their own `package.json` — `cd` into them and
`npm install` to work on them.

## Development workflow

1. **Branch** off `main` (`git checkout -b your-feature`). Don't commit directly to `main`.
2. **Make your change.** Keep it focused — one logical change per PR.
3. **Run the gates locally** (CI runs these in order):
   ```bash
   npm run typecheck
   npm test
   npm run lint        # run last — Biome autofixes formatting
   ```
4. **Add tests** for new behavior. Coverage thresholds are enforced (`vitest.config.ts`); a PR
   that drops coverage below the floor will fail CI.
5. **Open a PR** using the template. Describe what changed and how you verified it.

## Coding standards

- **TypeScript strict.** No `any` (`noExplicitAny` is a lint error) — use the `Result` type
  (`src/utils/result.ts`) and typed unions.
- **Errors are values, not surprises.** Don't swallow errors; log them (`src/utils/logger.ts`).
- **Style is enforced by Biome:** double quotes, 2-space indent, trailing commas, semicolons.
  Run `npm run lint:fix` rather than hand-formatting.
- **Comments explain *why*, not *what*.** Reserve them for non-obvious constraints, invariants,
  or workarounds. JSDoc on public APIs is welcome.
- **The web UI is server-rendered JSX with no client-side JavaScript.** Keep it that way.

## Testing

- **Unit:** `npm test` (`tests/*.test.ts`) — fast, hermetic, the default gate.
- **Integration:** `npm run test:integration` (`tests/integration/`).
- **Smoke:** `npm run test:smoke` hits a **live deployed instance** and needs `STAGING_URL` +
  `TEST_AUTH_TOKEN`. It is not part of the offline gate.

⚠️ **Benchmarks and write-heavy load tests run against staging only — never with a production
token.**

## Commit messages

- Describe the change clearly; reference issues where relevant.
- AI-assisted commits should include a co-author trailer, e.g.:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```

## Reporting bugs & requesting features

Use the [issue templates](.github/ISSUE_TEMPLATE/). For anything security-related, **do not open a
public issue** — follow [`SECURITY.md`](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
