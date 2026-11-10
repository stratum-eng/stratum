### Added
- **A change can have a title and a description.** Give them when opening a
  change (`title` and `description` on `POST /api/projects/{name}/changes`, on
  the `stratum_create_change` MCP tool, and as `--title` / `--description` on
  `stratum change create`), or set them later with `PATCH /api/changes/{id}` or
  the new `stratum_update_change` MCP tool. The title heads the change page and
  the changes list, and both become the pull request's title and body when the
  change is promoted to GitHub. A change without a title is still headed by the
  subject of its first commit.
