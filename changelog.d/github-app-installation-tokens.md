### Added
- **Outbound GitHub calls can authenticate as a GitHub App.** Set `GITHUB_APP_ID` and
  `GITHUB_APP_PRIVATE_KEY` (PKCS#8) and Stratum uses a short-lived installation token for
  project sync, pushing and opening promoted PRs, and evaluation verdict comments and commit
  statuses, instead of one instance-wide personal access token.
- **GitHub App installations are linked to the Stratum account they serve.** A project uses an
  installation only when that installation is linked to the project's owner. Link one from the
  app's setup page (`/github/app/setup`) or `POST /api/github/installations/{id}/link`; only the
  GitHub user who installed the app can link it. An org admin whose session does not meet the
  org's second-factor policy cannot link to, unlink from, or move a link away from that org until
  they sign in with a passkey (`SECOND_FACTOR_REQUIRED`).
- **Each GitHub repository has one canonical Stratum project.** Webhook events reach, and
  promotions and evaluation reports come from, only the first authorized project to act on the
  repository. A project that merely names the repository in its source URL gets neither. A
  promotion from another project answers `409`.

### Changed
- **Upgrade note: `GITHUB_TOKEN` now needs operator bindings.** The instance personal access
  token is used only for projects whose owner is bound to the repository's GitHub owner in
  `GITHUB_ALLOWED_OWNERS`, as comma-separated `githubOwner=org:<orgId>` or
  `githubOwner=user:<userId>` entries. Bindings name stable ids, never `@namespace` names,
  which can be renamed or deleted and reclaimed. Find an org's id with `GET /api/orgs/{slug}`
  or `SELECT id FROM orgs WHERE slug = '...'`. An instance that relies on `GITHUB_TOKEN` must
  add these bindings when upgrading, or GitHub sync, PR promotion and evaluation reports stop
  for its projects. The former `GITHUB_APP_ALLOWED_OWNERS` is still read, but a bare owner (or
  any other form) is now ignored instead of admitting every project. A caller the GitHub App refuses never falls
  back to the personal access token.
