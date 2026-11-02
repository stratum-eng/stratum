# Developer Workflow Guide

This document explains the new PR-based CI/CD workflow and how to use it effectively.

## Overview

The Stratum project uses a PR-based workflow with per-PR preview environments, integration tests, and manual production approvals.

Each PR gets its own isolated preview Worker. The shared staging and production
environments are deployed only from `main`, after the PR merges.

```text
┌─────────────┐    ┌──────────────┐    ┌─────────────┐
│   Create    │───▶│    Push      │───▶│   PR        │   per-PR, isolated
│    PR       │    │   Commits    │    │   Preview   │   (torn down on close)
└─────────────┘    └──────────────┘    └─────────────┘
                                              │
                                              ▼
                                       ┌──────────────┐
                                       │  Automated   │
                                       │    Tests     │
                                       └──────────────┘
                                              │
                                       merge to main
                                              │
                                              ▼
┌─────────────┐    ┌──────────────┐    ┌──────────────┐
│   Staging   │───▶│    Manual    │───▶│  Production  │
│   Deploy    │    │   Approval   │    │    Deploy    │
└─────────────┘    └──────────────┘    └──────────────┘
```

## Creating a Pull Request

### 1. Start a Feature Branch

```bash
git checkout -b feature/my-new-feature
```

### 2. Make Your Changes

Write code, add tests, and update documentation as needed.

### 3. Run Local Checks

Before pushing, run the same checks that CI will run:

```bash
# Run linter
npm run lint

# Run type checker
npm run typecheck

# Run unit tests
npm run test

# Run integration tests
npm run test:integration
```

### 4. Push and Create PR

```bash
git push -u origin feature/my-new-feature
```

Then create a Pull Request on GitHub.

## PR Automation

### Automatic Checks

When you create or update a PR, the following happens automatically:

1. **Lint Check** - Code style and formatting
2. **Type Check** - TypeScript type validation
3. **Unit Tests** - Fast unit test suite
4. **Integration Tests** - Integration test suite
5. **Security Scan** - Secret detection and security checks
6. **Preview Environment** - Deploy an isolated preview Worker for this PR

PRs do **not** deploy to the shared staging Worker. See
[Why PRs don't deploy to staging](#why-prs-dont-deploy-to-staging).

### PR Comments

The CI will automatically comment on your PR with:

- ✅ Preview environment URL
- ✅ Test results summary
- ✅ Links to workflow runs

### Updating Your PR

Every push to your PR branch will:

1. Re-run all checks
2. Update the preview environment
3. Update the PR comment with new information

## Preview Environment

### Accessing Your Preview

Once your PR is open, you can access your changes at:

```text
https://pr-<number>.staging.app.usestratum.dev
```

The exact URL is posted as a comment on your PR. Each preview is a dedicated
`stratum-pr-<number>` Worker with its own D1 database and KV namespace, and it is
destroyed when the PR closes.

### Testing on Your Preview

1. **Manual Testing** - Use the preview URL to manually test your changes
2. **API Testing** - Test API endpoints with tools like curl or Postman
3. **Integration Testing** - Run the smoke tests against it:

```bash
STAGING_URL=https://pr-<number>.staging.app.usestratum.dev \
  npm run test:smoke
```

### Why PRs don't deploy to staging

PR branches used to run `wrangler deploy --env=staging`, publishing over the
single shared `stratum-staging` Worker. Cloudflare records the last-applied
Durable Object migration tag **on the script itself**, so a PR that added a
migration left staging one tag ahead of `main`. Wrangler could not find that tag
in `main`'s `wrangler.toml`, assumed it had been deleted, and replayed the whole
chain from `v1` — which fails on the already-populated `MergeQueue` class:

```text
Cannot apply new-class migration to class 'MergeQueue' that is already
depended on by existing Durable Objects [code: 10074]
```

That red-lined every push to `main`, and with it the production deploy that gates
on staging. Deploying the shared environments from `main` only keeps their
migration state a function of `main`'s `wrangler.toml` alone.

`tests/wrangler-migration-chain.test.ts` guards the other half of the rule: a PR
may append migrations but never remove, rename, reorder, or rewrite one that
`main` already carries.

### Databases

| Environment | D1 database |
|-------------|-------------|
| Production | `stratum` |
| Staging | `stratum-staging` |
| PR preview | `stratum-pr-<number>` |

Staging data is isolated from production and may be reset periodically.

## Merging to Main

### Merge Requirements

Before a PR can be merged to `main`, all checks must pass:

- ✅ Lint check passed
- ✅ Type check passed
- ✅ Unit tests passed
- ✅ Integration tests passed
- ✅ Preview environment deployed
- ✅ Security scan passed

### Merge Process

1. Ensure all checks are green
2. Get code review approval (if required by branch protection)
3. Click "Merge pull request"
4. Delete the branch after merging

## Production Deployment

### Automatic Trigger

Merging to `main` triggers the production deployment workflow, but it requires **manual approval**.

### Approval Process

1. Go to the GitHub Actions tab
2. Find the pending "Deploy Production" workflow
3. Review the changes being deployed
4. Click "Approve and deploy"

### Deployment Steps

Once approved, the following happens:

1. Build and type-check
2. Deploy to Cloudflare Workers (production)
3. Run smoke tests against production
4. Create deployment notification issue

### Monitoring Production

After deployment:

1. Check the health endpoint: `https://stratum.<subdomain>.workers.dev/health`
2. Review the deployment issue created by the workflow
3. Monitor error logs in Cloudflare dashboard

## Testing Strategy

### Test Levels

1. **Unit Tests** (`npm run test`)
   - Fast, isolated tests
   - Run on every PR and push

2. **Integration Tests** (`npm run test:integration`)
   - Test component interactions
   - Run after unit tests pass

3. **Smoke Tests** (`npm run test:smoke`)
   - Test deployed environments
   - Run after staging and production deployments

### Running Tests Locally

```bash
# All unit tests
npm test

# With coverage
npm run test:coverage

# Watch mode
npm run test:watch

# Integration tests only
npm run test:integration

# Smoke tests (requires STAGING_URL or PRODUCTION_URL)
STAGING_URL=https://... npm run test:smoke
```

## Troubleshooting

### Staging Deployment Fails

1. Check the workflow logs in GitHub Actions
2. Verify your code compiles: `npm run typecheck`
3. Check for environment-specific issues (wrangler.toml config)

If the log carries `migration tag "vN", which was not found in your
wrangler.toml file` followed by error 10074, the deployed script's Durable Object
migration tag is ahead of the config being deployed. Reconcile the two — land the
commit that defines the missing tag, rather than deleting tags from
`wrangler.toml`, which only widens the gap.

### Tests Pass Locally but Fail in CI

1. Check for environment differences
2. Verify all dependencies are in `package.json`
3. Check for timing issues (add retries if needed)

### Production Deployment Issues

1. Check the approval workflow status
2. Verify secrets are set correctly
3. Check Cloudflare dashboard for errors

## Best Practices

### Before Creating a PR

- [ ] Code follows style guide (`npm run lint`)
- [ ] All tests pass locally
- [ ] Type checking passes
- [ ] Changes are documented

### PR Description

Include:

- What changed and why
- Testing instructions
- Screenshots (for UI changes)
- Link to related issues

### After Merging

- [ ] Verify staging deployment succeeded
- [ ] Monitor production deployment
- [ ] Test critical paths in production
- [ ] Close related issues

## Environment Differences

| Feature | Local Dev | Staging | Production |
|---------|-----------|---------|------------|
| Database | Local/SQLite | stratum-staging | stratum |
| KV Namespace | Local | stratum-staging | stratum-prod |
| Queue Consumers | No | Optional | Yes |
| Analytics | Disabled | Enabled | Enabled |
| Email Sending | Mock | Test mode | Live |
| GitHub OAuth | Local callback | Staging callback | Production callback |

## Support

If you encounter issues with the workflow:

1. Check the [STAGING_SETUP.md](./STAGING_SETUP.md) guide
2. Review workflow logs in GitHub Actions
3. Ask in the team chat or create an issue
