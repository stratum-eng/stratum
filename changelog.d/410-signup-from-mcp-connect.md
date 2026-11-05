### Added
- **Sign up straight from "connect your editor".** When adding Stratum's MCP server
  sends a first-time visitor to sign in, the page now offers **Create an account**,
  and verifying the signup email returns them to the consent screen instead of
  the dashboard. An `invite` parameter on the client's authorization URL pre-fills the
  invite code on instances running the invite gate. A sign-in link requested from
  the same page also returns to the consent screen.

### Security
- The consent-screen destination is bound to the magic link server-side and only
  honoured in the browser that requested the link. Opening the link on another
  device signs you in but shows "you're signed up; reconnect your editor" rather
  than presenting a consent screen to whoever opened it. The destination must be
  same-origin and exactly `/oauth/authorize`.
