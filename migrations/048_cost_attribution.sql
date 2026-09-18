-- Migration 048: name who pays for each cost sample.
--
-- `cost_records` (021, given `project_id` by 025) has recorded what a change
-- consumed since it existed, but never who owes for it. A project name is not a
-- billing subject: names are unique only per-namespace, and projects are
-- transferred and deleted. These columns make every new row attributable at the
-- moment the spend is incurred, which is the only moment the payer is known for
-- certain.

-- NULLABLE, and permanently so. Every historical row predates attribution, and
-- the mapping needed to backfill it lives in KV (the ProjectEntry's owner), not
-- in D1 — the same reason 025 backfilled no `project_id`. Live code writes NULL
-- too: `resolveBillingSubject` (src/storage/costs.ts) returns null rather than
-- throwing when an owner cannot be named, because `recordCosts` is best-effort
-- inside change creation, merge and deploy. So a NULL owner is a row nobody can
-- be billed for, which is honest, where an owner guessed from a project name
-- would be a row billed to possibly the wrong account.
ALTER TABLE cost_records ADD COLUMN owner_id TEXT;

-- CHECK'd rather than free text: an owner_type outside this set is unreachable
-- from `resolveBillingSubject`, which maps ProjectEntry's third kind ('agent')
-- onto the user that owns the agent instead of passing it through. A row
-- claiming a type no billing subject can have would aggregate under an account
-- that will never be invoiced.
ALTER TABLE cost_records ADD COLUMN owner_type TEXT CHECK(owner_type IN ('user','org'));

-- NOT NULL DEFAULT because the backfill is correct by construction, not merely
-- convenient: BYOK does not exist yet, so every row already in this table was
-- spend on the operator's own provider account, and the default states that
-- truth in place. Precedent for both ALTER shapes: a CHECK on an added column in
-- 037, NOT NULL DEFAULT in 032/034/041. No table rebuild — unlike `kind`, whose
-- closed CHECK would need one to widen.
ALTER TABLE cost_records ADD COLUMN source TEXT NOT NULL DEFAULT 'platform'
  CHECK(source IN ('platform','byok'));

-- Serves the owner-scoped usage read this work is being built toward
-- (`WHERE owner_id = ? ORDER BY created_at DESC`); no caller issues it yet.
--
-- Sorting on `created_at` is safe HERE specifically. Application code writes it
-- only through `recordCosts`, as `new Date().toISOString()`, so every row this
-- table gets in production is ISO 8601 with a 'T' separator. The hazard
-- 042/044/047 warn about is a column mixing that with `datetime('now')`'s space
-- separator, which sorts differently as TEXT (' ' 0x20 < 'T' 0x54) and silently
-- breaks every range comparison. A single-format column has no such problem.
--
-- Rows with a NULL owner are still indexed (SQLite indexes NULLs) but are never
-- selected by that predicate, which is the intent.
CREATE INDEX IF NOT EXISTS idx_costs_owner ON cost_records(owner_id, created_at DESC);
