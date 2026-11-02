-- Widen import_jobs.status CHECK to admit every value ImportStatus can produce (#304).
--
-- 010's CHECK listed only queued/cloning/processing/completed/failed/cancelled/
-- cancelling, but `ImportStatus` (src/types.ts) and VALID_STATUSES
-- (src/storage/imports.ts) also carry 'syncing' and 'checking', and the queue
-- consumer actively writes 'syncing' when an import enters its sync phase.
-- That write failed with CHECK constraint violation (SQLite error 19) on every
-- sync, and its Result was discarded, so the row silently kept its previous
-- status -- usually 'queued', because createImportJob always inserts 'queued'.
-- A job the consumer had picked up and was actively syncing therefore still
-- read as 'queued' in D1, which is a direct contributor to imports appearing
-- wedged forever.
--
-- SQLite cannot ALTER a CHECK constraint, so this is the standard table
-- rebuild. `defer_foreign_keys` is the D1-supported way to suspend FK
-- enforcement for the duration of the transaction (D1 does not support
-- `PRAGMA foreign_keys = off`); failed_imports carries a
-- `REFERENCES import_jobs(id) ON DELETE SET NULL` that would otherwise block
-- the drop.
PRAGMA defer_foreign_keys = true;

-- defer_foreign_keys postpones constraint *violation* checks to commit time,
-- but it does not suppress ON DELETE actions: DROP TABLE import_jobs still
-- fires SET NULL across failed_imports.import_id and silently severs every
-- failure record from the job it describes. Snapshot the linkage here and
-- restore it after the rename.
CREATE TABLE import_jobs_fk_backup AS
  SELECT id AS failed_import_id, import_id FROM failed_imports WHERE import_id IS NOT NULL;

CREATE TABLE import_jobs_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'cloning', 'processing', 'completed', 'failed', 'cancelled', 'cancelling', 'syncing', 'checking')),
  source_url TEXT NOT NULL,
  branch TEXT NOT NULL,
  progress_processed_files INTEGER DEFAULT 0,
  progress_total_files INTEGER,
  progress_current_file TEXT,
  progress_bytes_transferred INTEGER,
  progress_total_bytes INTEGER,
  logs TEXT NOT NULL DEFAULT '[]',
  errors TEXT NOT NULL DEFAULT '[]',
  -- Timestamps are ISO-8601 UTC strings, not SQLite's 'YYYY-MM-DD HH:MM:SS'.
  -- The storage layer writes `new Date().toISOString()` for all three; the
  -- DEFAULT stays only for a row written outside it, and the SELECT below
  -- normalises any legacy value. Mixing the two formats in one column silently
  -- breaks range queries, because these are compared as TEXT and 'T' (0x54)
  -- sorts after ' ' (0x20).
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1,
  depth INTEGER
);

-- Columns are named explicitly: the rebuilt table must not depend on the
-- physical column order of the original, which 040 appended `depth` to.
INSERT INTO import_jobs_new (
  id, project_id, namespace, slug, status, source_url, branch,
  progress_processed_files, progress_total_files, progress_current_file,
  progress_bytes_transferred, progress_total_bytes, logs, errors,
  started_at, completed_at, updated_at, version, depth
)
SELECT
  id, project_id, namespace, slug, status, source_url, branch,
  progress_processed_files, progress_total_files, progress_current_file,
  progress_bytes_transferred, progress_total_bytes, logs, errors,
  -- strftime parses both formats and always emits ISO, so a row that took the
  -- CURRENT_TIMESTAMP default becomes comparable with the ones the storage
  -- layer wrote. A NULL completed_at stays NULL.
  strftime('%Y-%m-%dT%H:%M:%fZ', started_at),
  strftime('%Y-%m-%dT%H:%M:%fZ', completed_at),
  strftime('%Y-%m-%dT%H:%M:%fZ', updated_at),
  -- version is NOT NULL in the rebuilt table: a NULL could never satisfy the
  -- optimistic-locking `WHERE id = ? AND version = ?`, leaving the row
  -- permanently unwritable by the stall sweep.
  COALESCE(version, 1),
  depth
FROM import_jobs;

DROP TABLE import_jobs;

ALTER TABLE import_jobs_new RENAME TO import_jobs;

UPDATE failed_imports
SET import_id = (
  SELECT b.import_id FROM import_jobs_fk_backup b WHERE b.failed_import_id = failed_imports.id
)
WHERE id IN (SELECT failed_import_id FROM import_jobs_fk_backup);

DROP TABLE import_jobs_fk_backup;

-- Recreate every index from 010, 011 and 040. The partial "active imports"
-- index gains 'syncing' so the status it was always meant to cover is finally
-- indexable; 'checking' is deliberately omitted -- it is declared in the type
-- union but never written anywhere, so indexing it would cost writes for rows
-- that cannot exist.
CREATE INDEX IF NOT EXISTS idx_import_jobs_ns_slug ON import_jobs(namespace, slug);

CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status)
  WHERE status IN ('queued', 'cloning', 'processing', 'cancelling', 'syncing');

CREATE INDEX IF NOT EXISTS idx_import_jobs_completed_at ON import_jobs(completed_at)
  WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_import_jobs_project_id ON import_jobs(project_id);

CREATE INDEX IF NOT EXISTS idx_import_jobs_version ON import_jobs(id, version);

-- Covers the scheduled import sweep's predicate
-- (status IN (...) AND updated_at < ? ORDER BY updated_at ASC). The partial
-- index above cannot serve it: it omits updated_at, so the sweep would scan
-- every non-terminal row on every 5-minute tick.
CREATE INDEX IF NOT EXISTS idx_import_jobs_status_updated_at ON import_jobs(status, updated_at);
