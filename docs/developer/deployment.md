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
`MAX_BACKUP_BYTES` (per-repo budget, default 128 MiB), and
`BACKUP_PINNED_PROJECTS` (comma-separated `@namespace/slug` projects snapshotted
in every run, on top of `MAX_REPOS_PER_RUN`). The daily backup runs on
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

Staging also binds `REPO_OBJECTS` (`stratum-repo-objects-staging`) for the fast
merge path. Any bucket bound as `REPO_OBJECTS` needs the `staged-sha/` lifecycle
rule from the [staged-tree retention runbook](../runbooks/staged-tree-retention.md).
Without it, staged-tree copies for unmerged commits are never reclaimed.

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
# GitHub OAuth — an OAuth App (Settings -> Developer settings -> OAuth Apps),
# NOT a GitHub App. Its "Authorization callback URL" must equal this env's
# OAUTH_REDIRECT_URI exactly. GitHub allows one callback per app, so production,
# staging, and local each need their own app.
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET

# Google OAuth — a Web application client in Google Cloud console (APIs &
# Services -> Credentials), with this env's GOOGLE_REDIRECT_URI listed under
# "Authorized redirect URIs". Google's OAuth policies ask for a separate Cloud
# project per deployment tier, so give production, staging, and local each
# their own client rather than sharing one. The requested scopes are
# openid/email/profile only, which keeps the consent screen in the
# non-sensitive tier.
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET

# GitHub App — outbound GitHub calls (sync, PR promotion push + create, eval
# verdict comments/statuses). A GitHub App this time, separate from the OAuth
# App above. Permissions: Contents RW, Pull requests RW, Commit statuses RW,
# Metadata R. Without Workflows RW, GitHub rejects a promotion push whose
# history touches .github/workflows/. Grant it only if agents' promoted
# changes may edit CI: it lets a pushed branch change what your workflows run.
# Webhook events: push, pull_request, pull_request_review (the
# installation events arrive without subscribing). For a repo the app is
# installed on, Stratum mints a 1h installation token and caches it in KV.
# Elsewhere it uses GITHUB_TOKEN, but only for owners bound in
# GITHUB_ALLOWED_OWNERS below. The private key MUST be PKCS#8
# (`-----BEGIN PRIVATE KEY-----`): WebCrypto can't import the PKCS#1 key GitHub
# downloads, so convert it first:
#   openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem
#
# Set the app's "Setup URL" to https://<host>/github/app/setup (tick "Redirect
# on update"). An installation token is only used for projects whose owner the
# installation is LINKED to there, or whom an operator binding below names.
# Without one of the two, any user could import another org's repo and act on
# it with that org's installation. Only the GitHub user who installed the app
# can link it (the installation.created webhook's sender), or, for an
# installation on a personal GitHub account, that account's owner. An
# installation on an ORGANIZATION made before this webhook handling existed
# has no recorded installer: reinstall the app (preferred), or bind its owner
# below. A personal-account installation can be linked as is.
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < app.pkcs8.pem
# Optional operator bindings: comma-separated githubOwner=org:<orgId> or
# githubOwner=user:<userId> entries. Each lets that Stratum org or user (and,
# for a user, their agents) act on that GitHub owner's repos without an
# installation link, and is the ONLY way any project can use GITHUB_TOKEN.
# Bindings take stable ids, never @namespaces: a namespace can be renamed or
# deleted and then claimed by someone else. Any other entry is ignored.
# Find the id with
#   npx wrangler d1 execute <db> --remote --command "SELECT id FROM orgs WHERE slug='stratum'"
#   (or "SELECT id FROM users WHERE username='you'")
# or, signed in as a member, GET /api/orgs/<slug> (org.id) / GET /api/users/me (id).
# A plain var, not a secret: add it under [vars] / --var, e.g.
#   GITHUB_ALLOWED_OWNERS = "stratum-eng=org:org_0123abcd..."
# (GITHUB_APP_ALLOWED_OWNERS, the former name, is still read.)
npx wrangler secret put GITHUB_WEBHOOK_SECRET
# Optional PAT for repos the app isn't installed on (or every repo when no app
# is configured), usable only by owners bound in GITHUB_ALLOWED_OWNERS. A
# PAT-only instance MUST set the bindings, or GitHub sync/promotion stops.
npx wrangler secret put GITHUB_TOKEN

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
npx wrangler secret put GOOGLE_CLIENT_ID --env=staging
npx wrangler secret put GOOGLE_CLIENT_SECRET --env=staging
```

Each provider is independent, and neither blocks magic-link sign-in.
`/auth/github` answers `501 {"error": "GitHub OAuth is not configured"}` until
its pair of secrets is present; `/auth/google` answers the same until its pair
of secrets *and* `GOOGLE_REDIRECT_URI` are present.

A first-time GitHub or Google identity (one matching neither an existing GitHub
id nor an account's email) creates nothing at the callback: it is sent to a
username step, and the account is created when that form is submitted. Staging
runs with `BETA_GATE = "1"`, where that form also demands an invite code —
signing in to staging with a brand-new Google or GitHub account and being asked
for one is the invite gate doing its job, not a misconfigured provider.
Production sets `BETA_GATE = "0"`, where the username alone is enough.

For local `wrangler dev`, put the four secrets in a gitignored `.dev.vars`
rather than in `wrangler.toml`.

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
GOOGLE_REDIRECT_URI = "https://your-instance.workers.dev/auth/google/callback"
STRATUM_TELEMETRY_DISABLED = "false"
# TELEMETRY_CONSENT_AT_SIGNUP = "true"
STRATUM_ENVIRONMENT = "production"

[env.staging.vars]
OAUTH_REDIRECT_URI = "https://your-instance-staging.workers.dev/auth/github/callback"
GOOGLE_REDIRECT_URI = "https://your-instance-staging.workers.dev/auth/google/callback"
STRATUM_TELEMETRY_DISABLED = "true"
STRATUM_ENVIRONMENT = "staging"
```

`OAUTH_REDIRECT_URI` is the **GitHub** callback and `GOOGLE_REDIRECT_URI` the
Google one; the names are asymmetric for backwards compatibility. Because named
environments replace top-level `[vars]` rather than inheriting them, each
`[env.<name>.vars]` block you deploy must declare both — a missing
`GOOGLE_REDIRECT_URI` disables Google sign-in in that environment even when the
secrets are set.

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

`TELEMETRY_CONSENT_AT_SIGNUP` makes telemetry opt-in for **new** accounts. Only
the literal `"true"` turns it on. With it on, every signup form (magic link, the
username step after GitHub or Google, and the approval page of an
agent-requested signup) shows an unticked consent box, and the account is
created with `users.telemetry_opt_out = 1` unless the box was ticked. Accounts
created with nobody to ask — SCIM provisioning, SSO just-in-time, the legacy
`POST /auth/email/send` form, `/dev-login` — are created opted out. The value is
written by the same `INSERT` that creates the account, so there is no window in
which an account that did not consent is opted in. It never changes an existing
account, and it does not affect anonymous capture (requests with no account
behind them). Unset — the default — signup is unchanged: no box, new accounts
opted in. The hosted instance sets it in both `[env.production.vars]` and
`[env.staging.vars]`; like the kill switch, it must be declared in each named
environment you deploy. It is independent of `STRATUM_TELEMETRY_DISABLED`, which
still switches telemetry off for everyone regardless of any account's setting.

#### `DO_JURISDICTION`

Restricts every Durable Object — all four classes — to a Cloudflare
jurisdiction. Accepted values are `eu`, `us` and `fedramp`; unset (the default,
and what production and staging run) means no restriction.

```toml
[vars]
DO_JURISDICTION = "eu"
```

- **It is for a fresh deployment.** A jurisdiction-restricted namespace
  addresses different objects than the unrestricted one, so setting or changing
  this on a deployment that has already run leaves its existing Durable Object
  state unreachable and still stored where it was. See
  [Do not switch an existing deployment](../user-guide/trust.md#do-not-switch-an-existing-deployment)
  for what each class holds.
- **The value must match exactly.** `EU`, `europe` or a value with whitespace is
  rejected: `configGuardMiddleware` answers `503` to every request, `/health`
  included, and logs the reason, and `durableObjectNamespace` throws in queue
  and cron handlers. A typo takes the deployment down instead of leaving it
  unrestricted.
- **Named environments do not inherit it.** Like every var above, it must be
  declared in each `[env.<name>.vars]` block you deploy. Set only under
  top-level `[vars]`, it has no effect on `wrangler deploy --env=…`, and nothing
  can warn about that — to the Worker, unset is the valid default.
- **New Durable Object code must use the helper.** Read a namespace with
  `durableObjectNamespace(env, "REPO_DO")` (`src/utils/durable-objects.ts`),
  never `env.REPO_DO`. `tests/durable-object-jurisdiction.test.ts` fails on a
  direct read, and on a binding added to `wrangler.toml` or `Env` without being
  registered in `DURABLE_OBJECT_BINDINGS`.

This variable is one step of several. The full, ordered procedure — storage
jurisdictions, queues, `workers_dev = false`, Regional Services — and the list
of what it cannot guarantee (queue consumers and cron handlers run wherever
Cloudflare schedules them) is in
[Deploying EU-only](../user-guide/trust.md#deploying-eu-only-self-hosted).

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
