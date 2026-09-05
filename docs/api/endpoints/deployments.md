# Deployments and Deploy Secrets API

Post-merge deployments and the encrypted per-project secret store that feeds
them. See the [Deployments user guide](../../user-guide/deployments.md) for the
concepts — the `deploys:` policy block, the three targets, limits, and what each
status means — and the [OpenAPI specification](../openapi.yml) for exact schemas.

Two authorization rules here are stricter than the usual project read/write
split:

- **Every secret route refuses agent identities**, even when the agent's owner
  is a project admin. Deploy credentials are the one thing an agent token is
  never trusted with.
- **`logTail` is served to project writers only.** It carries a redacted
  provider payload, and redaction is literal-substring matching.

No route on either router returns a secret value. There is no read path for a
stored secret anywhere in the API.

## An agent token gets `403` from a secret route and `401` from approve

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

## Deploy secrets

### List secret names
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

### Create or replace a secret
`PUT /api/projects/{namespace}/{slug}/secrets/{name}`

```json
{ "value": "…" }
```

`name` must match `^[A-Z][A-Z0-9_]{0,63}$`; `value` is capped at 4096 bytes.
Writing an existing name replaces it. Audited as `secret.written`.

Answers `500 DEPLOY_SECRET_KEY_MISSING` when the instance has no
`DEPLOY_SECRET_KEY` configured — secrets cannot be encrypted without it.

### Create or replace a secret (form-friendly)
`POST /api/projects/{namespace}/{slug}/secrets`

The browser's way in to the PUT above, which an HTML form cannot issue. Takes
`name` and `value` in the body and runs the same authorization gate. A
form-encoded caller is redirected back to the project settings page with a
fixed error code in the query string; a JSON caller gets JSON.

### Delete a secret
`DELETE /api/projects/{namespace}/{slug}/secrets/{name}`

`404` if the project has no such name. Audited as `secret.deleted`.

### Delete a secret (form-friendly)
`POST /api/projects/{namespace}/{slug}/secrets/{name}/delete`

Browsers cannot issue DELETE. Same gate; a form caller lands back on the
settings page, including when the name was already gone.

## Deployments

### List deployments
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

### Get a deployment
`GET /api/deployments/{id}`

The URL carries no project; the row's own project is what gets authorized. A
deployment in a project the caller cannot read answers `404`, not `403`, so an
id cannot be confirmed by probing.

### Approve a deployment
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

### Retry a deployment
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

## Events

Deployments emit `deployment.requested`, `deployment.succeeded` and
`deployment.failed` onto the project's event stream; all three are subscribable
from a project webhook.
