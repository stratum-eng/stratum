### Added
- **Pinned projects in every backup run.** Set `BACKUP_PINNED_PROJECTS` to a
  comma-separated list of `@namespace/slug` projects, and each backup run
  snapshots them in addition to the rotating slice. They do not use up any
  `MAX_REPOS_PER_RUN` slots, and they are never snapshotted twice in one run.
  The run manifest lists them under `repos.pinned`. Malformed entries are
  skipped with a warning, and unknown entries are listed under
  `repos.pinnedMissing`. The backup runbook now also has a quarterly restore
  drill and a drill log.
