### Changed
- **Stratum describes itself as the open-source, agent-first code forge everywhere.**
  The README, docs site, OpenAPI `info`, package manifests, CLI `--help`, agent-skill
  discovery files, and the signup page all carried different one-liners ("governance
  layer", "code collaboration platform for the AI engineering era", "code hosting for
  the AI engineering era", "agent operations platform"). They now share one: Stratum is
  the open-source, agent-first code forge, with the GitHub layer as the adoption path.
  The second run mode is called **forge mode** in every document (it was "alternative
  mode" in the guides and "standalone forge" in the README), and the deep-link anchor
  in the getting-started guide changed accordingly.

### Fixed
- **Two published files still said MIT after the AGPL relicense**: the source-repository
  link description in the docs site's `llms.txt`, and the `license` field of the MCP
  server card at `/.well-known/mcp/server-card.json`. Both now say `AGPL-3.0-or-later`.
- `docs/api/openapi.yml` reported `info.version: 1.0.0`; it now tracks the release
  version (`0.2.0`). `@stratum-eng/agent` was still at `0.1.0` and moves to `0.2.0`
  alongside `@stratum-eng/cli`.
- `agent/README.md` told readers to `npx @stratum-eng/agent`, which is not published;
  both client READMEs now say to build from source until it is.
- `AGENTS.md` claimed `pr-checks.yml` ends in a staging deploy and smoke test. It
  deliberately deploys nothing; the description now matches the workflow.
- The machine-readable documentation index at `docs.usestratum.dev/index.md` was
  missing the Deployments, Authentication, and Error codes pages.
