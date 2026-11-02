### Fixed
- **A manual conflict resolution can no longer be committed onto a base it was not
  evaluated against.** The resolution route evaluated the proposed content against one
  clone of the project, then `resolveConflict` took a second clone and committed onto
  whatever tip that one saw. If a push landed on the default branch in between, the
  resolution was committed cleanly on top of content the evaluator suite had never seen —
  no error, and the audit record named the evaluated revision as the commit's parent when
  it was not. The evaluated base is now pinned through to the commit, and a project that
  moved is refused with `409 STALE_PROJECT` ("re-resolve against the current revision")
  instead of being silently committed. That covers the narrow race as well as the common
  case: if the project moves between the check and the push, the remote refuses the
  commit, and that rejection now reports `STALE_PROJECT` too rather than a `502` that
  reads as an upstream outage. `accept-project` and `accept-workspace` re-stage content
  already committed on one side of the conflict and are unaffected.
