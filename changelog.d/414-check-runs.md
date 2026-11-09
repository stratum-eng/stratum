### Added
- **Check runs: asynchronous, per-job CI results reported back to a change (#414).**
  A new `checks` evaluator in `.stratum/policy.yaml` sends each evaluated
  revision to your CI runner and returns immediately; the runner reports each
  named check as `running`, then `passed`, `failed` or `errored`, through a
  signed callback (`POST /api/checks/:id`) — minutes later if it needs to.
  Check names are declared in the policy on the default branch, the callback is
  authenticated with a project secret named by `secretRef`, and a check that has
  not finished by its deadline (30 minutes by default, `deadlineMs` to change
  it) becomes `errored`. See the new *Check runs* guide for the runner contract.
- **`merge.requiredChecks`** lists the checks that must have passed before a
  change can merge. It reads the newest run of each check for the evaluated
  revision and fails closed: a check that is missing, queued, running, failed or
  errored blocks the merge, on both the single and the batch merge path. New
  commits start the checks again.
- Check runs appear on the change page with a **Re-run** button, in the API
  (`GET /api/changes/:id/checks`, `POST /api/changes/:id/checks/:checkId/rerun`),
  and over MCP as `stratum_list_checks` and `stratum_rerun_check`.

### Changed
- Self-hosters who use check runs on an instance with the evaluation queue bound
  must set `APP_URL` to the instance's public URL: it is the address a runner
  reports to. Nothing changes for an instance that does not declare a `checks`
  evaluator. The release adds migration `074_check_runs.sql` (one new table).
