# Issues

Stratum has a built-in issue tracker. It is deliberately small — issues exist
to give agents and humans a shared, linkable statement of intent that a change
can be tied back to, not to be a full project-management tool.

## Opening an issue

```bash
curl -X POST https://app.usestratum.dev/api/projects/@acme/billing/issues \
  -H "Authorization: Bearer stratum_user_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"title": "Retry storms on 429 from the GitHub API",
       "body": "The client retries 429 without honouring Retry-After."}'
```

**Read access to the project is enough to open an issue.** On a public project
that means any authenticated user — the platform-wide per-identity rate limit
(1,000 requests/minute authenticated) is what bounds abuse, not a per-issue
quota. Editing, closing, and labelling all require **write** access on the
project *and a user identity* — a reader can raise a problem but cannot triage
it, and an agent token can open and comment but never triage, whatever access
its owner has.

Project permission and credential scope are separate gates, and both apply.
Opening an issue is a `POST`, so a `read`-scoped API token is refused with
`403 TOKEN_SCOPE_INSUFFICIENT` however much project access its owner has. Use a
`read_write` token or a browser session; the examples here assume one.

Titles are capped at 200 characters and bodies at 20,000.

Issues are numbered per project, starting at 1, and referenced by that number
rather than by an opaque id.

## Linking an issue to a change

`linkedChangeId` ties an issue to the change meant to resolve it. The change
must belong to the same project — a link into another project is rejected.

```bash
curl -X POST https://app.usestratum.dev/api/projects/@acme/billing/issues \
  -H "Authorization: Bearer stratum_user_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"title": "Retry storms on 429", "linkedChangeId": "chg_123"}'
```

**When that change merges, every open issue linked to it closes automatically**,
attributed to `system`, and emits an `issue.closed` event. Per-issue failures
are logged and skipped rather than failing the merge.

## Triage: labels, assignee, status

All of it is one `PATCH`:

```bash
curl -X PATCH https://app.usestratum.dev/api/projects/@acme/billing/issues/42 \
  -H "Authorization: Bearer stratum_user_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"labels": ["bug", "needs-repro"], "assignee": "usr_abc", "status": "open"}'
```

| Field | Notes |
|---|---|
| `title`, `body` | Same caps as on create. |
| `status` | `open` or `closed`. |
| `labels` | Replaces the whole set. Max 20 per issue, 50 characters each. |
| `assignee` | A user id. Pass `null` to unassign. |
| `linkedChangeId` | Pass `null` to unlink. |

`labels` is a **replace**, not a merge: send the full list you want the issue to
end up with. `POST .../issues/{number}/close` exists for the UI button and is a
**toggle** — on an already-closed issue it reopens it, and it answers with a
`302` redirect. Scripts should prefer the idempotent `PATCH {"status": "closed"}`.

## Finding issues

`GET /api/projects/{namespace}/{slug}/issues` filters on four axes, which
combine:

```bash
# Open bugs assigned to a given user, mentioning "retry"
curl "https://app.usestratum.dev/api/projects/@acme/billing/issues?status=open&label=bug&assignee=usr_abc&q=retry" \
  -H "Authorization: Bearer stratum_user_xxxxx"
```

- `status` — `open` or `closed`
- `label` — issues carrying that exact label
- `assignee` — issues assigned to that user id
- `q` — case-insensitive substring search over **title and body**, max 200
  characters. `%` and `_` match literally, so a search string containing them
  finds them rather than acting as wildcards.

Results are ordered newest-first by issue number. Paginate with `limit`
(default 100, max 500) and `offset`.

## Comments

```bash
curl -X POST https://app.usestratum.dev/api/projects/@acme/billing/issues/42/comments \
  -H "Authorization: Bearer stratum_user_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"body": "Reproduced against the 2026-08-30 build."}'
```

Comments are capped at 20,000 characters and listed with the same
`limit`/`offset` pagination as issues. Read access is enough to comment.

These are issue comments, and separate from the review threads on a change —
for line-anchored comments on a diff, see [Code Review](code-review.md).

## Imported repositories have no issues

A GitHub import brings **git data only**. Issues, pull requests, releases, and
tags do not come across, so an imported project starts with an empty tracker
and issue numbering starts at 1. See
[Importing from GitHub](importing.md#current-limitations).

## Reference

- [Issues API](../api/endpoints/issues.md)
- [OpenAPI specification](../api/openapi.yml) — exact schemas and status codes
