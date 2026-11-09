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

An enabled mirror is checked against GitHub before it is saved, and saving
queues a push. Enabling a mirror also stops the project syncing from its source
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

## Browsing a branch

`GET .../files`, `.../content`, and `.../log` accept `?ref=<branch>`, defaulting
to the project's default branch. Branch names only: an unknown ref is a `404`
(never a silent fall back to the default), and a name that is both a branch and
a tag is a `409 AMBIGUOUS_REF` rather than a guess at which was meant. The
response echoes the `ref` actually read.
