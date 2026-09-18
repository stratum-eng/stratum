# Stratum Documentation

Welcome to the Stratum documentation. This directory contains comprehensive guides for users, developers, and API consumers.

The public-facing subset (user guide and API reference) is also published as a docs site built from [`website/`](../website/) — when editing those pages here, mirror the change in `website/src/content/docs/` (the OpenAPI spec needs no mirroring; the site build copies `api/openapi.yml` automatically).

## Documentation Structure

```
docs/
├── README.md                           # This file
├── ARTIFACTS_BEST_PRACTICES_AUDIT.md   # Artifacts usage audit
├── CURRENT_CAPABILITIES.md             # What the platform can do today
├── DEVELOPER_WORKFLOW.md               # Day-to-day developer workflow
├── REMAINING_WORK.md                   # Known remaining work
├── STAGING_SETUP.md                    # Staging environment setup
├── api/                                # API Documentation
│   ├── openapi.yml                     # OpenAPI 3.1.0 specification
│   ├── authentication.md               # Authentication methods
│   ├── errors.md                       # Error codes reference
│   └── endpoints/                      # Endpoint documentation
│       ├── README.md                   # Overview
│       ├── projects.md                 # Projects, branches, browsing, import
│       ├── workspaces.md               # Workspace API
│       ├── changes.md                  # Change lifecycle, merge, GitHub promotion
│       ├── reviews.md                  # Comment threads and review verdicts
│       ├── issues.md                   # Issue tracker API
│       ├── agents.md                   # Agents API
│       ├── users.md                    # Profile, account deletion, API tokens
│       └── organizations.md            # Organizations API
├── user-guide/                         # User Documentation
│   ├── README.md                       # User guide overview
│   ├── getting-started.md              # First steps tutorial
│   ├── importing.md                    # GitHub import guide
│   ├── code-review.md                  # Comment threads and review verdicts
│   ├── issues.md                       # The built-in issue tracker
│   ├── ci-integration.md               # Bring-your-own-CI guide
│   ├── troubleshooting.md              # Problem solving
│   └── faq.md                          # Frequently asked questions
├── developer/                          # Developer Documentation
│   ├── README.md                       # Developer guide overview
│   ├── architecture.md                 # System architecture (comprehensive)
│   ├── local-setup.md                  # Development environment
│   ├── database.md                     # Database schema
│   ├── queues.md                       # Queue system
│   ├── testing.md                      # Testing guide
│   └── deployment.md                   # Deployment procedures
├── adr/                                # Architecture Decision Records
│   ├── 001-namespace-support.md
│   ├── 002-queue-based-imports.md
│   ├── 003-d1-for-import-state.md
│   ├── 004-high-frequency-agent-commits.md
│   ├── 005-git-smart-http-proxy.md
│   ├── 006-ssh-transport.md
│   ├── 007-sandbox-evaluator-threat-model.md
│   └── 008-llm-provider-byok-threat-model.md
├── research/                           # Research notes
│   ├── github-alternatives-pain-points.md
│   ├── master-plan-alignment.md
│   ├── monetization-and-byok.md
│   └── option-b-warm-repo-do-spike.md
├── runbooks/                           # Operational runbooks
│   ├── artifacts-scaling.md
│   ├── backup-restore.md
│   └── d1-migration-reconciliation.md
└── archive/                            # Historical documents
    ├── README.md                       # Archive index
    ├── AUDIT.md                        # UI/UX architecture audit (2026-05-02)
    └── CODE_REVIEW.md                  # Code review of Phases 1-4 (2026-04-29)
```

## Quick Navigation

### For Everyone

**Current Priorities & Roadmap:**
- [ROADMAP.md](../ROADMAP.md) - Open work and priorities
- [CURRENT_CAPABILITIES.md](CURRENT_CAPABILITIES.md) - What the platform can do today
- [REMAINING_WORK.md](REMAINING_WORK.md) - Known remaining work

### For Users

**Getting Started:**
1. [User Guide Overview](user-guide/README.md)
2. [Getting Started](user-guide/getting-started.md)
3. [Importing from GitHub](user-guide/importing.md)
4. [Code Review](user-guide/code-review.md)
5. [Issues](user-guide/issues.md)
6. [CI Integration (Bring Your Own CI)](user-guide/ci-integration.md)

**Help:**
- [Troubleshooting](user-guide/troubleshooting.md)
- [FAQ](user-guide/faq.md)

### For API Consumers

**Getting Started:**
1. [Authentication](api/authentication.md)
2. [OpenAPI Specification](api/openapi.yml)

**Endpoints:**
- [Projects](api/endpoints/projects.md)
- [Workspaces](api/endpoints/workspaces.md)
- [Changes](api/endpoints/changes.md)
- [Reviews and Comments](api/endpoints/reviews.md)
- [Issues](api/endpoints/issues.md)
- [Agents](api/endpoints/agents.md)
- [Users](api/endpoints/users.md)

**Reference:**
- [Error Codes](api/errors.md)

### For Developers

**Getting Started:**
1. [Developer Guide Overview](developer/README.md)
2. [Local Setup](developer/local-setup.md)
3. [Architecture](developer/architecture.md) - Comprehensive technical reference

**Development:**
- [Database Schema](developer/database.md)
- [Queue System](developer/queues.md)
- [Testing](developer/testing.md)
- [Deployment](developer/deployment.md)

**Architecture Decisions:**
- [ADR 001: Namespace Support](adr/001-namespace-support.md)
- [ADR 002: Queue-Based Imports](adr/002-queue-based-imports.md)
- [ADR 003: D1 for Import State](adr/003-d1-for-import-state.md)
- [ADR 004: High-Frequency Agent Commits to a Shared Repo](adr/004-high-frequency-agent-commits.md)
- [ADR 005: Native `git push` via a Smart-HTTP Proxy](adr/005-git-smart-http-proxy.md)
- [ADR 006: SSH Transport for Git](adr/006-ssh-transport.md)
- [ADR 007: Sandbox Evaluator Threat Model and Time Budget](adr/007-sandbox-evaluator-threat-model.md)
- [ADR 008: LLM Provider Seam and BYOK Threat Model](adr/008-llm-provider-byok-threat-model.md)

**Historical Reference:**
- [Archived Documents](archive/README.md) - Code reviews, audits, etc.

## Documentation Status

"Last Updated" is the date of the last substantive commit touching the document.
Refreshed in full on 2026-08-31. "Outline" means the document exists but is a
short stub that needs to be fleshed out.

| Document | Status | Priority | Last Updated |
|----------|--------|----------|--------------|
| ROADMAP.md (Open work) | ✅ Complete | Critical | 2026-08-29 |
| CHANGELOG.md | ✅ Complete | High | 2026-08-31 |
| API OpenAPI Spec | ✅ Complete | High | 2026-08-31 |
| API Authentication | ✅ Complete | High | 2026-08-31 |
| API Endpoints - Projects | ✅ Complete | High | 2026-08-31 |
| API Endpoints - Changes | ✅ Complete | High | 2026-08-31 |
| API Endpoints - Reviews | ✅ Complete | High | 2026-08-31 |
| API Endpoints - Issues | ✅ Complete | High | 2026-08-31 |
| API Endpoints - Users | ✅ Complete | High | 2026-08-31 |
| API Endpoints - Workspaces | 🚧 Outline | Medium | 2026-08-25 |
| API Endpoints - Agents | 🚧 Outline | Medium | 2026-08-25 |
| API Endpoints - Organizations | 🚧 Outline | Medium | 2026-08-25 |
| API Errors | ✅ Complete | Medium | 2026-08-31 |
| User Guide - Getting Started | ✅ Complete | High | 2026-08-31 |
| User Guide - Importing | ✅ Complete | High | 2026-08-31 |
| User Guide - Code Review | ✅ Complete | High | 2026-08-31 |
| User Guide - Issues | ✅ Complete | High | 2026-08-31 |
| User Guide - CI Integration | ✅ Complete | High | 2026-08-31 |
| User Guide - Troubleshooting | ✅ Complete | Medium | 2026-08-31 |
| User Guide - FAQ | ✅ Complete | Medium | 2026-08-31 |
| Developer - Architecture | ✅ Complete | High | 2026-08-31 |
| Developer - Deployment | ✅ Complete | Medium | 2026-08-31 |
| Developer - Local Setup | 🚧 Outline | High | 2026-08-29 |
| Developer - Database | 🚧 Outline | High | 2026-08-25 |
| Developer - Queues | 🚧 Outline | Medium | 2026-08-25 |
| Developer - Testing | 🚧 Outline | Medium | 2026-08-25 |
| ADRs (001-008) | ✅ Complete | Low | 2026-09-06 |

**Legend:** ✅ Complete | 🚧 Outline / In Progress | 📋 Planned

## Contributing to Documentation

### Style Guide

1. **Clear and concise** - Avoid unnecessary jargon
2. **Code examples** - Include working examples
3. **Screenshots** - Add where helpful (for UI docs)
4. **Cross-references** - Link to related docs
5. **Up-to-date** - Keep current with code changes

### File Organization

- Use kebab-case for filenames
- Group related docs in directories
- Include README.md in each directory
- Keep single responsibility per file

### Markdown Standards

- Use ATX-style headers (`#` not `===`)
- Fenced code blocks with language
- Tables for structured data
- Links to other docs use relative paths

### Review Process

1. Update docs with code changes
2. Test all code examples
3. Check links work
4. Request review
5. Deploy with code

## Hosting and publishing

The public subset of these docs is already published at
**[docs.usestratum.dev](https://docs.usestratum.dev/)** — an Astro Starlight
site built from [`website/`](../website/) and served by a Cloudflare Worker
(`website/wrangler.toml`). The Worker exists to add agent-discovery `Link`
headers and Markdown content negotiation; the pages themselves are static.

Two workflows drive it:

- `.github/workflows/docs.yml` — builds on every PR touching `website/**` or
  `docs/**`, and deploys on push to `main`.
- `.github/workflows/deploy-docs.yml` — a manual `workflow_dispatch` deploy,
  guarded to `main` and sharing a concurrency group with the above so the two
  cannot race.

The OpenAPI spec needs no mirroring: `npm run sync:openapi` copies
`docs/api/openapi.yml` into the site's `public/` on every build.

### Keeping the two trees in sync

The user guide and API reference exist twice — here, and as Starlight pages
under `website/src/content/docs/`. **The copies under `docs/` are canonical**;
the website copies are mirrors that differ only in frontmatter and link style
(site-absolute `/guides/…` links between published pages, `github.com` links for
repo files the site does not publish).

You do not mirror by hand. `website/scripts/mirror-docs.mjs` regenerates the
website copies from these files:

```bash
cd website
npm run sync:guides    # regenerate the mirrors, then commit them
npm run check:guides   # exit 1 if any mirror is stale, without writing
```

Edit the copy under `docs/`, never the one under `website/src/content/docs/` —
the next `sync:guides` overwrites a direct edit there. Run `sync:guides` and
commit the result in the same PR as the `docs/` change.

The mirrors are **committed, not generated at build time**: a build that wrote
into tracked source files would leave every builder with a dirty tree. Instead
`.github/workflows/docs.yml` watches `docs/**` and runs `check:guides` before it
builds, so a `docs/` change that was not mirrored fails CI rather than deploying
a silently stale page.

To publish a **new** page: add the canonical file (`docs/user-guide/` for a
guide, `docs/api/` for a reference page), add a `[slug, description]` entry to
the matching list in `mirror-docs.mjs` — `GUIDES` for a guide, `REFERENCE` for
an API reference page, since a page missing from both is simply not mirrored —
then add it to the
`sidebar` in `website/astro.config.mjs`, and add it to `PAGES` in
`website/public/webmcp.js` (a test asserts that list covers every published
page) and to the documentation list in `website/public/index.md`.

## Feedback

Found an issue with the documentation? Please:

1. Open an issue on GitHub
2. Include the document path
3. Describe the problem
4. Suggest improvement (if possible)

## Maintenance

### Regular Tasks

- [ ] Review docs quarterly for accuracy
- [ ] Update API spec with new endpoints
- [ ] Check all code examples work
- [ ] Fix broken links
- [ ] Update screenshots if UI changes

### Versioning

Releases are changelog-driven: see [CHANGELOG.md](../CHANGELOG.md) and the
[release process](developer/releasing.md). When Stratum reaches 1.0:
- Maintain versioned docs
- Archive old versions

## License

Documentation is licensed under the same terms as the code it documents —
[AGPL-3.0-or-later](../LICENSE). See [`LICENSING.md`](../LICENSING.md).
