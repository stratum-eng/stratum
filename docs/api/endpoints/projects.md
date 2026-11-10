# Projects API

## List Projects
`GET /api/projects`

## Create Project
`POST /api/projects`

## Get Project
`GET /api/projects/{namespace}/{slug}`

## Import from GitHub
`POST /api/projects/{namespace}/{slug}/import`

See the [Importing from GitHub guide](../../user-guide/importing.md) for the
available options, how to track an import's progress, and keeping the project
in sync with its source.

## Delete Project
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

## List Branches

`GET /api/projects/{namespace}/{slug}/branches`

Returns `{ defaultBranch, branches: [{ name, oid }], truncated, totalBranchCount }`.
Read from the remote's ref advertisement, so the cost does not grow with the
branch count. Capped at 200 — `truncated` says so explicitly, and the default
branch is never the entry dropped.

## Create Branch

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

## Delete Branch

`DELETE /api/projects/{namespace}/{slug}/branches/{name}`

Hierarchical names are passed as real path segments
(`.../branches/release/2.x`); a percent-encoded slash (`release%2F2.x`) names
the same branch, since each path segment is decoded individually.
**Writers only.** The default branch cannot be deleted —
`409 DEFAULT_BRANCH_PROTECTED`.

## List Tags

`GET /api/projects/{namespace}/{slug}/tags`

Returns `{ tags, truncated, totalTagCount }`, with tags in ascending name order.
Each tag is:

| Field | Meaning |
|-------|---------|
| `name` | Tag name, without `refs/tags/`. |
| `oid` | What the ref points at: the tag object for an annotated tag, the target itself for a lightweight one. |
| `targetSha` | The commit the tag resolves to, or `null` when it could not be determined. |
| `annotated` | `true` for an annotated tag. |
| `message`, `tagger`, `timestamp` | Annotated tags only: the tag's message, its tagger as `Name <email>`, and the tagger time in epoch seconds. |
| `unresolvable` | `true` when the tag's object or target could not be read. The tag is still listed. |

Tag names come from the remote's ref advertisement, so a listing normally does
not clone the repository. The exception is a tag whose details are not stored
yet. The repository is cloned to read it, and the details are then remembered.
The first request after a new tag is pushed is therefore slower. A tag that could
not be resolved, or whose details come to more than 64 KB once stored (in
practice, a very long message), is not remembered. Every
request that lists such a tag clones the repository again, and `unresolvable`
can be `true` on any of those requests.

Capped at 200, keeping the highest-sorting names; `truncated` says so explicitly
and `totalTagCount` is the number the repository actually has. Readable by anyone
who can read the project.

## Push mirror

Keeps a GitHub repository a read-only, fast-forward-only copy of the project's
default branch and tags. The [push mirror guide](../../user-guide/push-mirror.md)
covers setup, the GitHub App permissions it needs, and recovery.

Every endpoint is for **project admins**: the project's owner, or an owner or
admin of the organization that owns it. A writer who is not an admin gets `403`,
anyone else `404`, and an agent `401`.

### Get the mirror
`GET /api/projects/{namespace}/{slug}/mirror`

```json
{
  "mirror": {
    "repo": "acme/widgets",
    "url": "https://github.com/acme/widgets",
    "enabled": true,
    "state": "ok",
    "pending": false,
    "lastPushedSha": "9f2c1e7a…",
    "lastPushedAt": "2026-11-09T10:15:02.000Z",
    "lastAttemptAt": "2026-11-09T10:15:00.000Z",
    "lastError": null,
    "nextAttemptAt": null,
    "attempts": 0
  }
}
```

`mirror` is `null` when the project has none. `state` is one of `idle`,
`pushing`, `ok`, `retrying`, `failed`, `diverged`. `pending` is true while a
push has been requested and has not completed.

The same object is the `mirror` field of
`GET /api/projects/{namespace}/{slug}/sync/status`, for anyone who can read the
project. Readers without write access do not get `lastError`, `nextAttemptAt`
or `attempts`.

### Configure the mirror
`PUT /api/projects/{namespace}/{slug}/mirror`

```json
{ "repo": "acme/widgets", "enabled": true }
```

`repo` is `owner/repository` on GitHub. `enabled` defaults to `true`. `POST` to
the same path does the same thing.

The target is checked against GitHub before it is saved, whether or not the
mirror is enabled; only disabling an existing mirror skips the check. Saving an
enabled mirror queues a push. Enabling a mirror also stops the project syncing from its source
and promoting changes to GitHub pull requests (`409 PUSH_MIRROR_ENABLED` on
those endpoints).

| Status | `code` | Meaning |
|---|---|---|
| `400` | `invalid-repo` | `repo` is not `owner/repository` |
| `403` | `not-authorized` | The App installation is not linked to the project's owner |
| `403` | `no-permission` | The App lacks **Contents: read and write** on the repository |
| `409` | `not-installed` | The App is not installed on the repository |
| `409` | `taken` | The repository is connected to another Stratum project |
| `409` | `deleting` | The project is being deleted |
| `502` | `github` | GitHub could not be reached |
| `503` | `not-configured` | The GitHub App is not configured on this instance |

### Resume the mirror
`POST /api/projects/{namespace}/{slug}/mirror/resume`

Clears a `failed` or `diverged` state and queues a push. Returns `202` with the
mirror. It never forces: a repository that is still diverged is reported as
diverged again. On a healthy mirror it queues a push now.

### Remove the mirror
`DELETE /api/projects/{namespace}/{slug}/mirror`

Deletes the configuration and status. The GitHub repository is not changed.

### Resync from GitHub (break-glass)
`POST /api/projects/{namespace}/{slug}/resync`

Fast-forwards the project's default branch to the same branch on GitHub. This
is the one exception to the read-only mirror, for a fix that had to land on
GitHub while Stratum could not merge. **The commits it brings in are not
evaluated.** Read [the guide](../../user-guide/push-mirror.md#break-glass-resync-from-github)
before you use it.

Project admins only, as above. In addition, an OAuth grant with write scope is
refused with `403 ADMIN_REQUIRES_DIRECT_CREDENTIAL`: use a browser session or a
personal API token with the `read_write` scope. A read-only token or grant is
refused first, with `403 TOKEN_SCOPE_INSUFFICIENT`. The organization's second-factor policy and
IP allowlist apply.

The source is the project's push mirror repository, or, for a project with no
mirror, its linked GitHub repository. The request cannot choose it.

```json
{ "expectedSha": "9f2c1e7a0b3d4c5e6f708192a3b4c5d6e7f80910" }
```

The body is optional. `expectedSha` is the full 40-character SHA that GitHub's
branch must be at; any other commit there is refused.

`200` with `"status": "fast-forwarded"`:

```json
{
  "status": "fast-forwarded",
  "branch": "main",
  "source": { "kind": "mirror", "repo": "acme/widgets" },
  "oldSha": "4b825dc6…",
  "newSha": "9f2c1e7a…",
  "commits": [{ "sha": "9f2c1e7a…", "summary": "Fix the merge queue deadlock", "author": "Ada" }],
  "commitCount": 1,
  "commitsTruncated": false,
  "evaluated": false,
  "mirror": { "repo": "acme/widgets", "state": "ok", "pending": true }
}
```

`200` with `"status": "up-to-date"` when the project already contains GitHub's
commit. It carries `branch`, `source`, `projectSha`, `upstreamSha` and `mirror`.
The branch was not moved. A push mirror that was `failed` or `diverged` is
still resumed, with a `mirror.resumed` audit entry, as after a fast-forward.

`source.kind` is `mirror` or `source`. `commits` holds at most 50 entries,
newest first. `mirror` is the mirror after the resync, or `null`.

A refusal carries `code`, and `projectSha` and `upstreamSha` when it knows them.
Nothing was changed, except where the table says the outcome is unknown.

| Status | `code` | Meaning |
|---|---|---|
| `400` | `RESYNC_INVALID_SHA` | `expectedSha` is not a full 40-character SHA |
| `400` | `RESYNC_INVALID_BODY` | The body is present but is not a JSON object. An empty body is accepted and means no pin |
| `403` | `ADMIN_REQUIRES_DIRECT_CREDENTIAL` | An OAuth grant was used |
| `403` | `GITHUB_APP_NOT_AUTHORIZED` | The App installation is not linked to the project's owner |
| `403` | `GITHUB_APP_PERMISSION_DENIED` | The App lacks **Contents: read** on the repository |
| `409` | `RESYNC_NO_UPSTREAM` | The project has no push mirror and no linked GitHub repository |
| `409` | `RESYNC_DIVERGED` | The two branches have diverged; the error names both commits |
| `409` | `RESYNC_SHA_MISMATCH` | GitHub's branch is not at `expectedSha` |
| `409` | `RESYNC_PROJECT_MOVED` | A merge landed while the resync was running; run it again |
| `409` | `RESYNC_UPSTREAM_BRANCH_MISSING` | The GitHub repository has no branch with the default branch's name |
| `409` | `RESYNC_PROJECT_BRANCH_MISSING` | The project has no commits; a resync does not populate it |
| `409` | `GITHUB_APP_NOT_INSTALLED` | The App is not installed on the repository |
| `409` | `TARGET_DELETING` | The project is being deleted |
| `502` | `GITHUB_ACCESS_DENIED` | GitHub refused the App's token for the repository |
| `502` | `RESYNC_UPSTREAM_UNAVAILABLE` | GitHub could not be read |
| `502` | `RESYNC_PROJECT_UNAVAILABLE` | The project's repository could not be read |
| `502` | `RESYNC_HISTORY_INCOMPLETE` | The history between the two commits could not be read completely |
| `502` | `RESYNC_PUSH_REJECTED` | The project's repository refused the fast-forward |
| `502` | `RESYNC_FAILED` | The resync failed. **The outcome may be unknown**: check the branch before you retry |
| `503` | `GITHUB_APP_NOT_CONFIGURED` | The GitHub App is not configured on this instance |
| `504` | `RESYNC_PUSH_TIMEOUT` | The push did not finish in time. **The outcome is unknown**: check the branch before you retry |

A fast-forward writes `branch.resync_requested` and `branch.resynced` audit
entries and emits a `branch.resynced` event. The settings page posts a form to
the same path with `confirm` (the source `owner/repository`, typed out) and an
optional `expected_sha`; a form post is answered with a redirect.

## Browsing a branch

`GET .../files`, `.../content`, and `.../log` accept `?ref=<branch>`, defaulting
to the project's default branch. Branch names only: an unknown ref is a `404`
(never a silent fall back to the default), and a name that is both a branch and
a tag is a `409 AMBIGUOUS_REF` rather than a guess at which was meant. The
response echoes the `ref` actually read.
