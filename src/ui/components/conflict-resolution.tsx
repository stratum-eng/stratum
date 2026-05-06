import type { FC } from "hono/jsx";

export interface ConflictFile {
  path: string;
  ours: {
    content: string;
    branch: string;
    commit: string;
    timestamp: string;
  };
  theirs: {
    content: string;
    branch: string;
    commit: string;
    timestamp: string;
  };
  base?: {
    content: string;
    commit: string;
  };
}

export interface SyncConflict {
  id: string;
  namespace: string;
  slug: string;
  sourceUrl: string;
  sourceBranch: string;
  conflicts: ConflictFile[];
  detectedAt: string;
  resolvedAt?: string;
  resolutionStrategy?: "ours" | "theirs" | "manual";
}

interface ConflictResolutionProps {
  conflict: SyncConflict;
  onResolve?: (resolution: {
    file: string;
    strategy: "ours" | "theirs" | "manual";
    content?: string;
  }) => void;
}

export const ConflictResolution: FC<ConflictResolutionProps> = ({ conflict, onResolve }) => {
  const isResolved = !!conflict.resolvedAt;

  return (
    <div class="card conflict-resolution-card" data-conflict-id={conflict.id}>
      <div class="conflict-header">
        <h2>
          <span class="icon-conflict">⚠️</span>
          {isResolved ? "Conflicts Resolved" : "Merge Conflicts Detected"}
        </h2>
        <span class={`badge badge-${isResolved ? "resolved" : "conflict"}`}>
          {isResolved ? "Resolved" : `${conflict.conflicts.length} file(s)`}
        </span>
      </div>

      <div class="conflict-info">
        <p>
          <strong>Source:</strong>{" "}
          <a href={conflict.sourceUrl} target="_blank" rel="noreferrer">
            {conflict.sourceUrl}
          </a>
        </p>
        <p>
          <strong>Branch:</strong> <code>{conflict.sourceBranch}</code>
        </p>
        <p>
          <strong>Detected:</strong> {new Date(conflict.detectedAt).toLocaleString()}
        </p>
      </div>

      <div class="conflicts-list">
        {conflict.conflicts.map((file) => (
          <ConflictFileViewer
            key={file.path}
            file={file}
            onResolve={onResolve}
            disabled={isResolved}
          />
        ))}
      </div>

      {!isResolved && (
        <div class="conflict-actions">
          <button
            type="button"
            class="btn btn-primary"
            onclick={`resolveAllConflicts('${conflict.id}', 'ours')`}
          >
            Accept All Ours
          </button>
          <button
            type="button"
            class="btn btn-secondary"
            onclick={`resolveAllConflicts('${conflict.id}', 'theirs')`}
          >
            Accept All Theirs
          </button>
          <a href="/docs/conflict-resolution" class="btn btn-link" target="_blank" rel="noreferrer">
            📖 Learn More
          </a>
        </div>
      )}

      {!isResolved && (
        <script
          dangerouslySetInnerHTML={{
            __html: `
            async function resolveAllConflicts(conflictId, strategy) {
              if (!confirm(\`Are you sure you want to accept all \${strategy} changes? This cannot be undone.\`)) {
                return;
              }
              
              try {
                const res = await fetch(\`/api/projects/conflicts/\${conflictId}/resolve\`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ strategy })
                });
                
                if (res.ok) {
                  window.location.reload();
                } else {
                  const error = await res.json();
                  alert('Failed to resolve conflicts: ' + error.message);
                }
              } catch (err) {
                alert('Network error: ' + err.message);
              }
            }
          `,
          }}
        />
      )}
    </div>
  );
};

interface ConflictFileViewerProps {
  file: ConflictFile;
  onResolve?: (resolution: {
    file: string;
    strategy: "ours" | "theirs" | "manual";
    content?: string;
  }) => void;
  disabled?: boolean;
}

/**
 * Server-rendered conflict file viewer with client-side JavaScript for interactivity.
 * Uses data attributes and inline scripts for state management instead of React hooks.
 */
const ConflictFileViewer: FC<ConflictFileViewerProps> = ({ file, disabled }) => {
  const fileId = file.path.replace(/[^a-zA-Z0-9]/g, "_");

  return (
    <div class="conflict-file" data-file-path={file.path} data-file-id={fileId}>
      <div class="file-header">
        <code class="file-path">{file.path}</code>
        <div class="file-actions">
          {disabled ? (
            <span class="badge badge-resolved">Resolved</span>
          ) : (
            <>
              <button
                type="button"
                class="btn btn-sm btn-secondary"
                data-resolution="ours"
                data-file-id={fileId}
                onclick={`handleFileResolve('${fileId}', 'ours')`}
              >
                Accept Ours
              </button>
              <button
                type="button"
                class="btn btn-sm btn-secondary"
                data-resolution="theirs"
                data-file-id={fileId}
                onclick={`handleFileResolve('${fileId}', 'theirs')`}
              >
                Accept Theirs
              </button>
              <button
                type="button"
                class="btn btn-sm btn-secondary"
                data-resolution="manual"
                data-file-id={fileId}
                onclick={`handleFileResolve('${fileId}', 'manual')`}
              >
                Manual Edit
              </button>
            </>
          )}
        </div>
      </div>

      <div class="diff-viewer">
        <div class="diff-section diff-ours" id={`diff-ours-${fileId}`}>
          <div class="diff-header">
            <span class="diff-label">Ours ({file.ours.branch})</span>
            <span class="diff-commit">{file.ours.commit.slice(0, 7)}</span>
            <span class="diff-time">{new Date(file.ours.timestamp).toLocaleString()}</span>
          </div>
          <pre class="diff-content">
            <code>{file.ours.content}</code>
          </pre>
        </div>

        <div class="diff-section diff-theirs" id={`diff-theirs-${fileId}`}>
          <div class="diff-header">
            <span class="diff-label">Theirs ({file.theirs.branch})</span>
            <span class="diff-commit">{file.theirs.commit.slice(0, 7)}</span>
            <span class="diff-time">{new Date(file.theirs.timestamp).toLocaleString()}</span>
          </div>
          <pre class="diff-content">
            <code>{file.theirs.content}</code>
          </pre>
        </div>

        {file.base && (
          <div class="diff-section diff-base" id={`diff-base-${fileId}`}>
            <div class="diff-header">
              <span class="diff-label">Base (common ancestor)</span>
              <span class="diff-commit">{file.base.commit.slice(0, 7)}</span>
            </div>
            <pre class="diff-content">
              <code>{file.base.content}</code>
            </pre>
          </div>
        )}
      </div>

      {!disabled && (
        <div class="manual-edit" id={`manual-edit-${fileId}`} style="display: none;">
          <label>Edit the file content manually:</label>
          <textarea
            class="manual-editor"
            id={`manual-textarea-${fileId}`}
            rows={10}
            placeholder="Enter the resolved file content here..."
          />
          <button
            type="button"
            class="btn btn-sm btn-primary"
            onclick={`submitManualResolution('${fileId}')`}
          >
            Save Manual Resolution
          </button>
        </div>
      )}

      {!disabled && (
        <script
          dangerouslySetInnerHTML={{
            __html: `
            // Track resolutions for this file
            if (!window.fileResolutions) window.fileResolutions = {};
            window.fileResolutions['${fileId}'] = {
              path: '${file.path.replace(/'/g, "\\'")}',
              strategy: null,
              content: null
            };

            function handleFileResolve(fileId, strategy) {
              // Update button styles
              document.querySelectorAll('[data-file-id="' + fileId + '"]').forEach(btn => {
                btn.classList.remove('btn-primary');
                btn.classList.add('btn-secondary');
              });
              document.querySelector('[data-file-id="' + fileId + '"][data-resolution="' + strategy + '"]').classList.remove('btn-secondary');
              document.querySelector('[data-file-id="' + fileId + '"][data-resolution="' + strategy + '"]').classList.add('btn-primary');

              // Show/hide manual edit textarea
              const manualEdit = document.getElementById('manual-edit-' + fileId);
              if (strategy === 'manual') {
                manualEdit.style.display = 'block';
              } else {
                manualEdit.style.display = 'none';
                // Store resolution immediately for ours/theirs
                window.fileResolutions[fileId].strategy = strategy;
                console.log('File resolution:', fileId, strategy);
              }
            }

            function submitManualResolution(fileId) {
              const textarea = document.getElementById('manual-textarea-' + fileId);
              const content = textarea.value;
              window.fileResolutions[fileId].strategy = 'manual';
              window.fileResolutions[fileId].content = content;
              console.log('Manual resolution saved:', fileId, content);
              alert('Manual resolution saved for ' + window.fileResolutions[fileId].path);
            }
          `,
          }}
        />
      )}
    </div>
  );
};
