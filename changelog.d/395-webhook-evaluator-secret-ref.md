### Security
- **Webhook evaluators can sign with a project secret instead of a literal in
  the policy file.** A `webhook` entry in `.stratum/policy.yaml` now accepts
  `secretRef: <NAME>`, resolved at evaluation time from the project's encrypted
  secret store (the one deploys use). A literal `secret` is readable by anyone
  with repository read access — and by the code under evaluation — so anyone
  could forge a signature your receiver accepts. If you used one, store the value
  as a project secret, switch to `secretRef`, and rotate it. A reference that
  does not resolve (missing, empty, undecryptable, or no `DEPLOY_SECRET_KEY`)
  fails the evaluation closed without contacting the receiver; it never sends
  unsigned or signs with an empty key. An invalid `secretRef` name fails the
  policy file closed.

### Deprecated
- **The webhook evaluator's literal `secret` field.** It still signs requests
  for now, and logs a warning each time. When an entry sets both `secret` and
  `secretRef`, `secretRef` wins and the literal is ignored — never used as a
  fallback.
