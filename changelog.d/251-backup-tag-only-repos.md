### Fixed
- **The backup format and restore now handle repositories whose only refs are
  tags.** A snapshot of a repository with an unborn `HEAD` but with tags now keeps
  its tags and every object only they reach, instead of being reported `empty`, and
  its repo manifest simply omits `tipSha`. Restoring it recreates the tags without
  inventing a default branch, and the restore plan accepts a manifest that has no
  `tipSha` but does carry tags. The scheduled backup still clones the default
  branch first, so a remote with no default branch still fails at the clone and is
  recorded as an error for that repository. Existing backups, which always record a
  `tipSha`, restore exactly as before. Repositories with neither commits nor tags are
  still skipped as `empty`.
