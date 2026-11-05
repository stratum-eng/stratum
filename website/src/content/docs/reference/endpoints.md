---
title: "API Endpoints"
description: "The Stratum REST API surface — projects, branches, workspaces, changes, reviews, issues, deployments, agents, users, organizations, and GitHub App installations."
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
- [GitHub App installations](#github-app-installations) — which Stratum owner's projects may
  act on GitHub through an app installation

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

### Mint a Workspace Remote Credential
`POST /api/workspaces/{namespace}/{slug}/workspaces/{name}/remote-credential`

Returns the workspace's git remote and a short-lived `stratum_git_` credential
for it. Backs the MCP tool `stratum_workspace_remote`; see
[Pushing from a local checkout](/guides/mcp/#pushing-from-a-local-checkout).

```bash
curl -X POST https://stratum.example.com/api/workspaces/@acme/billing/workspaces/fix-retries/remote-credential \
  -H "Authorization: Bearer $STRATUM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"expiresInMinutes": 30}'
# → 201 {"remote":"https://stratum.example.com/@acme/billing/workspaces/fix-retries.git",
#        "username":"stratum","token":"stratum_git_…","expiresAt":"…",
#        "credentialId":"tok_…","branches":["main","fix-retries"], …}
```

- **What it can do:** `git fetch` and `git push` on that one workspace, nothing
  else. It is refused on the project URL, on every other workspace, and on the
  whole API, `/mcp` included.
- **How long it lasts:** `expiresInMinutes`, 5 to 60, default 60. Never longer
  than the credential that minted it, and it stops working the moment that
  credential is revoked or expires (or, for the legacy key, is rotated or
  disabled; for an agent token, the agent is revoked).
- **Who may mint it:** a `read_write` API token, an `mcp:write` OAuth grant, an
  agent token, or the legacy key, held by someone who can push to the workspace
  (its creator or a project admin). A read-only credential gets `403
  TOKEN_SCOPE_INSUFFICIENT`; a browser session gets `403 TOKEN_REQUIRED`; every
  other refusal is a `404`.
- **Limits:** 20 live credentials per user (`409 TOKEN_LIMIT_REACHED`).
- **Audit:** each mint is recorded as `workspace_remote.credential_minted`, with
  the workspace, the expiry and the kind of credential that minted it. A refused
  use of an expired or revoked credential is recorded as `auth.failed` with
  method `workspace_git_token`. The secret itself is never logged or stored.

## Changes API

A change is a reviewable, evaluation-gated proposal to move a project's default
branch. See the [OpenAPI specification](/reference/openapi/) for exact schemas, and
[Reviews and Comments](#reviews-and-comments-api) for the discussion layer on top of a change.

### List Changes
`GET /api/projects/{name}/changes`

### Create Change
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

### Get Change
`GET /api/changes/{id}`

### Re-evaluate
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

### Reject
`POST /api/changes/{id}/reject`

Users only. Merged changes cannot be rejected.

### Merge
`POST /api/changes/{id}/merge`

Runs the full merge gate. Common refusals (see [Error codes](/reference/errors/) for
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
accepted from the request body: this endpoint acts with an instance GitHub
credential, so honouring a caller-supplied base would let any caller aim it at
a branch of its choosing.

The credential is the GitHub App's installation token when the app is installed
on the repository **and** that installation is linked to the project's owner
(see [GitHub App installations](#github-app-installations)), or an operator binding names
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
access to the project. Valid on changes in `open`, `evaluating`,
`needs_changes`, `accepted`, or `approved`.

While a change is `evaluating`, `approve` is refused with `409
EVALUATION_PENDING`. Until the evaluation pins the revision it judged, an
approval cannot be tied to the code the reviewer actually saw. `request_changes`
and `comment` are accepted but do not change the status; the evaluation's
verdict sets it — except that a `request_changes` made while it was pending
outranks a pass: the change lands on `needs_changes`, not `accepted`.

An approval is recorded only if the change is still exactly as it was loaded —
same status, evaluation run, evaluated revision and base. If it moved in
between, nothing is recorded and the response is `409 EVALUATION_PENDING` (an
evaluation started) or `409 REVIEW_STALE` (anything else); reload and review
again.

**Approvals are made by a signed-in human.** `approve` requires a browser
session (or the legacy user key). A scoped API token or an OAuth grant — what
MCP clients and the CLI hold, and what agents are handed — gets
`403 SESSION_REQUIRED` with an `approveUrl` (the change page) instead. Those
credentials can still send `request_changes` and `comment`, which can only
block a merge.

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

### Import Issues from GitHub
`POST /api/projects/{namespace}/{slug}/issues/import/github`

Project admin, user identity. Queues a background import of the project's GitHub
source repository's issues (pull requests skipped) and answers `202` with
`{ "run": … }`. Idempotent: re-running updates previously imported issues and
comments instead of duplicating them. Form posts redirect to the settings page.

| Status | Code | Meaning |
|---|---|---|
| `400` | `no-source` | The project has no GitHub source |
| `403` | `private` | The GitHub repository is private |
| `403` | `not-authorized` | No GitHub credential may act for the project's owner (no linked App installation and no operator binding) |
| `409` | `active` | An import is already queued or running |
| `409` | `incomplete` | The project's code import has not completed |
| `409` | `deleting` | The project is being deleted |
| `502` | `github` | GitHub could not be reached to check the repository |
| `503` | `not-configured` | No GitHub credential is available on the instance |
| `503` | `failed` | The run could not be created or queued; nothing was imported |

`GET` on the same path returns `{ "run": … }` for the latest run, or
`{ "run": null }`. Imported issues and comments carry `externalUrl` (the GitHub
original) and, when the author has no linked Stratum account, `externalAuthor`
(their GitHub login). See the
[user guide](/guides/issues/#importing-issues-from-github).

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

This route therefore requires a browser session or the legacy API key. A scoped
API token or an OAuth grant is refused with `403 SESSION_REQUIRED`: otherwise
revoking that credential would leave behind an agent token it minted. (A
read-only one never reaches that check; the scope check refuses it first with
`403 TOKEN_SCOPE_INSUFFICIENT`.)

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

Returns the authenticated user's profile, with `"actingAs": "user"`: `id`,
`email`, `username` (the caller's personal namespace is `@username`) and
`createdAt`.

```json
{ "id": "usr_…", "email": "alice@example.com", "username": "alice", "createdAt": "…", "actingAs": "user" }
```

An MCP OAuth grant [bound to an agent](/reference/authentication/#oauth-grants) gets
the agent and the owner it acts for instead. The owner's email is not included:

```json
{
  "actingAs": "agent",
  "agent": { "id": "agt_…", "name": "Claude Code on my-laptop" },
  "owner": { "id": "usr_…", "username": "alice" }
}
```

A bare agent token (`stratum_agent_…`) gets `401`.

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

Shows each token's name, scope, expiry, `lastUsedAt`, and non-secret prefix,
and — for a token bound to a project or organization — a `binding` object
(`kind`, the target's id, and a readable `label` such as `@alice/web`). An
account-wide token has no `binding`. The plaintext is never listed again.

#### Create Token
`POST /api/users/me/tokens`

```json
{ "name": "buildkite", "scope": "read", "expiresInDays": 90 }
```

`scope` is `read` (default) or `read_write`. `expiresInDays` is 1–365; omit for
a token that never expires. The plaintext is returned **exactly once**, by this
call, with `Cache-Control: no-store`. `409 TOKEN_LIMIT_REACHED` past 20 active
tokens.

To limit the token to one project or one organization's projects, add **one**
of:

```json
{ "name": "deploy-bot", "scope": "read_write", "project": "@alice/web" }
{ "name": "acme-ci", "scope": "read", "org": "acme" }
```

You must be able to read the project, or be a member of the organization;
otherwise `404`, exactly as for one that does not exist. Both at once is a
`400`. A bound token is refused (`403 TOKEN_BINDING_EXCLUDES_ROUTE`) on every
endpoint outside the project surfaces — see
[Project and organization binding](/reference/authentication/#project-and-organization-binding).

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

### Passkeys

Passkeys (WebAuthn) are the second factor of browser sign-in. See
[Passkeys and two-factor sign-in](/guides/passkeys/). Every endpoint
below accepts the **browser session cookie only** (`403 SESSION_REQUIRED` for a
token). Registering, removing, and regenerating recovery codes also need a
session from the last 15 minutes that used the account's existing passkey, if it
has one. Otherwise they return `403 REAUTHENTICATION_REQUIRED`.

- `GET /api/users/me/passkeys` — the passkeys (name, created, last used) and
  `recoveryCodesRemaining`
- `POST /api/users/me/passkeys/registration/options` — WebAuthn creation options
  for `navigator.credentials.create()`; the challenge is single-use and expires
  after 5 minutes
- `POST /api/users/me/passkeys/registration/verify` —
  `{ "name": "Laptop", "response": <RegistrationResponseJSON> }`; on the first
  passkey the `201` also carries ten one-time `recoveryCodes`, shown once
- `PATCH /api/users/me/passkeys/{id}` — `{ "name": "…" }`
- `DELETE /api/users/me/passkeys/{id}` — removing the last passkey also deletes
  the recovery codes
- `POST /api/users/me/passkeys/recovery-codes` — replace the recovery codes

### Delete Account
`DELETE /api/users/me`

GDPR-grade account erasure. Deletes the caller's account and **all** owned
projects, revokes all tokens/sessions (and the user's agents), and **anonymizes**
the user's contributions to *other* people's projects (author set to a
`deleted-user` tombstone — the contribution stays, the identity is removed).
Audit log entries are kept, with the account's id and email replaced by
`deleted-user` where they are the actor, the subject, or a complete string value
in the entry's detail. An id or email inside longer free text is not rewritten,
and neither are usernames.
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

### SSO Connection (org admins/owner)

- `PUT /api/orgs/:slug/sso` — create or replace the org's OIDC connection
- `GET /api/orgs/:slug/sso` — read the connection (secrets redacted)
- `DELETE /api/orgs/:slug/sso` — delete the connection
- `POST /api/orgs/:slug/sso/verify-domains` — verify email domains via DNS TXT
- `POST /api/orgs/:slug/sso/enable` — enable (requires verified domains)
- `POST /api/orgs/:slug/sso/disable` — disable
- `POST /api/orgs/:slug/sso/scim-token` — rotate the SCIM bearer token

See the [OpenAPI specification](/reference/openapi/) for full request/response
shapes, and [Authentication](/reference/authentication/) for the SCIM token class.

### Security policy

- `GET /api/orgs/:slug/security` — read the policy (any member)
- `PUT /api/orgs/:slug/security` — `{ "requireSecondFactor": true }` (admins/owner).
  Either field (`requireSecondFactor`, `ipAllowlist`) may be sent alone.

With `requireSecondFactor` on, a member's browser session reaches this org's
projects and `/api/orgs/:slug/` endpoints only if it passed a passkey check or
signed in through this org's own SSO. Otherwise those requests return
`403 SECOND_FACTOR_REQUIRED`. The policy never affects members' personal
projects, other orgs, or account settings. See
[Passkeys and two-factor sign-in](/guides/passkeys/). Turning it on
returns `409 ADMIN_SECOND_FACTOR_REQUIRED` until you have a passkey yourself.
API tokens are not checked against the policy when they are used. Instead the
policy applies when a credential is created: a session that has not met it
cannot mint an unbound API token, a token bound to this org or its projects,
an agent token, a rotated legacy key, or an OAuth grant (MCP/CLI consent).
Those requests return `403 SECOND_FACTOR_REQUIRED`. Tokens bound to other
targets are unaffected. See
[Creating credentials](/guides/passkeys/#creating-credentials).

#### IP allowlist

- `PUT /api/orgs/:slug/security` — `{ "ipAllowlist": ["203.0.113.0/24", "2001:db8::/32"] }`
  (admins/owner). `[]` removes the restriction.

When the list is non-empty, requests from outside it cannot use the access the
org grants. This covers its projects (including git clone and push), its
`/api/orgs/:slug/` endpoints, and creating projects in it. Every credential is
covered: sessions, API tokens, agent tokens, and OAuth grants. Those requests
return `403 IP_NOT_ALLOWED`, with `org` and the `ip` Stratum saw. A caller who is
not a member gets the usual `404` instead. Anonymous reads of public projects,
the SSO sign-in flow, SCIM, and leaving the org are not restricted. The client
address comes from `CF-Connecting-IP` only, and a request without it is refused.

Entries are IPv4 or IPv6 addresses or CIDR ranges, at most 100. They are returned
in canonical form. Saving a list that excludes your own current address returns
`409 IP_ALLOWLIST_SELF_LOCKOUT`; add `"allowSelfLockout": true` to save it
anyway. Changes are audited as `org.ip_allowlist_changed`. Refusals are audited
as `org.ip_access_denied`, at most once per member per org every 10 minutes. See
[Organization IP allowlists](/guides/org-ip-allowlist/).

### Members and teams

Any member can leave with `DELETE /api/orgs/:slug/members/<own user id>`, even
when the org's second-factor policy or IP allowlist blocks them. The owner cannot leave
(`409 OWNER_CANNOT_LEAVE`). Removing anyone else requires an org admin.

Members and teams are managed under `/api/orgs/{slug}/members` and
`/api/orgs/{slug}/teams` — add and remove a member, create, list and delete a
team, and add and remove a team's members. See the
[OpenAPI specification](/reference/openapi/) for the exact routes and schemas.

Every add, removal, and role change of a member, and every team created,
deleted, joined, or left, is recorded in the org's audit log below.

### Audit log (org admins/owner)

- `GET /api/orgs/:slug/audit` — one page of the org's audit trail, newest first
- `GET /api/orgs/:slug/audit/export` — the same entries as an NDJSON download

Plain members get `403`; non-members get the same `404` as a missing org.
A token bound to a project or organization is refused with `403
TOKEN_BINDING_EXCLUDES_ROUTE`, even one bound to this org: reading the audit
log is org administration, so use a session or an unbound token.

**What lands in an org's trail.** Events about the org itself (creation,
member added/removed, role changed, teams and team membership, SSO connection
and SCIM token administration, SCIM provisioning), failed SSO sign-ins against
the org's connection, and events on projects the org owns (forced merges,
dismissed approvals, manual conflict resolutions, webhooks, branches, deploy
secrets, deployment approvals and retries, deletion requests). Account-level
events — a user's own tokens, sessions, agents — belong to no org and appear
only in the instance-wide `GET /api/admin/audit`. Entries recorded before org
scoping shipped carry no org and are likewise instance-only.

**Filters.** `action`, `actor` (actor id), `since` (inclusive) and `until`
(exclusive, both ISO-8601). Malformed values are a `400`, never silently
ignored.

**Pagination.** `limit` (1–500, default 100). The response is
`{ "entries": [...], "nextCursor": "..." }`; pass `nextCursor` back as
`cursor` for the next, older page. It is absent on the last page. Cursors are
keyset-based, so pages stay stable while new events are appended.

```bash
curl -H "Authorization: Bearer $STRATUM_TOKEN" \
  "https://app.usestratum.dev/api/orgs/acme/audit?action=org.member.role_changed&limit=50"
```

**Export.** `GET /api/orgs/:slug/audit/export` (or `?format=ndjson` on the read
route) streams one JSON entry per line for the window `[since, until)`.
`until` defaults to now and `since` to 30 days earlier; a window longer than
90 days is refused with `400`, so export long periods in consecutive windows.
If storage fails partway through, the download is aborted rather than cut
short, so a file that completes is a complete window.

```bash
curl -H "Authorization: Bearer $STRATUM_TOKEN" -o acme-audit.ndjson \
  "https://app.usestratum.dev/api/orgs/acme/audit/export?since=2026-10-01T00:00:00Z&until=2026-11-01T00:00:00Z"
```

**Failed sign-ins.** An `auth.failed` entry is written only when the attempt
identifies something real — for an org, an SSO callback that reached its
connection with a valid sign-in state (bad or expired ID token, nonce
mismatch, email outside the verified domains, a disabled account). Repeats
for the same account or connection are collapsed to at most one entry per
minute.

**Who an entry is about.** An entry's `subject` is the thing acted on, never a
person: member and role events carry the org id (team membership events the
team id), and SCIM provisioning events carry the SSO connection id. The member
or provisioned user is named in `detail.userId`. Entries written before this
change carried the user id in `subject`.

**Immutability.** The audit log is append-only: there is no API to edit or
delete an entry, and the database rejects updates and deletes. The single
exception is account erasure, which replaces the erased person's id and email
with `deleted-user` — in the actor, the subject, and any complete value in
`detail` — and changes nothing else. The database accepts every such rewrite
only to the `deleted-user` sentinel, and the subject and detail rewrites only for
an account that is being deleted.

## GitHub App installations

When the instance runs a GitHub App, outbound GitHub calls for a project — PR
promotion, sync, and evaluation comments and statuses — use the app's
installation token for the repository **only if that installation is linked to
the project's owner, or an [operator binding](#operator-bindings) names that
owner** for the repository's GitHub owner. A project's source URL is whatever
its owner typed, so without one of the two anyone could import another
organization's repository and have Stratum push to it with that organization's
installation. An installation that is neither linked nor covered by a binding
grants nothing, and a caller the installation refuses is **not** handed the
instance-wide `GITHUB_TOKEN` instead: that credential is reserved for owners the
operator binds explicitly.

The same rule decides which project receives a repository's webhook events
(push, pull request, review), and every repository has **one canonical
project**. The first authorized project to act on a repository, or to receive
an event for it, claims it. Another project naming the same repository can
neither receive its events nor push or report to it, until the holder is
deleted or loses its authorization. A promotion from a non-canonical project
answers `409`.

Linking proves control on GitHub, not just in Stratum: only the GitHub user who
installed the app (or, for an installation on a personal GitHub account, that
account) can link it, matched against the GitHub account linked to your Stratum
account. Sign in with GitHub once to link one.

The app's **Setup URL** is `/github/app/setup`. GitHub sends you there after
installing, and the page lists your installations with a form to link each one.
It needs no JavaScript.

Users only. These endpoints are unreachable with a project- or org-bound token.
Acting on an organization (linking to it, unlinking from it, moving a link
away from it) takes an admin of that org whose session meets its
second-factor policy. Otherwise the request is refused with `403`
`SECOND_FACTOR_REQUIRED`, and the org is not offered as a link target.

### List installations
`GET /api/github/installations`

Installations you control on GitHub, plus those linked to you or to an org you
administer.

```json
{
  "githubLinked": true,
  "installations": [
    {
      "installationId": 777,
      "account": { "login": "acme", "type": "Organization" },
      "suspended": false,
      "linkedTo": null,
      "canLink": true,
      "canUnlink": false
    }
  ]
}
```

### Link an installation
`POST /api/github/installations/{installationId}/link`

```json
{ "org": "acme" }
```

Omit `org` (or send `""`) to link it to your personal account. An org must be
one you administer, or the request is a 400. An installation you can't prove
control of is a 404, the same as one that doesn't exist. Each installation
serves one Stratum owner. Moving an existing link is a 403 (`LINKED_ELSEWHERE`)
unless you are also the current owner or an admin of the current owner's org,
so having installed the app never lets you take a link away from the account
its admins chose.

The installer is recorded once, when GitHub reports the installation, and is
not re-checked against later org membership. If the person who installed the
app leaves the GitHub organization, an organization owner should link the
installation to the org (or suspend or uninstall the app on GitHub) so a stale
installer cannot link it elsewhere.

### Unlink an installation
`POST /api/github/installations/{installationId}/unlink`

Allowed for the linked user, or an admin of the linked org. The installation's
repositories then serve no project until it is linked again (or an operator
binding covers them).

### Operator bindings

`GITHUB_ALLOWED_OWNERS` binds a GitHub owner to the Stratum owner allowed to
act on its repositories without an installation link. It is a comma-separated
list of entries naming the Stratum owner **by id**:

```
GITHUB_ALLOWED_OWNERS = "acme=org:org_0123abcd,acme-labs=user:usr_4567ef01"
```

An entry admits only projects owned by that org or user, or by an agent whose
owner is that user. It covers the GitHub App on those repositories and is the
**only** way a project can use the instance `GITHUB_TOKEN`.

Ids are used rather than `@namespace` names because a namespace can be renamed
or deleted and then claimed by someone else, who must not inherit the binding.
Any other entry, including `githubOwner=@namespace`, is ignored, with a warning
in the logs. It does not admit every project. Members can read an org's id
from `GET /api/orgs/{slug}` (`org.id`), and their own from `GET /api/users/me`.
The former name, `GITHUB_APP_ALLOWED_OWNERS`, is still read, and the two lists
combine.
