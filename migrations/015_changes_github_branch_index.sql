-- Index for looking up Changes by GitHub branch
-- github_branch column already exists in the base schema (001_core.sql)
-- This migration only adds the performance index needed for webhook lookups.
CREATE INDEX IF NOT EXISTS idx_changes_github_branch
  ON changes(project, github_branch);
