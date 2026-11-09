### Added
- **Break-glass resync from GitHub.** A project admin can fast-forward a
  project's default branch to the same branch on its push mirror (or, for a
  project with no mirror, its linked GitHub repository), for the day a fix had to
  land on GitHub because Stratum could not merge. It only ever fast-forwards: a
  diverged branch is refused with `409 RESYNC_DIVERGED`, which names both
  commits, and nothing is forced, rewritten or merged. **The commits it brings in
  are not evaluated**, and the `branch.resync_requested` and `branch.resynced`
  audit entries and the new `branch.resynced` event say so and list them. It is
  available as `POST /api/projects/{namespace}/{slug}/resync` and as a card in
  project settings with a typed confirmation. OAuth grants and agents cannot run
  it, there is no MCP tool for it, and the organization's second-factor policy
  and IP allowlist apply. A mirror left `diverged` or `failed` by the incident is
  resumed and returns to `ok` without a force push. See
  `docs/user-guide/push-mirror.md`.
- `branch.resynced` event, subscribable by project webhooks.
- A break-glass runbook for an instance that hosts its own code,
  `docs/runbooks/break-glass-self-hosting.md`. It has not been rehearsed yet.
