-- Migration 046: Namespace claims.
--
-- One row per project ever created under a personal namespace, written to D1
-- before the project's KV entry. Project records live in KV, whose listings
-- are only eventually consistent, so a username change cannot learn from KV
-- alone whether a project exists yet. D1 is strongly consistent: the rename
-- refuses inside its own UPDATE when a claim exists, and creation writes its
-- claim before the KV entry, so neither operation can miss the other.
--
-- A row is released when its project is withdrawn during creation, best
-- effort. Past a grace window (CLAIM_GRACE_MS in src/storage/project-namespace.ts)
-- the rename check compares each row against KV and drops one with no project
-- behind it, so a failed release or a later project deletion cannot hold a
-- username forever. Rows are never the only record of a project.
--
-- Timestamps are ISO 8601 strings written by the application, as in 042/044.
CREATE TABLE IF NOT EXISTS namespace_claims (
  namespace TEXT NOT NULL,
  slug TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (namespace, slug)
);

CREATE INDEX IF NOT EXISTS idx_namespace_claims_owner ON namespace_claims(owner_id);
