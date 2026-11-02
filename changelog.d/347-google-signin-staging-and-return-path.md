### Fixed
- **Google sign-in works outside production.** Only `[env.production.vars]` declared
  `GOOGLE_REDIRECT_URI`, and the Google routes require it, so `/auth/google` answered
  `501` on staging and under `wrangler dev` however the secrets were set — named
  environments replace top-level `[vars]` rather than inheriting them. Staging and
  local now declare their own callback.
- **A Google sign-in returns to the page it started from.** `/auth/google` now accepts
  `?next=` the way `/auth/github` already did, carried through the round trip on the
  OAuth state record and honoured by the callback and by the username step a new
  account goes through. It previously always landed on `/` unless the MCP consent
  screen had remembered a destination.

### Security
- **Closed an open redirect in post-login destinations.** The same-origin check on
  `next` examined the path as written, but the redirect used the path after URL
  normalization, which resolves dot segments: `/auth/github?next=/.//evil.example`
  passed the check and then sent a freshly signed-in user to `//evil.example`. The
  normalized path is now checked as well, for every sign-in route.
