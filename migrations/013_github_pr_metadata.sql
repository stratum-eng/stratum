-- Add GitHub PR metadata columns for GitHub Bridge
-- Stores head SHA and comment ID for bidirectional sync

ALTER TABLE changes ADD COLUMN github_head_sha TEXT;
ALTER TABLE changes ADD COLUMN github_comment_id INTEGER;
