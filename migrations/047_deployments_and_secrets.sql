-- Migration 047: Post-merge deployments and the per-project secret store.
--
-- Timestamps are ISO 8601 strings written by the application, NOT
-- `datetime('now')`, for the reason spelled out in 042: the two formats sort
-- differently as TEXT (' ' 0x20 < 'T' 0x54), so a column mixing them silently
-- breaks every range comparison. `lease_expires_at` in particular is compared
-- against `now` to decide whether a running deployment is reclaimable — a
-- mixed-format value there would either strand a deployment forever or let the
-- consumer reclaim a live one and deploy the same commit twice.

-- Encrypted provider credentials (Vercel / Cloudflare API tokens).
--
-- `ciphertext` is AES-GCM with `(project_id, name)` bound as additional
-- authenticated data, so a row copied into another project or renamed fails to
-- decrypt rather than silently authorising against the wrong account. There is
-- deliberately no plaintext column and no read path: values leave D1 only
-- through the deploy consumer.
--
-- Scoped on `project_id` alone — never on the bare project name. Names are not
-- globally unique, and resolving a credential by name would cross tenants.
CREATE TABLE IF NOT EXISTS project_secrets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_by TEXT NOT NULL,
  -- Kept alongside created_by so a listing can name who last rotated a
  -- credential; a listing is the only view anyone ever gets of a secret.
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Also the lookup index for resolving a deployment's declared secret names.
CREATE UNIQUE INDEX IF NOT EXISTS ux_project_secrets_name
  ON project_secrets(project_id, name);

-- One row per deployment attempt. The row is the lease: the unique index below
-- is what makes a deploy run once, so the consumer inserts and lets a
-- constraint violation mean "someone else has it" — there is no check-then-act
-- window to lose.
CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  -- The bare project name, mirroring `changes`/`events`: the project deletion
  -- cascade (src/storage/deletion.ts) matches project-scoped rows on either
  -- form, and a row reachable by only one of them survives a deletion.
  project TEXT NOT NULL,
  -- NULL for a deploy not traceable to a change (a retry of an older commit).
  -- It is deliberately NOT part of the unique key: SQLite unique indexes do not
  -- constrain NULLs, so a nullable column there would stop excluding anything.
  change_id TEXT,
  commit_sha TEXT NOT NULL,
  name TEXT NOT NULL,
  target TEXT NOT NULL,
  -- A manual retry inserts attempt + 1 for the same commit. NOT NULL with a
  -- DEFAULT so it can carry the unique index (see above).
  attempt INTEGER NOT NULL DEFAULT 1,
  -- CHECK'd because a status outside this set is unreachable by the state
  -- machine and would render as an unknown state in the UI forever. 'skipped'
  -- means exactly one thing: no deploy was configured. Every other non-success
  -- is 'failed' with a reason — reporting a missing credential as a calm grey
  -- state is failing open on something that stops production updating.
  status TEXT NOT NULL CHECK (status IN
    ('pending_approval','queued','running','succeeded','failed','superseded','skipped')),
  reason TEXT,
  url TEXT,
  -- The provider's error payload, redacted against this deployment's secret
  -- values and truncated to MAX_LOG_TAIL (src/deploy/limits.ts). Served only to
  -- project writers: a provider error can echo request context, and
  -- canReadProject returns true unconditionally for public projects.
  log_tail TEXT,
  duration_ms INTEGER,
  -- A 'running' row past its lease is reclaimable by the deploy consumer, and
  -- by nothing else — read-time reclamation would let a page view flip a live
  -- deployment to 'failed', after which a retry deploys the same commit twice.
  lease_expires_at TEXT,
  requested_by_type TEXT NOT NULL,
  requested_by_id TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

-- The mutual exclusion for a deployment, not merely a data-integrity rule:
-- two consumers racing the same merge both INSERT, and exactly one wins.
CREATE UNIQUE INDEX IF NOT EXISTS ux_deployments_attempt
  ON deployments(project_id, name, commit_sha, attempt);

-- Covers the history listing's `WHERE project_id = ? ORDER BY created_at DESC`.
CREATE INDEX IF NOT EXISTS idx_deployments_project
  ON deployments(project_id, created_at DESC);
