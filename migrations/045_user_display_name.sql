-- Migration 045: Optional display name on users.
--
-- A free-form label shown in the header in place of the username. It is not an
-- identifier — the username stays the namespace in every URL — so it can be
-- changed at any time. NULL means "show the username".
ALTER TABLE users ADD COLUMN display_name TEXT;
