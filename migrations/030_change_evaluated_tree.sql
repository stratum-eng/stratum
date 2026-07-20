-- SEC-2 hardening: record the tree oid of the evaluated workspace tip on the
-- change. A merge backend compares the staged tree's oid against this to
-- content-address the code it is about to land against what was evaluated,
-- closing the residual TOCTOU between the pre-merge tip check and the staged-tree
-- read. Nullable/additive; legacy changes keep NULL and skip the check.
ALTER TABLE changes ADD COLUMN evaluated_tree_oid TEXT;
