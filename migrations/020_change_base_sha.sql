-- Record the project HEAD the change was evaluated against, enabling
-- staleness detection at merge time (merge.requireFreshBase policy).
ALTER TABLE changes ADD COLUMN base_sha TEXT;
