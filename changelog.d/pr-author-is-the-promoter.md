### Added
- **Promoted pull requests can be opened as the person promoting, not as the
  Stratum app.** GitHub records whoever's credential created a pull request as
  its author, so every promoted pull request was authored by the app's bot:
  review tools skipped it or wanted a seat for the bot, and the person whose
  agent wrote the code could approve it themselves. A person can now connect
  their GitHub account under Settings, and the pull requests they promote are
  opened as them whenever GitHub accepts their authorization; when it has
  lapsed or GitHub refuses it for that repository, the app opens the pull
  request as before and the promotion still succeeds. Nobody else's
  promotion is ever opened as them. The promote response reports
  `pullRequestAuthor`, `openedAs` and, when the app opened it, why. Off unless
  the operator sets the new `GITHUB_USER_TOKEN_SECRET`, which encrypts the
  stored authorizations; see `docs/developer/deployment.md`.

### Changed
- A person's refusals from GitHub no longer count against a repository's
  circuit breaker. Only calls made with the deployment's own credential do.
