# Staging Environment Setup

This document details the staging environment configuration and how to work with it.

## Overview

The staging environment provides an isolated copy of the production infrastructure for testing changes before they are deployed to production.

## Infrastructure Components

### Cloudflare Workers

- **Production**: `stratum` (your-instance.workers.dev)
- **Staging**: `stratum-staging` (your-instance-staging.workers.dev)

### D1 Database

| Environment | Database Name | Database ID |
|-------------|---------------|-------------|
| Production | stratum | `de9b583b-d5f3-4868-a1eb-2208b76c7062` |
| Staging | stratum-staging | `85c63ac2-381e-4cd9-9c35-e89dad02df65` |

### KV Namespaces

| Environment | Binding | ID |
|-------------|---------|-----|
| Production | STATE | `2285977f426647cf9e3db347cbc0f03b` |
| Staging | STATE | `18a609aeddac442087de919a12677856` |

### Artifacts (Git Repositories)

- **Production**: `stratum-prod` namespace
- **Staging**: `stratum-staging` namespace

### Queues

| Queue | Production | Staging |
|-------|------------|---------|
| EVENTS_QUEUE | stratum-events | stratum-events (shared) |
| IMPORT_QUEUE | stratum-imports | stratum-imports (shared) |

**Note**: Staging shares the same queues as production by default. Queue consumers are disabled in staging to prevent staging from processing production jobs.

## Configuration (wrangler.toml)

The staging environment is configured in `wrangler.toml`:

```toml
[env.staging]
name = "stratum-staging"

[[env.staging.artifacts]]
binding = "ARTIFACTS"
namespace = "stratum-staging"

[[env.staging.kv_namespaces]]
binding = "STATE"
id = "18a609aeddac442087de919a12677856"

[[env.staging.d1_databases]]
binding = "DB"
database_name = "stratum-staging"
database_id = "85c63ac2-381e-4cd9-9c35-e89dad02df65"
migrations_dir = "migrations"
```

## Deployment

### Automatic Deployment

Staging is automatically deployed when you open or update a Pull Request:

```yaml
# .github/workflows/pr-checks.yml
- name: Deploy to Cloudflare Staging
  run: npx wrangler deploy --env=staging
```

### Manual Deployment

To deploy to staging manually:

```bash
# Deploy current branch to staging
npx wrangler deploy --env=staging

# Deploy with specific vars
npx wrangler deploy --env=staging --var KEY=value
```

### Local Development with Staging Services

You can run locally but connect to staging services:

```bash
# Run dev server with staging bindings
wrangler dev --env=staging --local=false
```

**Warning**: This will use real staging data. Be careful with destructive operations.

## Database Management

### Running Migrations

Staging migrations run automatically on deployment. To run manually:

```bash
# Apply migrations to staging
npx wrangler d1 migrations apply stratum-staging --env=staging

# Check migration status
npx wrangler d1 migrations list stratum-staging --env=staging
```

### Database Queries

Execute SQL queries on staging:

```bash
# Interactive SQL shell
npx wrangler d1 execute stratum-staging --env=staging --command="SELECT * FROM projects LIMIT 5"

# Execute from file
npx wrangler d1 execute stratum-staging --env=staging --file=./query.sql
```

### Resetting Staging Data

**Warning**: This will delete all staging data!

```bash
# Backup first
npx wrangler d1 export stratum-staging --env=staging --output=./staging-backup.sql

# Reset (manual steps required - D1 doesn't have a simple reset)
# You'll need to delete and recreate the database
```

## Testing

### Smoke Tests

Run smoke tests against staging:

```bash
# Set the staging URL
export STAGING_URL=https://your-instance-staging.workers.dev

# Run smoke tests
npm run test:smoke
```

### Manual Testing

1. Access the staging URL from your PR comment
2. Test your changes thoroughly
3. Check browser console for errors
4. Verify API responses in Network tab

### API Testing

```bash
# Health check
curl https://your-instance-staging.workers.dev/health

# Test API endpoint
curl https://your-instance-staging.workers.dev/api/projects

# With authentication
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://your-instance-staging.workers.dev/api/projects
```

## Environment Variables

### Staging-Specific Variables

```toml
[env.staging.vars]
POSTHOG_HOST = "https://app.posthog.com"
OAUTH_REDIRECT_URI = "https://your-instance-staging.workers.dev/auth/github/callback"
```

### Secrets

Staging uses the same secrets as production:

```bash
# Set a secret for staging
npx wrangler secret put SECRET_NAME --env=staging

# List secrets
npx wrangler secret list --env=staging
```

**Important**: Staging and production share secrets by default. Be careful with production secrets!

## Queue Consumers

### Disabled by Default

Queue consumers are commented out in staging to prevent conflicts:

```toml
# [[env.staging.queues.consumers]]
# queue = "stratum-events-staging"
#
# [[env.staging.queues.consumers]]
# queue = "stratum-imports-staging"
```

### Enabling Queue Consumers

To test queue processing in staging:

1. Uncomment the queue consumer sections in `wrangler.toml`
2. Change queue names to staging-specific queues:
   ```toml
   queue = "stratum-events-staging"
   queue = "stratum-imports-staging"
   ```
3. Create the staging queues in Cloudflare dashboard
4. Deploy: `npx wrangler deploy --env=staging`

### Testing Queue Processing

```bash
# Send a test message to staging queue
wrangler queue send stratum-imports-staging '{"type":"github.import",...}'
```

## Logs and Monitoring

### View Logs

```bash
# Tail staging logs
npx wrangler tail --env=staging

# Filter by level
npx wrangler tail --env=staging --format=pretty | grep ERROR
```

### Analytics

Staging uses the same Analytics Engine dataset as production:

- Dataset: `stratum_requests`
- View in Cloudflare dashboard under Analytics > Workers

## Troubleshooting

### Deployment Fails

1. Check wrangler.toml syntax
2. Verify Cloudflare API token permissions
3. Check account ID is correct

```bash
# Test deployment (dry run)
npx wrangler deploy --env=staging --dry-run
```

### Database Connection Issues

1. Verify database ID in wrangler.toml
2. Check database exists in Cloudflare dashboard
3. Ensure migrations have been applied

```bash
# Verify database exists
npx wrangler d1 list
```

### Queue Issues

If staging is processing production jobs:

1. Check queue consumers are disabled in wrangler.toml
2. Verify no staging workers are running old code
3. Check queue names don't overlap

## Best Practices

### Data Management

- Don't put sensitive production data in staging
- Regularly clean up old test data
- Use obvious test names (e.g., `test-project-123`)

### Testing

- Always test on staging before production
- Verify critical paths work end-to-end
- Test error handling and edge cases

### Security

- Staging uses real services - be careful
- Don't use production credentials in staging tests
- Rotate secrets if accidentally exposed

## CI/CD Integration

The staging environment is integrated into the PR workflow:

```yaml
# .github/workflows/pr-checks.yml
jobs:
  deploy-staging:
    if: github.event_name == 'pull_request'
    steps:
      - name: Deploy to Cloudflare Staging
        run: npx wrangler deploy --env=staging

      - name: Smoke test
        run: curl -sfS "$STAGING_URL/health"

      - name: Comment PR with staging URL
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              body: `🚀 Staging: ${process.env.STAGING_URL}`
            });
```

## Related Documentation

- [DEVELOPER_WORKFLOW.md](./DEVELOPER_WORKFLOW.md) - Overall development workflow
- [README.md](../README.md) - Project overview
- Cloudflare Workers Docs: https://developers.cloudflare.com/workers/
- Cloudflare D1 Docs: https://developers.cloudflare.com/d1/
