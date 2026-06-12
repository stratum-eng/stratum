# Stratum TODO

The master-plan feature roadmap (stratum-master-plan-v2.md, Phases 0–3 plus the
code-level Phase 4 hardening items) is complete as of 2026-06-11. See
docs/CURRENT_CAPABILITIES.md for what exists and its limitations, and
docs/REMAINING_WORK.md for context on each remaining item below.

## Remaining (operational / scale — master-plan Phase 4, Stratum Cloud)

- [ ] Load testing: 1000+ concurrent workspaces per repo
- [ ] D1 hot/cold rotation (>30-day data → R2)
- [ ] Batch merging in the merge queue Durable Object
- [ ] SSO/SAML
- [ ] Multi-tenancy and billing for Stratum Cloud
- [ ] Backup strategy for D1 and Artifacts data
- [ ] Monitoring dashboard UI (metrics API exists at /api/admin/metrics)

## Engineering debt

- [ ] Migrate project/workspace identity from KV to D1 (unblocks
      workspace.deleted events and removes the scan fallback in getProject)
- [ ] Async evaluation worker (evaluation currently runs synchronously at
      change creation; fine at current scale)
- [ ] Per-project team permission grants (currently org-wide)
- [ ] Publish @stratum/cli and @stratum/agent to npm
