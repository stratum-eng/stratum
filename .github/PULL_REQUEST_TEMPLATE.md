<!-- Thanks for contributing to Stratum! Please fill out the sections below. -->

## Summary

<!-- What does this PR change, and why? -->

## Related issues

<!-- e.g. Closes #123 -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup
- [ ] Documentation
- [ ] Other:

## How was this verified?

<!-- Which gates did you run? Describe manual testing if relevant. -->

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run lint`

## Checklist

- [ ] Tests added or updated for the change (coverage thresholds still pass)
- [ ] A `changelog.d/<slug>.md` fragment added if this is user-visible (not a direct
      `CHANGELOG.md` edit — see `changelog.d/README.md`)
- [ ] Public docs updated if this changes user-facing config, API shape, or evaluator/policy
      behavior — edit the canonical page under `docs/user-guide/` or `docs/api/`, then
      `cd website && npm run sync:guides` and commit the regenerated mirrors (see AGENTS.md)
- [ ] No secrets, tokens, or personal data committed
- [ ] The web UI change (if any) stays server-rendered with no client-side JavaScript
