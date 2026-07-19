-- The exact workspace commit sha that a change was evaluated against. The merge
-- gate must merge *this* commit, not the workspace branch's current tip — pinning
-- it closes a TOCTOU where a re-push between evaluation and merge could land
-- unevaluated content on the project's default branch (ADR 005 / #115).
ALTER TABLE changes ADD COLUMN workspace_head_sha TEXT;
