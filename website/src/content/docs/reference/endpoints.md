---
title: "API Endpoints"
description: "The Stratum REST API surface — projects, branches, workspaces, changes, reviews, issues, deployments, agents, users, and organizations."
editUrl: "https://github.com/stratum-eng/stratum/edit/main/docs/api/endpoints/README.md"
---

- [Projects](#projects-api) — projects, branches, browsing, import, sync
- [Workspaces](#workspaces-api)
- [Changes](#changes-api) — the change lifecycle, merging, GitHub promotion
- [Reviews and Comments](#reviews-and-comments-api) — comment threads and review verdicts
- [Issues](#issues-api) — the built-in issue tracker
- [Deployments and Deploy Secrets](#deployments-and-deploy-secrets-api) — post-merge deployments,
  the approval gate, and the per-project secret store
- [Agents](#agents-api)
- [Users](#users-api) — profile, account deletion, API tokens
- [Organizations](#organizations-api)

The complete, authoritative surface — request and response schemas included —
is the [OpenAPI specification](/reference/openapi/).

## Projects API

### List Projects
`GET /api/projects`

### Create Project
`POST /api/projects`

### Get Project
`GET /api/projects/{namespace}/{slug}`

### Import from GitHub
`POST /api/projects/{namespace}/{slug}/import`

See the [Importing from GitHub guide](/guides/importing/) for the
available options, how to track an import's progress, and keeping the project
in sync with its source.

### Delete Project
`DELETE /api/projects/{namespace}/{slug}`

Permanently deletes a project and **all** associated data (repo + workspace
forks, changes, issues, events, metrics, webhooks). **Owner-only.** The request
body must confirm the exact path:

```json
{ "confirm": "@namespace/slug" }
```

Returns `202 Accepted` with `{ "status": "deleting", "jobId": "del_…" }` — the
cascade runs asynchronously and is idempotent/resumable. A mismatched `confirm`
returns `400`; a non-owner returns `404`.

### List Branches

`GET /api/projects/{namespace}/{slug}/branches`

Returns `{ defaultBranch, branches: [{ name, oid }], truncated, totalBranchCount }`.
Read from the remote's ref advertisement, so the cost does not grow with the
branch count. Capped at 200 — `truncated` says so explicitly, and the default
branch is never the entry dropped.

### Create Branch

`POST /api/projects/{namespace}/{slug}/branches`

```json
{ "name": "release/2.x", "startPoint": "trunk" }
```

`startPoint` may be a branch name or a full 40-character commit sha, and
defaults to the default branch's tip. Short shas and **tag names** are refused:
a tag can point at a non-commit, its peeled commit is not advertised on the push
path, and a tag may sit outside both the default branch's history and the tag
set a backup captures — so a branch created from one could fail to push or
vanish on restore. The new ref can only point at an object the repository
already holds, so branch creation cannot introduce content that has not passed
the change gate.

**Writers only** (a non-writer gets `404`). `400` for an invalid name or an
unresolvable start point. Three distinct `409`s: `BRANCH_EXISTS` if the name is
taken, `BRANCH_NAME_CONFLICT` if it collides with an existing ref path (`release`
when `release/2.x` exists — git stores refs as paths, so one cannot be both a
file and a directory), and `NO_DEFAULT_BRANCH` if the configured default branch
is not advertised by the remote and there is therefore nothing to default to.

### Delete Branch

`DELETE /api/projects/{namespace}/{slug}/branches/{name}`

Hierarchical names are passed as real path segments
(`.../branches/release/2.x`); a percent-encoded slash (`release%2F2.x`) names
the same branch, since each path segment is decoded individually.
**Writers only.** The default branch cannot be deleted —
`409 DEFAULT_BRANCH_PROTECTED`.

### Browsing a branch

`GET .../files`, `.../content`, and `.../log` accept `?ref=<branch>`, defaulting
to the project's default branch. Branch names only: an unknown ref is a `404`
(never a silent fall back to the default), and a name that is both a branch and
a tag is a `409 AMBIGUOUS_REF` rather than a guess at which was meant. The
response echoes the `ref` actually read.

## Workspaces API

### List Workspaces
`GET /api/workspaces/{namespace}/{slug}/workspaces`

### Create Workspace
`POST /api/workspaces/{namespace}/{slug}/workspaces`

### Commit Changes
`POST /api/workspaces/{name}/commit`

## Changes API

A change is a reviewable, evaluation-gated proposal to move a project's default
branch. See the [OpenAPI specification](/reference/openapi/) for exact schemas, and
[Reviews and Comments](#reviews-and-comments-api) for the discussion layer on top of a change.

### List Changes
`GET /api/projects/{name}/changes`

### Create Change
`POST /api/projects/{name}/changes`

Evaluation runs **synchronously** at creation, so a slow evaluator stretches the
request. A workspace containing git submodules is refused here with a `400`
carrying the explanatory message.

### Get Change
`GET /api/changes/{id}`

### Re-evaluate
`POST /api/changes/{id}/evaluate`

Users only. Merged, rejected, and promoted changes cannot be re-evaluated.

Re-evaluation runs under the **current** evaluator defaults, so a change that
passed under older limits may fail. Approvals are dismissed when the evaluated
base moves, not only when the tip does.

### Reject
`POST /api/changes/{id}/reject`

Users only. Merged changes cannot be rejected.

### Merge
`POST /api/changes/{id}/merge`

Runs the full merge gate. Common refusals (see [Error codes](/reference/errors/) for
the full list and the response shapes):

| Code | Meaning |
|---|---|
| `STALE_BASE` | The recorded base is behind project HEAD (`merge.requireFreshBase`) |
| `STALE_WORKSPACE` | The workspace advanced after evaluation |
| `WORKSPACE_UNVERIFIABLE` | Workspace state could not be verified against what was evaluated |
| `PROTECTION_BLOCKED` | Blocked by branch protection; the response lists `reasons` |
| `MERGE_CONFLICT` | Conflicts; the response carries a conflict id |

### Merge a Batch
`POST /api/projects/{name}/changes/merge-batch`

Resolves and policy-gates every change, then merges the eligible ones onto the
project head with a **single push** (see
[ADR 004](https://github.com/stratum-eng/stratum/blob/main/docs/adr/004-high-frequency-agent-commits.md)). At most 80 changes per
request, and requires the RepoDO backend. `force` is deny-by-default and must be
allowed by project policy (`merge.allowForce: true`).

### Promote to a GitHub PR
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

## Reviews and Comments API

Comment threads and human review verdicts on a change. See the
[Code Review user guide](/guides/code-review/) for the concepts, and
the [OpenAPI specification](/reference/openapi/) for exact schemas.

### Add a Comment
`POST /api/changes/{id}/comments`

Read access to the project is enough — users **and agents** may comment.
`body` max 20,000 chars.

```json
{ "body": "…", "file": "src/x.ts", "line": 214, "side": "new", "commitSha": "a1b2…" }
```

- `file` and `line` must be passed **together** to anchor the comment to a diff
  line. `line` is 1-based.
- `side` (`old` | `new`) and `commitSha` are accepted **only** alongside a
  `file`+`line` anchor.
- `parentCommentId` posts a reply into an existing thread. The parent must
  belong to the same change, replies inherit the thread's anchor (so anchor
  fields must be omitted), and a reply to a reply is flattened onto the thread
  root.

### List Comments
`GET /api/changes/{id}/comments`

### Resolve a Thread
`POST /api/changes/{id}/comments/{commentId}/resolve`

### Unresolve a Thread
`POST /api/changes/{id}/comments/{commentId}/unresolve`

Allowed for **project writers or the comment's author**. Only a thread *root*
can be resolved — resolving a reply is refused. Resolution is bookkeeping and
does not gate a merge.

### Submit a Review
`POST /api/changes/{id}/reviews`

**Users only** — agent tokens are refused, on every surface. Requires **write**
access to the project. Valid on changes in `open`, `needs_changes`,
`accepted`, or `approved`.

```json
{ "verdict": "approve", "comment": "…" }
```

| `verdict` | Effect |
|---|---|
| `approve` | Change → `approved`; counts toward `requiredApprovals` |
| `request_changes` | Change → `needs_changes` |
| `comment` | Comment-only; status untouched |

A `comment` verdict **requires** a non-empty `comment` (else `400`). It never
counts toward required approvals, never blocks a merge, and never replaces an
existing `approve`/`request_changes` verdict by the same reviewer — a verdict
row is recorded only if that reviewer has none yet. Its text is written to the
change's discussion and emits `change.commented`.

The response carries `changeStatus`: the new status after an
`approve`/`request_changes`, or the unchanged status after a `comment`.

The **change author's own approval never counts** toward `requiredApprovals`;
for an agent-created change the excluded author is the agent's owning user.

### List Reviews
`GET /api/changes/{id}/reviews`

## Issues API

Issues are numbered per project and addressed by that number. See the
[Issues user guide](/guides/issues/) for the concepts, and the
[OpenAPI specification](/reference/openapi/) for exact schemas.

### Open an Issue
`POST /api/projects/{namespace}/{slug}/issues`

Read access is enough to open an issue. Also accepts form-encoded bodies,
which redirect on success instead of returning JSON.

```json
{ "title": "…", "body": "…", "linkedChangeId": "chg_123" }
```

`title` max 200 chars, `body` max 20,000. `linkedChangeId` must reference a
change in the same project. `409 TARGET_DELETING` if the project is being
deleted.

### List Issues
`GET /api/projects/{namespace}/{slug}/issues`

Anonymous on public projects. Query parameters, all combinable:

| Parameter | Meaning |
|---|---|
| `status` | `open` or `closed` |
| `label` | Issues carrying this exact label |
| `assignee` | Issues assigned to this user id |
| `q` | Case-insensitive substring over title + body, max 200 chars (`%` and `_` are literal) |
| `limit` | Default 100, max 500 |
| `offset` | Rows to skip |

Ordered newest-first by issue number.

### Get an Issue
`GET /api/projects/{namespace}/{slug}/issues/{number}`

### Update an Issue
`PATCH /api/projects/{namespace}/{slug}/issues/{number}`

Requires **write** access **and a user identity** — an agent token is refused
with `401`. This is the editing and labelling path, so an agent can open an
issue and comment on it but cannot retitle, reassign, relabel, or close one.
Only the fields present in the body are written.

```json
{ "title": "…", "body": "…", "status": "closed",
  "assignee": "usr_abc", "labels": ["bug"], "linkedChangeId": null }
```

`labels` replaces the entire set (max 20 per issue, 50 chars each).
`assignee` and `linkedChangeId` accept `null` to clear.

### Close an Issue
`POST /api/projects/{namespace}/{slug}/issues/{number}/close`

Requires **write** access and a user identity. No body. Despite the name it is
a **toggle**: it flips an open issue closed and a closed issue back open, and
answers with a `302` redirect (it backs the UI button). For an idempotent close
from a script, use `PATCH {"status": "closed"}` instead.

Issues linked to a change also close **automatically** when that change merges,
attributed to `system`.

### Add a Comment
`POST /api/projects/{namespace}/{slug}/issues/{number}/comments`

Read access is enough. `body` max 20,000 chars.

### List Comments
`GET /api/projects/{namespace}/{slug}/issues/{number}/comments`

Paginated with `limit` (default 100, max 500) and `offset`.

## Deployments and Deploy Secrets API

Post-merge deployments and the encrypted per-project secret store that feeds
them. See the [Deployments user guide](/guides/deployments/) for the
concepts — the `deploys:` policy block, the three targets, limits, and what each
status means — and the [OpenAPI specification](/reference/openapi/) for exact schemas.

Two authorization rules here are stricter than the usual project read/write
split:

- **Every secret route refuses agent identities**, even when the agent's owner
  is a project admin. Deploy credentials are the one thing an agent token is
  never trusted with.
- **`logTail` is served to project writers only.** It carries a redacted
  provider payload, and redaction is literal-substring matching.

No route on either router returns a secret value. There is no read path for a
stored secret anywhere in the API.

### An agent token gets `403` from a secret route and `401` from approve

Both routes refuse an agent identity, but with different status codes, and the
difference is deliberate rather than an inconsistency to be normalized away:

| Caller | Secret routes | `POST /api/deployments/{id}/approve` |
|---|---|---|
| Anonymous / no credential | `401` | `401` |
| Agent token (`stratum_agent_…`) | `403 Agent credentials cannot manage deploy secrets` | `401 Only authenticated users can approve a deployment` |
| User without the required access | `403` | `403 Project access denied` |

A secret route checks `agentId` **first**, so an agent is a recognized principal
being told what it may not do — "we know exactly who you are, and this is not
yours": `403`. Approve checks only for a `userId`, which an agent token never
sets, so an agent falls into the same branch as an unauthenticated caller —
"we do not know who you are *as a user*": `401`. Neither code is retryable with
the same credential; both mean "use a user identity".

### Deploy secrets

#### List secret names
`GET /api/projects/{namespace}/{slug}/secrets`

Requires **project admin** and a non-agent identity: `403` for an agent token
(and for a user who is not an admin), `401` for a caller with no user identity
at all. Returns names and metadata only:

```json
{ "secrets": [
  { "name": "CLOUDFLARE_API_TOKEN", "createdBy": "usr_abc", "updatedBy": "usr_abc",
    "createdAt": "2026-09-01T10:00:00.000Z", "updatedAt": "2026-09-01T10:00:00.000Z" }
] }
```

#### Create or replace a secret
`PUT /api/projects/{namespace}/{slug}/secrets/{name}`

```json
{ "value": "…" }
```

`name` must match `^[A-Z][A-Z0-9_]{0,63}$`; `value` is capped at 4096 bytes.
Writing an existing name replaces it. Audited as `secret.written`.

Answers `500 DEPLOY_SECRET_KEY_MISSING` when the instance has no
`DEPLOY_SECRET_KEY` configured — secrets cannot be encrypted without it.

#### Create or replace a secret (form-friendly)
`POST /api/projects/{namespace}/{slug}/secrets`

The browser's way in to the PUT above, which an HTML form cannot issue. Takes
`name` and `value` in the body and runs the same authorization gate. A
form-encoded caller is redirected back to the project settings page with a
fixed error code in the query string; a JSON caller gets JSON.

#### Delete a secret
`DELETE /api/projects/{namespace}/{slug}/secrets/{name}`

`404` if the project has no such name. Audited as `secret.deleted`.

#### Delete a secret (form-friendly)
`POST /api/projects/{namespace}/{slug}/secrets/{name}/delete`

Browsers cannot issue DELETE. Same gate; a form caller lands back on the
settings page, including when the name was already gone.

### Deployments

#### List deployments
`GET /api/projects/{namespace}/{slug}/deployments`

Readable by anyone who can read the project (anonymously, for a public
project). Newest first.

| Parameter | Meaning |
|---|---|
| `name` | Only deployments for this `deploys:` entry name |
| `status` | One of `pending_approval`, `queued`, `running`, `succeeded`, `failed`, `superseded`, `skipped` |
| `limit` | Default 50, max 200 |
| `offset` | Rows to skip |

`logTail` is present only when the caller can write to the project.

#### Get a deployment
`GET /api/deployments/{id}`

The URL carries no project; the row's own project is what gets authorized. A
deployment in a project the caller cannot read answers `404`, not `403`, so an
id cannot be confirmed by probing.

#### Approve a deployment
`POST /api/deployments/{id}/approve`

Releases a `pending_approval` deployment: the row moves to `queued` and is
enqueued. Requires project **write** access and a **user** identity — an agent
token is refused. This is the same guarantee (and the same limitation) as a
human review verdict: a user's scoped API token and MCP OAuth grants are
accepted, so it means "not an agent", not "a human at a keyboard".

- `401` — no `userId` on the request. This covers both an anonymous caller and
  an agent token, because an agent token sets `agentId` and never `userId`;
  unlike the secret routes, this check does not look at `agentId` at all. See
  [the note above](#an-agent-token-gets-403-from-a-secret-route-and-401-from-approve).
- `403` — a user identity that cannot write to the deployment's project.
- `409 DEPLOYMENT_NOT_PENDING` — the row already left `pending_approval`
  (a second approver lands here rather than deploying the commit twice).
- `503 DEPLOY_QUEUE_UNAVAILABLE` — the instance has no `DEPLOY_QUEUE` binding.
  Checked *before* the status flip, since approval is not repeatable.

**A failed enqueue is not an error.** If the queue send is rejected after the
row has moved to `queued`, the request is written to the event outbox and the
call still succeeds — the five-minute sweep starts it. This is deliberate: the
row is already `queued`, so `approve` would refuse a second attempt and
`retry` only accepts terminal rows, which made the old "try again" advice
impossible to act on. A `500` now means the outbox write failed too, i.e.
nothing durable was recorded.

Audited as `deployment.approved`. A form-encoded caller gets a `302` back to
the deployment page.

#### Retry a deployment
`POST /api/deployments/{id}/retry`

Creates a **new attempt row** for the same commit with `attempt` incremented,
and enqueues it. Requires project write access; unlike approve, an agent
identity is accepted. Answers `201` with the new row.

- `409 DEPLOYMENT_NOT_RETRYABLE` — the deployment is not in a terminal status.
  A `pending_approval` row in particular cannot be retried, because the retry
  row would start `queued` and route around the approval gate.
- `409 DEPLOYMENT_RETRY_EXISTS` — someone else already created this attempt.
- `503 DEPLOY_QUEUE_UNAVAILABLE` — as above.

A failed enqueue is recorded to the outbox and still answers `201`, for the
same reason as approve: the new attempt row already exists and is `queued`, so
a repeat call would only collide with the unique index on
`(project, name, commit, attempt)`.

The originating change id is carried onto the retry, so the "was this change
reverted?" check still applies to it. Audited as `deployment.retried`.

### Events

Deployments emit `deployment.requested`, `deployment.succeeded` and
`deployment.failed` onto the project's event stream; all three are subscribable
from a project webhook.

## Agents API

An agent is a non-human contributor registered by a user. It authenticates with
an agent token and inherits its owner's project access. See
[Authentication](/reference/authentication/) for how agent tokens differ from a user's
scoped API tokens.

### List Agents
`GET /api/agents`

### Create Agent
`POST /api/agents`

Returns the new agent alongside its token as `token` — the **only** time the
plaintext is ever returned. Neither `GET /api/agents` nor `GET /api/agents/{id}`
includes it, and there is no way to re-read it; a lost token means deleting the
agent and registering a new one.

Agent tokens **do not expire** and are not scoped. The only way to revoke one is
to delete the agent.

### Get Agent
`GET /api/agents/{id}`

### Delete Agent
`DELETE /api/agents/{id}`

Deletes the agent row, which is what revokes its token — **the only revocation
path for a credential that never expires.** Requires the owning user's identity:
`401` without a user identity (an agent token sets `agentId` and never `userId`,
so an agent cannot delete itself or any sibling), `403` for a user who is not
the owner, `404` for an unknown id. Audited as `agent.revoked`.

Deleting the owning user's account revokes their agents too, as part of the
account cascade ([Delete Account](#delete-account)).

## Users API

Token management is covered in full — scopes, expiry, limits, and the legacy
credential — in [Authentication](/reference/authentication/).

### Get Current User
`GET /api/users/me`

Returns the authenticated user's profile.

### Get Current Usage

`GET /api/users/me/usage`

The caller's metered usage against their plan for the current billing period:
each meter's consumption and limit, the rate ceilings, the period, and when it
resets. A limit of `-1` is unlimited and `0` is a plan that forbids that meter
outright, so a client renders words rather than computing a percentage against
either.

Read-only, and deliberately the **only** billing surface a token can reach:
there is no endpoint here to raise a limit, buy capacity, or attach a payment
method. An **agent token** reports its owner's allowance, because that is the
account its evaluations are charged to.

Figures cover platform-billed usage only. Spend on a project's own provider key
(BYOK) is reported separately and never counted against an allowance. On an
instance with no billing service configured — every self-hosted deployment —
`metered` is `false` and every limit is unlimited.

### API tokens

Listing, creating, revoking, and disabling the legacy token accept the
**browser session cookie only**. An API token calling those gets
`403 SESSION_REQUIRED`, whatever its scope — a token that could mint or revoke
tokens would make revocation meaningless. `rotate-token` is the exception and
has its own rule, described with it below.

#### List Tokens
`GET /api/users/me/tokens`

Shows each token's name, scope, expiry, `lastUsedAt`, and non-secret prefix.
The plaintext is never listed again.

#### Create Token
`POST /api/users/me/tokens`

```json
{ "name": "buildkite", "scope": "read", "expiresInDays": 90 }
```

`scope` is `read` (default) or `read_write`. `expiresInDays` is 1–365; omit for
a token that never expires. The plaintext is returned **exactly once**, by this
call, with `Cache-Control: no-store`. `409 TOKEN_LIMIT_REACHED` past 20 active
tokens.

#### Revoke Token
`DELETE /api/users/me/tokens/{id}`

Revoked rows are kept, so the audit trail survives revocation, and they do not
count toward the 20-token limit.

#### Disable the Legacy Token
`POST /api/users/me/legacy-token/disable`

Permanently disables the single unnamed credential every account carries on its
user row (minted at signup; revealed only by `rotate-token`). Named tokens are
unaffected. **Cannot be undone** — move anything still using it onto a named
token first.

#### Rotate the Legacy Token
`POST /api/users/me/rotate-token`

Accepts a browser session **or the legacy credential itself**, but refuses a
**scoped** token with `SESSION_REQUIRED`. The key it mints never expires and
cannot be revoked individually, so letting a scoped token rotate it would mean
revoking that token contained nothing — it could have issued itself a permanent
replacement on the way out.

### Delete Account
`DELETE /api/users/me`

GDPR-grade account erasure. Deletes the caller's account and **all** owned
projects, revokes all tokens/sessions (and the user's agents), and **anonymizes**
the user's contributions to *other* people's projects (author set to a
`deleted-user` tombstone — the contribution stays, the identity is removed).
Requires confirmation with the caller's own username:

```json
{ "confirm": "<your-username>" }
```

Setting deletion **immediately invalidates the caller's credentials** (subsequent
requests return `401`). Returns `202 Accepted` with
`{ "status": "deleting", "jobId": "del_…" }`; the cascade runs asynchronously and
always completes (org sole-ownership is auto-resolved, never blocking erasure). A
mismatched `confirm` returns `400`.

## Organizations API

### List Organizations
`GET /api/orgs`

### Create Organization
`POST /api/orgs`

### Members and teams

Members and teams are managed under `/api/orgs/{slug}/members` and
`/api/orgs/{slug}/teams` — add and remove a member, create, list and delete a
team, and add and remove a team's members. See the
[OpenAPI specification](/reference/openapi/) for the exact routes and schemas.
