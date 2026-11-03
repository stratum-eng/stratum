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
| `PROTECTION_BLOCKED` | Blocked by branch protection; the response lists `reasons` |
| `MERGE_CONFLICT` | Conflicts; the response carries a conflict id |

## Merge a Batch
`POST /api/projects/{name}/changes/merge-batch`

Resolves and policy-gates every change, then merges the eligible ones onto the
project head with a **single push** (see
[ADR 004](../../adr/004-high-frequency-agent-commits.md)). At most 80 changes per
request, and requires the RepoDO backend. `force` is deny-by-default and must be
allowed by project policy (`merge.allowForce: true`).

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
`409`.

If a re-evaluation begins while the branch is being pushed, the response is
`409 EVALUATION_PENDING`: the PR exists and its link is recorded (`github` in
the body), but the change is not marked `promoted`. Promote again once the
evaluation finishes; that re-pushes to the same PR.

Once a change has a linked PR, each evaluation posts the verdict to the PR as a
comment (edited in place on re-evaluation) and as a `stratum/evaluation` commit
status.
