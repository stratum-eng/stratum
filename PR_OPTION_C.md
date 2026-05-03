# PR: Option C - Infrastructure Improvements

## Overview
Set up proper staging environment, PR-based CI/CD, and integration tests.

## Tasks

### 1. Staging Environment Setup
**Agent Assignment**: Task worker
**Priority**: HIGH

Create proper staging environment:
- Staging D1 database
- Staging KV namespace
- Staging Queue
- Staging Artifacts namespace
- Update wrangler.toml with staging env
- Staging secrets management

**Files**:
- Modify: `wrangler.toml`
- New: `.github/workflows/deploy-staging.yml`

### 2. PR-Based CI/CD Workflow
**Agent Assignment**: Task worker
**Priority**: HIGH

Create GitHub Actions workflow:
- Run on PR creation/update
- Run full test suite
- Deploy to staging environment
- Run smoke tests against staging
- Require approval for production
- Block merge on failures

**Files**:
- New: `.github/workflows/pr-checks.yml`
- Modify: `.github/workflows/ci.yml` (production)

### 3. Integration Tests for Queue
**Agent Assignment**: Task worker
**Priority**: MEDIUM

Test actual queue processing:
- Test message enqueuing
- Test queue consumer execution
- Test retry logic
- Test DLQ (dead letter queue)
- Mock external services

**Files**:
- New: `tests/integration/queue.test.ts`
- New: `tests/integration/import-flow.test.ts`
- Modify: `vitest.config.ts` (integration config)

### 4. Environment Parity
**Agent Assignment**: Task worker
**Priority**: MEDIUM

Ensure staging matches production:
- Same bindings and services
- Similar data volumes
- Feature flags for gradual rollout
- Database migration testing

**Files**:
- Modify: `wrangler.toml`
- New: `scripts/verify-environment.ts`

### 5. Smoke Tests
**Agent Assignment**: Task worker
**Priority**: MEDIUM

Post-deployment verification:
- Health check passes
- Critical paths work
- Import can be created
- Queue processes messages

**Files**:
- New: `tests/smoke/health.test.ts`
- New: `tests/smoke/import.test.ts`
- Modify: `.github/workflows/ci.yml`

## Acceptance Criteria
- [ ] Staging environment fully configured
- [ ] PRs deploy to staging automatically
- [ ] Production requires manual approval
- [ ] Integration tests run in CI
- [ ] Smoke tests run post-deployment
- [ ] Failed deployments rollback automatically
- [ ] Environment parity verified

## Workflow

### Developer Flow:
1. Create feature branch
2. Open PR
3. CI runs tests + deploys to staging
4. Review + CodeRabbit feedback
5. Merge to main
6. Deploy to production (manual)

## Files Modified
- Modify: `wrangler.toml`
- New: `.github/workflows/pr-checks.yml`
- Modify: `.github/workflows/ci.yml`
- New: Multiple test files
- New: Scripts for environment management
