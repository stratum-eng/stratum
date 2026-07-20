# Runbook: D1 migration reconciliation (`--remote` cutover)

## Why this exists

CI applied D1 migrations **without `--remote`** (`ci.yml` staging + production
steps, and the manual `d1-migrate.yml`). `wrangler d1 migrations apply` without
`--remote` targets a throwaway **local** SQLite file in the runner, not the
Cloudflare-hosted database — so the remote `d1_migrations` tracking table on
staging and production never recorded anything CI "applied."

The fix (adding `--remote` to those steps) is in the same change as this runbook.
**Do not merge it until you have completed the reconciliation below**, because the
first `--remote` run will attempt every migration the remote tracking table
considers unapplied — and on this instance that is a large backlog.

## Observed state (2026-07-20)

`wrangler d1 migrations list DB --remote --env=production` reported **22 pending**
migrations — `012_import_metrics.sql` through `032_event_completed_handlers.sql`.
That means production's `d1_migrations` table records nothing past `011`.

Re-apply safety of that backlog (analyzed from the migration files):

- Every `CREATE TABLE` / `CREATE INDEX` uses `IF NOT EXISTS` → **re-running is a
  safe no-op** if the object already exists.
- Many migrations carry `ALTER TABLE ADD COLUMN` (013, 020, 024b, 025 ×7, 026,
  027, 028, 029, 030, 032). SQLite/D1 has **no `IF NOT EXISTS` for columns**, so
  re-adding an existing column errors with `duplicate column name`.

There is also a **duplicate migration number**: both `024_backup_state.sql` and
`024_change_workspace_head_sha.sql` exist. `wrangler` orders them lexically
(`backup_state` before `change_workspace_head_sha`), which is deterministic but
fragile; leave the filenames as-is (renaming an already-applied migration forces a
re-run) and track a rename for the *next* schema change, not here.

## Step 0 — determine which world you are in

Production (app.usestratum.dev) is live and the running code needs the current
schema, so the schema was almost certainly applied out-of-band and only the
*tracking table* is behind. Confirm before acting:

```sh
npx wrangler d1 execute DB --remote --env=production \
  --command "SELECT name FROM sqlite_master WHERE type='table' \
             AND name IN ('webhooks','issues','audit_log','deletion_jobs','backup_state');"
```

- **Rows returned (tables exist)** → schema is ahead of the tracker. Use
  **Procedure A (baseline)**. Do **not** run `migrations apply` — it would fail at
  the first `ALTER TABLE` (013) and leave the tracker half-populated.
- **Empty** → the database really is behind. Use **Procedure B (staged apply)**.

Run the same diagnostic against `--env=staging` and reconcile each environment
independently — they can be in different states.

## Procedure A — baseline (schema already current)

Record the already-present migrations as applied, without executing them. The
`d1_migrations` table is `(id INTEGER PK, name TEXT UNIQUE, applied_at …)`; insert
one row per migration name that is physically present.

1. **Verify** the schema matches the backlog's end state — spot-check the columns
   the `ALTER`s add (e.g. `PRAGMA table_info(changes);` should show
   `workspace_head_sha`, `base_sha`, `evaluated_tree_oid`, the `025` project_id
   columns, etc.). If anything is missing, you are partially applied — stop and
   treat the missing ones via Procedure B before baselining the rest.
2. **Baseline** (idempotent via `INSERT OR IGNORE` on the `UNIQUE(name)` index):

   ```sh
   npx wrangler d1 execute DB --remote --env=production --command "
     INSERT OR IGNORE INTO d1_migrations (name) VALUES
       ('012_import_metrics.sql'),('013_github_pr_metadata.sql'),
       ('014_sync_history.sql'),('015_changes_github_branch_index.sql'),
       ('016_events.sql'),('017_webhooks.sql'),('018_issues.sql'),
       ('019_change_reviews.sql'),('020_change_base_sha.sql'),
       ('021_cost_records.sql'),('022_audit_log.sql'),('023_commit_metrics.sql'),
       ('024_backup_state.sql'),('024_change_workspace_head_sha.sql'),
       ('025_project_id_backfill_columns.sql'),('026_deletion_jobs.sql'),
       ('027_deletion_jobs_target_id.sql'),('028_change_snapshot.sql'),
       ('029_provenance_model_prompt.sql'),('030_change_evaluated_tree.sql'),
       ('031_magic_links.sql'),('032_event_completed_handlers.sql');"
   ```
3. **Confirm** the tracker is now clean:

   ```sh
   npx wrangler d1 migrations list DB --remote --env=production   # → "No migrations to apply"
   ```

Repeat for staging (binding `DB`, `--env=staging`) against whatever subset staging
actually has.

## Procedure B — staged apply (database really is behind)

1. Apply on **staging** first and verify the app:

   ```sh
   npx wrangler d1 migrations apply DB --remote --env=staging
   ```
   Deploy staging, hit `/health`, and exercise a webhook/issue/change flow.
2. Only then apply on **production** (schedule a low-traffic window; take a backup
   first via `POST /api/admin/backup`):

   ```sh
   npx wrangler d1 migrations apply DB --remote --env=production
   ```

## Step final — land the CI change

Once **both** environments report "No migrations to apply," merge the CI
`--remote` change. From then on every deploy applies new migrations to the correct
remote database, and this backlog cannot recur. Going forward, a PR that adds a
migration will surface as one pending entry in `migrations list --remote` — keep
that list short.
