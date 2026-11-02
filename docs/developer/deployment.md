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

[[r2_buckets]]
binding = "BACKUPS"
bucket_name = "stratum-backups"
```

Backups also read these optional vars (see the
[backup/restore runbook](../runbooks/backup-restore.md)):
`BACKUP_ENCRYPTION_SECRET` (set in production — encrypts backup blobs),
`BACKUP_RETENTION` (runs to keep, default 14), `MAX_REPOS_PER_RUN` (default 25),
`MAX_BACKUP_BYTES` (per-repo budget, default 128 MiB). The daily backup runs on
its own `0 4 * * *` cron — isolated from the `0 6 * * *` housekeeping so a slow
project sync can't starve it of the invocation budget.

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

[[env.staging.r2_buckets]]
binding = "BACKUPS"
bucket_name = "stratum-backups-staging"
```

Staging has no backup cron; trigger runs manually via `POST /api/admin/backup`
to validate the restore path (including the Artifacts push, which CI cannot
cover).

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

# Analytics — each request event carries the request properties: the matched
# route pattern (e.g. /:namespace/:slug/files), method, status, and latency;
# concrete paths (namespaces, repo slugs, change ids, file paths) are never
# sent. A request that never reached a registered route (e.g. rejected by
# global middleware before routing) is captured with route: "*"; a 404 is
# excluded entirely, not captured with route: "*". Events also carry identity
# attribution: distinctId is the acting user/agent id, or "server" for
# unattributed requests (those are marked $process_person_profile: false so
# no person profile is created). Note: the event property was renamed
# `path` -> `route`; dashboards and queries keyed on `path` must switch to
# `route` — old `path` references receive no new data.
#
# A second stream, stratum.<event type>, is emitted per repository activity by
# the queue consumer; it carries the event type, actor type, and an opaque
# projectId. Note: it previously carried `project`, the concrete project NAME —
# that property was removed (#257) because it identified private source the
# request path already redacts. Dashboards grouping on `project` must switch to
# `projectId`; old `project` references receive no new data.
#
# Both streams are suppressed for a user who has turned analytics off in
# Settings → Privacy, and for agents whose owner has.
npx wrangler secret put POSTHOG_API_KEY

# Backups — encrypts backup blobs at rest (D1 dumps contain secrets).
# Restore requires this exact value; do not rotate without retaining the old one.
npx wrangler secret put BACKUP_ENCRYPTION_SECRET
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

### Dev-login (local only)

`GET /dev-login` mints a session without credentials and is gated on the
`DEV_LOGIN_ENABLED` var being `"true"` **and** a localhost request host. It is set
`"true"` in the top-level `[vars]` for local `wrangler dev`; named environments do
not inherit top-level vars, so `[env.production]` and `[env.staging]` declare it
explicitly as `DEV_LOGIN_ENABLED = "false"`. Any value other than `"true"` keeps
the route inert, but declaring it `"false"` makes the intent provable (and stops
wrangler warning about the missing per-environment override). Never set it
`"true"` outside local dev.

### Security headers

All non-git responses carry `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, HSTS
(over HTTPS), and a CSP of `frame-ancestors 'none'; object-src 'none'; base-uri
'self'`. The CSP intentionally omits `script-src`: the server-rendered UI uses
inline event handlers that a `script-src` policy would break. Git smart-HTTP
responses are exempt.

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

Two endpoints, with different jobs:

```bash
# Liveness ping — static, does not touch the data plane. Use for uptime monitors.
curl https://your-instance.workers.dev/health
# {"status": "ok", "service": "stratum"}

# Deep health — checks D1 (incl. load-bearing schema), KV, queue, and artifacts.
# Used by the deploy smoke tests: returns HTTP 503 on any critical failure.
curl -i https://your-instance.workers.dev/api/health
```

`/api/health` severity model:

- **`unhealthy` → HTTP 503**: any *critical* dependency (database, KV, artifacts) is down, or the
  database is reachable but missing a load-bearing table (unapplied migrations — the #118 failure
  mode). Deploy smoke tests gate on this, so a broken data plane fails the deploy instead of
  shipping green.
- **`degraded` → HTTP 200**: only the non-critical queue is down (async delivery degrades; the app
  still serves).
- **`healthy` → HTTP 200**: all checks pass.

### Metrics

Monitor via Cloudflare Dashboard:
- Request volume
- Error rates
- CPU time
- Memory usage

## Rollback Strategy

### Code Rollback

Cloudflare keeps previous Worker versions, so a rollback re-points the Worker at
a prior version — no rebuild or redeploy needed.

> **Worker-code only.** `wrangler rollback` reverts the deployed **code**, not the
> database. It does **not** undo an applied D1 migration or restore data — if the
> bad version also ran a migration, roll the schema/data back separately (see
> **Database Rollback**). Always pass an explicit `--env` so you act on the
> intended environment.

```bash
# Find the version to roll back to (lists the 10 most recent deployments + IDs)
npx wrangler deployments list --env=production
npx wrangler deployments list --env=staging

# Roll back to the previous version (prompts to confirm)…
npx wrangler rollback --env=production --message "reason for rollback"
# …or roll back to a specific version by ID (quote it — bash reads <…> as redirection)
VERSION_ID="paste-the-ID-from-the-list-above"
npx wrangler rollback "$VERSION_ID" --env=production --message "reason for rollback"
```

Or via git: revert the offending commit and push — this triggers a fresh forward
deploy of the reverted code (slower than `wrangler rollback`, but re-runs CI).

### Database Rollback

⚠️ **Caution:** D1 migrations are **forward-only** — there is no down-migration
and no `wrangler d1 migrations rollback`. To reverse a schema change:

1. Write a **new** migration that undoes it (e.g. drop the added column/table).
   Note SQLite's limited `ALTER TABLE DROP COLUMN` support — a table rebuild may
   be required.
2. **Validate on staging first.** Apply the corrective migration to staging and
   confirm the schema/app are healthy before touching production:
   `npx wrangler d1 migrations apply stratum-staging --env=staging --remote`.
3. **Back up and verify before the production migration.** Trigger a backup
   (`POST /api/admin/backup`) and verify it via the restore-plan check in the
   [backup/restore runbook](../runbooks/backup-restore.md), then apply forward:
   `npx wrangler d1 migrations apply stratum --env=production --remote`.
4. If the bad migration **destroyed or corrupted data**, a forward "undo" only
   fixes the schema — you must restore the data. Restore a **verified,
   last-known-good** backup (⚠️ *not* necessarily the most recent — a backup taken
   after the corruption contains it). Restore it into a fresh/staging instance and
   validate the data **before** promoting to production, per the runbook.

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
STRATUM_ENVIRONMENT = "production"

[env.staging.vars]
OAUTH_REDIRECT_URI = "https://your-instance-staging.workers.dev/auth/github/callback"
STRATUM_TELEMETRY_DISABLED = "true"
STRATUM_ENVIRONMENT = "staging"
```

> **Named environments do not inherit top-level `[vars]` — they replace them.**
> Setting `STRATUM_TELEMETRY_DISABLED` only under `[vars]` has no effect on
> `wrangler deploy --env=production` or `--env=staging` (what `npm run
> deploy:production` and `deploy:staging` run). Declare it in **each**
> `[env.<name>.vars]` block you actually deploy, or the switch stays off.
>
> The same applies to `STRATUM_ENVIRONMENT`, which labels every analytics event
> so staging traffic can be told apart from production's in one PostHog
> project. An instance that leaves it unset reports `environment: "unknown"` —
> harmless, but every funnel built across both deployments is then wrong.

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
