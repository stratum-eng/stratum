-- Right-to-erasure for audit_log subject and detail (#425).
--
-- Migration 055 made the log append-only with one exception: rewriting
-- actor_id to the 'deleted-user' sentinel. Rows can also name a person in
-- `subject` (e.g. SCIM entries written before this release recorded the user
-- id there) and inside the `detail` JSON (e.g. `{ "userId": ... }`), and the
-- 055 trigger blocked any clean-up of those. This replaces it with a trigger
-- that permits exactly three single-column erasures and nothing else:
--
--   A. actor_id    -> 'deleted-user'  (unchanged from 055)
--   B. subject     -> 'deleted-user', when the old subject is the id or email
--                     of an account that is being erased
--   C. detail      -> the old detail with every JSON string token equal to the
--                     id or email of an account being erased replaced by
--                     "deleted-user" — and nothing else changed
--
-- "Being erased" means a users row with deleting_at set (migration 026). The
-- deletion cascade (`eraseUserFromAuditLog` in src/storage/deletion.ts) runs
-- before the users row is deleted, so the row is there to check against; an
-- account that is merely live cannot have its trail rewritten, and neither
-- can any value that isn't one of that account's own identifiers.
--
-- Why a token replace and not json_set on named keys: the same identifier can
-- sit under any key or inside an array (`reenabledUserIds`), and the rewrite
-- has to be checkable in the trigger. `replace(detail, json_quote(v), ...)`
-- on JSON text replaces only whole string tokens equal to v: a quote inside a
-- JSON string is always escaped as \", so `"v"` cannot match a fragment of a
-- longer string. Ids and emails never contain a backslash or a quote.
--
-- An empty value identifies nobody: `users.email` is NOT NULL but may be '', and
-- json_quote('') would match every empty string in a detail. B and C refuse it.
--
-- Every comparison is null-safe (IS / IS NOT) for the reason recorded in 055:
-- with `=`, a NULL makes the WHEN not true and the trigger silently does not
-- fire. Safe to re-run: the drop is IF EXISTS and the create follows it.

DROP TRIGGER IF EXISTS audit_log_no_update;

CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
WHEN NOT (
  -- Columns no erasure ever touches.
  NEW.id IS OLD.id
  AND NEW.action IS OLD.action
  AND NEW.actor_type IS OLD.actor_type
  AND NEW.created_at IS OLD.created_at
  AND NEW.org_id IS OLD.org_id
  AND NEW.project_id IS OLD.project_id
  AND (
    -- A. actor_id anonymization (055's rule, verbatim).
    (
      NEW.actor_id IS 'deleted-user'
      AND OLD.actor_id IS NOT NULL
      AND OLD.actor_id IS NOT 'deleted-user'
      AND NEW.subject IS OLD.subject
      AND NEW.detail IS OLD.detail
    )
    -- B. subject erasure.
    OR (
      NEW.subject IS 'deleted-user'
      AND NEW.actor_id IS OLD.actor_id
      AND NEW.detail IS OLD.detail
      AND OLD.subject IS NOT NULL
      AND OLD.subject IS NOT ''
      AND EXISTS (
        SELECT 1 FROM users
        WHERE deleting_at IS NOT NULL
          AND (users.id IS OLD.subject OR users.email IS OLD.subject)
      )
    )
    -- C. detail erasure, one identifier per statement.
    OR (
      NEW.actor_id IS OLD.actor_id
      AND NEW.subject IS OLD.subject
      AND NEW.detail IS NOT OLD.detail
      AND EXISTS (
        SELECT 1 FROM (
          SELECT id AS v FROM users WHERE deleting_at IS NOT NULL
          UNION
          SELECT email AS v FROM users WHERE deleting_at IS NOT NULL
        ) AS erased
        WHERE erased.v IS NOT 'deleted-user'
          AND erased.v IS NOT ''
          AND instr(OLD.detail, json_quote(erased.v)) > 0
          AND NEW.detail IS replace(OLD.detail, json_quote(erased.v), json_quote('deleted-user'))
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
