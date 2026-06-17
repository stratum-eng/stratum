# Deployment Guide

This document covers deployment procedures for Stratum to Cloudflare Workers.

## Overview

Stratum deploys to Cloudflare Workers with:
- **Production**: `your-instance.workers.dev`
- **Staging**: `your-instance-staging.workers.dev`

## Prerequisites

- Cloudflare account
- Wrangler CLI authenticated
- Access to required Cloudflare services:
  - Workers
  - D1
  - KV
  - Artifacts
  - Queues

## Environments

### Production

```toml
# wrangler.toml (default)
name = "stratum"
main = "src/index.ts"

[[artifacts]]
binding = "ARTIFACTS"
namespace = "stratum-prod"

[[kv_namespaces]]
binding = "STATE"
id = "your-kv-id"

[[d1_databases]]
binding = "DB"
database_name = "stratum"
database_id = "your-d1-id"
```

### Staging

```toml
[env.staging]
name = "stratum-staging"

[[env.staging.artifacts]]
binding = "ARTIFACTS"
namespace = "stratum-staging"

[[env.staging.kv_namespaces]]
binding = "STATE"
id = "your-staging-kv-id"

[[env.staging.d1_databases]]
binding = "DB"
database_name = "stratum-staging"
database_id = "your-staging-d1-id"
```

## Deployment Process

### Manual Deployment

**Staging:**
```bash
# Deploy to staging
npx wrangler deploy --env=staging

# Apply database migrations
npx wrangler d1 migrations apply stratum-staging --env=staging --remote
```

**Production:**
```bash
# Deploy to production
npx wrangler deploy

# Apply database migrations
npx wrangler d1 migrations apply stratum --remote
```

### Automated Deployment (GitHub Actions)

```yaml
# .github/workflows/deploy-staging.yml
name: Deploy to Staging

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - uses: actions/setup-node@v3
        with:
          node-version: 20
          
      - run: npm ci
      
      - run: npm run lint
      
      - run: npm run typecheck
      
      - run: npm test
      
      - name: Deploy to Staging
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          command: deploy --env=staging
          
      - name: Apply Migrations
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          command: d1 migrations apply stratum-staging --env=staging --remote
```

```yaml
# .github/workflows/deploy-production.yml
name: Deploy to Production

on:
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v3
        with:
          ref: main
          
      - uses: actions/setup-node@v3
        with:
          node-version: 20
          
      - run: npm ci
      
      - run: npm test
      
      - name: Deploy to Production
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          command: deploy
          
      - name: Apply Migrations
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          command: d1 migrations apply stratum --remote
```

## Pre-Deployment Checklist

### Code Quality

- [ ] All tests passing
- [ ] Linting passes (`npm run lint`)
- [ ] Type checking passes (`npm run typecheck`)
- [ ] Code review approved
- [ ] No console.log statements (use logger)

### Database

- [ ] Migrations written and tested locally
- [ ] Migrations are idempotent
- [ ] Backwards compatible (if needed)
- [ ] Migration order is correct

### Configuration

- [ ] Environment variables set
- [ ] Secrets configured (`wrangler secret put`)
- [ ] Bindings configured in wrangler.toml
- [ ] Domain/routing configured

### Testing

- [ ] Tested locally
- [ ] Tested on staging
- [ ] Critical paths verified
- [ ] Performance acceptable

## Database Migrations

### Creating Migrations

```bash
# Create new migration file
touch migrations/013_add_feature.sql
```

**Migration Template:**
```sql
-- migrations/013_add_feature.sql
-- Description: Add X feature to support Y

-- Create new table
CREATE TABLE IF NOT EXISTS new_feature (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Add column to existing table
ALTER TABLE existing_table ADD COLUMN new_column TEXT;

-- Create index
CREATE INDEX IF NOT EXISTS idx_new_feature_name ON new_feature(name);

-- Backfill data (if needed)
UPDATE existing_table SET new_column = 'default' WHERE new_column IS NULL;
```

### Testing Migrations

```bash
# Test locally
npx wrangler d1 migrations apply stratum --local

# Verify schema
npx wrangler d1 execute stratum --local --command ".schema"

# Rollback (manual)
npx wrangler d1 execute stratum --local --command "DROP TABLE new_feature"
```

### Deployment Order

1. **Apply migrations first** - Before code deployment
2. **Deploy code** - New code uses new schema
3. **Verify** - Check application health

### Rollback Procedure

**If migration fails:**
```bash
# Check status
npx wrangler d1 execute stratum --remote --command "SELECT * FROM d1_migrations"

# Manual rollback (if needed)
npx wrangler d1 execute stratum --remote --command "<rollback SQL>"
```

## Secrets Management

### Setting Secrets

**Production:**
```bash
# GitHub OAuth
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET

# Email
npx wrangler secret put EMAIL_FROM_ADDRESS

# Analytics
npx wrangler secret put POSTHOG_API_KEY
```

**Staging:**
```bash
npx wrangler secret put GITHUB_CLIENT_ID --env=staging
npx wrangler secret put GITHUB_CLIENT_SECRET --env=staging
```

### Viewing Secrets

```bash
# List secrets (names only)
npx wrangler secret list

# For staging
npx wrangler secret list --env=staging
```

⚠️ **Note:** Secret values cannot be retrieved after setting.

## Monitoring Deployments

### Logs

```bash
# Tail production logs
wrangler tail

# Tail staging logs
wrangler tail --env=staging

# Filter for errors
wrangler tail --format pretty | grep "ERROR"
```

### Health Checks

```bash
# Check service health
curl https://your-instance.workers.dev/health

# Expected response
{"status": "ok", "service": "stratum"}
```

### Metrics

Monitor via Cloudflare Dashboard:
- Request volume
- Error rates
- CPU time
- Memory usage

## Rollback Strategy

### Code Rollback

```bash
# Rollback to previous version
git log --oneline

# Deploy previous commit
npx wrangler deploy --version <previous-version>
```

Or via GitHub Actions:
1. Revert the commit
2. Push to trigger new deployment

### Database Rollback

⚠️ **Caution:** Data loss possible

```bash
# If migration needs rollback
# 1. Create rollback migration
# 2. Apply rollback
npx wrangler d1 migrations apply stratum --remote
```

### Emergency Procedures

**Service Down:**
1. Check Cloudflare status
2. Check logs: `wrangler tail`
3. Rollback to last known good version
4. Enable maintenance mode (if implemented)

**Database Issues:**
1. Check D1 status in dashboard
2. Review recent migrations
3. Consider restoring from backup (if available)

## Performance Optimization

### Before Deployment

1. **Bundle size check:**
```bash
npm run build
ls -la dist/
```

2. **Test cold start:**
```bash
wrangler dev --local
# Measure first request time
```

### Post-Deployment

1. **Monitor p95 latency:**
```bash
# Via Cloudflare Dashboard
# Analytics → Workers → stratum
```

2. **Check error rates:**
```bash
wrangler tail | grep "ERROR"
```

## Environment Variables

### Non-Secret Variables

Set in `wrangler.toml`:

```toml
[vars]
POSTHOG_HOST = "https://app.posthog.com"
OAUTH_REDIRECT_URI = "https://your-instance.workers.dev/auth/github/callback"
STRATUM_TELEMETRY_DISABLED = "false"

[env.staging.vars]
OAUTH_REDIRECT_URI = "https://your-instance-staging.workers.dev/auth/github/callback"
STRATUM_TELEMETRY_DISABLED = "true"
```

### Per-Environment Configuration

```typescript
// In code
const redirectUri = c.env.OAUTH_REDIRECT_URI;
const isStaging = redirectUri.includes("staging");
```

## Blue-Green Deployment

For zero-downtime deployments:

1. **Deploy to green environment:**
```bash
# Deploy with different name
name = "stratum-green"
npx wrangler deploy
```

2. **Test green environment**

3. **Switch traffic:**
   - Update DNS/routing
   - Or use Cloudflare Load Balancing

4. **Keep blue for rollback:**
```bash
# Old version remains as "stratum"
# Can switch back quickly
```

## Security Considerations

### Pre-Deployment Security Check

- [ ] No hardcoded secrets
- [ ] Dependencies scanned (`npm audit`)
- [ ] Input validation in place
- [ ] Rate limiting configured
- [ ] CORS properly configured

### Security Headers

Verify security headers in responses:

```bash
curl -I https://your-instance.workers.dev/api/projects

# Expected:
# X-Content-Type-Options: nosniff
# X-Frame-Options: DENY
```

## Troubleshooting

### Deployment Fails

**Check:**
1. Wrangler authentication: `npx wrangler whoami`
2. Valid wrangler.toml
3. All bindings configured
4. No syntax errors in code

### Migration Fails

**Check:**
1. Migration file syntax
2. Idempotency (IF NOT EXISTS)
3. No conflicting migrations
4. Database connectivity

### Service Unavailable After Deploy

**Check:**
1. Logs for errors: `wrangler tail`
2. Health endpoint: `/health`
3. Secrets configured correctly
4. Bindings accessible

### High Error Rate

**Check:**
1. Recent code changes
2. Database migrations
3. External dependencies
4. Resource limits hit

## Maintenance Windows

### Scheduled Maintenance

1. **Announce:** Notify users in advance
2. **Enable maintenance mode:** (if implemented)
3. **Deploy:** During low-traffic period
4. **Verify:** All systems operational
5. **Disable maintenance mode:**

### Database Maintenance

```bash
# Backup before major changes
npx wrangler d1 export stratum --remote --output=backup-$(date +%Y%m%d).sql

# Apply changes
npx wrangler d1 migrations apply stratum --remote
```

## Checklist Templates

### Minor Deployment

- [ ] Tests passing
- [ ] Code reviewed
- [ ] Deploy to staging
- [ ] Verify on staging
- [ ] Deploy to production
- [ ] Verify health check
- [ ] Monitor for 30 minutes

### Major Deployment

- [ ] All tests passing
- [ ] Load testing complete
- [ ] Documentation updated
- [ ] Migration tested
- [ ] Rollback plan prepared
- [ ] Deploy to staging
- [ ] QA sign-off on staging
- [ ] Schedule maintenance window
- [ ] Backup database
- [ ] Deploy to production
- [ ] Run smoke tests
- [ ] Monitor for 2 hours
- [ ] Team notification sent

## See Also

- [Wrangler Documentation](https://developers.cloudflare.com/workers/wrangler/)
- [Workers Deployment](https://developers.cloudflare.com/workers/platform/deployments/)
- [D1 Migrations](https://developers.cloudflare.com/d1/platform/migrations/)
- [Architecture Overview](./architecture.md)
