# ADR 003: D1 for Import State

## Status

Accepted

## Context

Import jobs need strong consistency for:
- Status tracking (queued, cloning, processing, completed, failed)
- Progress updates (file counts, bytes transferred)
- Cancellation support (requires atomic check-and-set)
- Concurrent access prevention

Initially used KV for import state, but encountered race conditions and consistency issues.

## Decision

Use D1 (SQLite) instead of KV for import job state.

### Why D1?

| Feature | D1 | KV |
|---------|-----|-----|
| Strong consistency | Yes | Eventual (60s) |
| Atomic operations | Yes | No |
| Complex queries | Yes | No |
| Transaction support | Yes | No |
| Ideal for | State machines | Caching |

### Schema

```sql
CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'cloning', 'processing', 
    'completed', 'failed', 'cancelled', 'cancelling'
  )),
  source_url TEXT NOT NULL,
  branch TEXT NOT NULL,
  progress_processed_files INTEGER DEFAULT 0,
  progress_total_files INTEGER,
  progress_current_file TEXT,
  progress_bytes_transferred INTEGER,
  progress_total_bytes INTEGER,
  logs TEXT NOT NULL DEFAULT '[]',
  errors TEXT NOT NULL DEFAULT '[]',
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER DEFAULT 1
);

-- Indexes for efficient lookups
CREATE INDEX idx_import_jobs_ns_slug ON import_jobs(namespace, slug);
CREATE INDEX idx_import_jobs_status ON import_jobs(status) 
  WHERE status IN ('queued', 'cloning', 'processing', 'cancelling');
CREATE INDEX idx_import_jobs_completed_at ON import_jobs(completed_at) 
  WHERE completed_at IS NOT NULL;
CREATE INDEX idx_import_jobs_project_id ON import_jobs(project_id);
```

### Optimistic Locking

The `version` field enables conflict detection:

```typescript
// Update with version check
const result = await db
  .prepare(`
    UPDATE import_jobs 
    SET status = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND version = ?
  `)
  .bind(newStatus, id, expectedVersion)
  .run();

// Check if update succeeded
if (result.meta.changes === 0) {
  throw new Error("Concurrent modification detected");
}
```

## Consequences

### Positive

- Strong consistency guarantees
- Atomic updates prevent race conditions
- SQL enables complex queries (e.g., "all active imports")
- Foreign key constraints possible
- Better for structured data

### Negative

- Higher latency than KV (~10-50ms vs ~1-5ms)
- Query costs (though minimal)
- More complex than simple KV gets/puts

## Migration from KV

Existing imports in KV were migrated:

1. New imports use D1 exclusively
2. Read from D1 first, fall back to KV for old imports
3. TTL on KV entries ensures cleanup

## Usage Patterns

### Check Cancellation Status

```typescript
async function isImportCancelled(
  db: D1Database,
  namespace: string,
  slug: string
): Promise<boolean> {
  const row = await db
    .prepare("SELECT status FROM import_jobs WHERE namespace = ? AND slug = ?")
    .bind(namespace, slug)
    .first<{ status: ImportStatus }>();
  
  return row?.status === 'cancelling' || row?.status === 'cancelled';
}
```

### Update Progress

```typescript
async function updateImportProgress(
  db: D1Database,
  namespace: string,
  slug: string,
  progress: ImportProgress,
  log: LogEntry
): Promise<void> {
  await db
    .prepare(`
      UPDATE import_jobs 
      SET 
        progress_processed_files = ?,
        progress_total_files = ?,
        progress_current_file = ?,
        logs = json_insert(logs, '$[#]', json(?)),
        updated_at = CURRENT_TIMESTAMP
      WHERE namespace = ? AND slug = ?
    `)
    .bind(
      progress.processedFiles,
      progress.totalFiles,
      progress.currentFile,
      JSON.stringify(log),
      namespace,
      slug
    )
    .run();
}
```

### List Active Imports

```sql
SELECT * FROM import_jobs 
WHERE status IN ('queued', 'cloning', 'processing', 'cancelling')
ORDER BY started_at DESC;

-- Uses partial index idx_import_jobs_status
```

## Alternatives Considered

### Stick with KV

Use KV with careful locking and workarounds.

**Rejected:**
- Eventual consistency too problematic
- No atomic operations
- Complex workarounds needed

### Durable Objects

Use DO for import coordination.

**Rejected:**
- Overkill for this use case
- D1 provides sufficient consistency
- DO better suited for WebSockets/coordination

### External Database

Use PlanetScale, Supabase, etc.

**Rejected:**
- Additional infrastructure
- Latency to external service
- D1 is native to Cloudflare

## Related Decisions

- [ADR 002: Queue-Based Imports](./002-queue-based-imports.md) - Uses D1 for state

## References

- [D1 Documentation](https://developers.cloudflare.com/d1/)
- Implementation: `src/storage/imports.ts`
- Migration: `migrations/010_import_jobs.sql`
