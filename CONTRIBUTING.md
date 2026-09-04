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

**Prerequisites:** Node.js 22.13+ (the test suite uses `node:sqlite`) and a Cloudflare account
(for full local dev against bindings).

```bash
git clone https://github.com/stratum-eng/stratum.git
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
- **The web UI is server-rendered JSX.** Pages must work with JavaScript disabled. A handful of
  inline scripts exist for progressive enhancement (file tree, clipboard, import progress); do not
  add a client-side framework, a build step, or behaviour that only works with JS on.

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

## Changelog & releases

Every user-visible change gets one new file under [`changelog.d/`](changelog.d/README.md), in the
same PR — not a direct edit to `CHANGELOG.md`'s `## [Unreleased]` section, which is how two PRs
end up editing the same lines. Use a [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
group (`Breaking`, `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`). That text
becomes the release notes verbatim, so write it for someone deciding whether to upgrade.

Releases are cut from the changelog with `npm run release:prepare` and published by the
**Release** workflow. Maintainers: see
[`docs/developer/releasing.md`](docs/developer/releasing.md).

## Documentation

User-facing and API docs live in [`docs/`](docs/). The public subset is also
published at [docs.usestratum.dev](https://docs.usestratum.dev/) from
[`website/`](website/) — but those pages are **generated**:
`website/scripts/mirror-docs.mjs` renders them from `docs/user-guide/` and
`docs/api/`. Edit the copy under `docs/`, then regenerate and commit the
mirrors in the same PR; a direct edit under `website/src/content/docs/` is
overwritten by the next sync.

```bash
cd website
npm run sync:guides    # regenerate the mirrors, then commit them
npm run check:guides   # exit 1 if they are stale — this is what CI runs
```

If your change alters behaviour a doc describes, update the doc in the same PR.
See [`docs/README.md`](docs/README.md) for the full layout and conventions.

## Reporting bugs & requesting features

Use the [issue templates](.github/ISSUE_TEMPLATE/). For anything security-related, **do not open a
public issue** — follow [`SECURITY.md`](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
