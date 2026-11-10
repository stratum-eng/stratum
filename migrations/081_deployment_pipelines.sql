-- Migration 079: deploy pipelines, recorded versions and rollback (#416).
--
-- Additive and nullable: every existing row is untouched, and a project that
-- only uses the static `deploys:` targets never writes `rollback_of`.
--
-- `version` is what a deployment put live, as the thing that can be asked for
-- again. For a pipeline it is whatever its steps wrote to
-- `$STRATUM_DEPLOY_VERSION_FILE` (a Cloudflare Worker version id, for a
-- Worker); for a static target it is the commit. It is a label that Stratum
-- stores and hands back to a rollback, never a credential.
--
-- A rollback redeploys an earlier version. It does NOT undo a database
-- migration: migrations are forward-only, and nothing in this table or the
-- code that reads it claims otherwise.
ALTER TABLE deployments ADD COLUMN version TEXT;

-- The deployment a rollback row puts back. NULL for every ordinary deploy.
-- Not a foreign key: a row outlives nothing here (deployment history has no
-- retention), and the project-deletion cascade removes both together.
ALTER TABLE deployments ADD COLUMN rollback_of TEXT;

-- "Is another deployment of this environment running?" — asked inside the
-- claim that serializes a pipeline per environment, and by the sweep that
-- fails a pipeline deployment whose executor never reported. Partial, so it
-- holds only the handful of rows in flight.
CREATE INDEX IF NOT EXISTS idx_deployments_in_flight
  ON deployments (project_id, name, status)
  WHERE status IN ('queued', 'running');
