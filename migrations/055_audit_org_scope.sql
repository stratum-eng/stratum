-- Audit log hardening (#255): tenant scoping + database-enforced immutability.
--
-- `org_id` / `project_id` are nullable: account-level events (a user's own
-- token, their session) belong to no org, and every row written before this
-- migration stays NULL — there is no reliable way to back-fill them, since
-- projects live in KV and the old rows never recorded an id. Org-scoped reads
-- therefore see history from this migration forward only.

ALTER TABLE audit_log ADD COLUMN org_id TEXT;

ALTER TABLE audit_log ADD COLUMN project_id TEXT;

-- Serves the org read/export API: equality on org_id, then a keyset walk on
-- (created_at, id) descending, so a page never scans another tenant's rows.
CREATE INDEX IF NOT EXISTS idx_audit_org_created ON audit_log(org_id, created_at DESC, id DESC);

-- Serves the failed-auth dedupe guard (`recordAuditOncePerWindow`): equality
-- on (action, subject, org_id), then a range on created_at.
CREATE INDEX IF NOT EXISTS idx_audit_dedupe ON audit_log(action, subject, org_id, created_at DESC);

-- Append-only, enforced below the application. No code path deletes audit
-- rows; this makes a future one fail loudly instead of silently erasing
-- history.
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

-- The ONE permitted update is right-to-erasure anonymization
-- (`anonymizeUserContributions` in src/storage/deletion.ts): rewriting
-- actor_id to the 'deleted-user' sentinel while every other column stays
-- byte-identical. Anything else — editing an action, a detail, a timestamp,
-- re-scoping a row to another org, or "un-anonymizing" one — aborts.
--
-- Every comparison is null-safe (IS / IS NOT): with `=`, a NULL operand makes
-- the whole condition NULL, the WHEN is not true, and the trigger silently
-- does not fire — `SET actor_id = NULL` would erase attribution unchecked.
-- OLD.actor_id must be non-NULL so a system row (no actor) cannot be
-- "anonymized" into one that looks like it had a person behind it.
CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
WHEN NOT (
  NEW.actor_id IS 'deleted-user'
  AND OLD.actor_id IS NOT NULL
  AND OLD.actor_id IS NOT 'deleted-user'
  AND NEW.id IS OLD.id
  AND NEW.action IS OLD.action
  AND NEW.actor_type IS OLD.actor_type
  AND NEW.subject IS OLD.subject
  AND NEW.detail IS OLD.detail
  AND NEW.created_at IS OLD.created_at
  AND NEW.org_id IS OLD.org_id
  AND NEW.project_id IS OLD.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
