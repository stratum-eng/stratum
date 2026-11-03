### Changed
- **Approvals are made by a signed-in human.** An `approve` review verdict now needs a browser
  session (or the legacy user key). Scoped API tokens and OAuth grants, which is what MCP
  clients and `stratum login` use and what agents are handed, get `403 SESSION_REQUIRED` with
  the change's URL to approve on instead. They can still request changes and comment, which can
  only block a merge. `stratum change review --verdict approve` and the MCP
  `stratum_review_change` tool now point you to the browser.
