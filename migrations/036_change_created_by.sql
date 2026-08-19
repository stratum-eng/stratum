-- SA-2: record the human author of a change so their own approval can be
-- excluded from the required-approval count. Without this, a lone writer could
-- open a change, approve it themselves, and satisfy `merge.requiredApprovals`.
-- Nullable/additive: legacy changes keep NULL (no author recorded); changes
-- created by an agent record the agent's owning user id. The merge gate passes
-- this value to countApprovals(excludeUserId).
ALTER TABLE changes ADD COLUMN created_by_user_id TEXT;
