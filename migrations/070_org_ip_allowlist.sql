-- Migration 070: per-org IP allowlist (#399).
--
-- A JSON array of canonical CIDR strings ("203.0.113.0/24", "2001:db8::/32").
-- NULL — the default, so every existing org is unaffected — means the org
-- applies no network restriction. The application never writes an empty array;
-- clearing the list writes NULL.
--
-- Additive only: a nullable column with no default rewrite, safe on a database
-- that already has every earlier migration applied.
ALTER TABLE orgs ADD COLUMN ip_allowlist TEXT;
