### Added
- **API tokens can be limited to one project or one organization.** When
  creating a token (Settings → API tokens, or `POST /api/users/me/tokens` with
  `project: "@owner/repo"` or `org: "slug"`), you can bind it to a single
  project, or to the projects an organization owns. A bound token answers every
  other project — public ones included — exactly as if it did not exist, over
  the API, MCP, and git alike, and it cannot reach account-level endpoints
  (usage, token and agent creation, organization administration, bulk import,
  the admin API, the web UI), which refuse it with `403
  TOKEN_BINDING_EXCLUDES_ROUTE`. A project-bound token cannot create projects;
  an organization-bound one can only create them in its organization. Binding is
  independent of the read/write scope, and existing tokens are unchanged:
  without a binding a token stays account-wide. The settings token list now
  shows what each token can reach. Requires migration 057.
