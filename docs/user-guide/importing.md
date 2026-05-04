# Importing from GitHub

## Quick Import

```bash
curl -X POST /api/projects/@username/repo/import \
  -d '{"url": "https://github.com/owner/repo"}'
```

## Track Progress

Check status via polling or SSE stream.

## Sync

Keep your Stratum project in sync with GitHub.
