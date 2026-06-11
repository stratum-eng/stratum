-- Discussion and human review verdicts on Changes.
-- A reviewer has at most one current review per change (re-reviewing
-- replaces the previous verdict); comments are append-only discussion.

CREATE TABLE IF NOT EXISTS change_comments (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK(author_type IN ('user','agent')),
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_change
  ON change_comments(change_id, created_at ASC);

CREATE TABLE IF NOT EXISTS change_reviews (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('approve','request_changes')),
  comment TEXT,
  created_at DATETIME NOT NULL,
  UNIQUE(change_id, reviewer_id)
);

CREATE INDEX IF NOT EXISTS idx_reviews_change
  ON change_reviews(change_id);
