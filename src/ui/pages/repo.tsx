import type { FC } from "hono/jsx";
import type { GitProvider, ImportProgress } from "../../types";
import { FileTree } from "../components/file-tree";
import { ImportProgressCard } from "../components/import-progress";
import { buildFileTree } from "../file-tree";
import { Layout } from "../layout";

interface RepoProps {
  project: {
    name: string;
    namespace: string;
    slug: string;
    remote: string;
    createdAt: string;
    sourceUrl?: string;
    sourceProvider?: GitProvider;
    lastSyncedAt?: string;
    lastSyncedCommit?: string;
    lastSyncStatus?: "success" | "failed" | "in_progress" | "idle";
    lastSyncError?: string;
    autoSyncEnabled?: boolean;
  };
  files: string[];
  log: Array<{ sha: string; message: string; author: string; timestamp: number }>;
  readme?: string | null;
  user?: { id: string; email: string; username: string } | null;
  importProgress?: ImportProgress | null;
  syncStatus?: {
    hasUpdates?: boolean;
    commitsBehind?: number;
    latestCommit?: string;
    lastCheckedAt?: string;
  } | null;
  canSync?: boolean;
}

function getProviderIcon(provider?: GitProvider): string {
  switch (provider) {
    case "github":
      return "📦";
    case "gitlab":
      return "🦊";
    case "bitbucket":
      return "📁";
    default:
      return "🔗";
  }
}

function getProviderName(provider?: GitProvider): string {
  switch (provider) {
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    case "bitbucket":
      return "Bitbucket";
    default:
      return "Git";
  }
}

function formatTimeAgo(dateString?: string): string {
  if (!dateString) return "Never";
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
  if (diffDays < 30) return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
  return date.toLocaleDateString();
}

function truncateCommit(sha?: string): string {
  if (!sha) return "Unknown";
  return sha.slice(0, 7);
}

export const RepoPage: FC<RepoProps> = ({
  project,
  files,
  log,
  readme,
  user,
  importProgress,
  syncStatus,
  canSync,
}) => {
  const hasSource = !!project.sourceUrl;
  const isSyncing = project.lastSyncStatus === "in_progress";
  const hasUpdates = syncStatus?.hasUpdates;
  const syncFailed = project.lastSyncStatus === "failed";

  return (
    <Layout title={project.name} user={user}>
      <div class="page-header">
        <h1>{project.name}</h1>
        <div class="header-actions">
          {hasSource && canSync && (
            <form
              method="post"
              action={`/api/projects/${project.namespace}/${project.slug}/sync`}
              style={{ display: "inline" }}
            >
              <button
                type="submit"
                class={`btn ${hasUpdates ? "btn-primary" : "btn-secondary"}`}
                disabled={isSyncing}
              >
                {isSyncing ? (
                  <>
                    <span class="spinner-small" /> Syncing...
                  </>
                ) : hasUpdates ? (
                  <>
                    {getProviderIcon(project.sourceProvider)} Sync Now{" "}
                    {syncStatus?.commitsBehind
                      ? `(${syncStatus.commitsBehind} commit${syncStatus.commitsBehind > 1 ? "s" : ""} behind)`
                      : ""}
                  </>
                ) : (
                  <>{getProviderIcon(project.sourceProvider)} Sync Now</>
                )}
              </button>
            </form>
          )}
          <a class="btn btn-primary" href={`/${project.namespace}/${project.slug}/changes`}>
            View changes
          </a>
        </div>
      </div>

      {/* Sync Status Banner */}
      {hasSource && (
        <div class={`card sync-status-card ${syncFailed ? "sync-error" : ""}`}>
          <div class="sync-status-header">
            <div class="sync-status-info">
              <span class="sync-provider">
                {getProviderIcon(project.sourceProvider)} {getProviderName(project.sourceProvider)}
              </span>
              <a
                href={project.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="sync-source-link"
              >
                {project.sourceUrl?.replace(/^https?:\/\//, "")}
              </a>
            </div>
            <div class="sync-status-badge">
              {project.lastSyncStatus === "in_progress" && (
                <span class="badge badge-info">Syncing...</span>
              )}
              {hasUpdates && project.lastSyncStatus !== "in_progress" && (
                <span class="badge badge-warning">Updates Available</span>
              )}
              {syncFailed && <span class="badge badge-error">Sync Failed</span>}
              {!hasUpdates && project.lastSyncStatus === "success" && (
                <span class="badge badge-success">Up to date</span>
              )}
              {!project.lastSyncStatus && <span class="badge">Not synced</span>}
            </div>
          </div>

          <div class="sync-status-details">
            <div class="sync-detail">
              <span class="sync-label">Last synced:</span>
              <span class="sync-value">{formatTimeAgo(project.lastSyncedAt)}</span>
            </div>
            {project.lastSyncedCommit && (
              <div class="sync-detail">
                <span class="sync-label">Commit:</span>
                <code class="sync-commit">{truncateCommit(project.lastSyncedCommit)}</code>
              </div>
            )}
            {syncStatus?.lastCheckedAt && (
              <div class="sync-detail">
                <span class="sync-label">Last checked:</span>
                <span class="sync-value">{formatTimeAgo(syncStatus.lastCheckedAt)}</span>
              </div>
            )}
            {project.autoSyncEnabled && (
              <div class="sync-detail">
                <span class="badge badge-info">Auto-sync enabled</span>
              </div>
            )}
          </div>

          {project.lastSyncError && (
            <div class="sync-error-message">
              <strong>Error:</strong> {project.lastSyncError}
            </div>
          )}
        </div>
      )}

      {importProgress && (
        <ImportProgressCard
          namespace={importProgress.namespace}
          slug={importProgress.slug}
          status={importProgress.status}
          progress={importProgress.progress}
          logs={importProgress.logs}
          errors={importProgress.errors}
          sourceUrl={importProgress.sourceUrl}
          branch={importProgress.branch}
        />
      )}

      {readme && (
        <div class="card readme-card">
          <div class="readme-content">
            <pre>{readme}</pre>
          </div>
        </div>
      )}

      <div class="card">
        <h2>Files</h2>
        <FileTree nodes={buildFileTree(files)} namespace={project.namespace} slug={project.slug} />
      </div>

      <div class="card">
        <h2>Recent commits</h2>
        {log.length === 0 ? (
          <div class="empty-state">
            <p>No commits yet.</p>
          </div>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>SHA</th>
                <th>Message</th>
                <th>Author</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {log.map((commit) => (
                <tr key={commit.sha}>
                  <td class="mono">{commit.sha.slice(0, 7)}</td>
                  <td>{commit.message}</td>
                  <td>{commit.author}</td>
                  <td>{new Date(commit.timestamp * 1000).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
};
