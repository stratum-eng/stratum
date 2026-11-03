### Fixed
- **An organization's second-factor policy now also applies when a credential is created.** A
  session that had not met an org's "require a second factor" policy could still create an
  API token, an agent token, a new legacy key or an MCP/CLI connection. These are never asked
  for a second factor when used, so they then reached that org's projects. Creating any
  credential that could reach the org is now refused with `403 SECOND_FACTOR_REQUIRED` until
  the session meets the policy: an unbound token, a token bound to the org or one of its
  projects, an agent, a rotated legacy key, or OAuth consent. A token bound to your own
  projects, or to an org without the policy, can still be created. Credentials created before
  the policy was turned on are unaffected; review and revoke them from Settings if needed.
