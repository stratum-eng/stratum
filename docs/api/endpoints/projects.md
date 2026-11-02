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

## Browsing a branch

`GET .../files`, `.../content`, and `.../log` accept `?ref=<branch>`, defaulting
to the project's default branch. Branch names only: an unknown ref is a `404`
(never a silent fall back to the default), and a name that is both a branch and
a tag is a `409 AMBIGUOUS_REF` rather than a guess at which was meant. The
response echoes the `ref` actually read.
