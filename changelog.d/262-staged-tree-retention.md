### Fixed
- **Staged-tree copies no longer pile up in R2.** The copy of each workspace
  commit that the fast merge path keeps now lives under its own `staged-sha/`
  prefix. A bucket lifecycle rule expires those copies (see
  `docs/runbooks/staged-tree-retention.md`), which covers rejected changes,
  intermediate commits and abandoned workspaces. Merges still delete their own
  copy right away.
