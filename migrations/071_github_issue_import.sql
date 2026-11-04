-- Migration 064: import GitHub issues into a project's tracker (#421).
--
-- github_issue_imports is the run log: one row per import the API queued. The
-- queue job advances it page by page, so it is also how the settings page and
-- the status endpoint tell "queued", "running", "completed" and "failed" apart.
-- At most one run per project may be active at a time; the partial unique index
-- enforces that in the database rather than trusting a read-then-insert in the
-- route, which two concurrent clicks could both pass.
--
-- github_issue_map records which Stratum issue a GitHub issue became. It is the
-- idempotency key — a re-run finds the row and updates the issue instead of
-- creating a duplicate — and the table `#123` references are rewritten from.
-- Keyed by the source repository too, so a project whose upstream changes never
-- confuses one repo's #5 with another's.
--
-- github_issue_comment_map does the same for comments, keyed by the Stratum
-- issue id because issue_comments itself has no project column.
--
-- external_author / external_url on issues and issue_comments carry the GitHub
-- login (when no Stratum account is linked to that GitHub user) and the link
-- back to the original. Both are NULL for anything not imported.
--
-- Every statement is additive, so this is safe on a database that already has
-- every earlier migration applied.

CREATE TABLE IF NOT EXISTS github_issue_imports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  github_repo TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
  initiated_by TEXT NOT NULL,
  next_page INTEGER NOT NULL DEFAULT 1,
  issues_created INTEGER NOT NULL DEFAULT 0,
  issues_updated INTEGER NOT NULL DEFAULT 0,
  comments_imported INTEGER NOT NULL DEFAULT 0,
  pulls_skipped INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  completed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_github_issue_imports_project
  ON github_issue_imports(project_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_github_issue_imports_one_active
  ON github_issue_imports(project_id) WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS github_issue_map (
  project_id TEXT NOT NULL,
  github_repo TEXT NOT NULL,
  github_number INTEGER NOT NULL,
  issue_id TEXT NOT NULL,
  stratum_number INTEGER NOT NULL,
  github_url TEXT NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (project_id, github_repo, github_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_github_issue_map_issue
  ON github_issue_map(issue_id);

CREATE TABLE IF NOT EXISTS github_issue_comment_map (
  issue_id TEXT NOT NULL,
  github_comment_id INTEGER NOT NULL,
  comment_id TEXT NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (issue_id, github_comment_id)
);

ALTER TABLE issues ADD COLUMN external_author TEXT;
ALTER TABLE issues ADD COLUMN external_url TEXT;
ALTER TABLE issue_comments ADD COLUMN external_author TEXT;
ALTER TABLE issue_comments ADD COLUMN external_url TEXT;
