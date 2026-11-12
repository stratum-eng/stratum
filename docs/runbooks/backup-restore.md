# Runbook: Backup & Restore

Stratum backs up all durable state to an R2 bucket (`BACKUPS`) once a day and on
demand. This runbook covers what is captured, how to trigger a run, how to verify
one, and how to restore — including the one leg that cannot be proven in CI and
must be validated on staging.

## What is backed up

Each run writes one timestamped prefix `<runTs>/` (an ISO-8601 instant) to the
`BACKUPS` bucket:

| Path | Contents |
| --- | --- |
| `<runTs>/d1/<table>.ndjson` | One NDJSON dump per backed-up D1 table (header line carries table + columns). Tables excluded on purpose are listed in `src/storage/d1-backup.ts`; `github_user_connections` is one. |
| `<runTs>/kv/projects.json` | All project identity records from KV. |
| `<runTs>/kv/workspaces.json` | All workspace identity records from KV. |
| `<runTs>/repos/<projectId>.pack` | Git pack of the **full reachable object set** for the repo. |
| `<runTs>/repos/<projectId>.manifest.json` | Tip sha (absent for a tag-only repo — see [tag-only snapshots](#repos--the-leg-ci-cannot-prove)), tag and branch refs, object/byte counts, and the full `ProjectEntry`. |
| `<runTs>/_manifest.json` | Run summary. **Written last** — its presence marks the run complete. |

A run whose `_manifest.json` is missing crashed partway; treat it as unusable and
restore from the previous complete run. Retention counts only complete runs, and
each backup collects older incomplete prefixes, so crashed runs cannot pile up and
evict good backups — the newest prefix is always protected in case it is a run
still in progress.

Retention also reads `healthy` from each complete run's manifest
(`pruneRuns` in `src/storage/backup-store.ts`):

- Healthy runs fill the `BACKUP_RETENTION` window. A manifest without a `healthy`
  field, or one that cannot be decoded (for example after
  `BACKUP_ENCRYPTION_SECRET` changed), is treated as unknown and counts toward the
  window the same way.
- Unhealthy runs never take a window slot. One is kept only while it is among the
  newest `BACKUP_RETENTION` complete runs, so failures still age out. They are not
  capped tighter, because a run that is unhealthy only because one repo failed
  still holds the newest pack for every other repo in its slice. Worst-case
  storage is therefore about twice the window.
- The newest healthy run is always kept, however many unhealthy runs follow it.
- If any manifest cannot be read from R2, that backup prunes nothing.

### Repo coverage and the cursor

An instance with more repos than `MAX_REPOS_PER_RUN` (default 25) snapshots the
oldest-backed-up repos first, tracked in the D1 `backup_state` table. Every repo
is therefore covered within `ceil(totalRepos / MAX_REPOS_PER_RUN)` daily runs, not
starved. Raise `MAX_REPOS_PER_RUN` to shorten that window.

### Pinned projects

Some repos should not wait their turn in the rotation. List them in
`BACKUP_PINNED_PROJECTS` and they are snapshotted in **every** run:

```toml
[env.production.vars]
BACKUP_PINNED_PROJECTS = "@stratum/stratum,@acme/infra"
```

- Entries are comma-separated `@namespace/slug` paths, the same as in a project
  URL. The leading `@` may be omitted (`acme/infra` means `@acme/infra`).
  Whitespace and empty entries are ignored, and duplicates collapse to one.
- Parsing is strict. An entry that is not exactly one valid namespace and one
  valid slug is **skipped and logged** (`ignoring malformed
  BACKUP_PINNED_PROJECTS entry`) on every run, never fuzzy-matched. A
  well-formed entry that matches no project (deleted, renamed, or a typo) is
  logged as `pinned project not found` and listed under `repos.pinnedMissing`
  in the run's `_manifest.json`. Neither makes the run unhealthy, so check the
  logs or `pinnedMissing` after changing the setting.
- Pinned projects are **in addition to** the rotation: they do not use up any of
  the `MAX_REPOS_PER_RUN` slots, and they are excluded from the rotation so none
  is snapshotted twice in a run. `repos.total` still counts every project;
  `repos.deferred` counts only unpinned ones left for a later run.
- The run manifest lists them as `repos.pinned: [{ projectId, path }]`. Their
  outcome lands in `backedUp`, `skipped` or `failed` like any other repo, and a
  failed pinned repo makes the run unhealthy. `MAX_BACKUP_BYTES` still applies,
  so an oversized pinned repo is skipped, not backed up. Look for it under
  `repos.skipped`.
- Every pinned repo adds to the run's wall-clock time, which shares the cron's
  roughly 15-minute budget with the rotation. Pin only a handful of repos. If
  runs get close to the limit, lower `MAX_REPOS_PER_RUN` to make room.

### Encryption

D1 dumps contain secrets (session material, webhook secrets, token hashes). If
`BACKUP_ENCRYPTION_SECRET` is set, every blob is encrypted with AES-GCM (PBKDF2-
derived key) before it lands in R2. **Set it in production.** Restore requires the
same secret; store it in the same secret manager as the other Stratum secrets and
do not rotate it without re-encrypting or retaining the old value.

Independently, lock the `BACKUPS` bucket down: no public access, least-privilege
tokens, and a bucket lifecycle policy that matches your retention expectations.

### The second key a restore depends on: `DEPLOY_SECRET_KEY`

`BACKUP_ENCRYPTION_SECRET` is not the only key a restore needs. The
`project_secrets` table is backed up as **ciphertext only** — the plaintext of a
deploy secret is never stored and no route can read one back — and those rows are
decryptable solely by the `DEPLOY_SECRET_KEY` that was in force when they were
written. That key is a Wrangler secret and is **not in any backup**.

Consequences to plan for *before* you need them:

- Restoring `project_secrets` into an instance with a different or missing
  `DEPLOY_SECRET_KEY` produces rows that look present on each project's settings
  page but fail every deploy with `Could not decrypt project secret…` (or, with
  no key at all, `DEPLOY_SECRET_KEY is not configured on this instance`).
- There is no re-encryption path. The only recovery is the original key, or
  having every project re-enter its secret values by hand.
- So: store `DEPLOY_SECRET_KEY` wherever you store `BACKUP_ENCRYPTION_SECRET`,
  retain the old value across a rotation, and treat a restore into a fresh
  instance as needing *both* keys carried over.

## Configuration

| Binding / var | Purpose | Default |
| --- | --- | --- |
| `BACKUPS` (R2 bucket) | Backup destination. If absent, runs skip cleanly. | — |
| `BACKUP_ENCRYPTION_SECRET` | Enables envelope encryption when set. | off |
| `BACKUP_RETENTION` | Whole healthy (or unknown-health) runs to keep; older runs are pruned. Unhealthy runs do not use slots and age out after this many complete runs; the newest healthy run is always kept. | 14 |
| `MAX_REPOS_PER_RUN` | Rotating repos snapshotted per run (pinned repos are extra). | 25 |
| `BACKUP_PINNED_PROJECTS` | Comma-separated `@namespace/slug` projects snapshotted in every run. See [pinned projects](#pinned-projects). | none |
| `MAX_BACKUP_BYTES` | Per-repo object budget; larger repos are skipped, not failed. | 128 MiB |

The daily run fires from its own `0 4 * * *` cron (production and default
configs) — deliberately separate from the `0 6 * * *` housekeeping so a slow
project sync can't starve the backup of its ~15-minute invocation budget.
Staging has no backup cron by design — validate there via the manual endpoint.

## Triggering and verifying a run

Manual trigger (admin only — `X-Admin-API-Key` or an admin session):

```bash
curl -X POST https://<host>/api/admin/backup -H "X-Admin-API-Key: $ADMIN_API_KEY"
```

A run already in flight returns `409`. Every manual run is recorded in `audit_log`
as `backup.run`.

List recent runs and their completeness:

```bash
curl https://<host>/api/admin/backup -H "X-Admin-API-Key: $ADMIN_API_KEY"
# => { "runs": [ { "runTs": "...", "complete": true }, ... ] }
```

Verify a run: confirm the newest run is `complete: true`, then spot-check the
bucket for the expected `d1/`, `kv/`, and `repos/` blobs under that prefix.

## Restore

Restore is not automated end to end — it is a deliberate operation. Restore into a
**fresh or staging instance first** and verify before pointing production at it.

### Verify a backup is restorable (dry run)

Before relying on a backup — and as a periodic rot check — confirm a run is
actually restorable **without writing anything**:

```
GET /api/admin/restore/<runTs>/plan            # admin only
```

It reads and **decrypts** every blob under `<runTs>/` and checks each leg against
the run manifest, returning a `plan`:

- `complete` — the `_manifest.json` is present (the run did not crash partway).
- `d1[]` — per table, `expectedRows` (from the manifest) vs `parsedRows` (from the
  dump); `ok` is false on a missing/undecodable dump or a **row-count mismatch**
  (silent truncation).
- `kv` — project/workspace counts, cross-checked against the manifest.
- `repos[]` — per repo, that the manifest parses (has a `tipSha`, or — for a
  tag-only snapshot — at least one tag) and the `.pack`
  is present and decodes.
- `restorable` — true only when the run is complete and every leg is `ok`.

A `restorable: false` (or a top-level decode error — usually a wrong
`BACKUP_ENCRYPTION_SECRET`) means do **not** rely on that run; use an earlier
complete run. This endpoint never mutates anything; the write/apply steps below
are the deliberate, separately-run operation.

**A repository has a route; D1 and KV do not yet.** See [Repos](#repos--the-leg-ci-cannot-prove)
for `POST /api/admin/restore/<runTs>/repos/<projectId>`. `restoreTable` and
`restoreKvIdentity` are library functions with no caller in the Worker, so running
either today means building a temporary entry point: a route behind the same admin
check (`requireAdmin` in `src/routes/restore.ts`) that loads the run from `BACKUPS`
and calls the function with the Worker's bindings. Deploy it to the environment
being restored, which takes deploy access to that environment and the admin
credential, then remove it when the restore is done.

### D1

For each `<runTs>/d1/<table>.ndjson`, use `restoreTable` (in `src/storage/d1-backup.ts`).
Restore tables in the file order `BACKUP_TABLES` lists — it is FK-dependency
ordered (parents before children). `restoreTable` verifies the NDJSON header's
table name matches and chunks inserts under D1's bind cap.

`project_secrets` restores like any other table, but its rows are only *usable*
if the target instance has the same `DEPLOY_SECRET_KEY` — see
[the second key a restore depends on](#the-second-key-a-restore-depends-on-deploy_secret_key).
If you cannot carry that key over, restore the table anyway (the names and
metadata are still the record of what each project needs) and tell project
admins to re-enter every value; a stale row is silently unusable, not visibly
missing.

### KV identity

Use `restoreKvIdentity` (in `src/storage/kv-backup.ts`) with `projects.json` then
`workspaces.json`. It reloads projects first, then workspaces keyed by their parent
project.

### Repos — the leg CI cannot prove

To restore one project's repo from a run, as an admin:

```
POST /api/admin/restore/<runTs>/repos/<projectId>     # X-Admin-API-Key, or an admin session
{}                  # recreate a repo that no longer exists
{ "force": true }   # overwrite the project's existing repo
{ "drill": true }   # restore to a scratch repo, verify it, delete it
```

The response's `restore.verification` reads every restored ref back from Artifacts
and compares it with the manifest. **Check `verification.ok` even on a `200`**:
`mismatches` names any ref that came back wrong, and `error` means the refs could not
be read at all. Also check `branchesTruncatedTotal`: when present, the backup held only
some of the repo's branches. A `504 PUSH_TIMEOUT` means the outcome is unknown, since
the push may still land: inspect the repo before retrying. Every attempt is audited as
`backup.repo_restore`, before the push and after it.

A run marked unhealthy can still be used, because one failed repo does not spoil the
others in its slice. The run must be complete and hold a pack for that project;
otherwise the answer is `404`. This restores the Git repository only: a project that
was deleted also needs its registry entry back from the KV leg. It holds the whole pack
in memory and pushes within one request, so a repository near `MAX_BACKUP_BYTES` is
untested and may hit Worker limits.

Cloudflare Artifacts exposes no low-level object-write or set-ref API, so a repo is
restored by **recreating it and pushing** a reconstructed history, not by writing
objects directly. `restoreProjectRepo` (in `src/backup/repo-restore.ts`):

1. Resolves the Artifacts repo name from the manifest's `ProjectEntry.remote`.
2. Refuses to overwrite an existing repo unless `force` is passed (guards against
   clobbering live data).
3. Reconstructs the repo in memory from the pack — `reconstructRepo` writes every
   object loose, points `main` at the manifest tip sha, and **asserts the resolved
   tip matches** before returning. Because the backup captured the full reachable
   object set, the reconstructed history is closed under reachability and preserves
   the original tip sha.
4. Pushes `main` to Artifacts.

**Tag-only snapshots (no `tipSha`).** A repo manifest's `tipSha` is optional: a
repository whose only refs are tags (an unborn `HEAD`) snapshots its tags and every
tag-reachable object, and its manifest omits `tipSha`. Restoring one writes and
pushes **only the tag refs** — no default branch is fabricated, so the restored
repo has an unborn default branch exactly as the source did, and the UI and sync
treat it like a repo with no commits until something is pushed to it. With
`force` over an existing repo, that repo's default branch is left as it was rather
than deleted. A manifest with neither a `tipSha` nor any tag is invalid: the
restore plan flags it and `reconstructRepo` refuses it. Manifests written before
this change always carry `tipSha` and restore unchanged.

In practice the backup does not produce these today: the snapshot clone targets
the default branch, so a remote with no default branch fails at the clone and
shows up as an error for that repo in the run summary, not as a skip. Every path
that creates repository content creates the default branch first.

`reconstructRepo` is fully covered by CI (`tests/repo-restore.test.ts`): a
snapshot round-trips to a repo whose tip sha, full commit chain, and tree all
match, and a truncated pack is rejected. **The Artifacts push in step 4 cannot run
in CI** — there is no local Artifacts emulator. Validate it on staging:

1. Snapshot a known staging repo (trigger a backup, confirm the pack exists).
2. Run `POST /api/admin/restore/<runTs>/repos/<projectId>` with `{ "drill": true }`.
3. Confirm `verification.ok` is `true`, `checked` covers the repo's refs, and
   `scratchDeleted` is `true`.

Do this after any change to `repo-restore.ts`, `git-ops.ts` push handling, or the
Artifacts client, and before relying on backups in production.

## Restore drill (quarterly)

A backup is only proven by restoring it. Run this drill **once a quarter**, and
also after any change listed in the previous section. Run it against
**staging only**. Never restore into production to test a backup.

**Before you start:** pin the drill repo on staging (`BACKUP_PINNED_PROJECTS` in
`[env.staging.vars]`) so every run has a pack to restore. Pick a repo with real
history: several commits, at least one branch besides the default, and at
least one tag.

1. **Take a backup.** Staging has no backup cron, so trigger a run:
   `POST /api/admin/backup`. In the response, confirm that `summary.healthy` is
   `true` and that the drill repo is listed in `summary.repos.pinned`, not in
   `failed` or `skipped`. Note the `runTs`.
2. **Check that the run is restorable.** Call `GET /api/admin/restore/<runTs>/plan`
   and confirm `restorable: true`.
3. **Run the drill.** It restores to a generated scratch repo and never touches the
   live one:
   ```bash
   curl -X POST "$STAGING/api/admin/restore/<runTs>/repos/<projectId>" \
     -H "X-Admin-API-Key: $ADMIN_KEY" -d '{"drill": true}'
   ```
4. **Read the result.** The drill passes when `verification.ok` is `true`, with
   `checked` covering the default branch, the other branches and the tags. The
   comparison is against the manifest, so commits made after `<runTs>` don't affect it.
   This proves the refs landed on the commits the backup recorded. It does not run
   `git fsck` on the result.
5. **Clean up if you have to.** The drill deletes its scratch repo. If `scratchDeleted`
   is `false`, delete the repo named by `repoName` yourself.
6. **Record it.** Add a row to the drill log below: the date, who ran it,
   the repo, the `runTs`, and the result. On a failure, link the issue
   you filed.

### Drill log

| Date | Operator | Repo | Run (`runTs`) | Result | Notes / issue |
| --- | --- | --- | --- | --- | --- |

## Failure modes

- **Missing `_manifest.json`** — run crashed; use the previous complete run.
- **`too large` / `empty` skips in the summary** — expected for over-cap or
  commit-less repos with no resolvable tags; not failures. Raise `MAX_BACKUP_BYTES` if a real repo is
  being skipped.
- **Decrypt failure on restore** — `BACKUP_ENCRYPTION_SECRET` differs from the one
  used at backup time. Restore requires the original secret.
- **Deploys fail with `Could not decrypt project secret…` after a restore** — the
  restored `project_secrets` rows were encrypted under a different
  `DEPLOY_SECRET_KEY`. Not a backup defect: that key is never backed up. Restore
  the original key, or have each project re-enter its secrets.
- **Promoted pull requests are opened by the app again after a restore** —
  expected. People's stored GitHub authorizations (`github_user_connections`)
  are not backed up, and a restored pair would not work anyway. Each person
  connects again under Settings → GitHub.
- **Repo restore `409`** — the project's repo still exists; pass `force` only when
  intentionally overwriting.
- **Repo restore `404`** — the run did not complete, or holds no pack for that
  project (a rotating run holds only its slice). Try another run.
