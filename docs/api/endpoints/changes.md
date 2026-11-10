# Changes API

A change is a reviewable, evaluation-gated proposal to move a project's default
branch. See the [OpenAPI specification](../openapi.yml) for exact schemas, and
[Reviews and Comments](reviews.md) for the discussion layer on top of a change.

## List Changes
`GET /api/projects/{name}/changes`

`?status=` filters by status. `external` lists the pull requests from the
project's GitHub mirror that are waiting for a maintainer to
[import](#import-a-pull-request) them.

## Create Change
`POST /api/projects/{name}/changes`

```json
{
  "workspace": "fix-retries",
  "title": "Retry on 5xx only",
  "description": "A 4xx is the caller's mistake and retrying it trips the circuit breaker.\n\nFixes #214."
}
```

Only `workspace` is required. `title` is one line of up to 200 characters, and
`description` is up to 20,000 characters of markdown. Give both: the title heads
the change page and the changes list, and both carry over to the pull request
when the change is promoted to GitHub. A change opened without a title is headed
by the subject of its first commit.

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

For a change that came from a pull request on the project's GitHub mirror, the
response also carries `externalPullRequest`:

```json
{
  "repo": "acme/widgets",
  "number": 7,
  "url": "https://github.com/acme/widgets/pull/7",
  "author": "casey-c",
  "title": "Fix the widget",
  "headSha": "9f2c1e7a…",
  "importedHeadSha": null,
  "commits": 2,
  "changedFiles": 3,
  "state": "open",
  "refusal": null,
  "importedBy": null,
  "importedAt": null,
  "agreementConfirmedBy": null,
  "agreementConfirmedAt": null,
  "commitAuthors": [],
  "closure": { "state": "none", "error": null }
}
```

`title`, `author` and `commitAuthors` are text chosen by the pull request's
author. Display them as text.

## Import a pull request
`POST /api/changes/{id}/import`

Brings the commits of an `external` change's pull request into a workspace and
starts the change's evaluation. See
[Pull requests on the mirror](../../user-guide/mirror-pull-requests.md) for the
whole flow and its trust model.

A person with write access to the project only. An agent gets `401`.

```json
{ "agreementConfirmed": true, "headSha": "9f2c1e7a…" }
```

Both fields are optional. `agreementConfirmed` is required when the mirror sets
`requireContributorAgreement`. `headSha` is the head commit you looked at; send
it so that commits pushed since are not imported unseen.

Answers `202` with the change, its `externalPullRequest`, and
`evaluation.mode` (`queued`, or `inline` when the verdict is already in the
response).

| Status | `code` | Meaning |
|---|---|---|
| `409` | `NOT_EXTERNAL` | The change is not waiting to be imported |
| `409` | `PR_HEAD_MOVED` | The pull request has commits newer than `headSha` |
| `409` | `PR_NOT_OPEN` | The pull request is closed, or no longer targets the default branch |
| `409` | `EXTERNAL_IMPORT_UNAVAILABLE` | The mirror is disabled or no longer accepts pull requests |
| `422` | `CONTRIBUTOR_AGREEMENT_REQUIRED` | `agreementConfirmed` was not `true` |
| `502` | `GITHUB_ACCESS_DENIED` | GitHub refused the App's token for the mirror repository. Always `502`, whatever status GitHub gave |
| `422` | `PR_TOO_MANY_COMMITS`, `PR_TOO_MANY_FILES`, `PR_TOO_LARGE` | Over a [limit](../../user-guide/mirror-pull-requests.md#limits) |
| `422` | `SUBMODULES_UNSUPPORTED`, `LFS_UNSUPPORTED` | The pull request adds a submodule or a Git LFS pointer |
| `422` | `PR_CONFLICTS`, `PR_UNRELATED_HISTORY`, `PR_EMPTY` | It cannot be joined to the default branch, or adds nothing to it |

A `422` other than the first is also stored on the change, as
`externalPullRequest.refusal`, until the pull request gets new commits.

## Update Change
`PATCH /api/changes/{id}`

Sets or clears the `title` and `description`. Send either or both; `null` or an
empty string clears a field, and a field left out is not touched. Needs write
access to the project. Agent tokens are accepted: the text is the author's
account of the change and no gate reads it. Returns `{ "change": … }`.

## Re-evaluate
`POST /api/changes/{id}/evaluate`

Users only. Merged, rejected, and promoted changes cannot be re-evaluated. An
`external` change answers `409 EXTERNAL_NOT_IMPORTED`:
[importing](#import-a-pull-request) it is what starts its evaluation.

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
| `EXTERNAL_NOT_IMPORTED` | The change is `external`: a pull request nobody has imported; refused even with `force` |
| `PR_HEAD_MOVED` | The change came from a pull request that now has commits newer than the ones imported; refused even with `force` — import them first |
| `EVALUATION_MISSING` | The evaluation failed closed and pinned no revision; refused even with `force` — re-evaluate first |
| `STALE_BASE` | Under `merge.requireFreshBase`: the recorded base is behind project HEAD, or the change has no recorded base |
| `BASE_UNVERIFIABLE` (`503`) | Under `merge.requireFreshBase`: project HEAD could not be read, so freshness could not be verified. Nothing merged; retry |
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

The `200` response has three lists, and a client must read all of them:
`merged` holds the ids that merged, `conflicted` the ids that hit a merge
conflict, and `skipped` each change that was not attempted, with a `reason`.

When nothing is eligible the answer is `400`, and its body carries the
`skipped` list. One case is different: under
`merge.requireFreshBase`, if the project head could not be read and that
leaves nothing to merge, the answer is `503 BASE_UNVERIFIABLE` with the
`skipped` list. That is a fault to retry, not an ineligible batch.

A change that came from a pull request on the mirror is skipped, so that its
commits are kept. Merge it on its own.

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

A [first-party CI](../../user-guide/ci.md) step is re-run as a whole job: every
step in it gets a new run, and the response carries the one for the check named
in the URL.

### Read a CI step's log
`GET /api/changes/{id}/checks/{checkId}/log`

The output of one [first-party CI](../../user-guide/ci.md) step, as
`text/plain`. Needs read access to the project. This is the URL such a check's
`detailsUrl` holds. A running step's log grows between requests.

| Status | Code | Meaning |
|---|---|---|
| `404` | `NOT_FOUND` | No such change, or no such check run on it |
| `404` | `CHECK_HAS_NO_LOG` | The check was reported by a project's own runner; follow its `detailsUrl` instead |
| `404` | `CHECK_LOG_NOT_FOUND` | The executor has no log for this run: not started yet, or expired |
| `502` / `503` | `CI_EXECUTOR_UNAVAILABLE` | `502`: the executor could not be reached or refused the request. `503`: the instance has no executor, or it is misconfigured; the error message names the setting |

### Report a check run (runner callback)
`POST /api/checks/{checkRunId}`

Called by the **runner**, not by an API client. It takes no bearer token and no
session: the request is authenticated by `X-Stratum-Signature: sha256=<hex>`,
the HMAC-SHA256 of the raw body under the project secret the policy's `checks`
entry names — or, for a [first-party CI](../../user-guide/ci.md) step, under the
instance's executor secret, which only the instance's own executor holds. A token bound to one project or organization is refused before
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
