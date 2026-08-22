-- SA-3: flag a change whose diff modifies a merge-protection config file
-- (.stratum/policy.yaml or stratum.config.json). Such a change alters the gate
-- itself, so the merge path requires a human approval for it and forbids
-- force-merging it — a writer can't silently relax protection for later changes.
-- Nullable/additive; legacy changes keep NULL (treated as "does not touch").
ALTER TABLE changes ADD COLUMN touches_protected_config INTEGER;
