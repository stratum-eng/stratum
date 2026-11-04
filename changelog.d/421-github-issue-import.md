### Added
- **Import a project's GitHub issues into its issue tracker.** Project admins can
  run it from the **Import GitHub issues** card in project settings, or with
  `POST /api/projects/{namespace}/{slug}/issues/import/github`. It copies each
  issue's title, body, state, labels, timestamps and comments, links every
  imported issue and comment back to GitHub, and skips pull requests. Authors
  with a linked Stratum account are attributed to it; others are shown by their
  GitHub login. `#123` references are rewritten to the imported numbers. The
  import runs in the background, waits out GitHub rate limits, and is safe to
  re-run: it updates what it already imported instead of duplicating it, so it
  can catch a project up right before switching over. Public repositories only
  for now. It needs a GitHub credential that may act for the project's owner,
  the same as every other GitHub call: a linked GitHub App installation or an
  operator binding. Requires D1 migration `064_github_issue_import.sql`.
