-- Check runs (#414, ADR 011): asynchronous, per-job CI results reported back to
-- a change by an external runner.
--
-- A row is one attempt at one named check on one revision of one change. Rows
-- are created ONLY by Stratum, when it dispatches the checks a project's base
-- policy declares; the runner's signed callback (`POST /api/checks/:id`) can
-- move a row's status and nothing else. `change_id`, `revision` and `name` are
-- therefore never runner-supplied, which is what stops a runner inventing a
-- check that satisfies a required name, or reporting one revision's result
-- against another.
--
-- `id` is the callback address: 128 random bits, so it cannot be enumerated.
-- `revision` is the evaluated head sha the check was dispatched for; the merge
-- gate reads only rows whose revision equals the change's current
-- `evaluated_sha`, so a new revision starts with no checks at all.
-- `attempt` orders re-runs of the same (change, revision, name); the gate and
-- the callback both honour only the highest.
-- `secret_ref` is the NAME of the project secret the callback's signature is
-- verified against, resolved at callback time from `project_secrets` under
-- `project_id`. No key material is stored here.
-- `last_sequence` is the highest runner-supplied sequence number applied so
-- far: a callback at or below it is a redelivery and changes nothing.
-- `deadline_at` is when a check that has not reached a terminal state is
-- flipped to `errored`, by the five-minute sweep and, lazily, by the gate and
-- the callback.
--
-- Additive only: a new table and its indexes. No foreign keys, like
-- `eval_runs`' siblings; the project deletion cascade removes rows by
-- `change_id`.
CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  base_sha TEXT,
  name TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed', 'errored')),
  details_url TEXT,
  summary TEXT,
  secret_ref TEXT NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  deadline_at TEXT NOT NULL
);

-- One row per attempt. Also what makes two concurrent dispatches for the same
-- revision unable to both claim the same attempt number.
CREATE UNIQUE INDEX IF NOT EXISTS idx_checks_identity
  ON checks (change_id, revision, name, attempt);

-- The deadline sweep's only query: non-terminal checks, earliest deadline first.
CREATE INDEX IF NOT EXISTS idx_checks_deadline
  ON checks (status, deadline_at);
