-- Issue numbers become per-project (by canonical project_id) instead of per-NAME.
--
-- Before: numbering was `MAX(number)+1 WHERE project = <name>` and the uniqueness
-- guard was UNIQUE(project, number). Two projects sharing a name in different
-- namespaces (@alice/api, @bob/api) therefore shared one number sequence, and
-- switching to per-project numbering would make them collide on (name, number)
-- and raise a spurious 500 on insert.
--
-- Swap the guard from (project, number) to (project_id, number). This is safe on
-- existing data:
--   * Post-025 rows carry distinct project_ids, and numbers were unique per name,
--     so (project_id, number) has no duplicates to reject on index creation.
--   * Legacy rows keep project_id = NULL; NULLs are DISTINCT in a SQLite unique
--     index, so they never collide with each other or with new rows.
-- createIssue (this migration ships with the code change) counts legacy NULL rows
-- via a name fallback, so numbering does not restart at 1 for a project that has
-- pre-migration issues.
DROP INDEX IF EXISTS idx_issues_project_number;
CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_project_id_number ON issues(project_id, number);
