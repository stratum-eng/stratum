# Stratum Documentation

Welcome to the Stratum documentation. This directory contains comprehensive guides for users, developers, and API consumers.

## Documentation Structure

```
docs/
├── README.md                           # This file
├── api/                                # API Documentation
│   ├── openapi.yml                     # OpenAPI 3.1.0 specification
│   ├── authentication.md               # Authentication methods
│   ├── errors.md                       # Error codes reference
│   └── endpoints/                      # Endpoint documentation
│       ├── README.md                   # Overview
│       ├── projects.md                 # Project API
│       ├── workspaces.md               # Workspace API
│       ├── changes.md                  # Changes API
│       ├── agents.md                   # Agents API
│       ├── users.md                    # Users API
│       └── organizations.md            # Organizations API
├── user-guide/                         # User Documentation
│   ├── README.md                       # User guide overview
│   ├── getting-started.md              # First steps tutorial
│   ├── importing.md                    # GitHub import guide
│   ├── troubleshooting.md              # Problem solving
│   └── faq.md                          # Frequently asked questions
├── developer/                          # Developer Documentation
│   ├── README.md                       # Developer guide overview
│   ├── architecture.md                 # System architecture
│   ├── local-setup.md                  # Development environment
│   ├── database.md                     # Database schema
│   ├── queues.md                       # Queue system
│   ├── testing.md                      # Testing guide
│   └── deployment.md                   # Deployment procedures
└── adr/                                # Architecture Decision Records
    ├── 001-namespace-support.md
    ├── 002-queue-based-imports.md
    └── 003-d1-for-import-state.md
```

## Quick Navigation

### For Users

**Getting Started:**
1. [User Guide Overview](user-guide/README.md)
2. [Getting Started](user-guide/getting-started.md)
3. [Importing from GitHub](user-guide/importing.md)

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
- [Agents](api/endpoints/agents.md)

**Reference:**
- [Error Codes](api/errors.md)

### For Developers

**Getting Started:**
1. [Developer Guide Overview](developer/README.md)
2. [Local Setup](developer/local-setup.md)
3. [Architecture](developer/architecture.md)

**Development:**
- [Database Schema](developer/database.md)
- [Queue System](developer/queues.md)
- [Testing](developer/testing.md)
- [Deployment](developer/deployment.md)

**Architecture:**
- [ADR 001: Namespace Support](adr/001-namespace-support.md)
- [ADR 002: Queue-Based Imports](adr/002-queue-based-imports.md)
- [ADR 003: D1 for Import State](adr/003-d1-for-import-state.md)

## Documentation Status

| Document | Status | Priority | Last Updated |
|----------|--------|----------|--------------|
| API OpenAPI Spec | ✅ Complete | High | 2024-01-15 |
| API Authentication | ✅ Complete | High | 2024-01-15 |
| API Endpoints | ✅ Complete | High | 2024-01-15 |
| API Errors | ✅ Complete | Medium | 2024-01-15 |
| User Guide - Getting Started | ✅ Complete | High | 2024-01-15 |
| User Guide - Importing | ✅ Complete | High | 2024-01-15 |
| User Guide - Troubleshooting | ✅ Complete | Medium | 2024-01-15 |
| User Guide - FAQ | ✅ Complete | Medium | 2024-01-15 |
| Developer - Architecture | ✅ Complete | High | 2024-01-15 |
| Developer - Local Setup | ✅ Complete | High | 2024-01-15 |
| Developer - Database | ✅ Complete | High | 2024-01-15 |
| Developer - Queues | ✅ Complete | Medium | 2024-01-15 |
| Developer - Testing | ✅ Complete | Medium | 2024-01-15 |
| Developer - Deployment | ✅ Complete | Medium | 2024-01-15 |
| ADRs | ✅ Complete | Low | 2024-01-15 |

**Legend:** ✅ Complete | 🚧 In Progress | 📋 Planned

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

## Hosting/Publishing

### Options

1. **GitHub Pages** (Recommended)
   - Free hosting
   - Version controlled
   - Integrated with repo

2. **ReadTheDocs**
   - Better search
   - Versioning support
   - PDF generation

3. **Vercel**
   - Fast CDN
   - Preview deployments
   - Custom domains

4. **Cloudflare Pages**
   - Native to stack
   - Fast globally
   - Integrated with Workers

### Setup for GitHub Pages

```yaml
# .github/workflows/docs.yml
name: Deploy Documentation

on:
  push:
    branches: [main]
    paths: [docs/**]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node
        uses: actions/setup-node@v3
        
      - name: Install dependencies
        run: npm install -g @redocly/cli
        
      - name: Build docs
        run: |
          mkdir -p _site
          cp -r docs/* _site/
          redocly build-docs docs/api/openapi.yml -o _site/api/index.html
          
      - name: Deploy to GitHub Pages
        uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./_site
```

## Documentation Gaps

### Known Gaps

1. **UI Screenshots** - Web UI documentation lacks visual guides
2. **Video Tutorials** - No video walkthroughs yet
3. **Interactive API Explorer** - OpenAPI spec exists but no hosted explorer
4. **Changelog** - No formal changelog documentation
5. **Migration Guides** - No guides for migrating from other platforms

### Planned Additions

1. **CLI Documentation** - When CLI tool is built
2. **Advanced Topics** - Performance tuning, scaling
3. **Case Studies** - Real-world usage examples
4. **API SDKs** - Client library documentation
5. **Contributing Guide** - Detailed contribution guidelines

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

When Stratum reaches 1.0:
- Maintain versioned docs
- Keep changelog
- Archive old versions

## License

Documentation is licensed under the same MIT license as the project.
