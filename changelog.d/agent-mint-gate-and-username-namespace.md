### Security
- **A scoped API token or OAuth grant can no longer create agents.** `POST /api/agents`
  mints an agent token, which never expires and is not tied to the credential that
  created it, so a scoped token or an MCP client's OAuth grant that could call it would
  survive its own revocation. It now returns `403 SESSION_REQUIRED` for those callers,
  the same rule the legacy-key rotate routes already follow. Browser sessions and the
  legacy API key are unaffected; the settings page already required a session.
- **A username can no longer be taken over an organization's or another account's
  namespace.** Users and organizations share the `@name` namespace, but renaming an
  account (and signing up) only checked other usernames. Renaming to an org's slug, or
  to a name whose namespace still held another account's projects, gave the account a
  namespace it did not own, and the import routes, which authorize by that namespace,
  then accepted it. Renames, signups, org creation and `GET /api/users/check-username` now
  treat an org slug, a live project claim, or existing projects under `@name` as taken.
- **The OAuth authorize endpoint is no longer an open redirect.** Client registration is
  open, so anyone could register a client whose redirect URI was their own site and then
  link users to `/oauth/authorize` with a malformed request, which bounced them straight
  to that site from Stratum's domain. Invalid authorization requests (bad
  `response_type`, PKCE, scope or resource) now show an error page naming the OAuth
  error code instead of redirecting. Only the user's own "deny" on the consent screen
  sends an error back to the client.
