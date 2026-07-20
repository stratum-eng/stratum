-- Prevent duplicate provenance rows for a single merge commit. A concurrent
-- double-merge of the same change (the merge path is not wrapped in a CAS on
-- every backend) could reach recordProvenance twice and write two rows for one
-- commit, corrupting the audit trail.
--
-- Scope is (change_id, commit_sha), NOT change_id alone: a legitimate re-merge of
-- a change after a revert produces a DIFFERENT commit sha and must still record.

-- First remove any existing duplicates (from before this constraint), keeping the
-- earliest row per (change_id, commit_sha).
DELETE FROM provenance
 WHERE rowid NOT IN (
   SELECT MIN(rowid) FROM provenance GROUP BY change_id, commit_sha
 );

CREATE UNIQUE INDEX IF NOT EXISTS idx_provenance_change_commit
  ON provenance(change_id, commit_sha);
