# ADR 002: Queue-Based Imports

## Status

Accepted

## Context

Importing GitHub repositories can take significant time (seconds to minutes). Doing this synchronously in the request handler would:
- Hit Worker execution time limits (30-50 seconds)
- Provide poor user experience (long wait times)
- Risk timeouts and failures

## Decision

Use Cloudflare Queues for asynchronous import processing.

### Architecture

```
Request → Create Import Job → Queue Message → Background Worker → Process Import
                ↓                    ↓               ↓
           Return 201          Persisted       Update Status
           (queued)             in Queue        (polling/SSE)
```

### Queue Configuration

```toml
[[queues.producers]]
binding = "IMPORT_QUEUE"
queue = "stratum-imports"

[[queues.consumers]]
queue = "stratum-imports"
max_batch_size = 1  # Sequential processing
max_retries = 3
retry_delay = 30
```

### Import Job State Machine

```
queued → cloning → processing → completed
  ↓         ↓           ↓
cancelling → cancelled   failed
```

### Status Tracking

Import progress tracked in D1 database for strong consistency:

```sql
CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  progress_processed_files INTEGER DEFAULT 0,
  progress_total_files INTEGER,
  logs TEXT NOT NULL DEFAULT '[]',
  errors TEXT NOT NULL DEFAULT '[]',
  -- ...
);
```

## Consequences

### Positive

- Non-blocking API responses
- Can handle large repositories (with retries)
- Progress tracking via polling or SSE
- Reliable delivery with retries
- Can cancel long-running imports

### Negative

- Added complexity (queue infrastructure)
- Need for status polling
- Eventual consistency (status may lag)
- Additional storage for job state

## Implementation Details

### API Endpoints

```
POST   /api/projects/:namespace/:slug/import        # Queue import
GET    /api/projects/:namespace/:slug/import/status  # Poll status
GET    /api/projects/:namespace/:slug/import/stream  # SSE stream
POST   /api/projects/:namespace/:slug/import/cancel  # Cancel import
```

### Client Flow

```javascript
// 1. Start import
const { importId } = await fetch('/api/projects/.../import', { method: 'POST' });

// 2. Stream progress
const eventSource = new EventSource('/api/projects/.../import/stream');
eventSource.onmessage = (e) => {
  const progress = JSON.parse(e.data);
  updateUI(progress);
  if (progress.status === 'completed') {
    eventSource.close();
  }
};
```

### Cancellation

Uses optimistic locking with version field:

```sql
UPDATE import_jobs 
SET status = 'cancelling', version = version + 1
WHERE id = ? AND version = ?;
```

Worker checks cancellation status periodically during processing.

## Rate Limiting

Imports are rate-limited to prevent abuse:
- 1 import per minute per user
- 1 concurrent import per project
- 5 cancels per minute per user

## Alternatives Considered

### Synchronous Processing

Import in request handler with streaming response.

**Rejected:**
- Worker timeout risk
- Poor UX for large repos
- No retry mechanism

### Durable Objects

Use Durable Objects for coordination.

**Rejected:**
- More complex than needed
- Queues provide sufficient reliability
- May revisit for advanced features

### External Queue (SQS, etc.)

Use AWS SQS or similar.

**Rejected:**
- Additional infrastructure
- Latency to external service
- Cloudflare Queues is native

## Related Decisions

- [ADR 003: D1 for Import State](./003-d1-for-import-state.md) - Database choice for import tracking

## References

- [Cloudflare Queues](https://developers.cloudflare.com/queues/)
- Implementation: `src/queue/import-queue.ts`
- API: `src/routes/projects.ts` (import endpoints)
