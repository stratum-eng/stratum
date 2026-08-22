-- Line-anchored review comments, threads, and comment-only reviews (#192).
--
-- change_comments grows nullable anchor/thread columns: a comment with
-- file+line is pinned to a diff line ('side' says which half of the diff),
-- parent_comment_id threads replies under a thread-root comment, and resolved
-- marks a thread root as addressed. All columns are nullable (or defaulted) so
-- existing change-level comments remain valid with every anchor NULL.

ALTER TABLE change_comments ADD COLUMN file TEXT;
ALTER TABLE change_comments ADD COLUMN line INTEGER;
ALTER TABLE change_comments ADD COLUMN side TEXT CHECK(side IN ('old','new'));
ALTER TABLE change_comments ADD COLUMN commit_sha TEXT;
ALTER TABLE change_comments ADD COLUMN parent_comment_id TEXT REFERENCES change_comments(id);
ALTER TABLE change_comments ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_comments_parent
  ON change_comments(parent_comment_id);

-- Widen the verdict CHECK to allow 'comment' (a review that records
-- participation without approving or blocking). SQLite cannot alter a CHECK
-- constraint, so rebuild change_reviews in place. No other table references
-- change_reviews, and the UNIQUE(change_id, reviewer_id) upsert key survives.
CREATE TABLE change_reviews_new (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('approve','request_changes','comment')),
  comment TEXT,
  created_at DATETIME NOT NULL,
  UNIQUE(change_id, reviewer_id)
);

INSERT INTO change_reviews_new (id, change_id, reviewer_id, verdict, comment, created_at)
  SELECT id, change_id, reviewer_id, verdict, comment, created_at FROM change_reviews;

DROP TABLE change_reviews;
ALTER TABLE change_reviews_new RENAME TO change_reviews;

CREATE INDEX IF NOT EXISTS idx_reviews_change
  ON change_reviews(change_id);
