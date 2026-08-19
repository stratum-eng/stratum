-- Issue tracker basics (#198): comments, labels, and a single assignee.
--
-- issue_comments mirrors change_comments (019): append-only discussion rows
-- keyed by the issue's globally-unique id (not the per-project number, which is
-- only unique within a project).
--
-- issue_labels is a per-issue label-string table rather than a labels catalog +
-- join table: labels here are free-form strings and the only operations are
-- set/remove/list/filter, which the (issue_id, label) pair covers directly.
-- A catalog (colors, descriptions) can layer on later without rewriting rows.
--
-- assignee is a single nullable user id on the issue row — one assignee per
-- issue by design; multi-assignee is out of scope for #198.

CREATE TABLE IF NOT EXISTS issue_comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK(author_type IN ('user','agent')),
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issue_comments_issue
  ON issue_comments(issue_id, created_at ASC);

CREATE TABLE IF NOT EXISTS issue_labels (
  issue_id TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (issue_id, label)
);

CREATE INDEX IF NOT EXISTS idx_issue_labels_label
  ON issue_labels(label);

ALTER TABLE issues ADD COLUMN assignee TEXT;

CREATE INDEX IF NOT EXISTS idx_issues_assignee
  ON issues(assignee);
