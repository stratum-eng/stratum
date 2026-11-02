### Fixed
- **A project's overview page no longer stalls for several seconds after every push.** The
  per-commit view cache added in #379 was only ever served for the branch's current tip, so
  the first view after any push or merge waited for a full clone (8s on a modest repository).
  The page now shows the last cached view straight away, with a note naming the commit it
  shows, and refreshes the cache in the background, so the next view is current. Only a
  branch that has never been viewed waits for a clone. A burst of viewers starts one refresh
  between them, not one each. The page's other independent lookups (import progress, sync
  status, write access, snapshot) now run in parallel, not one after another.
