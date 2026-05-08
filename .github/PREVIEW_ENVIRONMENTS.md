# PR Preview Environments

This repository uses isolated preview environments for each Pull Request. Each PR gets its own:
- **Cloudflare Worker** (e.g., `stratum-pr-34`)
- **D1 Database** (e.g., `stratum-pr-34`)
- **KV Namespace** (e.g., `stratum-preview-state-pr-34`)
- **Subdomain** (e.g., `pr-34.staging.app.usestratum.dev`)

## How It Works

### On PR Open/Sync
1. Creates a new D1 database for the PR
2. Applies all migrations to the database
3. Deploys a Worker with the PR's code
4. Creates a DNS record for `pr-{NUMBER}.staging.app.usestratum.dev`
5. Posts a comment on the PR with the preview URL

### On PR Close/Merge
1. Deletes the D1 database
2. Deletes the Worker
3. Deletes the KV namespace
4. Posts a comment confirming cleanup

## Setup Required

Add these secrets to your GitHub repository:

- `CLOUDFLARE_API_TOKEN` - API token with permissions for:
  - Zone:Read, Zone:Edit (for DNS management)
  - Cloudflare Workers:Edit, Cloudflare Workers Scripts:Edit
  - D1:Read, D1:Edit (for database management)

- `CLOUDFLARE_ACCOUNT_ID` - Your Cloudflare account ID

- `CLOUDFLARE_ZONE_ID` - Zone ID for `usestratum.dev`

No KV secret is required — the workflow automatically creates a per-PR KV namespace (`stratum-preview-state-pr-{NUMBER}`) using `CLOUDFLARE_API_TOKEN` and deletes it when the PR closes.

## DNS Configuration

Ensure you have a wildcard DNS record:
```txt
*.staging.app.usestratum.dev → CNAME → your-workers-subdomain.workers.dev
```

## Benefits

✅ **Isolation**: Each PR has its own database and KV namespace — no cross-PR state bleed  
✅ **Testing**: Test freely without affecting other PRs or staging  
✅ **Free**: Uses Cloudflare's generous free tier  
✅ **Auto-cleanup**: Resources are automatically deleted when PR closes  
✅ **Full Features**: Custom domain gives you access to all Worker features (email, etc.)

## Limitations

- D1 databases have a limit (free tier: 500MB per DB, 10GB total)
- Preview environment databases persist data between PR syncs (databases are reused when the deploy job's "Create D1 Database" step finds an existing database by name), and are only deleted when the PR is closed or merged
- Old/unused databases should be manually cleaned if you hit limits
