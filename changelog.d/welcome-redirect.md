### Fixed
- **Signing up no longer ends on a "page not found".** Confirming a new account
  from the email link now opens the dashboard, which shows how to create or import
  a first project. An agent-initiated signup opens Settings, with a notice saying
  whether the agent was connected. A plain signup, and an agent signup whose
  agent was connected, used to redirect to `/welcome`, which does not exist; an
  agent signup that missed the hand-off already went to Settings, and now says
  whether the request expired or the connection failed.
