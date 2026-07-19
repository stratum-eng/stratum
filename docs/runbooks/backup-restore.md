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
| `<runTs>/d1/<table>.ndjson` | One NDJSON dump per D1 table (header line carries table + columns). |
| `<runTs>/kv/projects.json` | All project identity records from KV. |
| `<runTs>/kv/workspaces.json` | All workspace identity records from KV. |
| `<runTs>/repos/<projectId>.pack` | Git pack of the **full reachable object set** for the repo. |
| `<runTs>/repos/<projectId>.manifest.json` | Tip sha, object/byte counts, and the full `ProjectEntry`. |
| `<runTs>/_manifest.json` | Run summary. **Written last** — its presence marks the run complete. |

A run whose `_manifest.json` is missing crashed partway; treat it as unusable and
restore from the previous complete run.

### Repo coverage and the cursor

An instance with more repos than `MAX_REPOS_PER_RUN` (default 25) snapshots the
oldest-backed-up repos first, tracked in the D1 `backup_state` table. Every repo
is therefore covered within `ceil(totalRepos / MAX_REPOS_PER_RUN)` daily runs, not
starved. Raise `MAX_REPOS_PER_RUN` to shorten that window.

### Encryption

D1 dumps contain secrets (session material, webhook secrets, token hashes). If
`BACKUP_ENCRYPTION_SECRET` is set, every blob is encrypted with AES-GCM (PBKDF2-
derived key) before it lands in R2. **Set it in production.** Restore requires the
same secret; store it in the same secret manager as the other Stratum secrets and
do not rotate it without re-encrypting or retaining the old value.

Independently, lock the `BACKUPS` bucket down: no public access, least-privilege
tokens, and a bucket lifecycle policy that matches your retention expectations.

## Configuration

| Binding / var | Purpose | Default |
| --- | --- | --- |
| `BACKUPS` (R2 bucket) | Backup destination. If absent, runs skip cleanly. | — |
| `BACKUP_ENCRYPTION_SECRET` | Enables envelope encryption when set. | off |
| `BACKUP_RETENTION` | Whole runs to keep; older runs are pruned. | 14 |
| `MAX_REPOS_PER_RUN` | Repos snapshotted per run. | 25 |
| `MAX_BACKUP_BYTES` | Per-repo object budget; larger repos are skipped, not failed. | 128 MiB |

The daily run fires from the `0 6 * * *` cron (production and default configs).
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

### D1

For each `<runTs>/d1/<table>.ndjson`, use `restoreTable` (in `src/storage/d1-backup.ts`).
Restore tables in the file order `BACKUP_TABLES` lists — it is FK-dependency
ordered (parents before children). `restoreTable` verifies the NDJSON header's
table name matches and chunks inserts under D1's bind cap.

### KV identity

Use `restoreKvIdentity` (in `src/storage/kv-backup.ts`) with `projects.json` then
`workspaces.json`. It reloads projects first, then workspaces keyed by their parent
project.

### Repos — the leg CI cannot prove

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

`reconstructRepo` is fully covered by CI (`tests/repo-restore.test.ts`): a
snapshot round-trips to a repo whose tip sha, full commit chain, and tree all
match, and a truncated pack is rejected. **The Artifacts push in step 4 cannot run
in CI** — there is no local Artifacts emulator. Validate it on staging:

1. Snapshot a known staging repo (trigger a backup, confirm the pack exists).
2. Delete or rename the staging repo.
3. Run `restoreProjectRepo` against the snapshot.
4. Clone the restored repo and confirm `HEAD` equals the manifest tip sha and the
   working tree matches the original.

Do this after any change to `repo-restore.ts`, `git-ops.ts` push handling, or the
Artifacts client, and before relying on backups in production.

## Failure modes

- **Missing `_manifest.json`** — run crashed; use the previous complete run.
- **`too large` / `empty` skips in the summary** — expected for over-cap or
  commit-less repos; not failures. Raise `MAX_BACKUP_BYTES` if a real repo is
  being skipped.
- **Decrypt failure on restore** — `BACKUP_ENCRYPTION_SECRET` differs from the one
  used at backup time. Restore requires the original secret.
- **Repo restore `409`** — the target repo still exists; restore into a fresh
  instance, or pass `force` only when intentionally overwriting.
