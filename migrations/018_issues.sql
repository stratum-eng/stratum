-- Lightweight issue tracker. Issues are scoped by project name (the same key
-- the changes and events tables use) and numbered per project. An issue
-- optionally links to a Change; when that Change merges, the issue closes
-- automatically via the event pipeline.

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  author_type TEXT NOT NULL CHECK(author_type IN ('user','agent')),
  author_id TEXT NOT NULL,
  linked_change_id TEXT,
  closed_at DATETIME,
  closed_by TEXT,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_project_number
  ON issues(project, number);

CREATE INDEX IF NOT EXISTS idx_issues_project_status
  ON issues(project, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_issues_linked_change
  ON issues(linked_change_id);
