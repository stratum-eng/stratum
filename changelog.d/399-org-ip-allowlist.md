### Added
- **Organizations can restrict access to their own networks.** An org admin sets
  `PUT /api/orgs/{slug}/security` `{"ipAllowlist": ["203.0.113.0/24", "2001:db8::/32"]}`
  (IPv4 and IPv6, up to 100 ranges). Requests from outside those ranges then get
  `403 IP_NOT_ALLOWED` on **that org's** projects (including git clone and push,
  and MCP tool calls), on its `/api/orgs/{slug}/` endpoints, and on linking,
  unlinking or moving a GitHub App installation for the org. This applies to
  every credential: sessions, API tokens, agent tokens, and OAuth grants.
  Members' personal projects, other organizations, anonymous reads of public
  projects, the SSO sign-in flow, and SCIM are not affected. An empty list,
  which is the default, means no restriction. Saving a list that excludes your
  own address is refused (`409 IP_ALLOWLIST_SELF_LOCKOUT`) unless you send
  `"allowSelfLockout": true`. See the new "Organization IP allowlists" guide.
- New audit events in the org's audit log: `org.ip_allowlist_changed`, and
  `org.ip_access_denied`, which is sampled to at most one entry per member per
  org every 10 minutes.

### Changed
- `GET`/`PUT /api/orgs/{slug}/security` responses, and org objects, now include
  `ipAllowlist`. `PUT` accepts `requireSecondFactor` and `ipAllowlist`
  independently, so either can be sent alone.

### Security
- The client address for the allowlist comes only from `CF-Connecting-IP`.
  `X-Forwarded-For` is never read. A request with no client address is refused
  by a restricted org.
