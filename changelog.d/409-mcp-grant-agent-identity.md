### Added
- **MCP connections can act as an agent, so MCP work has agent provenance.** The
  consent screen now asks who the application connects as: a new agent (the
  default, named after the application, e.g. "Claude Code on my-laptop"), one of
  your existing agents, or you. A connection bound to an agent works as that
  agent, acting for you. Changes it opens show the agent in their provenance and
  in the activity feed, and every agent-token rule applies: no merge, reject,
  review verdict or issue triage. An agent created on the consent screen has no
  token of its own, so disconnecting the application, or the connection reaching
  its 180-day limit, ends the agent's access too. `stratum_whoami`
  (`GET /api/users/me`) reports `actingAs: "agent"` with the agent and its owner,
  or `actingAs: "user"`.

### Changed
- **New MCP connections act as an agent by default.** Such a connection can open
  changes, push and comment, but cannot merge, reject, approve or list your
  projects, because those actions are reserved for you. To keep the previous
  behaviour, choose "Me" on the consent screen.
- **Settings → Connected applications shows who each connection acts as.**
  Connections made before this release keep acting as you and are labelled
  "You (no agent provenance)". Reconnect to choose an agent.
