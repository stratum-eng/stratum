### Changed
- **The npm packages moved to the `@stratum-eng` scope.** `@stratum/cli` and
  `@stratum/agent` are now `@stratum-eng/cli` and `@stratum-eng/agent` — the
  `@stratum` scope on npm belongs to an unrelated owner. Install and `npx`
  invocations change accordingly (`npx @stratum-eng/agent ...`); nothing else
  about the packages, their binaries (`stratum`, `stratum-agent`), or their APIs
  changes. Neither package was ever published under the old names, so there is
  nothing to migrate off.
