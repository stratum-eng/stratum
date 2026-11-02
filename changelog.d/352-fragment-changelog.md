### Added
- **`changelog.d/` fragment files replace direct `## [Unreleased]` edits.** Every PR
  that needs a changelog entry now adds one new file under `changelog.d/` instead of
  editing the shared `Unreleased` section — the single most frequent source of PR
  merge conflicts in this repo. `npm run release:prepare` folds every fragment into
  `Unreleased` (inferring the version bump from their groups, same as before) before
  cutting the release, then deletes the fragments it consumed. `npm run release:check`
  validates fragment structure too, and now also rejects an `Unreleased` entry written
  above the first `### Group` heading, which would otherwise be dropped from the cut
  release without a word. Existing `Unreleased` content and already-open PRs that still
  edit it directly keep working unchanged, so long as each entry sits under a group —
  fragments are an additional source folded in at release time, not a forced migration.
  See `changelog.d/README.md`.
