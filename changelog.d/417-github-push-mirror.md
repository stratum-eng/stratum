### Added
- **Push mirror to GitHub.** A project can keep a read-only copy of its default
  branch and tags on a GitHub repository. Stratum pushes after every merge, and
  only ever fast-forwards: it never force-pushes and never deletes a ref. If the
  GitHub repository has history the project does not, the mirror is marked
  `diverged`, a `mirror.diverged` event and audit entry are written, and nothing
  is pushed until a project admin resumes it. Failed pushes retry with backoff
  and then leave a visible `failed` state; a merge is never blocked or failed by
  its mirror. Configure it under **Settings → GitHub mirror** or with
  `PUT /api/projects/{namespace}/{slug}/mirror` (project admins only). Status is
  on the settings page, at `GET …/mirror`, and in the `mirror` field of
  `GET …/sync/status`. Needs the GitHub App installed on the mirror repository
  with **Contents: read and write** (and **Workflows: read and write** if the
  project has workflow files). See the "Mirroring a project to GitHub" guide.
- `mirror.diverged` and `mirror.failed` events, subscribable by project webhooks.

### Changed
- A project with a push mirror enabled no longer syncs from its source or
  promotes changes to GitHub pull requests; both answer `409`
  `PUSH_MIRROR_ENABLED`. Projects without a mirror are unaffected.
- **Self-hosters:** `wrangler.toml` now binds a `stratum-mirrors` queue. Create
  it before deploying (`wrangler queues create stratum-mirrors`), or remove the
  `MIRROR_QUEUE` binding — mirrors are then pushed by the five-minute sweep.
