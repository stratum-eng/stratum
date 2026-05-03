# PR: Option B - New Features

## Overview
Add new import capabilities including sync, multiple providers, bulk imports, and templates.

## Tasks

### 1. Git Sync Feature
**Agent Assignment**: Task worker
**Priority**: HIGH

Keep imported repos in sync with GitHub:
- Add `sync` queue message type
- Create scheduled job to check for updates
- Detect new commits on default branch
- Auto-sync or manual sync option
- Conflict resolution UI

**Files**:
- Modify: `src/queue/import-queue.ts`
- New: `src/routes/sync.ts` (expand existing)
- Modify: `src/ui/pages/repo.tsx`

### 2. GitLab/Bitbucket Support
**Agent Assignment**: Task worker
**Priority**: MEDIUM

Support imports from other git providers:
- Abstract git operations (clone, fetch, etc.)
- GitLab API integration
- Bitbucket API integration
- Provider-specific auth (tokens)
- UI provider selector

**Files**:
- New: `src/storage/git-providers/
- New: `src/storage/git-providers/github.ts`
- New: `src/storage/git-providers/gitlab.ts`
- New: `src/storage/git-providers/bitbucket.ts`
- Modify: `src/routes/projects.ts`
- Modify: `src/ui/pages/new-project.tsx`

### 3. Bulk Import
**Agent Assignment**: Task worker
**Priority**: MEDIUM

Import multiple repos at once:
- CSV/JSON upload format
- GitHub org/repo list import
- Progress tracking for batch
- Partial failure handling
- Results report

**Files**:
- New: `src/routes/bulk-import.ts`
- New: `src/ui/pages/bulk-import.tsx`
- Modify: `src/queue/import-queue.ts`

### 4. Import Templates
**Agent Assignment**: Task worker
**Priority**: LOW

Pre-configured project templates:
- Template definitions (React, Node, Python, etc.)
- Template repository structure
- Default files and configs
- Post-import setup hooks

**Files**:
- New: `src/templates/
- New: `src/templates/react.json`
- New: `src/templates/node.json`
- New: `src/templates/python.json`
- Modify: `src/routes/projects.ts`

## Acceptance Criteria
- [ ] Can sync existing imports with upstream
- [ ] Can import from GitLab and Bitbucket
- [ ] Can bulk import multiple repos
- [ ] Can create projects from templates
- [ ] All providers have auth flow
- [ ] UI supports all new features
- [ ] Tests for all new functionality
- [ ] Documentation updated

## Dependencies
- Option A (metrics) helpful for monitoring bulk imports
