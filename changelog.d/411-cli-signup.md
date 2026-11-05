### Added
- **`stratum signup` in the CLI.** An agent can sign its human up in one command:
  `stratum signup --email you@example.com --username you [--invite CODE] [--agent-name NAME]`.
  It prints the code the human types on the approval page, waits for them to approve from the
  email, and stores the new agent token the same way `stratum login --key` does. It exits
  non-zero with a clear message when the address already has an account (use `stratum login`),
  the username is taken, the invite code is invalid, or the request expires.
