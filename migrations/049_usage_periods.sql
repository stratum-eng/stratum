-- Migration 049: the owner-scoped usage aggregate a limit is compared against.
--
-- `cost_records` cannot be that aggregate, and this is the whole reason for a
-- second table. It is in PROJECT_SCOPED_TABLES (src/storage/deletion.ts) and
-- hard-deleted by the project cascade, so any allowance summed from it is
-- refunded by deleting a project: burn the month's quota, delete the project,
-- get the quota back. This table keys on the billing subject instead and joins
-- only the ACCOUNT cascades, so the one thing that clears usage is erasing the
-- account that incurred it — at which point there is no subject left to bill.
--
-- `cost_records` remains the per-change evidence of what was spent; this is the
-- running total. Both are written by `recordCosts` (src/storage/costs.ts) from
-- the same timestamp, so a cost row and the period it counts toward can never
-- disagree.
--
-- This total is NOT recoverable from that ledger, which is the uncomfortable
-- half and the reason it is backed up in its own right (see BACKUP_TABLES in
-- src/storage/d1-backup.ts). The cascade that hard-deletes cost rows leaves
-- these standing, so replaying the ledger would rebuild usage only for projects
-- that still exist and hand every other owner their month back — the same
-- refund this table exists to prevent, arriving by a different route. A lost
-- upsert is therefore a permanent under-count, accepted because the alternative
-- is failing a change over an accounting write.
--
-- Timestamps are ISO 8601 strings written by the application, NOT
-- `datetime('now')`, for the reason 042/044/047 give: the two formats sort
-- differently as TEXT (' ' 0x20 < 'T' 0x54), and a column mixing them silently
-- breaks every comparison over it.
--
-- Rollback: drop the table. Writes are best-effort by contract and reads are
-- Result-typed, so an absent table degrades to logged failures rather than a
-- broken change flow — but every accumulated total is gone with it.

CREATE TABLE IF NOT EXISTS usage_periods (
  -- The subject `resolveBillingSubject` named: a user or an org, never a
  -- project and never an agent. NOT NULL, unlike `cost_records.owner_id`,
  -- which 048 deliberately left nullable so an unattributable sample is still
  -- recorded. There is no such thing here: a quantity nobody can be billed for
  -- cannot be enforced against anyone, so `recordCosts` drops those samples
  -- rather than accumulating a bucket no limit could ever apply to.
  owner_id TEXT NOT NULL,
  -- CHECK'd, and closed, for the same reason as `cost_records.owner_type`: an
  -- owner_type outside this set is unreachable from `resolveBillingSubject`,
  -- which maps ProjectEntry's third kind ('agent') onto the user that owns the
  -- agent instead of passing it through. Unlike `meter` below, this set does
  -- not grow — it is exactly what `BillingSubject` admits.
  owner_type TEXT NOT NULL CHECK(owner_type IN ('user','org')),
  -- 'YYYY-MM', UTC (PRD Open Question 1). Zero-padded, so lexical order is
  -- chronological order and a period range is a plain TEXT comparison.
  period TEXT NOT NULL,
  -- Deliberately NOT CHECK'd — the one place this table departs from 048's
  -- shape, and a decision rather than an omission. `cost_records.kind` carries
  -- a closed CHECK from 021, and the bill for it is already recorded in this
  -- feature's own scope: `storage_bytes` is a Non-Goal partly because adding a
  -- kind would force a 043-style table rebuild. The meter set is expected to
  -- grow (`deploys_month` has no recording site yet), so a CHECK here would buy
  -- validation that the `MeterKey` union already gives at the only writer, at a
  -- cost that has demonstrably bitten once. An unrecognised meter is an inert
  -- row nothing reads; an unwritable one is a failed write on a hot path.
  meter TEXT NOT NULL,
  -- Which provider account paid, carried into the aggregate rather than summed
  -- away. An allowance is a limit on what the OPERATOR spends, so enforcement
  -- reads the 'platform' rows alone: a project running the gate on its own key
  -- costs the operator nothing and must not be charged against a hosted
  -- allowance. Collapsing the two here would be a one-way door — this table is
  -- not rebuildable from `cost_records` (see above), so any month accumulated
  -- without the dimension could never have it recovered, and the usage page
  -- could never show a project what its own key paid for.
  source TEXT NOT NULL DEFAULT 'platform' CHECK(source IN ('platform','byok')),
  -- REAL, matching `cost_records.quantity`, which is what accumulates into it:
  -- sandbox milliseconds and character-derived token estimates are not
  -- guaranteed integral, and rounding at the aggregate would drift.
  -- CHECK'd non-negative, because the UPSERT below adds rather than replaces
  -- and nothing else stops a negative delta from REFUNDING the month — through
  -- the one statement this whole table exists to make non-refundable. It is
  -- reachable without malice: sandbox_ms is wall-clock arithmetic
  -- (`Date.now() - startedAt` in post-merge.ts and sandbox-evaluator.ts), so a
  -- backwards clock step yields one. Failing the write is correct here; the
  -- caller treats accumulation as best-effort and an under-count is the safe
  -- direction, where a refund is not.
  quantity REAL NOT NULL DEFAULT 0 CHECK(quantity >= 0),
  updated_at TEXT NOT NULL,
  -- `owner_type` is deliberately outside the key: it describes the owner, it is
  -- not part of its identity. In the key it would let one account hold two rows
  -- for the same meter and month, and a limit compared against either alone
  -- would be wrong. `source` IS in the key for the opposite reason — platform
  -- and BYOK spend are two separately-answerable questions, and one limit
  -- applies to only one of them. The key doubles as the UPSERT's conflict
  -- target (src/storage/usage.ts), and SQLite's implicit index on it already
  -- serves the owner+period lookup, so no separate index is added. (It is not a
  -- *covering* index — `quantity` and `updated_at` sit outside the key — but the
  -- search is on the key, which is what matters here.)
  PRIMARY KEY (owner_id, period, meter, source)
);
