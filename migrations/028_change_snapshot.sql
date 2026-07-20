-- SEC-2 + provenance integrity: snapshot on the change what the merge gate and
-- the provenance record need, captured at the point the work was evaluated.
--
--   evaluated_sha     the workspace tip the evaluation actually ran against, so
--                     a merge can reject a workspace that moved since eval.
--   agent_model       the agent's model as of change creation (not read live at
--                     merge, where the agent record may have drifted).
--   agent_prompt_hash the agent's prompt hash as of change creation.
--
-- All nullable and additive; historical rows keep NULLs (honest — the data was
-- never captured for them).
ALTER TABLE changes ADD COLUMN evaluated_sha TEXT;
ALTER TABLE changes ADD COLUMN agent_model TEXT;
ALTER TABLE changes ADD COLUMN agent_prompt_hash TEXT;
