import type { FC } from "hono/jsx";
import type { IssueComment } from "../../storage/issue-comments";
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
  /** Labels keyed by issue id (issues without labels may be absent). */
  labels: Record<string, string[]>;
  /** Author display names keyed by author id. */
  authors: Record<string, string>;
  filter: "open" | "closed" | "all";
  /** Active ?label= filter, if any. */
  activeLabel?: string;
  /** Active ?q= search text, if any. */
  query?: string;
  canWrite: boolean;
  user?: { id: string; email: string; username: string } | null;
}

const statusBadge = (status: Issue["status"]) =>
  status === "open" ? "badge badge-open" : "badge badge-merged";

const LabelChips: FC<{ labels: string[]; base: string }> = ({ labels, base }) => (
  <>
    {labels.map((label) => (
      <a
        key={label}
        class="badge issue-label"
        href={`${base}?label=${encodeURIComponent(label)}`}
        title={`Filter by label "${label}"`}
      >
        {label}
      </a>
    ))}
  </>
);

export const IssuesPage: FC<IssuesPageProps> = ({
  project,
  issues,
  labels,
  authors,
  filter,
  activeLabel,
  query,
  canWrite,
  user,
}) => {
  const base = `/${project.namespace}/${project.slug}/issues`;
  // Preserve the label/search filters when switching status tabs.
  const keep = [
    ...(activeLabel ? [`label=${encodeURIComponent(activeLabel)}`] : []),
    ...(query ? [`q=${encodeURIComponent(query)}`] : []),
  ].join("&");
  const tab = (status?: "closed" | "all") => {
    const params = [...(status ? [`status=${status}`] : []), ...(keep ? [keep] : [])].join("&");
    return params ? `${base}?${params}` : base;
  };
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
        <a href={tab()} class={filter === "open" ? "issues-filter-active" : ""}>
          Open
        </a>
        <a href={tab("closed")} class={filter === "closed" ? "issues-filter-active" : ""}>
          Closed
        </a>
        <a href={tab("all")} class={filter === "all" ? "issues-filter-active" : ""}>
          All
        </a>
        <form method="get" action={base} class="issues-search">
          {filter !== "open" && <input type="hidden" name="status" value={filter} />}
          {activeLabel && <input type="hidden" name="label" value={activeLabel} />}
          <input type="search" name="q" placeholder="Search issues…" value={query ?? ""} />
        </form>
        {activeLabel && (
          <span class="issues-meta">
            label: <strong>{activeLabel}</strong> <a href={tab()}>clear</a>
          </span>
        )}
      </div>

      {issues.length === 0 ? (
        <div class="empty-state">
          <p>
            No {filter === "all" ? "" : `${filter} `}issues
            {activeLabel || query ? " match the current filter" : ""}.
          </p>
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
              <LabelChips labels={labels[issue.id] ?? []} base={base} />
              {issue.linkedChangeId && (
                <a href={`/changes/${issue.linkedChangeId}`} class="issues-linked-change">
                  {issue.linkedChangeId}
                </a>
              )}
              <span class="issues-meta">
                opened {new Date(issue.createdAt).toLocaleDateString()} by{" "}
                {authors[issue.authorId] ?? issue.authorType}
                {issue.assignee
                  ? ` · assigned to ${authors[issue.assignee] ?? issue.assignee}`
                  : ""}
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
  labels: string[];
  comments: IssueComment[];
  /** Author display names keyed by author id (issue + comment authors + assignee). */
  authors: Record<string, string>;
  canWrite: boolean;
  user?: { id: string; email: string; username: string } | null;
}

export const IssueDetailPage: FC<IssueDetailPageProps> = ({
  project,
  issue,
  labels,
  comments,
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
        <LabelChips labels={labels} base={base} />
        <span class="issues-meta">
          opened {new Date(issue.createdAt).toLocaleString()} by{" "}
          {authors[issue.authorId] ?? issue.authorType}
          {issue.assignee ? ` · assigned to ${authors[issue.assignee] ?? issue.assignee}` : ""}
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

      <div class="issue-comments">
        <h2>
          {comments.length === 0
            ? "Comments"
            : `${comments.length} comment${comments.length === 1 ? "" : "s"}`}
        </h2>
        {comments.map((comment) => (
          <div key={comment.id} class="card issue-comment">
            <div class="issues-meta">
              {authors[comment.authorId] ?? comment.authorType} ·{" "}
              {new Date(comment.createdAt).toLocaleString()}
            </div>
            <pre class="issue-body-text">{comment.body}</pre>
          </div>
        ))}
        {user ? (
          <div class="card">
            <form method="post" action={`${apiBase}/${issue.number}/comments`} class="issue-form">
              <label>
                Add a comment
                <textarea name="body" rows={4} required />
              </label>
              <button type="submit" class="btn btn-primary">
                Comment
              </button>
            </form>
          </div>
        ) : (
          <p class="issues-meta">Sign in to comment.</p>
        )}
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
