### Changed
- **An organization's "require a second factor" policy now applies to tokens, agents and connections when they are used.** Until now the policy was checked for browser sessions, and when a credential was created. A credential created before the policy was turned on, or before its owner joined the organization, kept reaching the organization's projects. Each API token, legacy API key, agent token, OAuth grant (MCP and CLI) and workspace remote credential now records how the session that created it had signed in, and an organization with the policy refuses one that was not created with a second factor (or through that organization's own SSO) with `403 SECOND_FACTOR_REQUIRED`, over the API, MCP and `git`. **Every credential created before this release records nothing, so it stops reaching organizations that have the policy on.** Nothing else changes: personal projects and organizations without the policy are unaffected. To restore access, sign in with a passkey and create the credential again. Self-hosters: apply migration `072_credential_mint_factors.sql`.

### Added
- **Admins can see what the second-factor policy will refuse before turning it on.** `GET /api/orgs/{slug}/security` now returns `secondFactorImpact` to admins and the owner: how many members, API tokens, agents, OAuth grants and legacy keys do not meet the policy.

### Security
- Closed the gap that left credentials minted before an organization's second-factor policy outside that policy. The #428 release notes asked admins to review and revoke those credentials by hand; that is no longer needed.
