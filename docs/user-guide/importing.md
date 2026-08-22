# Importing from GitHub

Stratum imports repositories from **GitHub, GitLab, and Bitbucket**. Imports run
as background jobs, so large repositories don't block the request. The complete
request/response contract for every endpoint on this page is in the
[OpenAPI specification](../api/openapi.yml).

Examples use the hosted instance and a user API token — substitute your own
host and token:

```bash
export STRATUM_HOST=https://app.usestratum.dev
export STRATUM_API_KEY=stratum_user_xxxxx
```

## Start an import

```bash
curl -X POST "$STRATUM_HOST/api/projects/@username/repo/import" \
  -H "Authorization: Bearer $STRATUM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://github.com/owner/repo", "branch": "main"}'
```

A successful
request returns `201` with an `importId` and `status: "queued"`. Imports are
rate limited (3 per minute per user, 1 concurrent import per project) and only
allowed into your own namespace. If the project already exists with an
incomplete import, the import is re-triggered and `200` is returned.

### Options

| Field        | Default                   | Description |
| ------------ | ------------------------- | ----------- |
| `url`        | (required)                | Repository URL on `github.com`, `gitlab.com`, or `bitbucket.org`. |
| `branch`     | provider's default branch | Branch to import. When omitted, Stratum asks the provider API for the repository's real default branch; if that lookup fails the import falls back to `main` (fail-open) and logs a warning. |
| `depth`      | `10`                      | Shallow clone depth: an integer from 1 to 1000, or `0` / `"full"` to import the branch's full history. |
| `visibility` | `private`                 | `private` or `public`. |

## Track progress

Poll the status endpoint:

```bash
curl -H "Authorization: Bearer $STRATUM_API_KEY" \
  "$STRATUM_HOST/api/projects/@username/repo/import/status"
```

This returns an `ImportProgress` object: a `status` (`queued`, `cloning`,
`processing`, `completed`, `failed`, `cancelled`, …), a `progress` object
(`totalFiles`, `processedFiles`, `currentFile`, `bytesTransferred`,
`totalBytes`), and any `errors` and `logs`. Polling also recovers imports that
have stalled for more than 5 minutes.

Or subscribe to Server-Sent Events instead of polling — the stream emits the
same `ImportProgress` JSON as an SSE `data:` line every 2 seconds until the
import completes, fails, or is cancelled:

```bash
curl -N -H "Authorization: Bearer $STRATUM_API_KEY" \
  "$STRATUM_HOST/api/projects/@username/repo/import/stream"
```

A failed import can be retried with
`POST …/import/retry` (rate limited like the initial import), and an ongoing
one cancelled with `POST …/import/cancel`.

## Sync

Keep an imported project in sync with its source repository. Trigger a sync
check — when the source has new commits, a background sync is queued:

```bash
curl -X POST "$STRATUM_HOST/api/projects/@username/repo/sync" \
  -H "Authorization: Bearer $STRATUM_API_KEY"
```

The response reports `hasUpdates`, `commitsBehind`, `latestCommit`, and
`lastSyncedCommit`, plus an `importId` and `status: "queued"` when a sync was
actually started.

Check state with `GET …/sync/status`, which returns a `SyncStatus` object
(`lastSyncStatus`: `success` / `failed` / `in_progress` / `idle`,
`lastSyncedAt`, `commitsBehind`, `autoSyncEnabled`, and an `importProgress`
object while a sync is active), or follow it live over SSE with
`GET …/sync/stream` — the sync-status object is emitted every 2 seconds until
the sync succeeds or fails, and the stream self-closes after 5 minutes.

Enable automatic syncing with:

```bash
curl -X POST "$STRATUM_HOST/api/projects/@username/repo/sync/settings" \
  -H "Authorization: Bearer $STRATUM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"autoSyncEnabled": true, "syncFrequency": 60}'
```

`syncFrequency` is in minutes. Past runs are listed by
`GET …/sync/history` (paginated with `limit`/`offset`).

## Failure notifications

If an import fails, Stratum emails the user who started it, with a copy to the
instance admin (`ADMIN_EMAIL`) when one is configured.

## Current limitations

What import does **not** do yet:

- **Public repositories only.** Imports clone anonymously — provider tokens are
  not used for the clone, and GitHub sign-in only requests the `user:email`
  OAuth scope. Token-authenticated clones of private repositories are future
  work.
- **Git data only.** Issues, pull requests, releases, and tags are not
  imported — only the selected branch's commit history and files.
- **Single branch.** Only one branch is imported per project; the clone is a
  `singleBranch` clone bounded by `depth`.
- **No self-hosted instances.** Only `github.com`, `gitlab.com`, and
  `bitbucket.org` URLs are recognized; GitHub Enterprise Server and self-hosted
  GitLab are not supported.

Bidirectional GitHub sync — inbound webhooks and outbound PR promotion, i.e.
**layer mode** — is covered in [Getting started](getting-started.md).
