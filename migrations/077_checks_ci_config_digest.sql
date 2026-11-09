-- First-party CI (#415, ADR 012): mark the check runs the CI executor owns.
--
-- A check run dispatched to the instance's CI executor (the steps of the base
-- branch's `.stratum/ci.yaml`) differs from one dispatched to a project's own
-- runner in two ways the merge gate and the callback need to know about:
--
--   * its callback is verified against the instance's executor secret, not a
--     project secret, so a project's runner key can never report it; and
--   * the gate must be able to tell that the steps it was run with are the
--     steps the base declares NOW. A step list that changed on the base after
--     the dispatch — a step added, a command edited, a step made optional —
--     is a different gate, and the old result must not satisfy it.
--
-- `ci_config_digest` carries both. NULL means "a project runner's check", the
-- only kind that existed before this migration. A non-NULL value is the
-- SHA-256 of the validated CI configuration the run was dispatched under.
--
-- Additive and nullable: existing rows are untouched and stay project checks.
ALTER TABLE checks ADD COLUMN ci_config_digest TEXT;

-- "Has this project ever run first-party CI?" — asked by the merge gate only
-- when the base branch cannot be read at all, to tell a project with no CI
-- from one whose ci.yaml is temporarily out of reach. Partial, so it costs
-- nothing for the rows of projects' own runners.
CREATE INDEX IF NOT EXISTS idx_checks_ci_project
  ON checks (project_id)
  WHERE ci_config_digest IS NOT NULL;
