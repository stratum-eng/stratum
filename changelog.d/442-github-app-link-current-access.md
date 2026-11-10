### Security
- **Linking a GitHub App installation now checks who controls it on GitHub today, not who
  installed it.** Linking sends you through the GitHub App's authorization page and then asks
  GitHub what you manage at that moment: a current owner of the GitHub organization the app is
  installed on (or the personal account itself) can link it, whether or not they installed it,
  and someone who installed it and has since left the organization or lost the owner role no
  longer can. The GitHub user token is used for that one request, never stored or logged, and
  revoked afterwards. Existing links are untouched. (#442)

### Changed
- **Operators must give Stratum the GitHub App's OAuth credentials before anyone can link an
  installation.** Set `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` (the GitHub App's
  own client ID and secret, not the sign-in OAuth app's), add `https://<host>/github/app/callback`
  as the app's Callback URL, and tick "Request user authorization (OAuth) during installation".
  Until both variables are set, linking is refused with `501 NOT_CONFIGURED` and the setup page
  says why; there is no fallback to the old rule. See `docs/developer/deployment.md`.
- **`POST /api/github/installations/{id}/link` starts a GitHub round trip instead of linking.**
  A browser session gets `{ "ok": true, "authorizeUrl": "…" }` (a form post is redirected to
  GitHub) and the outcome arrives as `?notice=` on `/github/app/setup`. An API token is refused
  with `403 BROWSER_REQUIRED`, since a token cannot be walked through GitHub's authorization page.
- **`GET /api/github/installations` no longer lists an installation for the person who installed
  it.** It lists installations linked to you or an org you administer, plus, for a browser
  session, the ones GitHub confirmed from the setup page's new "Find installations I can link"
  button. The response gains `linkingConfigured`.
