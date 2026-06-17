import type { FC } from "hono/jsx";
import type { Issue } from "../../storage/issues";
import { Layout } from "../layout";

interface ProjectRef {
  name: string;
  namespace: string;
  slug: string;
}

interface IssuesPageProps {
  project: ProjectRef;
  issues: Issue[];
  /** Author display names keyed by author id. */
  authors: Record<string, string>;
  filter: "open" | "closed" | "all";
  canWrite: boolean;
  user?: { id: string; email: string; username: string } | null;
}

const statusBadge = (status: Issue["status"]) =>
  status === "open" ? "badge badge-open" : "badge badge-merged";

export const IssuesPage: FC<IssuesPageProps> = ({
  project,
  issues,
  authors,
  filter,
  canWrite,
  user,
}) => {
  const base = `/${project.namespace}/${project.slug}/issues`;
  return (
    <Layout title={`Issues — ${project.name}`} user={user}>
      <div class="page-header">
        <h1>Issues</h1>
        <div class="page-header-actions">
          {canWrite && (
            <a class="btn btn-primary" href={`${base}/new`}>
              New issue
            </a>
          )}
          <a class="btn" href={`/${project.namespace}/${project.slug}`}>
            Back to repo
          </a>
        </div>
      </div>

      <div class="issues-filter">
        <a href={base} class={filter === "open" ? "issues-filter-active" : ""}>
          Open
        </a>
        <a href={`${base}?status=closed`} class={filter === "closed" ? "issues-filter-active" : ""}>
          Closed
        </a>
        <a href={`${base}?status=all`} class={filter === "all" ? "issues-filter-active" : ""}>
          All
        </a>
      </div>

      {issues.length === 0 ? (
        <div class="empty-state">
          <p>No {filter === "all" ? "" : `${filter} `}issues.</p>
          <p class="empty-state-hint">
            Open an issue to track work, bugs, or ideas for this project.
          </p>
        </div>
      ) : (
        <ul class="issues-list">
          {issues.map((issue) => (
            <li key={issue.id} class="issues-item">
              <span class={statusBadge(issue.status)}>{issue.status}</span>
              <a href={`${base}/${issue.number}`} class="issues-title">
                #{issue.number} {issue.title}
              </a>
              {issue.linkedChangeId && (
                <a href={`/changes/${issue.linkedChangeId}`} class="issues-linked-change">
                  {issue.linkedChangeId}
                </a>
              )}
              <span class="issues-meta">
                opened {new Date(issue.createdAt).toLocaleDateString()} by{" "}
                {authors[issue.authorId] ?? issue.authorType}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
};

interface IssueDetailPageProps {
  project: ProjectRef;
  issue: Issue;
  /** Author display names keyed by author id. */
  authors: Record<string, string>;
  canWrite: boolean;
  user?: { id: string; email: string; username: string } | null;
}

export const IssueDetailPage: FC<IssueDetailPageProps> = ({
  project,
  issue,
  authors,
  canWrite,
  user,
}) => {
  const base = `/${project.namespace}/${project.slug}/issues`;
  const apiBase = `/api/projects/${project.namespace}/${project.slug}/issues`;
  return (
    <Layout title={`#${issue.number} ${issue.title} — ${project.name}`} user={user}>
      <div class="page-header">
        <h1>
          #{issue.number} {issue.title}
        </h1>
        <a class="btn" href={base}>
          Back to issues
        </a>
      </div>

      <div class="issue-status-row">
        <span class={statusBadge(issue.status)}>{issue.status}</span>
        <span class="issues-meta">
          opened {new Date(issue.createdAt).toLocaleString()} by{" "}
          {authors[issue.authorId] ?? issue.authorType}
          {issue.closedAt ? ` · closed ${new Date(issue.closedAt).toLocaleString()}` : ""}
          {issue.closedBy === "system" ? " (auto-closed by merged change)" : ""}
        </span>
        {canWrite && (
          <form method="post" action={`${apiBase}/${issue.number}/close`}>
            <button type="submit" class="btn btn-small">
              {issue.status === "open" ? "Close issue" : "Reopen issue"}
            </button>
          </form>
        )}
      </div>

      {issue.linkedChangeId && (
        <div class="card" style={{ marginTop: "1rem" }}>
          <p style={{ margin: 0 }}>
            Linked change: <a href={`/changes/${issue.linkedChangeId}`}>{issue.linkedChangeId}</a>
            {issue.status === "open" ? " — this issue closes automatically when it merges." : ""}
          </p>
        </div>
      )}

      <div class="card issue-body">
        {issue.body ? <pre class="issue-body-text">{issue.body}</pre> : <p>No description.</p>}
      </div>
    </Layout>
  );
};

interface NewIssuePageProps {
  project: ProjectRef;
  user?: { id: string; email: string; username: string } | null;
}

export const NewIssuePage: FC<NewIssuePageProps> = ({ project, user }) => {
  const apiBase = `/api/projects/${project.namespace}/${project.slug}/issues`;
  return (
    <Layout title={`New issue — ${project.name}`} user={user}>
      <div class="page-header">
        <h1>New issue</h1>
        <a class="btn" href={`/${project.namespace}/${project.slug}/issues`}>
          Cancel
        </a>
      </div>

      <div class="card">
        <form method="post" action={apiBase} class="issue-form">
          <label>
            Title
            <input type="text" name="title" maxlength={200} required />
          </label>
          <label>
            Description
            <textarea name="body" rows={8} />
          </label>
          <label>
            Linked change ID (optional — issue closes when it merges)
            <input type="text" name="linkedChangeId" placeholder="chg_…" />
          </label>
          <button type="submit" class="btn btn-primary">
            Open issue
          </button>
        </form>
      </div>
    </Layout>
  );
};
