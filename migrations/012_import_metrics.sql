-- Import metrics and failed imports tracking
-- Provides monitoring and alerting capabilities

-- Table for import metrics
CREATE TABLE IF NOT EXISTS import_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_type TEXT NOT NULL,
  namespace TEXT,
  slug TEXT,
  value REAL NOT NULL,
  recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index for fast metric lookups by type
CREATE INDEX IF NOT EXISTS idx_import_metrics_type ON import_metrics(metric_type);

-- Index for time-based metric queries
CREATE INDEX IF NOT EXISTS idx_import_metrics_recorded_at ON import_metrics(recorded_at);

-- Index for namespace/slug specific metrics
CREATE INDEX IF NOT EXISTS idx_import_metrics_ns_slug ON import_metrics(namespace, slug);

-- Index for compound queries (type + time)
CREATE INDEX IF NOT EXISTS idx_import_metrics_type_time ON import_metrics(metric_type, recorded_at);

-- Table for tracking failed imports with detailed error info
CREATE TABLE IF NOT EXISTS failed_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id TEXT,
  namespace TEXT NOT NULL,
  slug TEXT NOT NULL,
  error_type TEXT NOT NULL,
  error_message TEXT NOT NULL,
  error_details TEXT, -- JSON for structured error data
  stack_trace TEXT,
  source_url TEXT,
  branch TEXT,
  notified BOOLEAN DEFAULT FALSE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (import_id) REFERENCES import_jobs(id) ON DELETE SET NULL
);

-- Index for finding unnotified failures
CREATE INDEX IF NOT EXISTS idx_failed_imports_notified ON failed_imports(notified) 
  WHERE notified = FALSE;

-- Index for error type analysis
CREATE INDEX IF NOT EXISTS idx_failed_imports_error_type ON failed_imports(error_type);

-- Index for time-based error queries
CREATE INDEX IF NOT EXISTS idx_failed_imports_created_at ON failed_imports(created_at);

-- Index for namespace/slug lookups
CREATE INDEX IF NOT EXISTS idx_failed_imports_ns_slug ON failed_imports(namespace, slug);

-- View for import success rates by day
CREATE VIEW IF NOT EXISTS v_import_stats_daily AS
SELECT 
  date(recorded_at) as date,
  SUM(CASE WHEN metric_type = 'import_started' THEN value ELSE 0 END) as started,
  SUM(CASE WHEN metric_type = 'import_completed' THEN value ELSE 0 END) as completed,
  SUM(CASE WHEN metric_type = 'import_failed' THEN value ELSE 0 END) as failed,
  SUM(CASE WHEN metric_type = 'import_cancelled' THEN value ELSE 0 END) as cancelled,
  AVG(CASE WHEN metric_type = 'import_duration_ms' THEN value END) as avg_duration_ms
FROM import_metrics
GROUP BY date(recorded_at)
ORDER BY date DESC;
