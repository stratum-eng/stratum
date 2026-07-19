-- Atomic dedup of active deletion jobs per target. The route-level
-- find-then-insert was a TOCTOU: two concurrent delete requests for the same
-- target could both pass the check and enqueue two active cascades. Add a
-- dedicated target_id column (the project/user id, extracted from the target
-- JSON) plus a PARTIAL UNIQUE INDEX so the database itself rejects a second
-- active job for the same (kind, target).
ALTER TABLE deletion_jobs ADD COLUMN target_id TEXT;

-- Backfill any existing rows (the table is new, but keep the migration correct
-- regardless): project targets carry projectId, account targets carry userId.
UPDATE deletion_jobs
   SET target_id = COALESCE(json_extract(target, '$.projectId'), json_extract(target, '$.userId'))
 WHERE target_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deletion_jobs_active_target
  ON deletion_jobs(kind, target_id)
  WHERE state IN ('pending', 'running', 'verifying');
