### Added
- **Promoted pull requests can be opened as the person promoting, not with the
  instance's own credential.** GitHub records whoever's credential created a
  pull request as its author, so every promoted pull request was authored by
  the Stratum app's bot (or the `GITHUB_TOKEN` account under an operator
  binding):
  review tools skipped it or wanted a seat for the bot, and the person whose
  agent wrote the code could approve it themselves. A person can now connect
  their GitHub account under Settings, and the pull requests they promote are
  opened as them. Stratum creates the pull request with the instance's own
  credential, as it did before, when their authorization has lapsed, is being renewed by
  another of their promotions at that moment, cannot be read, or is refused by
  GitHub for that repository. Nobody else's
  promotion is ever opened as them. The promote response reports
  `pullRequestAuthor`, `openedAs` and, when the app opened it, why. Off unless
  the operator sets the new `GITHUB_USER_TOKEN_SECRET`, which encrypts the
  stored authorizations; see `docs/developer/deployment.md`.

### Changed
- A person's refusals from GitHub no longer count against a repository's
  circuit breaker. Only calls made with the deployment's own credential do.
