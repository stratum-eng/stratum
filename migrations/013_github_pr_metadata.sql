-- Add GitHub PR metadata columns for GitHub Bridge
-- Stores head SHA and comment ID for bidirectional sync

-- Add github_head_sha column if it doesn't exist
ALTER TABLE changes ADD COLUMN github_head_sha TEXT;

-- Add github_comment_id column if it doesn't exist  
ALTER TABLE changes ADD COLUMN github_comment_id INTEGER;
