# Changes API

A change is a reviewable, evaluation-gated proposal to move a project's default
branch. See the [OpenAPI specification](../openapi.yml) for exact schemas, and
[Reviews and Comments](reviews.md) for the discussion layer on top of a change.

## List Changes
`GET /api/projects/{name}/changes`

## Create Change
`POST /api/projects/{name}/changes`

Evaluation runs **synchronously** at creation, so a slow evaluator stretches the
request. A workspace containing git submodules is refused here with a `400`
carrying the explanatory message.

## Get Change
`GET /api/changes/{id}`

## Re-evaluate
`POST /api/changes/{id}/evaluate`

Users only. Merged, rejected, and promoted changes cannot be re-evaluated.

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
accepted from the request body: this endpoint acts with the instance-wide GitHub
token, so honouring a caller-supplied base would let any caller aim that shared
credential at a branch of its choosing.

Once a change has a linked PR, each evaluation posts the verdict to the PR as a
comment (edited in place on re-evaluation) and as a `stratum/evaluation` commit
status.
