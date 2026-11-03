### Added
- **Organization audit log.** Org admins and owners can read their org's audit
  trail at `GET /api/orgs/{slug}/audit` (filter by action, actor, and time
  range; cursor-paginated) and download it as NDJSON at
  `GET /api/orgs/{slug}/audit/export` for windows of up to 90 days. Events about
  the org, its SSO/SCIM configuration, and projects it owns are scoped to it;
  plain members get `403` and non-members `404`. Events recorded before this
  release are not attributed to an org and stay in the instance-wide view.
- **More events are audited:** org creation, members added and removed, member
  role changes, teams created and deleted, and team membership changes.
- **Failed authentication is audited** when the attempt identifies a real
  account or org: a revoked or expired API token or MCP OAuth token, a token or
  agent whose account is disabled or being deleted, a reused or expired magic
  link, and SSO callbacks refused after reaching an org's connection. Unknown
  credentials are not recorded, and repeats for the same credential or account
  are collapsed to one entry per minute.

### Changed
- `GET /api/admin/audit` now returns `nextCursor` for pagination and accepts
  `org`, `since`, `until`, and `cursor` filters. Existing `action`, `actor`, and
  `limit` parameters and the `entries` field are unchanged.

### Security
- **The audit log is append-only at the database.** Updates and deletes on
  `audit_log` are rejected by triggers, except the account-erasure rewrite of an
  erased person's actor id to `deleted-user`.
