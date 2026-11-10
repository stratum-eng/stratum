-- Migration 084: a title and a description on a change.
--
-- A change had neither, so the only thing to call it by was its id, and the
-- only account of what it does was its diff. Both are optional and set by
-- whoever opens the change (or edited later). NULL on every existing row; the
-- change page falls back to the subject of the change's first commit.
ALTER TABLE changes ADD COLUMN title TEXT;
ALTER TABLE changes ADD COLUMN description TEXT;
