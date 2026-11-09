# Changes API

A change is a reviewable, evaluation-gated proposal to move a project's default
branch. See the [OpenAPI specification](../openapi.yml) for exact schemas, and
[Reviews and Comments](reviews.md) for the discussion layer on top of a change.

## List Changes
`GET /api/projects/{name}/changes`

## Create Change
`POST /api/projects/{name}/changes`

Evaluation runs **off the request** where the instance has an evaluation queue
(the hosted instance does): the response is `202` with the change in status
`evaluating` and no verdict. Poll `GET /api/changes/{id}` until the status leaves
`evaluating` — it becomes `accepted` or `needs_changes`, with the evaluation runs
recorded exactly as an inline evaluation records them. A change cannot be merged
while it is `evaluating`, even with `force`.

Each evaluator runs under its own deadline, so one that hangs fails closed in
place (score 0, a reason naming the deadline) without holding up the others. A
run that cannot finish at all — retries exhausted, or a consumer that never
reported back, which the five-minute sweep detects — leaves the change
`needs_changes` with `evalReason` starting `Evaluation did not complete`.
Re-evaluate to try again.

On an instance with no evaluation queue bound, or when enqueueing fails,
evaluation runs inline and the response is `201` with the verdict, as it always
was. A workspace containing git submodules is refused with the explanatory
message — inline as a `400`, queued as a `needs_changes` verdict.

## Get Change
`GET /api/changes/{id}`

## Re-evaluate
`POST /api/changes/{id}/evaluate`

Users only. Merged, rejected, and promoted changes cannot be re-evaluated.

With an evaluation queue this **re-enqueues** and answers `202`: the change
moves to `evaluating` under a new run, and any run still in flight is
superseded — its verdict is discarded when it finishes, so an older run can
never overwrite a newer revision's result. Re-evaluating a change that is stuck
in `evaluating` is allowed, and is the manual way to recover it. Without the
queue the evaluation runs inline and answers `200` with the verdict.

Re-evaluation runs under the **current** evaluator defaults, so a change that
passed under older limits may fail. Approvals are dismissed when the evaluated
base moves, not only when the tip does.

## Reject
`POST /api/changes/{id}/reject`

Users only. Merged changes cannot be rejected.

## Merge
`POST /api/changes/{id}/merge`

Runs the full merge gate. Common refusals (see [Error codes](../errors.md) for
the full list and the response shapes):

| Code | Meaning |
|---|---|
| `EVALUATION_PENDING` | The change is still `evaluating`; refused even with `force` |
| `EVALUATION_MISSING` | The evaluation failed closed and pinned no revision; refused even with `force` — re-evaluate first |
| `STALE_BASE` | The recorded base is behind project HEAD (`merge.requireFreshBase`) |
| `STALE_WORKSPACE` | The workspace advanced after evaluation |
| `WORKSPACE_UNVERIFIABLE` | Workspace state could not be verified against what was evaluated |
| `PROTECTION_BLOCKED` | Blocked by branch protection; the response lists `reasons`. A [required check](#check-runs) that is missing, `queued`, `running`, `failed` or `errored` for the evaluated revision appears here |
| `MERGE_CONFLICT` | Conflicts; the response carries a conflict id |

## Merge a Batch
`POST /api/projects/{name}/changes/merge-batch`

Resolves and policy-gates every change, then merges the eligible ones onto the
project head with a **single push** (see
[ADR 004](../../adr/004-high-frequency-agent-commits.md)). At most 80 changes per
request, and requires the RepoDO backend. `force` is deny-by-default and must be
allowed by project policy (`merge.allowForce: true`).

## Check runs

Per-job CI results a project's runner reports back to a change, asynchronously.
The policy block, the runner contract and the gate are described in
[Check runs](../../user-guide/checks.md); this is the HTTP surface.

A check run:

```json
{
  "id": "chk_51c0…",
  "changeId": "chg_8f2b…",
  "revision": "4a7d…",
  "baseSha": "9c1e…",
  "name": "test",
  "attempt": 1,
  "status": "running",
  "summary": "142 of 214 tests",
  "detailsUrl": "https://ci.example.com/runs/8841",
  "createdAt": "2026-11-09T12:00:00.000Z",
  "startedAt": "2026-11-09T12:00:04.000Z",
  "deadlineAt": "2026-11-09T12:30:00.000Z"
}
```

`status` is `queued`, `running`, `passed`, `failed` or `errored`. `revision` is
the evaluated head sha the run was dispatched for. `attempt` counts runs of the
same check on the same revision; `completedAt` is present once the status is
terminal.

### List a change's check runs
`GET /api/changes/{id}/checks`

Needs read access to the project. Returns the **newest run of each check on
the change's evaluated revision** — the set `merge.requiredChecks` is checked
against:

```json
{ "changeId": "chg_8f2b…", "revision": "4a7d…", "checks": [ … ] }
```

`revision` is `null`, and `checks` empty, for a change that has not been
evaluated yet. `?all=true` returns every run instead: all revisions and all
attempts, oldest first.

### Re-run a check
`POST /api/changes/{id}/checks/{checkId}/rerun`

Users only, with write access to the project. Creates a new run of the same
check **on the same revision** and dispatches it to the runner; the run named
in the URL stops counting. Answers `202` with `{ "check": { … } }` — the new
run, `queued`.

| Status | Code | Meaning |
|---|---|---|
| `404` | `NOT_FOUND` | No such check run on this change |
| `409` | `EVALUATION_PENDING` | The change is still `evaluating`; its checks are dispatched when that finishes |
| `409` | `STALE_REVISION` | The workspace has new commits, or the change is on another revision. Re-evaluate the change instead |
| `409` | `CHECK_SUPERSEDED` | A newer run of this check exists; re-run that one |
| `409` | `CHECK_NOT_DECLARED` | The policy on the default branch no longer declares this check |
| `409` | `POLICY_INVALID` | The project's policy file is invalid |
| `409` | `CONFLICT` | The change is merged, rejected or reverted |
| `502` | `CHECK_DISPATCH_FAILED` | The new run was created but the runner could not be reached. The body carries it as `check`, already `errored` |

### Report a check run (runner callback)
`POST /api/checks/{checkRunId}`

Called by the **runner**, not by an API client. It takes no bearer token and no
session: the request is authenticated by `X-Stratum-Signature: sha256=<hex>`,
the HMAC-SHA256 of the raw body under the project secret the policy's `checks`
entry names. A token bound to one project or organization is refused before
routing.

```json
{
  "checkRunId": "chk_51c0…",
  "headSha": "4a7d…",
  "status": "passed",
  "sequence": 3,
  "summary": "214 tests passed",
  "detailsUrl": "https://ci.example.com/runs/8841"
}
```

`checkRunId` must equal the id in the URL and `headSha` the run's revision.
`status` is `running`, `passed`, `failed` or `errored`. `sequence` is a
positive integer that increases with every report for the run. `summary`
(truncated to 4,000 characters) and `detailsUrl` (an `http(s)` URL without
credentials, at most 2,048 characters) are optional. The body may be at most
64 KB.

| Status | Code | Meaning |
|---|---|---|
| `200` | — | `{ "applied": true, "check": { … } }` — recorded |
| `200` | — | `{ "applied": false, "check": { … } }` — a redelivered or out-of-order report (`sequence` not above the last applied one); nothing changed |
| `400` | `INVALID_REPORT` | Signed, but not a valid report |
| `401` | `INVALID_SIGNATURE` | Missing or wrong signature, **or no such check run** — the same response either way, so the endpoint does not reveal which ids exist |
| `409` | `STALE_REVISION` | `headSha` is not the run's revision, or the change has moved to a newer revision |
| `409` | `CHECK_SUPERSEDED` | A newer run of this check replaced this one |
| `409` | `CHECK_TERMINAL` | The run already finished; terminal states are final |
| `409` | `CHECK_DEADLINE_EXCEEDED` | The deadline passed first; the run is `errored` |
| `413` | `PAYLOAD_TOO_LARGE` | Body over 64 KB |

Every `409` carries the run's current state as `check`. Unauthenticated
requests share the per-address anonymous rate limit.

## Promote to a GitHub PR
`POST /api/changes/{id}/github-pr`

Users only. The change must be `accepted` (or already promoted), and the project
must be connected to GitHub with a configured token. Creates a PR — **draft by
default** — from branch `stratum/{changeId}` and marks the change `promoted`.

```json
{ "title": "…", "body": "…", "draft": true }
```

The PR base is **always the project's own recorded default branch** and is not
accepted from the request body: this endpoint acts with an instance GitHub
credential, so honouring a caller-supplied base would let any caller aim it at
a branch of its choosing.

The credential is the GitHub App's installation token when the app is installed
on the repository **and** that installation is linked to the project's owner
(see [GitHub App installations](github-app.md)), or an operator binding names
the project's owner for the repository's GitHub owner. The instance-wide
`GITHUB_TOKEN` is used only for such a binding. A project with neither gets
`403`, and a project that is not the repository's canonical project gets
`409 GITHUB_REPO_NOT_CANONICAL`. When no App credential could be obtained and
`GITHUB_TOKEN` is unset, the answer is `400 GITHUB_NOT_CONFIGURED` rather than
a refusal. That covers an instance with no App configured, a configured App
that is not installed on the repository, and a configured App whose
installation lookup or token minting failed. The last case is logged as a
"GitHub App token unavailable" warning; check for it before assuming the
configuration is missing.

If a re-evaluation begins while the branch is being pushed, the response is
`409 EVALUATION_PENDING`: the PR exists and its link is recorded (`github` in
the body), but the change is not marked `promoted`. Promote again once the
evaluation finishes; that re-pushes to the same PR.

Once a change has a linked PR, each evaluation posts the verdict to the PR as a
comment (edited in place on re-evaluation) and as a `stratum/evaluation` commit
status.
