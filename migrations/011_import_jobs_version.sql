-- version column was included directly in 010_import_jobs.sql's CREATE TABLE,
-- so the ALTER TABLE is skipped here to avoid "duplicate column name" on existing DBs.

-- Create index for efficient version-based lookups during updates
CREATE INDEX IF NOT EXISTS idx_import_jobs_version ON import_jobs(id, version);
