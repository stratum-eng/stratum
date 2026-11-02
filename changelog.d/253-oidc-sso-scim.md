### Added
- **Enterprise single sign-on (OIDC) per organization.** An org admin or owner
  configures one OIDC connection with `PUT /api/orgs/{slug}/sso`, proves ownership
  of its email domains with a DNS TXT record, and enables it. Members then sign in
  at `/auth/sso` with the org slug or their work email (authorization code + PKCE);
  first-time users on a verified domain are provisioned into the org. Requires the
  `SSO_ENCRYPTION_SECRET` secret; the SSO endpoints answer `501` without it. SSO
  does not yet lock out the other sign-in methods.
- **SCIM 2.0 user provisioning at `/scim/v2`.** Each SSO connection gets its own
  `stratum_scim_*` bearer token. Identity providers can create, adopt, update, and
  deactivate users. Deactivation is reversible: it disables every credential the
  account holds and deletes its browser sessions. Reactivation restores the
  account's tokens, agents, and OAuth grants; the user signs in again for a new
  session. SCIM Groups are not implemented.

### Security
- **A disabled account cannot authenticate by any route.** Legacy and scoped API
  tokens, MCP OAuth access tokens, agent tokens, session cookies, git over HTTPS,
  and every sign-in flow (magic link, GitHub, Google, SSO, and completing a parked
  OAuth signup) refuse it.
- **GitHub sign-in links to an existing account only through a verified email,**
  and never links onto a disabled or deleting account.
