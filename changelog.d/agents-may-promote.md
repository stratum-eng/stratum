### Changed
- **Agents can promote an accepted change to a GitHub pull request.**
  `POST /api/changes/{id}/github-pr` and the `stratum_promote_change` MCP tool
  used to refuse agent tokens and agent-bound connections. They are now accepted
  when the agent has write access to the project (it has its owner's). A change
  can only be promoted once its gates have accepted it, and merging the pull
  request is still decided on GitHub. `promotedBy` records the agent's id when
  an agent promoted. An agent can only open a draft. When the agent's owner has
  connected their GitHub account, the pull request is opened as the owner, so
  GitHub will not let them approve their own agent's work; otherwise it is
  opened with the instance's own credential. Review verdicts, merging, rejecting and re-evaluating
  remain user-only. A person signed in to the browser must still promote a
  change whose `.github/` differs from the project's (its workflows would run
  with the repository's secrets as soon as the pull request opened) or that
  edits the merge-protection config.
- **Promoting such a change with a scoped API token or an OAuth grant is now
  refused** with `403 PROMOTION_NEEDS_PERSON`, as it is for an agent. Those
  credentials act for a user but are what an agent is handed; before, they
  could promote anything. Promote from the change page instead.
