### Added
- **Outbound GitHub calls can authenticate as a GitHub App.** Set `GITHUB_APP_ID` and
  `GITHUB_APP_PRIVATE_KEY` (PKCS#8) and Stratum uses a short-lived installation token for
  project sync, pushing and opening promoted PRs, and evaluation verdict comments and commit
  statuses, instead of one instance-wide personal access token. `GITHUB_TOKEN` keeps working
  as the fallback, so nothing changes until you opt in.
- **GitHub App installations are linked to the Stratum account they serve.** A project uses an
  installation only when that installation is linked to the project's owner. Link one from the
  app's setup page (`/github/app/setup`) or `POST /api/github/installations/{id}/link`; only the
  GitHub user who installed the app can link it. Operators can let every project use the
  installations on their own GitHub accounts with `GITHUB_APP_ALLOWED_OWNERS`.
