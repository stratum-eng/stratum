# Error Codes

Errors are returned as JSON: `{ "error": "<human-readable message>" }`, with a
machine-readable `code` field present on some errors. The per-endpoint status
codes are in the [OpenAPI specification](openapi.yml).

## HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | OK |
| 201 | Created |
| 202 | Accepted — the work runs asynchronously (e.g. project/account deletion) |
| 302 / 303 | Redirect — form-encoded requests to form-friendly endpoints redirect instead of returning JSON |
| 400 | Bad Request |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not Found |
| 409 | Conflict — merge staleness and merge conflicts (see codes below) |
| 410 | Gone — the resource was deleted |
| 413 | Payload Too Large — a request body exceeded its cap (`PAYLOAD_TOO_LARGE`; the git and `/mcp` paths have their own caps) |
| 422 | Unprocessable — the request was understood but cannot be applied |
| 429 | Rate Limited |
| 500 | Server Error |
| 501 | Not Implemented — an optional integration is not configured on this instance (e.g. GitHub/Google OAuth) |
| 502 | Bad Gateway — an upstream provider call failed |
| 503 | Service Unavailable — a dependency is unhealthy, or an optional binding is absent (see `DEPLOY_QUEUE_UNAVAILABLE`) |
| 504 | Gateway Timeout — an operation exceeded its bound (see `PUSH_TIMEOUT`) |

## Machine-readable error codes

- Caller authentication failures carry **no machine-readable code**: a `401`
  is `{"error": "Invalid token"}` (or similar) with no `code` field. Branch on
  the status, not a code. (`AUTH_ERROR` exists internally but surfaces only
  when the *instance's* outbound GitHub credential fails during a sync push —
  it never describes your own authentication.)
- `404`s likewise usually carry no code — `{"error": "..."}` only — and an
  unauthorized private project is deliberately indistinguishable from a
  missing one. There is no `PROJECT_NOT_FOUND` code; where a code does
  appear on a 404 it is the generic `NOT_FOUND`.
- Rate limiting carries **no machine-readable code**: a `429` has
  `{"error": "Too many requests"}` plus `Retry-After`, `X-RateLimit-Limit`,
  and `X-RateLimit-Remaining` headers
- `TOKEN_SCOPE_INSUFFICIENT` — a `read` token was used for a write. Returned
  `403`, checked before routing on the HTTP method, on API routes. The git
  smart-HTTP router enforces the same rule on the resolved operation (so
  `git push` and its `git-receive-pack` advertisement are refused too) but
  answers with its deliberate plain-text `404` — never this code — so an
  unauthorized caller cannot distinguish "no permission" from "no such repo"
- `TOKEN_LIMIT_REACHED` — `409`; the account already holds 20 active tokens.
  Revoked tokens do not count toward the limit
- `SESSION_REQUIRED` — `403`; the endpoint accepts the browser session cookie
  only. Applies to token management (`/api/users/me/tokens`,
  `legacy-token/disable`) and to `rotate-token` when called with a scoped token
- `SESSION_EXPIRED` — `401`; the browser session is no longer valid
- `ADMIN_REQUIRES_DIRECT_CREDENTIAL` — `403`; an MCP/CLI OAuth grant was used on
  `/api/admin/*`. Refused before routing, even when the account behind the grant
  is the instance administrator
- `CSRF` — `403`; a `POST`/`PUT`/`PATCH`/`DELETE` arrived with an `Origin` or
  `Referer` that is missing, malformed, or names a different host. Enforced for
  session-cookie callers and for the few unauthenticated endpoints that must not
  be forgeable (magic-link verify); bearer-token callers are unaffected
- `SYNC_DIVERGED` — the upstream and the Stratum copy have genuinely diverged in
  content. The fetch window is deepened incrementally first, so this is a real
  conflict rather than a too-shallow clone
- `PINNED_SHA_UNREACHABLE` — the pinned commit is not reachable in the clone
- `PUSH_TIMEOUT` — `504` during restore. The push **may still land** — do not
  assume it failed
- `STALE_BASE` — the change's recorded base is behind the project HEAD
  (`merge.requireFreshBase`); re-evaluate on the new base
- `STALE_WORKSPACE` — the workspace advanced after evaluation; the merge is
  rejected so unevaluated commits can never land
- `WORKSPACE_UNVERIFIABLE` — the workspace state could not be verified against
  what was evaluated
- `MERGE_CONFLICT` — the merge produced conflicts; the response includes a
  conflict id for `POST /api/projects/conflicts/{id}/resolve`
- `PROTECTION_BLOCKED` — `403` (not a 409, despite sitting beside the staleness
  codes); the merge is blocked by branch protection and the response lists the
  `reasons`. A policy that names an evaluator whose binding is absent — most
  commonly `sandbox`, whose `[[sandboxes]]` binding is commented out by default —
  fails closed rather than being skipped, so it shows up here permanently until
  the binding is enabled or the evaluator is dropped from the policy
- `TARGET_DELETING` — `409`; the project (or its owner) is being deleted
- `NOT_REDRIVABLE` — `409`; the deletion job is not in an incomplete state
- `IMPORT_IN_PROGRESS` — `409`; the project's import has not finished, so the
  requested operation would race it
- `GONE` — `410`; the resource was deleted
- `INVALID_PATH` — `422`; the requested path is invalid (e.g. a conflict
  resolution naming a path outside the repo)
- `AMBIGUOUS_REF` — `409`; a `?ref=` names something that is both a branch and a
  tag, so the read is refused rather than guessing
- `BRANCH_EXISTS` — `409`; a branch of that name already exists
- `BRANCH_NAME_CONFLICT` — `409`; the name collides with an existing ref *path*
  (`release` when `release/2.x` exists — git stores refs as paths)
- `NO_DEFAULT_BRANCH` — `409`; the configured default branch is not advertised
  by the remote, so there is nothing to default a start point to
- `DEFAULT_BRANCH_PROTECTED` — `409`; the default branch cannot be deleted
- `SUBMODULES_UNSUPPORTED` — a gitlink entry (any depth) and/or a root-level
  `.gitmodules` file was found on import, or in the workspace a change is being
  created from — a gated push and `POST /api/projects/{name}/changes` alike,
  since both run the same scan; git submodules are not supported
  (see [Importing from GitHub](../user-guide/importing.md#unsupported-content)).
  This code is internal and is **not** returned to API clients as a code:
  `POST /api/projects/{name}/changes` reports it as a plain 400 carrying the
  explanatory message, a gated push reports it over the git protocol as a
  per-ref `ng` reason, and an import records a `failed` queue job. Match on the
  message, not on this identifier.

### Post-merge deployments

- `DEPLOY_QUEUE_UNAVAILABLE` — `503`; the instance has no `DEPLOY_QUEUE`
  binding, so deployments are not enabled here. Checked before the row's status
  is changed, so approving or retrying is still possible once it is configured
- `DEPLOYMENT_NOT_PENDING` — `409`; the deployment is not awaiting approval (it
  already ran, or someone else approved it first)
- `DEPLOYMENT_NOT_RETRYABLE` — `409`; only a finished deployment can be retried.
  A `queued`, `running` or `pending_approval` row still has a future, and
  retrying one would publish the same commit twice
- `DEPLOYMENT_RETRY_EXISTS` — `409`; that attempt number already exists —
  someone retried first, and their row is the live one

### Manual conflict resolution

`POST /api/projects/conflicts/{id}/resolve` runs the same gates a change does,
and reports them with its own codes:

- `SECRET_DETECTED` — `422`; the secret scan rejected the resolution; the
  response carries `issues`
- `EVALUATION_FAILED` — `422`; the evaluator suite rejected the resolution; the
  response carries `issues`
- `EVAL_PREP_FAILED` — `502`; the diff the evaluators would judge could not be
  built
- `INVALID_INPUT` — `400`/`422`; the resolution body is malformed, names an
  unknown strategy, or carries a file over the 10 MB per-file cap

### Generic codes

Anything thrown as an `AppError` and not matched above surfaces with its own
code and status: `VALIDATION_ERROR` (`400`), `NOT_FOUND` (`404`), `FORBIDDEN`
(`403`), `CONFLICT` (`409`), `PAYLOAD_TOO_LARGE` (`413`),
`EXTERNAL_SERVICE_ERROR` / `GITHUB_ERROR` / `GIT_PROTOCOL` (`502`), and
`INTERNAL_ERROR` (`500`). Treat these as families, not as a stable contract for
a specific endpoint — the coded errors above are the ones worth branching on.

Separately, an **import job** records a failure *category* on the job row —
`NETWORK_ERROR`, `TIMEOUT`, `AUTH_ERROR`, `NOT_FOUND`, `RATE_LIMITED`,
`UNSUPPORTED_CONTENT`, `STORAGE_ERROR`, `GIT_ERROR`, `CANCELLED`,
`UNKNOWN_ERROR` — classified from the failure message. These are not API error
responses: they appear on the admin metrics API and in the failure notification,
not as a `code` on a request you made.
