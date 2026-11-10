-- Migration 085: whether a change's GitHub pull request is still a draft.
--
-- Promotion opens the pull request as a draft by default. The change page
-- offers to mark it ready for review, and needs to know when to stop offering.
-- 1 = draft, 0 = ready, NULL = not known (promoted before this migration, or
-- no pull request).
ALTER TABLE changes ADD COLUMN github_pr_draft INTEGER;
