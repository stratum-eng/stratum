-- Provenance integrity: capture the model and prompt hash used for a merged
-- change, so the audit record matches the product claim ("which model, a hash of
-- the prompt"). Values are snapshotted onto the change at creation (migration
-- 024) and copied here at merge, so they reflect the model that did the work
-- rather than the agent's current registration. Full per-evaluator evidence
-- remains linked by change_id -> eval_runs.
ALTER TABLE provenance ADD COLUMN model TEXT;
ALTER TABLE provenance ADD COLUMN prompt_hash TEXT;
