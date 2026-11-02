import type { FC } from "hono/jsx";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import type { GitProvider, ImportProgress } from "../../types";
import { FileTree } from "../components/file-tree";
import { ImportProgressCard } from "../components/import-progress";
import { ProjectHeader } from "../components/project-header";
import { buildFileTree } from "../file-tree";
import { Layout } from "../layout";
import { BranchSwitcher } from "./branches";

marked.setOptions({ gfm: true, breaks: false });

const ALLOWED_README_TAGS = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "br",
  "hr",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "blockquote",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "a",
  "img",
  "details",
  "summary",
  "div",
  "span",
];

function renderReadme(raw: string): string {
  const html = marked(raw) as string;
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_README_TAGS,
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "width", "height"],
      code: ["class"],
      pre: ["class"],
      td: ["align"],
      th: ["align"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, rel: "noopener noreferrer", target: "_blank" },
      }),
    },
  });
}

interface RepoProps {
  project: {
    name: string;
    namespace: string;
    slug: string;
    visibility?: string;
    remote: string;
    createdAt: string;
    sourceUrl?: string;
    sourceProvider?: GitProvider;
    sourceOwner?: string;
    sourceRepo?: string;
    lastSyncedAt?: string;
    lastSyncedCommit?: string;
    lastSyncStatus?: "success" | "failed" | "in_progress" | "idle";
    lastSyncError?: string;
    autoSyncEnabled?: boolean;
  };
  files: string[];
  /**
   * True when the repository listing could not be read (clone/auth/API failure)
   * rather than genuinely being empty. Both cases arrive as `files: []`, but
   * only the second means "this project has no content".
   */
  filesUnavailable?: boolean;
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
  isOwner?: boolean;
  /** Whether the viewer can open project settings (shows the Settings tab). */
  canWrite?: boolean;
  /** Per-request CSP nonce, threaded to every script-rendering child. */
  nonce: string;
  /** Branch this tree and log were read from, or `undefined` for the default
   * branch — whose links stay bare, see `refQuery`. Threaded into every file
   * link so browsing does not silently drop back to the default branch. */
  refName?: string;
  /** The project's default branch, so the switcher can show what `refName:
   * undefined` actually means. */
  defaultBranch?: string;
  /** Branch names for the switcher. Empty hides it — the listing is best-effort
   * and its failure must not take the repo page down. */
  branchNames?: string[];
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

/**
 * The project overview: file tree, recent commits, README, and the import and
 * sync cards.
 *
 * Branch-aware (#181): `refName` names the branch being browsed and is absent
 * on the default branch, so the common URL is unchanged. `branchNames` feeds
 * the switcher and may hold only the current branch — the listing is
 * best-effort and is deliberately skipped when the page was served from the KV
 * snapshot, which is the path that must stay free of git work.
 */
export const RepoPage: FC<RepoProps> = ({
  project,
  files,
  filesUnavailable,
  log,
  readme,
  user,
  importProgress,
  syncStatus,
  canSync,
  isOwner,
  canWrite,
  nonce,
  refName,
  defaultBranch,
  branchNames = [],
}) => {
  const hasSource = !!project.sourceUrl;
  const currentRef = refName ?? defaultBranch;
  // #304: an empty repo offered a live "Sync Now" button beside "Not synced"
  // and an in-progress import badge — three claims that could not all be true.
  // A failed listing also yields no files, but that is the one moment a user
  // most needs Sync Now, so it must not be mistaken for an empty repo.
  const hasContent = files.length > 0 || filesUnavailable === true;
  const isSyncing = project.lastSyncStatus === "in_progress";
  const hasUpdates = syncStatus?.hasUpdates;
  const syncFailed = project.lastSyncStatus === "failed";

  return (
    <Layout title={project.name} user={user}>
      <ProjectHeader project={project} active="code" canWrite={canWrite ?? isOwner}>
        {hasSource && canSync && hasContent && (
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
                  Sync Now{" "}
                  {syncStatus?.commitsBehind
                    ? `(${syncStatus.commitsBehind} commit${syncStatus.commitsBehind > 1 ? "s" : ""} behind)`
                    : ""}
                </>
              ) : (
                <>Sync Now</>
              )}
            </button>
          </form>
        )}
        {currentRef !== undefined && (
          <BranchSwitcher
            action={`/${project.namespace}/${project.slug}`}
            branchNames={branchNames}
            currentRef={currentRef}
          />
        )}
      </ProjectHeader>

      {/* Sync Status Banner */}
      {hasSource && (
        <div class={`card sync-status-card ${syncFailed ? "sync-error" : ""}`}>
          <div class="sync-status-header">
            <div class="sync-status-info">
              <span class="sync-provider">
                {project.sourceOwner && project.sourceRepo
                  ? `Forked from ${project.sourceOwner}/${project.sourceRepo}`
                  : `${getProviderIcon(project.sourceProvider)} ${getProviderName(project.sourceProvider)}`}
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
              <strong>Error:</strong> {project.lastSyncError.slice(0, 200)}
              {project.lastSyncError.length > 200 ? "…" : ""}
            </div>
          )}
        </div>
      )}

      {hasSource && canSync && files.length > 0 && project.sourceProvider === "github" && (
        <div class="card" style={{ marginTop: "1rem" }}>
          <h3 style={{ marginTop: 0 }}>Prepare a pull request</h3>
          <p style={{ color: "#aaa", marginBottom: "1rem" }}>
            Your changes in <strong>{project.name}</strong> can be pushed back to{" "}
            <a href={project.sourceUrl} target="_blank" rel="noopener noreferrer">
              {project.sourceOwner && project.sourceRepo
                ? `${project.sourceOwner}/${project.sourceRepo}`
                : project.sourceUrl?.replace(/^https?:\/\//, "")}
            </a>{" "}
            as a pull request. Open your Changes to review and push.
          </p>
          <a href={`/${project.namespace}/${project.slug}/changes`} class="btn btn-primary">
            Open Changes
          </a>
        </div>
      )}

      {hasSource && canSync && files.length > 0 && project.sourceProvider !== "github" && (
        <div class="card" style={{ marginTop: "1rem" }}>
          <h3 style={{ marginTop: 0 }}>Review your changes</h3>
          <p style={{ color: "#aaa", marginBottom: "1rem" }}>
            View and manage your changes before pushing them upstream.
          </p>
          <a href={`/${project.namespace}/${project.slug}/changes`} class="btn btn-primary">
            Open Changes
          </a>
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
          nonce={nonce}
        />
      )}

      <div class="repo-layout">
        <div class="repo-sidebar">
          <div class="card">
            <h2>Files</h2>
            <FileTree
              nodes={buildFileTree(files)}
              namespace={project.namespace}
              slug={project.slug}
              nonce={nonce}
              refName={refName}
            />
          </div>
        </div>

        <div class="repo-main">
          {readme && (
            <div class="card readme-card">
              <h2>README</h2>
              {/* renderReadme() runs marked then sanitize-html — safe to inject */}
              <div
                class="readme-content"
                dangerouslySetInnerHTML={{ __html: renderReadme(readme) }}
              />
            </div>
          )}

          <div class="card">
            <h2>Recent commits</h2>
            {log.length === 0 ? (
              <div class="empty-state">
                <p>No commits yet.</p>
              </div>
            ) : (
              <table class="table commit-table">
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
                      <td class="mono commit-sha">{commit.sha.slice(0, 7)}</td>
                      <td class="commit-message">{commit.message.split("\n")[0]}</td>
                      <td class="commit-author">{commit.author.replace(/<[^>]+>/, "").trim()}</td>
                      <td class="commit-date">
                        {new Date(commit.timestamp * 1000).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
};
