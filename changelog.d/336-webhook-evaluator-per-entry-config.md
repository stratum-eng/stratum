### Fixed
- **A policy with more than one `webhook` evaluator now contacts every receiver.** Each
  `webhook` entry built its own evaluator but re-derived its configuration at evaluation
  time by searching the policy for the first entry of that type, so a policy declaring
  two receivers sent both requests to the first URL, signed both with the first secret,
  and applied the first entry's `timeoutMs` to both — while the second receiver was
  never contacted and nothing logged a word about it. Each evaluator is now handed the
  entry it was built for.
- **A failing evaluator can no longer be masked by a passing duplicate of the same
  type.** `requiredEvaluators` read the single latest `eval_runs` row per evaluator type,
  so when one type ran more than once in the same evaluation — two webhook receivers, two
  `diff` evaluators — only one verdict reached the merge gate, and a change one receiver
  had rejected could merge. Every run of a type in the newest evaluation round is now
  folded with AND, matching the rule the manual-conflict-resolution path already applied.
  A later passing re-evaluation still clears an earlier failure.
- **An evaluation round is now identified rather than inferred from its timestamp.**
  `eval_runs` rows carry a `round_id` (migration 048) shared by every run of one
  evaluation pass. Round identity was previously "these rows share a `ran_at`", which
  two passes can do — a change's initial evaluation and a re-evaluation, or two
  concurrent `POST /changes/:id/evaluate` calls, since that route takes no lock — and
  reading them as one round could AND a superseded failure into a later passing round,
  leaving the change blocked until someone re-evaluated again. Rows written before the
  migration keep the old timestamp grouping.
