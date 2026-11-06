### Added
- **Admins can restore a repository from a backup.**
  `POST /api/admin/restore/{runTs}/repos/{projectId}` recreates a project's repository
  from a backup run, and needs `force` to overwrite one that exists. With
  `{ "drill": true }` it restores to a scratch repository, compares every ref with the
  backup, and deletes it, without touching the project's repository. Every attempt is
  audited as `backup.repo_restore`. Database and KV restore have no route yet.

### Changed
- The trust page no longer calls the restore path tested end to end. Its restore functions
  have tests, but the live push has to be proven by a drill on staging.
