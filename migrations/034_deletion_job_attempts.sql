-- Re-drivable incomplete deletions: bound auto-retry with an attempt counter.
-- `incomplete` used to be a hard-terminal state (the sweep excluded it) so a
-- permanently-failing target could never loop forever. With a capped attempt
-- count the sweep can safely re-drive TRANSIENT failures, while genuinely stuck
-- jobs (attempts exhausted, or a terminal residual) stay `incomplete` for an
-- operator to re-drive explicitly via the admin route.
ALTER TABLE deletion_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
