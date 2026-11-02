-- Per-connection DNS domain-verification token (#253 Task 4). Issued at
-- connection create; an org admin proves domain ownership by publishing
-- `stratum-sso-verify=<token>` as a TXT record at `_stratum-sso.<domain>`.
-- The token survives email_domains edits (only domains_verified_at clears),
-- so an admin never has to re-publish DNS after tweaking the domain list.
ALTER TABLE org_sso_connections ADD COLUMN domain_verification_token TEXT;
