# PR: Option A - Polish & Monitoring

## Overview
Add health checks, metrics, alerting, and improved error handling for the import system.

## Tasks

### 1. Health Check Endpoint
**Agent Assignment**: Task worker
**File**: `src/routes/health.ts` (new)

Create a comprehensive health check endpoint at `/api/health` that checks:
- D1 database connectivity
- KV storage connectivity  
- Queue availability
- Artifacts service availability

Returns JSON:
```json
{
  "status": "healthy",
  "timestamp": "2026-01-01T00:00:00Z",
  "checks": {
    "database": { "status": "ok", "latency": "5ms" },
    "kv": { "status": "ok", "latency": "3ms" },
    "queue": { "status": "ok" },
    "artifacts": { "status": "ok" }
  }
}
```

### 2. Import Metrics Collection
**Agent Assignment**: Task worker
**File**: `src/storage/metrics.ts` (new)

Track and store import metrics in D1:
- Total imports started
- Total imports completed
- Total imports failed
- Total imports cancelled
- Average import duration
- Import failures by error type

Create table:
```sql
CREATE TABLE import_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_type TEXT NOT NULL,
  namespace TEXT,
  slug TEXT,
  value REAL,
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 3. Metrics Dashboard API
**Agent Assignment**: Task worker
**File**: `src/routes/metrics.ts` (new)

Create endpoint `/api/admin/metrics` returning:
- Imports in last 24h/7d/30d
- Success/failure rates
- Average processing time
- Queue depth
- Error breakdown

### 4. Failed Import Alerting
**Agent Assignment**: Task worker
**File**: `src/queue/import-queue.ts` (modify)

When import fails:
1. Log detailed error
2. Store in D1 failed_imports table
3. Send email notification (if EMAIL binding available)
4. Track in metrics

### 5. UI Error Improvements
**Agent Assignment**: Task worker
**File**: `src/ui/components/import-progress.tsx` (modify)

Improve error display:
- Show actionable error messages
- Link to troubleshooting docs
- "Retry with different settings" suggestions
- Contact support button

## Acceptance Criteria
- [ ] Health endpoint returns 200 with all checks passing
- [ ] Metrics are collected for every import
- [ ] Admin can view metrics via API
- [ ] Failed imports trigger notifications
- [ ] UI shows helpful error messages
- [ ] All tests pass
- [ ] Code reviewed by CodeRabbit

## Files Modified
- New: `src/routes/health.ts`
- New: `src/storage/metrics.ts`
- New: `src/routes/metrics.ts`
- Modify: `src/queue/import-queue.ts`
- Modify: `src/ui/components/import-progress.tsx`
- New migration: `012_import_metrics.sql`
