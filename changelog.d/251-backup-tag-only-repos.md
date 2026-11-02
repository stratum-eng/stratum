### Fixed
- **Backups no longer drop a repository whose only refs are tags.** A repository with
  no commits on its default branch (an unborn `HEAD`) but with tags was reported
  `empty` and skipped, so its tags and every object only they reached were missing
  from the backup. Such a repository is now snapshotted with its tags and their
  objects, and its repo manifest simply omits `tipSha`. Restoring it recreates the
  tags without inventing a default branch, and the restore plan accepts a manifest
  that has no `tipSha` but does carry tags. Existing backups, which always record a
  `tipSha`, restore exactly as before. Repositories with neither commits nor tags are
  still skipped as `empty`.
