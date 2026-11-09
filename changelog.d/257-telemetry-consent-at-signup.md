### Added
- **Telemetry can be made opt-in for new accounts.** Setting
  `TELEMETRY_CONSENT_AT_SIGNUP = "true"` adds an unticked *Send anonymous usage
  analytics* box to every signup form (magic link, the username step after
  GitHub or Google, and the approval page of an agent-requested signup). An
  account is created opted out of both server-side and browser telemetry unless
  the box was ticked, and accounts created with nobody to ask — SCIM
  provisioning and SSO just-in-time — start opted out. The setting is off by
  default, so a self-hosted instance behaves exactly as before unless it turns
  this on, and existing accounts keep the setting they have. Anyone can still
  change their choice later under **Settings → Privacy**.

### Changed
- **The hosted instance now asks before collecting telemetry for a new
  account.** It runs with `TELEMETRY_CONSENT_AT_SIGNUP = "true"`, so new signups
  there are opted out unless they tick the box. Accounts created earlier are
  unaffected.
