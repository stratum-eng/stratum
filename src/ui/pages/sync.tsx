import type { FC } from "hono/jsx";
import { Layout } from "../layout";

/**
 * Return the input string if it is a valid `http:` or `https:` URL, otherwise `null`.
 *
 * @param url - The URL string to validate; may be `undefined`
 * @returns `url` when its scheme is exactly `http:` or `https:`, `null` otherwise
 */
function validateSafeUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return url;
    }
    return null;
  } catch {
    return null;
  }
}

interface SyncStatus {
  namespace: string;
  slug: string;
  sourceUrl: string;
  sourceBranch: string;
  lastSyncedAt?: string;
  lastSyncedCommit?: string;
  lastSyncStatus: "success" | "failed" | "in_progress" | "idle";
  lastSyncError?: string;
  hasUpdates: boolean;
  commitsBehind?: number;
  latestCommit?: string;
  autoSyncEnabled: boolean;
  syncFrequency?: number; // Minutes between auto-syncs
  lastCheckedAt: string;
}

interface SyncPageProps {
  project: {
    namespace: string;
    slug: string;
    name: string;
  };
  syncStatus: SyncStatus;
  syncHistory: Array<{
    id: string;
    startedAt: string;
    completedAt?: string;
    status: "success" | "failed" | "cancelled";
    commitsSynced: number;
    error?: string;
  }>;
}

export const SyncPage: FC<SyncPageProps> = ({ project, syncStatus, syncHistory }) => {
  const isSyncing = syncStatus.lastSyncStatus === "in_progress";
  const hasError = syncStatus.lastSyncStatus === "failed";
  const hasUpdates =
    syncStatus.hasUpdates && syncStatus.commitsBehind && syncStatus.commitsBehind > 0;

  return (
    <Layout title={`Sync - ${project.name}`}>
      <div class="container">
        <div class="page-header">
          <h1>Sync Status</h1>
          <div class="header-actions">
            <a href={`/${project.namespace}/${project.slug}`} class="btn btn-secondary">
              ← Back to Project
            </a>
          </div>
        </div>

        {/* Status Card */}
        <div class={`card sync-status-card status-${syncStatus.lastSyncStatus}`}>
          <div class="status-header">
            <div class="status-indicator">
              {isSyncing && <span class="spinner" />}
              {syncStatus.lastSyncStatus === "success" && <span class="icon-success">✓</span>}
              {hasError && <span class="icon-error">✗</span>}
              {syncStatus.lastSyncStatus === "idle" && <span class="icon-idle">○</span>}
            </div>
            <div class="status-info">
              <h2>
                {isSyncing && "Syncing..."}
                {syncStatus.lastSyncStatus === "success" && "Up to Date"}
                {hasError && "Sync Failed"}
                {syncStatus.lastSyncStatus === "idle" && "Not Synced"}
              </h2>
              <p class="status-meta">
                {syncStatus.lastSyncedAt
                  ? `Last synced: ${new Date(syncStatus.lastSyncedAt).toLocaleString()}`
                  : "Never synced"}
              </p>
            </div>
            <div class="status-actions">
              {!isSyncing && (
                <form
                  method="post"
                  action={`/api/projects/${project.namespace}/${project.slug}/sync`}
                  onsubmit="event.preventDefault(); handleSyncSubmit(this);"
                >
                  <button
                    type="submit"
                    id="sync-button"
                    class={`btn ${hasUpdates ? "btn-primary" : "btn-secondary"}`}
                    data-original-class={hasUpdates ? "btn-primary" : "btn-secondary"}
                    disabled={isSyncing}
                  >
                    {hasUpdates
                      ? `Sync Now (${syncStatus.commitsBehind} commit${syncStatus.commitsBehind === 1 ? "" : "s"} behind)`
                      : "Check for Updates"}
                  </button>
                </form>
              )}
            </div>
          </div>

          {hasError && syncStatus.lastSyncError && (
            <div class="error-message">
              <strong>Error:</strong> {syncStatus.lastSyncError}
            </div>
          )}
        </div>

        {/* Source Info */}
        <div class="card source-info-card">
          <h3>Source Repository</h3>
          <div class="info-grid">
            <div class="info-item">
              <label>URL</label>
              {(() => {
                const safeUrl = validateSafeUrl(syncStatus.sourceUrl);
                if (safeUrl) {
                  return (
                    <a href={safeUrl} target="_blank" rel="noreferrer">
                      {syncStatus.sourceUrl}
                    </a>
                  );
                }
                return <span class="text-muted">{syncStatus.sourceUrl || "Not available"}</span>;
              })()}
            </div>
            <div class="info-item">
              <label>Branch</label>
              <code>{syncStatus.sourceBranch}</code>
            </div>
            <div class="info-item">
              <label>Latest Commit</label>
              <code>{syncStatus.latestCommit?.slice(0, 7) || "N/A"}</code>
            </div>
            <div class="info-item">
              <label>Last Checked</label>
              <span>{new Date(syncStatus.lastCheckedAt).toLocaleString()}</span>
            </div>
          </div>
        </div>

        {/* Auto-Sync Settings */}
        <div class="card auto-sync-card">
          <h3>Auto-Sync Settings</h3>
          <form
            method="post"
            action={`/api/projects/${project.namespace}/${project.slug}/sync/settings`}
            class="auto-sync-form"
            onsubmit="event.preventDefault(); handleSettingsSubmit(this);"
          >
            <div class="form-group">
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  name="autoSyncEnabled"
                  checked={syncStatus.autoSyncEnabled}
                  onchange="toggleSyncFrequency(this)"
                />
                Enable automatic sync
              </label>
              <p class="help-text">
                When enabled, the project will automatically sync when new commits are detected.
              </p>
            </div>

            <div class="form-group">
              <label>Sync Frequency</label>
              <select
                id="syncFrequency"
                name="syncFrequency"
                disabled={!syncStatus.autoSyncEnabled}
              >
                <option
                  value="5"
                  selected={
                    syncStatus.syncFrequency === 5 ||
                    (!syncStatus.syncFrequency && syncStatus.autoSyncEnabled)
                  }
                >
                  Every 5 minutes
                </option>
                <option value="15" selected={syncStatus.syncFrequency === 15}>
                  Every 15 minutes
                </option>
                <option value="30" selected={syncStatus.syncFrequency === 30}>
                  Every 30 minutes
                </option>
                <option value="60" selected={syncStatus.syncFrequency === 60}>
                  Every hour
                </option>
                <option value="360" selected={syncStatus.syncFrequency === 360}>
                  Every 6 hours
                </option>
                <option value="720" selected={syncStatus.syncFrequency === 720}>
                  Every 12 hours
                </option>
                <option value="1440" selected={syncStatus.syncFrequency === 1440}>
                  Every 24 hours
                </option>
              </select>
            </div>

            <button type="submit" class="btn btn-secondary" data-original-class="btn-secondary">
              Save Settings
            </button>
          </form>
        </div>

        {/* Sync History */}
        <div class="card sync-history-card">
          <h3>Sync History</h3>
          {syncHistory.length === 0 ? (
            <p class="empty-state">No sync history yet.</p>
          ) : (
            <table class="table sync-history-table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Status</th>
                  <th>Commits</th>
                  <th>Duration</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {syncHistory.map((sync) => (
                  <tr key={sync.id} class={`sync-row status-${sync.status}`}>
                    <td>{new Date(sync.startedAt).toLocaleString()}</td>
                    <td>
                      <span class={`badge badge-${sync.status}`}>{sync.status}</span>
                    </td>
                    <td>{sync.commitsSynced}</td>
                    <td>
                      {sync.completedAt
                        ? `${Math.round((new Date(sync.completedAt).getTime() - new Date(sync.startedAt).getTime()) / 1000)}s`
                        : "-"}
                    </td>
                    <td>
                      {sync.error && (
                        <span class="error-hint" title={sync.error}>
                          Error details
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Client-side JavaScript for form handling */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              async function handleSyncSubmit(form) {
                const button = form.querySelector('button[type="submit"]');
                const originalText = button.textContent;
                const originalClass = button.getAttribute('data-original-class') || 'btn-secondary';
                button.disabled = true;
                button.textContent = 'Syncing...';
                
                try {
                  const response = await fetch(form.action, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                    },
                  });
                  
                  if (response.ok) {
                    const data = await response.json();

                    // Show success message
                    if (data.synced) {
                      button.textContent = '✓ ' + data.message;
                      button.classList.remove('btn-primary', 'btn-secondary');
                      button.classList.add('btn-success');

                      // Reload page after 2 seconds to show updated status
                      setTimeout(() => window.location.reload(), 2000);
                      // Fallback: re-enable button if reload is blocked
                      setTimeout(() => {
                        button.disabled = false;
                      }, 2500);
                    } else {
                      button.textContent = data.message || 'Up to date';

                      // Reload page after 2 seconds to show updated status
                      setTimeout(() => window.location.reload(), 2000);
                      // Fallback: re-enable button if reload is blocked
                      setTimeout(() => {
                        button.disabled = false;
                      }, 2500);
                    }
                  } else {
                    const error = await response.json();
                    button.textContent = 'Error: ' + (error.message || 'Sync failed');
                    button.classList.remove('btn-primary', 'btn-secondary');
                    button.classList.add('btn-danger');
                    
                    // Re-enable button after 3 seconds
                    setTimeout(() => {
                      button.disabled = false;
                      button.textContent = originalText;
                      button.classList.remove('btn-danger');
                      // Restore original button class from data attribute
                      button.classList.add(originalClass);
                    }, 3000);
                  }
                } catch (err) {
                  button.textContent = 'Network error';
                  button.classList.remove('btn-primary', 'btn-secondary');
                  button.classList.add('btn-danger');
                  
                  // Re-enable button after 3 seconds
                  setTimeout(() => {
                    button.disabled = false;
                    button.textContent = originalText;
                    button.classList.remove('btn-danger');
                    // Restore original button class from data attribute
                    button.classList.add(originalClass);
                  }, 3000);
                }
              }
              
              async function handleSettingsSubmit(form) {
                const button = form.querySelector('button[type="submit"]');
                const originalText = button.textContent;
                const originalClass = button.getAttribute('data-original-class') || 'btn-secondary';
                const formData = new FormData(form);
                const autoSyncEnabled = formData.get('autoSyncEnabled') === 'on';
                const data = {
                  autoSyncEnabled,
                };
                // Only include syncFrequency when autoSyncEnabled is true
                if (autoSyncEnabled) {
                  const frequencyValue = formData.get('syncFrequency');
                  if (frequencyValue) {
                    data.syncFrequency = parseInt(frequencyValue);
                  }
                }
                
                button.disabled = true;
                button.textContent = 'Saving...';
                
                try {
                  const response = await fetch(form.action, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(data),
                  });
                  
                  if (response.status === 501) {
                    button.textContent = 'Feature coming soon!';
                    button.classList.remove(originalClass);
                    button.classList.add('btn-info');
                    
                    setTimeout(() => {
                      button.disabled = false;
                      button.textContent = originalText;
                      button.classList.remove('btn-info');
                      button.classList.add(originalClass);
                    }, 3000);
                  } else if (response.ok) {
                    button.textContent = '✓ Settings saved!';
                    button.classList.remove(originalClass);
                    button.classList.add('btn-success');
                    
                    setTimeout(() => {
                      button.disabled = false;
                      button.textContent = originalText;
                      button.classList.remove('btn-success');
                      button.classList.add(originalClass);
                    }, 3000);
                  } else {
                    const error = await response.json();
                    button.textContent = 'Error: ' + (error.message || 'Save failed');
                    button.classList.remove(originalClass);
                    button.classList.add('btn-danger');
                    
                    setTimeout(() => {
                      button.disabled = false;
                      button.textContent = originalText;
                      button.classList.remove('btn-danger');
                      button.classList.add(originalClass);
                    }, 3000);
                  }
                } catch (err) {
                  button.textContent = 'Network error';
                  button.classList.remove(originalClass);
                  button.classList.add('btn-danger');
                  
                  setTimeout(() => {
                    button.disabled = false;
                    button.textContent = originalText;
                    button.classList.remove('btn-danger');
                    button.classList.add(originalClass);
                  }, 3000);
                }
              }
              
              function toggleSyncFrequency(checkbox) {
                const select = document.getElementById('syncFrequency');
                if (select) {
                  select.disabled = !checkbox.checked;
                }
              }
            `,
          }}
        />
      </div>
    </Layout>
  );
};
