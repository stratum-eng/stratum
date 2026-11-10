### Fixed
- **A change in a workspace that was behind its project was evaluated on the
  wrong diff.** The gates compared the workspace with the project's latest
  commit, so everything the project had gained since the workspace forked
  showed up as the change undoing it. A one-file change in a workspace three
  commits behind was judged on a 174,000-character diff of 35 files, of which
  the `llm` gate read the first 48,000 characters. The diff is now taken from
  the commit the workspace forked from, so it holds only what the workspace
  changed. The `baseSha` sent to webhook evaluators and check runners names
  that commit. The diff on the change page is the same one.

### Changed
- **A workspace more than 64 commits behind its project can no longer be
  evaluated as it stands.** Evaluation fails with `FORK_POINT_NOT_FOUND` and
  says to bring the workspace up to date. A merge already needed the fork point
  within the project's last 50 commits.
