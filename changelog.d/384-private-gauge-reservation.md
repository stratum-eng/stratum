### Fixed
- **Concurrent creations can no longer go past the private-project limit.**
  Creating, importing or bulk-importing private projects at the same time could
  admit more than the plan allows, because each request counted existing
  projects before the others had written theirs. Bulk import made this much
  larger: several batches sent back to back were each checked against the same
  starting total. Each admitted creation now holds its place until its project
  is written or fails (held places lapse after 15 minutes), so a second request
  sees it. If the usage meter cannot be reached, the limit is checked against
  existing projects only, as before.
