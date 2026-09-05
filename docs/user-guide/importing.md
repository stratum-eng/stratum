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
`totalBytes`), and any `errors` and `logs`. Polling also recovers an import that
has been in an actively-progressing state (`cloning`, `processing`, `syncing`,
`cancelling`) for more than **20 minutes** without its timestamp advancing.
`queued` is deliberately excluded — a job waiting to be picked up is not
stalled, and the scheduled sweep covers it under a one-hour grace period.

`processedFiles` and `totalFiles` are not an incrementing counter: they are
both written once, from the file walk that builds the repository snapshot, in
the `processing` phase just before the status becomes `completed`. Expect them
to stay at `0` for the whole clone and then jump to the final count.

One exception: the snapshot write handles its own failures and returns no
count, and the import is still marked `completed` in that case. So a completed
import whose `processedFiles` and `totalFiles` are both `0` means the snapshot
could not be built — not that the repository was empty. The repository itself
imported fine; only the file listing is missing.

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
  -d '{"autoSyncEnabled": true}'
```

Auto-sync runs on a **fixed daily schedule** (06:00 UTC on the hosted
instance) for every project with `autoSyncEnabled`. The settings endpoint also
accepts a `syncFrequency` field, but it is stored and **not yet used** — the
scheduler does not read it, so it does not change the cadence. Trigger
`POST …/sync` yourself for anything more frequent. Past runs are listed by
`GET …/sync/history` (paginated with `limit`/`offset`).

## Failure notifications

If a **queued** import fails, Stratum emails the user who started it, plus one
operator copy. (A deployment with no import queue configured falls back to
processing the import directly in the request, and that path sends no failure
notification at all — it is a development fallback, not the normal path.)

Sending requires two things:

- **An `EMAIL` binding on the Worker.** Without it no failure notification is
  sent, whatever the addresses below are set to.
- **At least one resolvable recipient.** The operator copy goes to
  `ADMIN_EMAIL`, or — when `ADMIN_EMAIL` is unset — to `EMAIL_FROM_ADDRESS`.
  Leaving `ADMIN_EMAIL` unconfigured therefore does not switch the operator copy
  off; it redirects it to the sender address.

When the initiator's address cannot be resolved, the operator copy is still
sent, and identical addresses are de-duplicated so nobody is mailed twice. A
failure is reported only in the logs when the `EMAIL` binding is absent, or when
neither an initiator address nor an operator address can be resolved.

## Current limitations

What import does **not** do yet:

- **Public repositories only.** Imports clone anonymously — provider tokens are
  not used for the clone, and GitHub sign-in only requests the `user:email`
  OAuth scope. Token-authenticated clones of private repositories are future
  work.
- **Git data only.** Issues, pull requests, releases, and tags are not
  imported — only the selected branch's commit history and files.
- **Single branch.** Only one branch is imported per project. The clone is a
  `singleBranch` clone; it is bounded by `depth` only for shallow imports —
  `depth: 0` (or `"full"`) omits the cutoff and fetches the whole history of
  that one branch.
- **No self-hosted instances.** Only `github.com`, `gitlab.com`, and
  `bitbucket.org` URLs are recognized; GitHub Enterprise Server and self-hosted
  GitLab are not supported.

Bidirectional GitHub sync — inbound webhooks and outbound PR promotion, i.e.
**layer mode** — is covered in
[Getting started](getting-started.md#choose-your-level-of-buy-in-layer-mode-vs-alternative-mode).

## Unsupported content

**Git submodules are not supported.** A repository containing a gitlink tree
entry (the `160000` mode git uses for a submodule reference) at any depth, or a
root-level `.gitmodules` file, is rejected. A gated push is refused over the
git protocol, `POST /api/projects/{name}/changes` answers 400, and an import
ends as `failed` — each carrying an explanatory message rather than a
machine-readable submodule code.

On import the check is best-effort. When the just-imported tree can be read,
submodule content fails the import with `status: "failed"` — before the
project is ever marked imported. When the tree cannot be read at all (the read
token cannot be minted, the clone fails, or the scan itself errors) the import
proceeds with a warning and is left unscanned, rather than failing a healthy
repository because of an infrastructure hiccup. So a completed import is not
on its own proof that a repository is submodule-free.

The same scan runs whenever a change is created — on a gated push to a
project's default branch and on `POST /api/projects/{name}/changes` alike —
and there it is unconditional: a change carrying submodule content is refused,
and so is one whose scan could not run. That is the gate that keeps submodule
content out of a merge.

This is deliberate: git's checkout silently drops a gitlink entry when
Stratum's server-side git layer materializes a working tree, so partially
importing a repo with submodules would let a later merge quietly corrupt it
rather than fail loudly. Remove submodules (or flatten them into the repo)
before importing, or push to a workspace remote for content that never
touches the default branch. Full submodule support (recursive clone and
browsing) is tracked for later; see
[`CURRENT_CAPABILITIES.md`](../CURRENT_CAPABILITIES.md).
