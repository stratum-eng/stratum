### Fixed
- **A project's overview page no longer takes 30–45 seconds to load.** When its cached
  snapshot had expired — which, after seven days, was every project — the page cloned the
  repository three times per view, once each for the file list, the commit log, and the
  README, spending ~24s of CPU on a modest repository and approaching the Workers CPU limit.
  It now reads all three from a single clone and caches the result against the exact commit
  it describes, so later views of an unchanged branch skip the clone entirely, and a push or
  merge can never be served a stale page.
