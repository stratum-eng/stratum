### Fixed
- **Staged-tree copies can now be expired in R2.** The copy of each workspace
  commit that the fast merge path keeps now lives under its own `staged-sha/`
  prefix, so a bucket lifecycle rule can expire it. That covers copies for
  rejected changes, intermediate commits and abandoned workspaces. Merges still
  delete their own copy right away. **Operators must add the rule to each bucket
  bound as `REPO_OBJECTS`.** Until they do, copies still accumulate. See
  `docs/runbooks/staged-tree-retention.md`.
