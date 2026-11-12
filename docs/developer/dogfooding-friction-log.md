# Dogfooding friction log

Stratum is developed on Stratum, in layer mode: agent work goes through the
`@stratum/stratum` project on the hosted instance, and GitHub stays the source
of truth (tracker #423). This file records every point where that flow was
slower, more confusing, or impossible without going to GitHub directly.

Add an entry when it happens, not later. Each entry says what was attempted,
what happened, and what was done instead. Link the issue or PR once one exists.

## Entries

### 2026-11-09: setup

- **The MCP consent screen defaults to a new agent, which cannot do setup.**
  The first connection was bound to an agent, so creating the org, importing
  the repository and listing orgs were all refused. `stratum_list_orgs`
  answered `Unauthorized`, with nothing to say that the connection's identity
  was the cause. Worked around by reconnecting as the user.
- **An agent-bound connection cannot re-evaluate or promote a change.** Both
  were user-credential-only, so an agent could open a change but could not
  carry it to a pull request. Neither call bypasses a gate, unlike merge,
  reject and review. *Promotion is fixed:* an agent with write access may now
  promote an accepted change, as a draft, except one whose `.github/` differs
  from the project's or that edits merge-protection config. Re-evaluation is
  still refused to an agent.
- **No MCP tool links a GitHub App installation to an org.** That step exists
  only as the `/github/app/setup` page and its REST routes.
- **CI results on a promoted pull request are not visible in Stratum.** The
  GitHub webhook handler takes no `check_run`, `check_suite` or `status`
  events.
- **Review comments on a promoted pull request are not mirrored.** A
  changes-requested review flips the change to `needs_changes`, but the comment
  text stays on GitHub and replies cannot be sent back.
- **Merging a promoted change does not merge its pull request.** The merge
  happens inside Stratum only; the pull request must still be merged on GitHub.
