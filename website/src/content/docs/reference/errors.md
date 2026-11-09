---
title: "Error Codes"
description: "HTTP status codes and the machine-readable error codes Stratum returns."
editUrl: "https://github.com/stratum-eng/stratum/edit/main/docs/api/errors.md"
---

Errors are returned as JSON: `{ "error": "<human-readable message>" }`, with a
machine-readable `code` field present on some errors. The per-endpoint status
codes are in the [OpenAPI specification](/reference/openapi/).

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
  and `X-RateLimit-Remaining` headers. Limits are per minute and approximate: on
  Stratum's hosted service each Cloudflare location counts separately, and a
  successful response reports only `X-RateLimit-Limit`, not how much of it is
  left. Back off on `429` and honour `Retry-After` rather than pacing against
  a remaining count
- `TOKEN_SCOPE_INSUFFICIENT` — a `read` token was used for a write. Returned
  `403`, checked before routing on the HTTP method, on API routes. The git
  smart-HTTP router enforces the same rule on the resolved operation (so
  `git push` and its `git-receive-pack` advertisement are refused too) but
  answers with its deliberate plain-text `404` — never this code — so an
  unauthorized caller cannot distinguish "no permission" from "no such repo"
- `TOKEN_BINDING_EXCLUDES_ROUTE` — `403`; a token bound to one project or
  organization was used on an endpoint outside the project surfaces (account
  settings, token or agent minting, organization administration, bulk import,
  the admin API, or the web UI). Checked before routing, but after the
  read-only rule: a `read` bound token sending a non-`GET`/`HEAD` request to
  such an endpoint (e.g. `POST /api/agents`) gets `TOKEN_SCOPE_INSUFFICIENT`
  instead. A bound token used on a *project* outside its binding gets that
  route's ordinary not-found answer instead — even on routes that answer a
  non-writer with `403` — so the binding does not reveal what else exists
- `TOKEN_LIMIT_REACHED` — `409`; the account already holds 20 active tokens.
  Revoked tokens do not count toward the limit
- `SESSION_REQUIRED` — `403`; the endpoint accepts the browser session cookie
  only. Applies to token management (`/api/users/me/tokens`,
  `legacy-token/disable`), to `rotate-token` when called with a scoped token,
  and to an `approve` review verdict sent with a scoped token or OAuth grant
  (the body carries `approveUrl`, the change page to approve on)
- `SESSION_EXPIRED` — `401`; the browser session is no longer valid
- `ADMIN_REQUIRES_DIRECT_CREDENTIAL` — `403`; an MCP/CLI OAuth grant was used on
  `/api/admin/*`, or on a project's break-glass
  [`resync`](/reference/endpoints/#resync-from-github-break-glass) endpoint.
  The `/api/admin/*` refusal happens before routing; the resync refusal
  happens at the start of its handler. Both apply even when the account behind
  the grant is the instance administrator or the project's admin. A read-only
  grant on resync gets `TOKEN_SCOPE_INSUFFICIENT` first
- `RESYNC_DIVERGED` — `409`; a break-glass resync found that the project's
  default branch and the branch on GitHub have diverged. The body carries
  `projectSha` and `upstreamSha`. Nothing was changed. The other `RESYNC_*`
  codes are listed with the
  [endpoint](/reference/endpoints/#resync-from-github-break-glass)
- `CSRF` — `403`; a `POST`/`PUT`/`PATCH`/`DELETE` arrived with an `Origin` or
  `Referer` that is missing, malformed, or names a different host. Enforced for
  session-cookie callers and for the few unauthenticated endpoints that must not
  be forgeable (magic-link verify); bearer-token callers are unaffected
- `IP_NOT_ALLOWED` — `403`; the request came from outside an organization's IP
  allowlist and asked for that org's resources (its projects or
  `/api/orgs/{slug}/` endpoints). The body carries `org` and the `ip` Stratum
  saw (`null` when the request had no client address). Only a member sees this;
  anyone else gets the route's usual `404`. Over git it is a plain-text `403`
  with an `X-Stratum-Error-Code: IP_NOT_ALLOWED` header. See
  [Organization IP allowlists](/guides/org-ip-allowlist/)
- `IP_ALLOWLIST_SELF_LOCKOUT` — `409`; `PUT /api/orgs/{slug}/security` would save
  an IP allowlist that excludes the caller's own address. Resend with
  `"allowSelfLockout": true` to save it anyway
- `SYNC_DIVERGED` — the upstream and the Stratum copy have genuinely diverged in
  content. The fetch window is deepened incrementally first, so this is a real
  conflict rather than a too-shallow clone
- `PINNED_SHA_UNREACHABLE` — the pinned commit is not reachable in the clone
- `PUSH_TIMEOUT` — `504` during restore. The push **may still land** — do not
  assume it failed
- `EXTERNAL_NOT_IMPORTED` — `409`; the change is `external`: it stands for a
  pull request on the project's GitHub mirror that nobody has imported. It
  cannot be merged or evaluated, with or without `force`. Import it with
  `POST /api/changes/{id}/import`.
- `PR_HEAD_MOVED` — `409`; the pull request behind a change has commits newer
  than the ones in hand. On import: newer than the `headSha` you sent, or
  pushed while the import ran. On merge: newer than the ones that were
  imported, with or without `force`. Look at the pull request again and import
  the new commits
- `EVALUATION_PENDING` — `409`; the change is still `evaluating`, so there is no
  verdict to merge on. Refused even with `force`: force bypasses a failing
  verdict, never a missing one. Poll the change and merge once it has one.
  Also returned by `approve` while the change is evaluating, and by
  `POST /api/changes/{id}/github-pr` when a re-evaluation began while the PR
  was being opened — the PR exists (the response carries `github`) but the
  change is not promoted; promote again once the evaluation finishes
- `EVALUATION_MISSING` — `409`; the change's evaluation ended without a verdict
  (it failed closed), so there is no evaluated revision to merge. Refused even
  with `force`. Re-evaluate the change first
- `REVIEW_STALE` — `409`; the change moved on (its evaluation finished or was
  re-run, or its status changed) between loading it and recording the
  approval. Nothing was recorded: reload the change and review it again
- `STALE_BASE` — the change's recorded base is behind the project HEAD, or
  the change has no recorded base (`merge.requireFreshBase`); re-evaluate on
  the new base
- `BASE_UNVERIFIABLE` — `503`; under `merge.requireFreshBase` the project HEAD
  could not be read, so the change's base could not be checked. The merge is
  refused rather than allowed unverified; retry. A batch merge answers this
  way only when the unreadable head leaves nothing to merge; otherwise it
  merges the rest and lists these changes under `skipped`
- `STALE_WORKSPACE` — the workspace advanced after evaluation; the merge is
  rejected so unevaluated commits can never land
- `STALE_PROJECT` — `409`; the project's default branch advanced between the
  point a manual conflict resolution was evaluated and the point it would have
  been committed. The same principle as `STALE_WORKSPACE` from the other side:
  the resolution would otherwise have landed on a base no evaluator saw. Nothing
  is committed — re-resolve against the current revision
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
  A `merge.requiredChecks` entry blocks the same way: a required
  [check run](/guides/checks/) that is missing, `queued`, `running`,
  `failed` or `errored` for the evaluated revision is listed in `reasons`
- `INVALID_SIGNATURE` — `401`; a check-run callback (`POST /api/checks/{id}`)
  had no valid `X-Stratum-Signature`, **or** named a check run that does not
  exist. The two are deliberately the same response
- `INVALID_REPORT` — `400`; a check-run callback was signed but its body is not
  a valid report
- `STALE_REVISION` — `409`; a check-run report or re-run refers to a revision
  the change has moved on from. For a re-run, re-evaluate the change instead
- `CHECK_SUPERSEDED` — `409`; a newer run of the same check has replaced the
  one addressed
- `CHECK_TERMINAL` — `409`; the check run already finished as `passed`,
  `failed` or `errored`, and a terminal state is final
- `CHECK_DEADLINE_EXCEEDED` — `409`; the report arrived after the check run's
  deadline, and the run is `errored`
- `CHECK_NOT_DECLARED` — `409`; a re-run was asked for a check the project's
  policy no longer declares
- `CHECK_DISPATCH_FAILED` — `502`; a re-run was created but the runner could
  not be reached. The response carries the new run, already `errored`
- `CHECK_HAS_NO_LOG` — `404`; a log was asked for a check run reported by a
  project's own runner. Only a first-party CI step has a log on Stratum
- `CHECK_LOG_NOT_FOUND` — `404`; the CI executor holds no log for this check
  run: the step has not started, never ran, or its log has expired
- `CI_EXECUTOR_UNAVAILABLE` — `502` when the instance's CI executor could not
  be reached or refused the request, `503` when the instance has no executor
  or it is misconfigured (the message names the setting)
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
  (see [Importing from GitHub](/guides/importing/#unsupported-content)).
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
  someone retried or rolled back first, and their row is the live one
- `DEPLOYMENT_NOT_ROLLBACKABLE` — `409`; only a `succeeded` deployment can be
  rolled back to. Nothing else was ever live
- `DEPLOYMENT_NOT_RUNNING` — `409`, on the CI executor's report
  (`POST /api/deploy-reports/{id}`); there is no running pipeline deployment
  with that id for that commit, so the report changes nothing
- `LOG_NOT_AVAILABLE` / `LOG_NOT_FOUND` — `404`, on
  `GET /api/deployments/{id}/log`; the deployment is not a pipeline deployment,
  or no step log has been stored for it yet

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
`UNKNOWN_ERROR` — classified from the failure message. As *categories* these are
not API error responses: they appear on the admin metrics API and in the failure
notification, not as a `code` on a request you made.

Two of those names do also exist as response codes in their own right, so match
on the endpoint rather than on the name alone:

- `GIT_ERROR` — `500`; a git operation the request depended on could not be
  completed. Returned by `POST /api/projects/conflicts/{id}/resolve` when the
  project's current revision cannot be read, so the evaluated base cannot be
  verified. The request was well formed; retrying can succeed
- `AUTH_ERROR` — `401`; the repository credential was rejected or has expired
