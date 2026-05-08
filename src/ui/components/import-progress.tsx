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

// Error classification and troubleshooting tips
interface ErrorInfo {
  type: string;
  title: string;
  description: string;
  tips: string[];
  actionButton?: {
    label: string;
    action: string;
  };
}

function classifyError(errorMessage: string): ErrorInfo {
  const msg = errorMessage.toLowerCase();

  // Authentication errors
  if (
    msg.includes("auth") ||
    msg.includes("unauthorized") ||
    msg.includes("403") ||
    msg.includes("credentials")
  ) {
    return {
      type: "AUTH_ERROR",
      title: "Authentication Failed",
      description:
        "We couldn't access the repository. This usually means the repository requires authentication or the provided credentials are invalid.",
      tips: [
        "Verify that the repository URL is correct and publicly accessible",
        "If it's a private repository, ensure your GitHub account has access",
        "Check if the repository requires specific permissions or SSH keys",
        "Try accessing the repository directly in your browser to confirm it exists",
      ],
      actionButton: {
        label: "Check Repository Access",
        action: "window.open('{sourceUrl}', '_blank')",
      },
    };
  }

  // Network errors
  if (
    msg.includes("network") ||
    msg.includes("fetch") ||
    msg.includes("connection") ||
    msg.includes("timeout")
  ) {
    return {
      type: "NETWORK_ERROR",
      title: "Network Error",
      description:
        "We couldn't connect to the repository due to a network issue. This might be temporary.",
      tips: [
        "Check if the repository URL is accessible from your browser",
        "Verify your internet connection",
        "The repository host might be experiencing issues - try again in a few minutes",
        "If using a corporate network, check if GitHub access is blocked by a firewall",
      ],
    };
  }

  // Not found errors
  if (
    msg.includes("not found") ||
    msg.includes("404") ||
    msg.includes("doesn't exist") ||
    msg.includes("does not exist")
  ) {
    return {
      type: "NOT_FOUND",
      title: "Repository Not Found",
      description: "The repository or branch you specified could not be found.",
      tips: [
        "Double-check the repository URL for typos",
        "Verify that the repository exists and hasn't been deleted or made private",
        "Make sure the branch name is correct - try 'main' or 'master' if unsure",
        "Check if the repository URL includes '.git' suffix and try without it",
      ],
      actionButton: {
        label: "View Repository",
        action: "window.open('{sourceUrl}', '_blank')",
      },
    };
  }

  // Rate limiting
  if (msg.includes("rate limit") || msg.includes("429") || msg.includes("too many requests")) {
    return {
      type: "RATE_LIMITED",
      title: "Rate Limited",
      description:
        "We've hit a rate limit while trying to access the repository. This is usually temporary.",
      tips: [
        "Wait a few minutes and try again",
        "Large repositories may trigger rate limits - consider importing a smaller branch",
        "If this persists, contact support for assistance",
      ],
    };
  }

  // Git errors
  if (msg.includes("git") || msg.includes("clone") || msg.includes("repository")) {
    return {
      type: "GIT_ERROR",
      title: "Git Operation Failed",
      description:
        "We encountered an error while trying to clone the repository. The repository might be large or have special requirements.",
      tips: [
        "Ensure the repository is a valid Git repository",
        "Very large repositories may timeout - try importing with a shallow clone (depth: 1)",
        "Check if the repository has submodules that might be causing issues",
        "Some repositories require specific Git LFS setup",
      ],
    };
  }

  // Storage errors
  if (
    msg.includes("disk") ||
    msg.includes("quota") ||
    msg.includes("space") ||
    msg.includes("storage")
  ) {
    return {
      type: "STORAGE_ERROR",
      title: "Storage Error",
      description: "We ran out of storage space while importing the repository.",
      tips: [
        "The repository might be too large for our current storage limits",
        "Try importing a specific subdirectory instead of the entire repository",
        "Contact support to discuss storage options for large repositories",
      ],
    };
  }

  // Default error
  return {
    type: "UNKNOWN_ERROR",
    title: "Import Failed",
    description:
      "An unexpected error occurred while importing the repository. Our team has been notified.",
    tips: [
      "Try the import again - this might have been a temporary issue",
      "Check the detailed error logs below for more information",
      "If the problem persists, contact support with the error details",
      "Consider trying with different import settings (e.g., different branch or depth)",
    ],
  };
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

  // Get the main error for classification (use the last error or logs)
  const lastError = errors.length > 0 ? errors[errors.length - 1] : undefined;
  const mainError = lastError?.error ?? logs.find((l) => l.level === "error")?.message ?? "";

  const errorInfo = isFailed ? classifyError(mainError) : null;

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

      {/* Enhanced Error Section */}
      {isFailed && errorInfo && (
        <div class="error-detail-section error-alert">
          <div class="error-header">
            <span class="error-icon">⚠️</span>
            <h3>{errorInfo.title}</h3>
          </div>
          <p class="error-description">{errorInfo.description}</p>

          <div class="troubleshooting-section">
            <h4>💡 Troubleshooting Tips</h4>
            <ul class="troubleshooting-tips">
              {errorInfo.tips.map((tip, i) => (
                <li key={i}>{tip}</li>
              ))}
            </ul>
          </div>

          {errorInfo.actionButton && (
            <div class="error-action">
              <button
                type="button"
                class="btn btn-secondary"
                onclick={errorInfo.actionButton.action.replace("{sourceUrl}", sourceUrl)}
              >
                {errorInfo.actionButton.label}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Technical Error Details (collapsible) */}
      {errors.length > 0 && (
        <div class="errors-section technical-errors">
          <details>
            <summary>Technical Details ({errors.length} errors)</summary>
            <ul class="error-list">
              {errors.slice(-5).map((e, i) => (
                <li key={i} class="error-item">
                  <code>{e.file}</code>: {e.error}
                </li>
              ))}
            </ul>
            {errors.length > 5 && <p class="more-errors">...and {errors.length - 5} more errors</p>}
          </details>
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
        <div class="actions-section failed-actions">
          <form
            method="post"
            action={`/api/projects/${namespace}/${slug}/import/retry`}
            class="retry-form"
          >
            <button type="submit" class="btn btn-primary">
              🔄 Retry Import
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
