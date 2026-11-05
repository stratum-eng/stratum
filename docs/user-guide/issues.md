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

## Importing issues from GitHub

A repository import brings **git data only**, so an imported project starts with
an empty tracker. To bring a GitHub repository's issues across, use the
**Import GitHub issues** card on the project's **Settings** page, or the API:

```bash
curl -X POST https://app.usestratum.dev/api/projects/@acme/billing/issues/import/github \
  -H "Authorization: Bearer stratum_user_xxxxx" \
  -H "Content-Type: application/json"
```

The source is always the project's own GitHub source — the repository it was
imported from — and is never taken from the request. The answer is `202` with
the queued run; the import itself runs in the background, a page of 25 issues at
a time, so a repository of any size works. Follow it on the settings page or
with `GET` on the same URL, which returns the latest run:

```json
{ "run": { "id": "ghi_…", "status": "running", "githubRepo": "acme/billing",
           "issuesCreated": 25, "issuesUpdated": 0, "commentsImported": 41,
           "pullsSkipped": 7 } }
```

`status` moves through `queued` → `running` → `completed` or `failed`; `message`
explains a failure or a rate-limit wait.

**What is copied** for every issue: title, body, open/closed state, labels,
created and closed timestamps, and every comment. Each imported issue and
comment links back to its original on GitHub. **Pull requests are skipped** —
GitHub's issues API returns them too, and they are not issues here.

**Authors.** An issue or comment whose GitHub author has linked their GitHub
account to a Stratum account is attributed to that account. Anyone else is shown
by their GitHub login, marked "(GitHub)"; the API returns it as
`externalAuthor`, and `authorId` is then the admin who ran the import.

**Numbers and references.** Imported issues are numbered after the project's
existing issues, in GitHub creation order, so GitHub #12 is not necessarily
Stratum #12. Bare `#123` references in imported text are rewritten: one to an
issue that has been imported becomes its Stratum number, and anything else — a
pull request, or an issue not reached yet — becomes an explicit
`owner/repo#123` reference to GitHub, so it never silently points at an
unrelated local issue. References inside code spans, and qualified references
like `other/repo#4`, are left alone.

**Re-running is safe**, and is how you catch up before switching over: an issue
or comment that was already imported is updated in place, never duplicated. A
re-run also resolves the forward references the first run had to leave pointing
at GitHub. GitHub is treated as the source of truth until then — a re-run
overwrites the title, body, state and labels of imported issues with GitHub's
current values (authorship is left as it was). Comments deleted on GitHub are
not deleted here.

**Requirements and limits:**

- Project **admin** (the owner, or an org owner/admin), signed in as a user.
- The project has a GitHub source and its code import has completed.
- **Public repositories only**, for now: the import reads GitHub with an
  instance GitHub credential, and a private repository is refused with `403`.
- A GitHub credential must be allowed to act for the project's owner, by the
  same rule as every other GitHub call (see
  [GitHub App installations](../api/endpoints/github-app.md)). That means the
  GitHub App installation for the repository is linked to the owner, or an
  operator binding names the owner. Otherwise the request gets `403`
  (`not-authorized`). If no credential is available at all, it gets `503`.
- One import per project at a time — a second request answers `409`.
- Imported issues do not emit `issue.opened` events, so webhooks are not fired
  for every historical issue.
- Imported text is stored as written and displayed as plain text, exactly like
  any other issue; nothing in it is rendered as HTML.

## Reference

- [Issues API](../api/endpoints/issues.md)
- [OpenAPI specification](../api/openapi.yml) — exact schemas and status codes
