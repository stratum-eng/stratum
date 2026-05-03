import type { FC } from "hono/jsx";

interface ImportProgressProps {
  namespace: string;
  slug: string;
  status: string;
  progress: {
    totalFiles?: number;
    processedFiles: number;
    currentFile?: string;
  };
  logs: Array<{
    message: string;
    level: "info" | "warn" | "error";
    timestamp: string;
  }>;
  errors: Array<{
    file: string;
    error: string;
    timestamp: string;
  }>;
  sourceUrl: string;
  branch: string;
}

export const ImportProgressCard: FC<ImportProgressProps> = ({
  namespace,
  slug,
  status,
  progress,
  logs,
  errors,
  sourceUrl,
  branch,
}) => {
  const isActive = ["queued", "cloning", "processing"].includes(status);
  const isComplete = status === "completed";
  const isFailed = status === "failed";
  const isCancelled = status === "cancelled";

  const percent = progress.totalFiles
    ? Math.round((progress.processedFiles / progress.totalFiles) * 100)
    : status === "cloning"
      ? 10
      : status === "processing"
        ? 50
        : 0;

  // Safely escape for JavaScript string interpolation
  const safeNamespace = JSON.stringify(namespace).slice(1, -1);
  const safeSlug = JSON.stringify(slug).slice(1, -1);

  return (
    <div class="card import-progress-card" data-import-status={status}>
      <div class="import-header">
        <h2>
          {isActive && <span class="spinner" />}
          {isComplete && <span class="icon-success">✓</span>}
          {isFailed && <span class="icon-error">✗</span>}
          {isCancelled && <span class="icon-cancelled">○</span>}
          Import{" "}
          {isComplete
            ? "Complete"
            : isFailed
              ? "Failed"
              : isCancelled
                ? "Cancelled"
                : "in Progress"}
        </h2>
        <span class={`badge badge-${status}`}>{status}</span>
      </div>

      <div class="import-source">
        <p>
          From:{" "}
          <a href={sourceUrl} target="_blank" rel="noreferrer">
            {sourceUrl}
          </a>
        </p>
        <p>
          Branch: <code>{branch}</code>
        </p>
      </div>

      {(isActive || isComplete) && (
        <div class="progress-section">
          <div class="progress-bar">
            <div class="progress-fill" style={`width: ${percent}%`} />
          </div>
          <p class="progress-text">
            {progress.processedFiles} {progress.totalFiles ? `/ ${progress.totalFiles}` : ""} files
            processed
            {progress.currentFile && <span class="current-file">• {progress.currentFile}</span>}
          </p>
        </div>
      )}

      {errors.length > 0 && (
        <div class="errors-section">
          <h3>Errors ({errors.length})</h3>
          <ul class="error-list">
            {errors.slice(-5).map((e, i) => (
              <li key={i} class="error-item">
                <code>{e.file}</code>: {e.error}
              </li>
            ))}
          </ul>
          {errors.length > 5 && <p class="more-errors">...and {errors.length - 5} more errors</p>}
        </div>
      )}

      {logs.length > 0 && (
        <div class="logs-section">
          <details>
            <summary>View logs ({logs.length})</summary>
            <ul class="log-list">
              {logs.slice(-10).map((log, i) => (
                <li key={i} class={`log-item log-${log.level}`}>
                  <span class="log-time">{new Date(log.timestamp).toLocaleTimeString()}</span>
                  <span class="log-message">{log.message}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {isActive && (
        <div class="actions-section">
          <form
            method="post"
            action={`/api/projects/${namespace}/${slug}/import/cancel`}
            onsubmit="return confirm('Are you sure you want to cancel this import?');"
          >
            <button type="submit" class="btn btn-danger">
              Cancel Import
            </button>
          </form>
        </div>
      )}

      {isFailed && (
        <div class="actions-section">
          <form method="post" action={`/api/projects/${namespace}/${slug}/import/retry`}>
            <button type="submit" class="btn btn-primary">
              Retry Import
            </button>
          </form>
        </div>
      )}

      {isActive && (
        <script
          dangerouslySetInnerHTML={{
            __html: `
            // Connect to SSE for real-time updates
            const evtSource = new EventSource('/api/projects/${safeNamespace}/${safeSlug}/import/stream');
            
            evtSource.onmessage = function(event) {
              const data = JSON.parse(event.data);
              
              // Update progress bar
              const percent = data.progress.totalFiles 
                ? Math.round((data.progress.processedFiles / data.progress.totalFiles) * 100)
                : data.status === 'cloning' ? 10 : data.status === 'processing' ? 50 : 0;
              
              const fill = document.querySelector('.progress-fill');
              if (fill) fill.style.width = percent + '%';
              
              // Update status badge
              const badge = document.querySelector('.badge');
              if (badge) {
                badge.textContent = data.status;
                badge.className = 'badge badge-' + data.status;
              }
              
              // Update progress text
              const progressText = document.querySelector('.progress-text');
              if (progressText) {
                let text = data.progress.processedFiles + ' files processed';
                if (data.progress.totalFiles) text += ' / ' + data.progress.totalFiles;
                if (data.progress.currentFile) text += ' • ' + data.progress.currentFile;
                progressText.innerHTML = text;
              }
              
              // Update header
              const header = document.querySelector('.import-header h2');
              if (header && (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled')) {
                if (data.status === 'completed') {
                  header.innerHTML = '<span class="icon-success">✓</span> Import Complete';
                } else if (data.status === 'failed') {
                  header.innerHTML = '<span class="icon-error">✗</span> Import Failed';
                } else {
                  header.innerHTML = '<span class="icon-cancelled">○</span> Import Cancelled';
                }
              }
              
              // Close connection and reload on completion
              if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
                evtSource.close();
                setTimeout(() => window.location.reload(), 2000);
              }
            };
            
            evtSource.onerror = function() {
              console.error('SSE connection failed, falling back to polling');
              evtSource.close();
              // Fallback to polling
              setInterval(async () => {
                const res = await fetch('/api/projects/${safeNamespace}/${safeSlug}/import/status');
                if (res.ok) {
                  const data = await res.json();
                  if (data.status === 'completed') {
                    window.location.reload();
                  }
                }
              }, 5000);
            };
          `,
          }}
        />
      )}
    </div>
  );
};
