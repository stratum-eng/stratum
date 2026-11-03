### Breaking
- **Evaluation runs off the request path.** On an instance with the new evaluation
  queue (the hosted one has it), `POST /api/projects/{name}/changes` answers `202`
  with the change in a new `evaluating` status and no verdict, and
  `POST /api/changes/{id}/evaluate` re-enqueues and answers `202` the same way.
  Poll `GET /api/changes/{id}` until the status becomes `accepted` or
  `needs_changes`. API clients that read `eval` from the creation response must
  handle its absence. Without the queue, or if enqueueing fails, evaluation runs
  inline and the responses are unchanged (`201` / `200` with the verdict). The UI
  shows `evaluating` with a Refresh link (it reloads itself only for signed-out
  viewers, so a draft comment is never lost); the MCP tools and the CLI and
  reference agent understand it too (`stratum change create --wait`).
- **A change still `evaluating` cannot be merged**, even with `force` — the merge
  answers `409 EVALUATION_PENDING`. Nor can one whose evaluation ended without a
  verdict (`409 EVALUATION_MISSING`); re-evaluate it first. Once the verdict is
  recorded, merge protection behaves exactly as before.
- **Approvals wait for the verdict.** `approve` on an `evaluating` change answers
  `409 EVALUATION_PENDING`, and an approval is recorded only if the change is
  still as the reviewer loaded it — otherwise `409 REVIEW_STALE`. A
  `request_changes` made while evaluation is pending is kept: the change lands on
  `needs_changes` even if the evaluation passes.
- **Promoting during a re-evaluation** answers `409 EVALUATION_PENDING`; the
  GitHub PR is still opened and linked, and promoting again re-pushes to it.

### Added
- **`timeoutMs` for the `llm` evaluator** (default 30s, clamped to 1s–120s). A model
  that has not answered by then fails the gate closed with score 0.
- **Every evaluator runs under its own deadline**, so one that hangs fails closed on
  its own and the others still report. A run whose consumer never reports back is
  re-dispatched by the five-minute sweep, and failed closed (`needs_changes`,
  "Evaluation did not complete") after two re-dispatches.

### Fixed
- Change creation latency no longer depends on how long the evaluators take, and
  the `llm` evaluator can no longer hold a request open without bound.
