-- Asynchronous evaluation (#412, ADR 009). Change creation and
-- POST /changes/:id/evaluate enqueue an evaluation run instead of running the
-- evaluator suite on the request path; the change sits in status 'evaluating'
-- until a queue consumer records the verdict.
--
-- `eval_run_id` names the run the change is currently waiting on. Every
-- enqueue writes a fresh one, and the consumer's result write is conditional
-- on it (`WHERE id = ? AND eval_run_id = ? AND status = 'evaluating'`), so a
-- run that was superseded — by a re-evaluation of a newer revision, or by the
-- sweep re-dispatching a stuck run — can never overwrite the newer verdict.
--
-- `eval_requested_at` is when that run was dispatched, so the 5-minute sweep
-- can find a run whose consumer crashed or whose message was lost.
-- `eval_requested_by` is the user who asked for it (absent for an agent or the
-- sweep), carried on the row so a re-dispatched run keeps attributing its
-- metered spend to the same actor. `eval_attempts` counts re-dispatches; past
-- the cap the sweep fails the change closed instead of retrying forever.
--
-- Additive only: every column is nullable or defaulted, so the migration is
-- safe on a database with every earlier migration applied, and existing rows
-- (none of which is 'evaluating') are untouched.
ALTER TABLE changes ADD COLUMN eval_run_id TEXT;
ALTER TABLE changes ADD COLUMN eval_requested_at TEXT;
ALTER TABLE changes ADD COLUMN eval_requested_by TEXT;
ALTER TABLE changes ADD COLUMN eval_attempts INTEGER NOT NULL DEFAULT 0;

-- The sweep's only query: changes still evaluating, oldest dispatch first.
CREATE INDEX IF NOT EXISTS idx_changes_evaluating
  ON changes (status, eval_requested_at);
