# ADR 009: Asynchronous Evaluation

## Status

Accepted. Implements issue #412 ("Run evaluation off the request path; add a
timeout to the llm evaluator").

## Context

Evaluation ran synchronously inside `POST /projects/:name/changes` and
`POST /changes/:id/evaluate`, so creating a change took as long as the slowest
evaluator. ADR 007 bounded the sandbox evaluator with a total budget; the `llm`
evaluator had only its provider's 30s transport timeout, which a policy could
not configure and which a provider that never settled did not reliably honour.
A request-bound evaluator also rules out the next thing evaluation should do:
run a real CI suite that takes minutes.

## Decision

### 1. A change waits on a run, not on the request

With the `EVALUATION_QUEUE` binding present, change creation writes the change
in a new status, **`evaluating`**, with an `eval_run_id`, and sends one
`{ type: "change.evaluate", changeId, runId }` message to `stratum-evaluations`.
The response is `202` with no verdict. `POST /changes/:id/evaluate` moves the
change back to `evaluating` under a fresh run id and sends a message the same
way.

The queue consumer (`src/queue/evaluation-queue.ts`) runs the same computation
an inline evaluation runs — `evaluateWorkspace` in `src/services/change-flow.ts`
is shared by both — and records the verdict into the same `eval_runs` rows and
`changes` columns.

### 2. Runs are keyed to the revision they were asked for

Every write a queued run makes is conditional on
`id = ? AND eval_run_id = ? AND status = 'evaluating'`, and the run's
`eval_runs` inserts, any approval dismissal, and the status update are one D1
batch guarded by that same predicate (`src/storage/change-evaluation.ts`).

A run is superseded the moment anything writes a new `eval_run_id` (a
re-evaluation, the sweep) or moves the change out of `evaluating` (a reject, a
merge by another path). A superseded run's batch matches no row, so it cannot
overwrite a newer revision's verdict, cannot add a round the merge gate would
read as the newest, and cannot reopen a closed change. Its metered costs are
still recorded — the evaluators ran.

A random run id rather than the workspace tip is the key because the tip is not
known until the consumer has cloned the workspace; the run records the tip it
actually evaluated (`evaluated_sha`), exactly as inline evaluation does, and the
merge gate's SEC-2 check against that pin is unchanged.

Ordinary status writes (a review approving the change, a promotion, a GitHub
review) are guarded to leave an `evaluating` row alone. Each of those read the
status before a re-evaluation moved it; landing afterwards would make the change
mergeable with no verdict *and* orphan the run. Reject, merge and revert are
final and still win.

### 3. Every evaluator has its own deadline; `llm` gets a configurable one

`runEvaluation` races each evaluator against a deadline: its own configured
timeout plus 10s of grace (webhook `timeoutMs`, sandbox `totalBudgetMs`, llm
`timeoutMs`), or 60s for evaluators with none. Expiry records a failing verdict
for that evaluator only; the rest still report.

The `llm` evaluator accepts `timeoutMs` (default 30s, clamped to 1s–120s) and
enforces it itself, failing closed with "no verdict within Nms". The provider
transport is given the same timeout, so the request is aborted rather than left
running. A timed-out call is charged at its reservation estimate: the request
left the Worker and may be billed.

### 4. Merging requires a verdict

`POST /changes/:id/merge` refuses an `evaluating` change with
`409 EVALUATION_PENDING` **even under force**. Force bypasses a failing verdict;
it cannot bypass a missing one — a fresh change has no `evaluated_sha` to pin,
so a forced merge would land a live tip no gate had seen. `checkMergeProtection`
also refuses it first thing, and the merge DOs (RepoDO, MergeQueue) already
refuse any status outside approved/accepted/promoted, so the `REPO_DO_ENABLED`
paths needed no change. Once a verdict exists, every rule applies exactly as
before.

### 5. Failure and recovery

- The consumer retries a transient failure (`max_retries = 2`) and, on its last
  delivery or on a permanent one (project/workspace gone, submodules), fails
  the run closed: `needs_changes`, score 0, `evalReason` "Evaluation did not
  complete: …". No `eval_runs` rows are written, so `requiredEvaluators` reports
  "has not run", which is true.
- The five-minute cron's `evaluation-sweep` finds runs dispatched more than 20
  minutes ago that are still `evaluating` — a consumer that crashed, a message
  that was lost — and re-dispatches them under a new run id, up to twice, then
  fails them closed.
- If the queue send itself fails, the run executes inline on the request rather
  than stranding the change until the sweep.

### 6. The queue is optional

With `EVALUATION_QUEUE` unbound (an older self-host config), creation and
re-evaluation evaluate inline and respond as they always did (`201`/`200` with
the verdict). The sweep fails any stuck run closed in that configuration rather
than running a minutes-long evaluation inside the cron's shared budget.

## Consequences

- **API shape.** Clients reading `eval` from the creation response must handle
  `202` with no verdict and poll `GET /changes/:id`. The CLI (`--wait`), the
  reference agent and the MCP tool descriptions were updated; the UI already
  meta-refreshes an open change and now does the same for `evaluating`.
- **Gated `git push` stays synchronous.** Its report-status line is how the
  pusher learns the verdict, and its submodule refusal tears down the fork it
  created. It is now bounded by the per-evaluator deadlines; moving it to the
  queue is tracked in `docs/REMAINING_WORK.md`.
- **New infrastructure.** `stratum-evaluations` (+ `-dlq`) per environment,
  suffixed on staging and per-PR on previews, provisioned by the same CI steps
  that read queue names from `wrangler.toml`.
- **Reviews during evaluation.** `approve` is refused with `409
  EVALUATION_PENDING`: until the run pins `evaluated_sha` nothing ties an
  approval to the revision the reviewer saw, so it could count for a tip the
  run evaluated later. `request_changes` and comments are recorded (they can
  only block) but do not move the status; the run's verdict sets it.

## Alternatives considered

- **`waitUntil` instead of a queue.** Work scheduled after the response is cut
  off 30 seconds later, which a sandbox evaluation exceeds by design.
- **Cloudflare Workflows.** Durable steps would suit a multi-phase CI run, but
  the evaluation is one step today and the queue pattern (consumer + D1 state +
  sweep) is already how deploys and imports work here.
- **Keying runs by workspace tip.** Not knowable at enqueue time without a
  clone on the request path, which is the cost this change removes.
