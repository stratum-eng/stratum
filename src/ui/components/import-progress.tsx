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
  /** Per-request CSP nonce — required so the card's scripts pass `script-src`. */
  nonce: string;
}

// Error classification and troubleshooting tips
interface ErrorInfo {
  type: string;
  title: string;
  description: string;
  tips: string[];
  /**
   * Optional action button. Clicking it opens the import's source URL in a new
   * tab (wired via a nonce'd addEventListener script — CSP forbids inline
   * `onclick=` handlers and eval'ing action strings).
   */
  actionButton?: {
    label: string;
  };
}

/**
 * Markers that identify a genuine Git LFS failure. Each one names the git-lfs
 * tool itself, and that is the whole rule: a marker must come from git-lfs's
 * own output, never from a URL.
 *
 * Anything path-shaped is unusable here, however LFS-specific it looks. A
 * repository URL can contain any path, so `/info/lfs` matches
 * `github.com/info/lfs` and `objects/batch` matches `github.com/objects/batch`
 * — ordinary repositories whose 404 would then be reported as "this repository
 * uses Git LFS", losing the "View Repository" action. Both markers were also
 * redundant: git-lfs prefixes its own diagnostics, so every real message that
 * mentions those paths already matches one of the three below.
 *
 * Word boundaries do not help either — /\bgit-lfs\b/ matches
 * `git-lfs-tools`, because a boundary exists between "s" and "-".
 *
 * This branch runs BEFORE not-found (see classifyError), which is what makes
 * breadth here expensive: every false positive is a missing repository being
 * told it uses LFS.
 */
const LFS_MARKERS = [
  "git-lfs:", // git-lfs CLI error prefix
  "git-lfs filter-process", // smudge/clean filter failure
  "git lfs ", // spaced prose form; a URL cannot contain a raw space
];

/**
 * git-lfs does not always name itself. A batch-API failure is reported as
 * `batch response: <error>` next to the endpoint it called, and that message
 * matches none of {@link LFS_MARKERS} — it is still git-lfs's own output,
 * which is the rule above, so the rule covered this case and the marker list
 * did not.
 *
 * Neither half is usable alone: "batch response" is ordinary English, and the
 * endpoint is path-shaped, so on its own it would match a repository at
 * `github.com/info/lfs/objects/batch`. Required TOGETHER they are
 * unambiguous — a repository URL does not also carry git-lfs's response
 * prefix — so this is an ALL-of match, unlike the ANY-of list above.
 */
const LFS_BATCH_RESPONSE_MARKERS = ["batch response", "/info/lfs/objects/batch"];

/**
 * Map a raw import failure message to user-facing guidance. Exported for tests:
 * the ORDER of these branches is load-bearing, and order is exactly what a
 * rendering test cannot see.
 */
/**
 * Spans that carry a repository's own name into an error message: a URL, or
 * git's scp-style `user@host:path` remote. Removed before classification so a
 * repository called `oauth-server` or `fetch-utils` cannot decide how its
 * failure is described.
 */
const REMOTE_SPAN = /\b[a-z][a-z0-9+.-]*:\/\/\S+|\b[\w.-]+@[\w.-]+:\S+/gi;

/**
 * Fully-qualified ref spans, removed for the same reason as {@link REMOTE_SPAN}:
 * a ref is named by whoever pushed it, so `refs/heads/401` must not be read as
 * an HTTP status and `refs/heads/disk-cleanup` must not be read as a storage
 * failure. A ref name is not inside a URL, so remote-stripping alone never
 * reached these.
 *
 * Only the `refs/...` form is removed here; a bare branch name is handled by
 * {@link MISSING_REF_SPAN}, which needs git's phrasing to recognise one.
 */
const REF_SPAN = /\brefs\/(?:heads|tags|remotes)\/\S+/gi;

/**
 * git's own wording for a ref the remote does not have. Shared by the stripper
 * below and the not-found branch, so a phrase can never be taught to one and
 * not the other.
 */
const MISSING_REF_MARKERS = ["couldn't find remote ref", "could not find remote ref"];

/**
 * The bare ref name in `couldn't find remote ref fix-401-redirect`.
 *
 * A bare name carries no `refs/` prefix, so {@link REF_SPAN} cannot see it and
 * the marker shape cannot exclude it: a phrase marker holds a space and a name
 * cannot, but an HTTP status is digits, and digits are something a branch is
 * plausibly called. `fix-401-redirect` and `release-403` are ordinary branch
 * names, and both reported an authentication failure for a ref that simply is
 * not there.
 *
 * What makes the name recognisable is the phrase in front of it: git only says
 * this about a ref, so the token that follows is a ref name by construction.
 * The phrase itself is kept — the not-found branch classifies on it.
 */
const MISSING_REF_SPAN = new RegExp(`(${MISSING_REF_MARKERS.join("|")})\\s+\\S+`, "gi");

/**
 * Markers of a real authentication failure, as git and the GitHub API phrase
 * them.
 *
 * Every entry contains a space, and that is not decoration: neither a URL nor
 * a ref name can, so a phrase git emits cannot also be something a repository
 * is called. The bare nouns these replace (`auth`, `credentials`) are exactly
 * the substrings that made `acme/oauth-server` report an authentication
 * problem — and because this branch runs first, its answer won over every
 * other classification.
 */
const AUTH_MARKERS = [
  "authentication failed",
  "authentication required",
  "requires authentication",
  "could not read username",
  "could not read password",
  "invalid username or password",
  "permission denied",
  "access denied",
  "bad credentials",
  "invalid credentials",
];

/**
 * Markers of a real transport failure.
 *
 * Same space-carrying rule as {@link AUTH_MARKERS}. Node's transport codes
 * cannot follow it — they are single tokens — so they are matched separately
 * by {@link hasTransportCode} rather than excepted from the rule here.
 */
const NETWORK_MARKERS = [
  "connection refused",
  "connection reset",
  "connection closed",
  "connection timed out",
  "operation timed out",
  "timed out",
  "network is unreachable",
  "network error",
  "failed to connect",
  "failed to fetch",
  "fetch failed",
  "socket hang up",
];

/**
 * Node's transport codes, which no phrase can express.
 *
 * Matched against the message with its ORIGINAL case, because Node always
 * emits them upper-case (`getaddrinfo ENOTFOUND`, `connect ECONNREFUSED`)
 * while a ref name is conventionally lower-case. That is what separates a
 * real DNS failure from a branch called `enotfound-handling` — treating them
 * as case-insensitive single tokens reintroduced exactly the name collision
 * this function exists to remove.
 */
const TRANSPORT_CODES = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH"];

/** Whether `rawText` carries a Node transport code as a standalone upper-case token. */
function hasTransportCode(rawText: string): boolean {
  return TRANSPORT_CODES.some((code) => new RegExp(`(?<![A-Z])${code}(?![A-Z])`).test(rawText));
}

/**
 * Keeps digits that belong to a repository or ref path from being read as an
 * HTTP status. `1403` is not a 403, and neither is `/v1/403/spec` — a real
 * status is preceded by a space, a bracket, or nothing at all.
 */
function hasStatus(text: string, code: string): boolean {
  return new RegExp(`(?<![\\d/])${code}(?!\\d)`).test(text);
}

/**
 * Turns an import failure into guidance a person can act on.
 *
 * The message is the only input, and it carries the repository remote and the
 * ref alongside git's own words — both named by whoever pushed them. So one
 * rule governs every branch below: a marker must be something git says, not a
 * word a name can contain. Two spans are removed before matching for what the
 * rule cannot express, and the remaining markers are phrases, because neither
 * a URL nor a ref name can hold a space.
 *
 * Branch order is load-bearing and separately covered by the LFS suite in
 * #218; the earliest match wins, so a widened predicate here is answered on
 * far more failures than the one it was widened for.
 */
export function classifyError(errorMessage: string): ErrorInfo {
  const msg = errorMessage.toLowerCase();
  // Matched against by every branch EXCEPT LFS and not-found below. Those two
  // read the full message on purpose: LFS_BATCH_RESPONSE_MARKERS requires the
  // path `/info/lfs/objects/batch`, which legitimately arrives inside a URL,
  // so stripping there would undo the LFS detection #218 added.
  const prose = msg
    .replace(REMOTE_SPAN, " ")
    .replace(REF_SPAN, " ")
    .replace(MISSING_REF_SPAN, "$1 ");
  // The same text with its original case kept, for the transport codes above.
  const proseRaw = errorMessage
    .replace(REMOTE_SPAN, " ")
    .replace(REF_SPAN, " ")
    .replace(MISSING_REF_SPAN, "$1 ");

  // Authentication errors
  // 401/403 carry the refusal on their own, so the original predicate's bare
  // "unauthorized" token is gone: it is redundant beside them (every real
  // message carrying the word carries the status too — `HTTP Error: 401
  // Unauthorized`) and it broke the space rule, classifying a 404 for a ref
  // named `fix-unauthorized-redirect` as an auth failure.
  if (
    AUTH_MARKERS.some((marker) => prose.includes(marker)) ||
    hasStatus(prose, "401") ||
    hasStatus(prose, "403")
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
      },
    };
  }

  // Network errors
  if (NETWORK_MARKERS.some((marker) => prose.includes(marker)) || hasTransportCode(proseRaw)) {
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

  // Git LFS — deliberately BEFORE the not-found branch. Stratum exposes no
  // `/objects/lfs` or `objects/batch` route, so an LFS client's batch request
  // falls through to the app's 404 handler and arrives here as a message
  // containing both "not found" and "404". Classified below, the one failure
  // this guidance exists to explain would instead tell the user to check the
  // repository URL for typos.
  //
  // Match explicit LFS markers only. A bare "lfs" substring also appears in
  // ordinary repository names and URLs (`github.com/acme/lfs-tools`), and
  // because this branch sits ahead of not-found, a plain 404 for any such
  // repository would be answered with "this repository uses Git LFS".
  if (
    LFS_MARKERS.some((marker) => msg.includes(marker)) ||
    LFS_BATCH_RESPONSE_MARKERS.every((marker) => msg.includes(marker))
  ) {
    return {
      type: "GIT_ERROR",
      title: "Git LFS Not Supported",
      description:
        "This repository uses Git LFS, which Stratum does not support. There is no LFS batch endpoint, so the LFS client's request fails.",
      tips: [
        "The rest of the repository still imports — LFS-tracked files arrive as pointer files, not their contents",
        "Keep large binaries out of Stratum-hosted repositories, or keep an LFS-dependent repository on GitHub in layer mode",
        "See the Git LFS section of the capabilities guide for the full limitation and workarounds",
      ],
    };
  }

  // Not found errors
  //
  // "couldn't find remote ref" is git's own wording for a ref that is absent
  // from the remote, and it earns its place here: without it the message
  // carries no not-found token at all, so once {@link REF_SPAN} removes the
  // ref name the failure falls through to UNKNOWN_ERROR — a message that says
  // precisely what went wrong, answered with "an unexpected error occurred".
  if (
    msg.includes("not found") ||
    msg.includes("404") ||
    msg.includes("doesn't exist") ||
    msg.includes("does not exist") ||
    MISSING_REF_MARKERS.some((marker) => msg.includes(marker))
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
      },
    };
  }

  // Rate limiting
  if (
    prose.includes("rate limit") ||
    hasStatus(prose, "429") ||
    prose.includes("too many requests")
  ) {
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
  // Still bare nouns, but read from `prose`: a repository named `git-tools` no
  // longer reaches here through its URL. A ref name can still collide, which
  // needs the corpus of real messages this branch produces to narrow safely.
  if (prose.includes("git") || prose.includes("clone") || prose.includes("repository")) {
    return {
      type: "GIT_ERROR",
      title: "Git Operation Failed",
      description:
        "We encountered an error while trying to clone the repository. The repository might be large or have special requirements.",
      tips: [
        "Ensure the repository is a valid Git repository",
        "Very large repositories may timeout - try importing with a shallow clone (depth: 1)",
        "Check if the repository has submodules that might be causing issues",
      ],
    };
  }

  // Storage / naming conflict errors
  if (prose.includes("already exists")) {
    return {
      type: "ALREADY_EXISTS",
      title: "Import Conflict",
      description:
        "A storage conflict was detected while setting up the repository. Retrying usually resolves this.",
      tips: [
        "Click Retry Import — the conflict is typically resolved on the next attempt",
        "If retrying fails repeatedly, contact support with the error details below",
      ],
    };
  }

  // As with the git branch: URL-borne collisions are closed, ref-name ones are
  // not yet.
  if (
    prose.includes("disk") ||
    prose.includes("quota") ||
    prose.includes("space") ||
    prose.includes("storage") ||
    prose.includes("artifacts")
  ) {
    return {
      type: "STORAGE_ERROR",
      title: "Storage Error",
      description: "An error occurred while storing the repository. This may be a temporary issue.",
      tips: [
        "The repository might be too large for our current storage limits",
        "Try the import again - this might have been a temporary service issue",
        "Contact support if the problem persists",
      ],
    };
  }

  // Default error — include raw message if available so it's diagnosable
  const rawDetail = errorMessage.trim()
    ? `Error details: ${errorMessage}`
    : "No error details available. Check the logs below.";
  return {
    type: "UNKNOWN_ERROR",
    title: "Import Failed",
    description: rawDetail,
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
  nonce,
}) => {
  // 'syncing' belongs here: until migration 043 widened the status CHECK it
  // could never be stored, so this list never had to account for it. Now that
  // the consumer's sync-phase write actually lands, omitting it would render a
  // running import with no spinner, no Cancel button, and — because the live
  // refresh script is gated on this too — no way for the page to advance.
  const isActive = ["queued", "cloning", "processing", "syncing"].includes(status);
  const isComplete = status === "completed";
  const isFailed = status === "failed";
  const isCancelled = status === "cancelled";
  const isCancelling = status === "cancelling";

  // Coarse fallbacks for phases that report no file counts. 'syncing' runs
  // after the file work, so it sits above 'processing' rather than dropping the
  // bar back to empty.
  const percent = progress.totalFiles
    ? Math.round((progress.processedFiles / progress.totalFiles) * 100)
    : status === "cloning"
      ? 10
      : status === "processing"
        ? 50
        : status === "syncing"
          ? 75
          : 0;

  // Safely escape for interpolation into a quoted string inside an inline
  // <script> body — JSON.stringify alone doesn't escape "<", so a namespace
  // or slug containing "</script>" could terminate the script tag early.
  const safeNamespace = JSON.stringify(namespace).slice(1, -1).replace(/</g, "\\u003c");
  const safeSlug = JSON.stringify(slug).slice(1, -1).replace(/</g, "\\u003c");

  // Get the main error for classification (use the last error or logs)
  const lastError = errors.length > 0 ? errors[errors.length - 1] : undefined;
  const mainError = lastError?.error ?? logs.find((l) => l.level === "error")?.message ?? "";

  const errorInfo = isFailed ? classifyError(mainError) : null;

  return (
    <div class="card import-progress-card" data-import-status={status}>
      <div class="import-header">
        <h2>
          {(isActive || isCancelling) && <span class="spinner" />}
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
                : isCancelling
                  ? "Cancelling…"
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
                id="import-error-action"
                class="btn btn-secondary"
                data-url={sourceUrl}
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
            id="import-cancel-form"
            method="post"
            action={`/api/projects/${namespace}/${slug}/import/cancel`}
          >
            <button type="submit" class="btn btn-danger">
              Cancel Import
            </button>
          </form>
        </div>
      )}

      {(isFailed || isCancelled || isCancelling) && (
        <div class="actions-section failed-actions">
          <form
            method="post"
            action={`/api/projects/${namespace}/${slug}/import/retry`}
            class="retry-form"
          >
            <button type="submit" class="btn btn-primary">
              Retry import
            </button>
          </form>
          {/*
            Delete is offered only once the job has actually finished. While it
            is still 'cancelling' the queue consumer may yet own the row, and
            removing it there would orphan an in-flight import.
          */}
          {(isFailed || isCancelled) && (
            <form
              id="import-delete-form"
              method="post"
              action={`/api/projects/${namespace}/${slug}/import/delete`}
              class="delete-form"
            >
              <button type="submit" class="btn btn-secondary">
                Delete import
              </button>
            </form>
          )}
          {isCancelling && (
            <p class="help-text">
              Cancelling can take a moment. If it stays stuck, Retry re-queues the import.
            </p>
          )}
        </div>
      )}

      {(isFailed || isCancelled) && (
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `
            // Progressive enhancement only: discarding the job also discards its
            // error log, and there is no undo. Without JS the form still posts.
            (function () {
              var deleteForm = document.getElementById('import-delete-form');
              if (!deleteForm) return;
              deleteForm.addEventListener('submit', function (event) {
                if (!confirm('Delete this import record? Its logs and error details will be lost.')) {
                  event.preventDefault();
                }
              });
            })();
          `,
          }}
        />
      )}

      {isFailed && errorInfo?.actionButton && (
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `
            // Wire the error action button (replaces the former inline onclick).
            (function () {
              var btn = document.getElementById('import-error-action');
              if (!btn) return;
              btn.addEventListener('click', function () {
                // 'noopener' is required here: unlike <a target="_blank">, which
                // modern browsers treat as implicitly noopener, window.open()
                // still hands the opened page a live window.opener reference.
                // The URL is repository-supplied, so without this it could
                // navigate this authenticated tab (reverse tabnabbing).
                window.open(btn.dataset.url, '_blank', 'noopener,noreferrer');
              });
            })();
          `,
          }}
        />
      )}

      {(isActive || isCancelling) && (
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `
            // Confirm before cancelling the import (replaces the former inline onsubmit).
            (function () {
              var cancelForm = document.getElementById('import-cancel-form');
              if (!cancelForm) return;
              cancelForm.addEventListener('submit', function (event) {
                if (!confirm('Are you sure you want to cancel this import?')) {
                  event.preventDefault();
                }
              });
            })();

            // Connect to SSE for real-time updates
            const evtSource = new EventSource('/api/projects/${safeNamespace}/${safeSlug}/import/stream');
            
            evtSource.onmessage = function(event) {
              const data = JSON.parse(event.data);
              
              // Update progress bar
              const percent = data.progress.totalFiles 
                ? Math.round((data.progress.processedFiles / data.progress.totalFiles) * 100)
                : data.status === 'cloning' ? 10
                : data.status === 'processing' ? 50
                : data.status === 'syncing' ? 75
                : 0;
              
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
                  // Reload on every terminal status so a pending cancellation
                  // doesn't leave the page stuck on "Cancelling…".
                  if (['completed', 'failed', 'cancelled'].includes(data.status)) {
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
