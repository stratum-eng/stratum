### Fixed
- **The private-project limit now applies to imports.** Importing a repository
  (`POST /api/projects/{namespace}/{slug}/import`) and bulk import
  (`POST /api/bulk-import`) both check the account's private-project limit, as
  creating a project already did. A bulk import checks the whole batch at once:
  if its private repositories would go past the limit, it answers `403` and
  imports none of them. Public repositories and projects that already exist do
  not count.
