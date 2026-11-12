### Fixed
- **An imported project stopped syncing from its source after its first queued
  sync.** The sync job recorded its result on the project and left the sync
  status saying "in progress". That status is what a pushed commit and a manual
  sync both check before standing aside, so every later push was skipped and
  every manual sync was refused with "A sync is already in progress", until the
  status was edited by hand. The job now records how it ended there too, and an
  "in progress" claim older than 30 minutes is ignored, so a project stuck this
  way recovers at its next push or sync, and a job that never reports back can
  no longer block the ones after it.
