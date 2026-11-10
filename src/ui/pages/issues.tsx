import type { FC } from "hono/jsx";
import type { IssueComment } from "../../storage/issue-comments";
import { type Issue, SYSTEM_AUTHOR_ID } from "../../storage/issues";
import { ProjectHeader } from "../components/project-header";
import { Layout } from "../layout";

interface ProjectRef {
  name: string;
  namespace: string;
  slug: string;
  visibility?: string;
}

interface IssuesPageProps {
  project: ProjectRef;
  issues: Issue[];
  /** Absent for an issue with no labels, rather than an empty array. */
  labels: Record<string, string[]>;
  authors: Record<string, string>;
  filter: "open" | "closed" | "all";
  activeLabel?: string;
  query?: string;
  /** Zero-based page index; `hasNext` comes from reading one row past the page. */
  page: number;
  hasNext: boolean;
  canWrite: boolean;
  user?: { id: string; email: string; username: string } | null;
}

/**
 * Previous/next links for a page bounded by a fixed limit. `hasNext` comes from
 * reading one row past the limit, so there is no total to show — the label
 * carries the 1-based page number rather than "of N".
 *
 * `order` is the chronological direction of the underlying query, and it decides
 * which way the labels point. The issue list is newest-first (`desc`), so a
 * higher page holds older rows; comments are oldest-first (`asc`), so a higher
 * page holds *newer* rows. Labelling both the same way would send the reader the
 * wrong direction on one of them.
 */
const PageNav: FC<{
  base: string;
  keep: string;
  page: number;
  hasNext: boolean;
  order?: "asc" | "desc";
}> = ({ base, keep, page, hasNext, order = "desc" }) => {
  if (page === 0 && !hasNext) return null;
  const href = (target: number) => {
    const params = [...(keep ? [keep] : []), ...(target > 0 ? [`page=${target}`] : [])].join("&");
    return params ? `${base}?${params}` : base;
  };
  const prevLabel = order === "asc" ? "← Older" : "← Newer";
  const nextLabel = order === "asc" ? "Newer →" : "Older →";
  return (
    <nav class="page-nav" aria-label="Pagination">
      {page > 0 ? (
        <a class="btn" href={href(page - 1)} rel="prev">
          {prevLabel}
        </a>
      ) : (
        <span class="btn btn-disabled" aria-disabled="true">
          {prevLabel}
        </span>
      )}
      <span class="issues-meta">Page {page + 1}</span>
      {hasNext ? (
        <a class="btn" href={href(page + 1)} rel="next">
          {nextLabel}
        </a>
      ) : (
        <span class="btn btn-disabled" aria-disabled="true">
          {nextLabel}
        </span>
      )}
    </nav>
  );
};

/**
 * Who to show as an issue's or comment's author. An item imported from GitHub
 * whose author has no Stratum account records the importer as `authorId` and
 * the GitHub login as `externalAuthor`; the login is the honest answer.
 */
const authorLabel = (
  item: { authorId: string; authorType: string; externalAuthor?: string },
  authors: Record<string, string>,
) =>
  item.externalAuthor !== undefined
    ? `${item.externalAuthor} (GitHub)`
    : item.authorId === SYSTEM_AUTHOR_ID
      ? "Stratum (automated)"
      : (authors[item.authorId] ?? item.authorType);

/** Link back to the GitHub original of an imported issue or comment. */
const GitHubBackLink: FC<{ href: string; label: string }> = ({ href, label }) => (
  <a href={href} target="_blank" rel="noopener noreferrer nofollow">
    {label}
  </a>
);

const statusBadge = (status: Issue["status"]) =>
  status === "open" ? "badge badge-open" : "badge badge-merged";

/**
 * `keep` carries the filters a label link must not discard — the status tab and
 * the search text. The label itself is replaced, not accumulated, so the caller
 * must leave the active `label=` out of `keep`.
 */
const LabelChips: FC<{ labels: string[]; base: string; keep?: string }> = ({
  labels,
  base,
  keep,
}) => (
  <>
    {labels.map((label) => (
      <a
        key={label}
        class="badge issue-label"
        href={`${base}?label=${encodeURIComponent(label)}${keep ? `&${keep}` : ""}`}
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
  page,
  hasNext,
  canWrite,
  user,
}) => {
  const base = `/${project.namespace}/${project.slug}/issues`;
  // Preserve the label/search filters when switching status tabs.
  const keep = [
    ...(activeLabel ? [`label=${encodeURIComponent(activeLabel)}`] : []),
    ...(query ? [`q=${encodeURIComponent(query)}`] : []),
  ].join("&");
  // A label link swaps the label filter, so it carries the status tab and the
  // search text but deliberately not the current `label=`.
  const labelKeep = [
    ...(filter !== "open" ? [`status=${filter}`] : []),
    ...(query ? [`q=${encodeURIComponent(query)}`] : []),
  ].join("&");
  // Everything the pager must carry across pages: status tab, label, search.
  const pageKeep = [...(filter !== "open" ? [`status=${filter}`] : []), ...(keep ? [keep] : [])]
    .filter(Boolean)
    .join("&");
  const tab = (status?: "closed" | "all") => {
    const params = [...(status ? [`status=${status}`] : []), ...(keep ? [keep] : [])].join("&");
    return params ? `${base}?${params}` : base;
  };
  return (
    <Layout title={`Issues — ${project.name}`} user={user}>
      <ProjectHeader project={project} active="issues" canWrite={canWrite}>
        {canWrite && (
          <a class="btn btn-primary" href={`${base}/new`}>
            New issue
          </a>
        )}
      </ProjectHeader>

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
            label: <strong>{activeLabel}</strong>{" "}
            {/* labelKeep, not tab(): tab() carries `keep`, which includes the
                active `label=`, so it would rebuild the very filter this link
                clears. labelKeep is the same set minus the label. */}
            <a href={labelKeep ? `${base}?${labelKeep}` : base}>clear</a>
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
              <LabelChips labels={labels[issue.id] ?? []} base={base} keep={labelKeep} />
              {issue.linkedChangeId && (
                <a href={`/changes/${issue.linkedChangeId}`} class="issues-linked-change">
                  {issue.linkedChangeId}
                </a>
              )}
              <span class="issues-meta">
                opened {new Date(issue.createdAt).toLocaleDateString()} by{" "}
                {authorLabel(issue, authors)}
                {issue.assignee
                  ? ` · assigned to ${authors[issue.assignee] ?? issue.assignee}`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      <PageNav base={base} keep={pageKeep} page={page} hasNext={hasNext} />
    </Layout>
  );
};

interface IssueDetailPageProps {
  project: ProjectRef;
  issue: Issue;
  labels: string[];
  comments: IssueComment[];
  /** Zero-based comment page; `commentsHasNext` reads one row past the page. */
  commentPage: number;
  commentsHasNext: boolean;
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
  commentPage,
  commentsHasNext,
  authors,
  canWrite,
  user,
}) => {
  const base = `/${project.namespace}/${project.slug}/issues`;
  const apiBase = `/api/projects/${project.namespace}/${project.slug}/issues`;
  return (
    <Layout title={`#${issue.number} ${issue.title} — ${project.name}`} user={user}>
      <ProjectHeader project={project} active="issues" canWrite={canWrite} />
      <div class="page-header">
        <h1>
          #{issue.number} {issue.title}
        </h1>
      </div>

      <div class="issue-status-row">
        <span class={statusBadge(issue.status)}>{issue.status}</span>
        <LabelChips labels={labels} base={base} />
        <span class="issues-meta">
          opened {new Date(issue.createdAt).toLocaleString()} by {authorLabel(issue, authors)}
          {issue.assignee ? ` · assigned to ${authors[issue.assignee] ?? issue.assignee}` : ""}
          {issue.closedAt ? ` · closed ${new Date(issue.closedAt).toLocaleString()}` : ""}
          {issue.closedBy === "system" ? " (auto-closed by merged change)" : ""}
          {issue.externalUrl !== undefined && (
            <>
              {" · "}
              <GitHubBackLink href={issue.externalUrl} label="imported from GitHub" />
            </>
          )}
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
          {comments.length === 0 || commentPage > 0 || commentsHasNext
            ? "Comments"
            : `${comments.length} comment${comments.length === 1 ? "" : "s"}`}
        </h2>
        {comments.map((comment) => (
          <div key={comment.id} class="card issue-comment">
            <div class="issues-meta">
              {authorLabel(comment, authors)} · {new Date(comment.createdAt).toLocaleString()}
              {comment.externalUrl !== undefined && (
                <>
                  {" · "}
                  <GitHubBackLink href={comment.externalUrl} label="on GitHub" />
                </>
              )}
            </div>
            <pre class="issue-body-text">{comment.body}</pre>
          </div>
        ))}
        <PageNav
          base={`${base}/${issue.number}`}
          keep=""
          page={commentPage}
          hasNext={commentsHasNext}
          order="asc"
        />
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
      <ProjectHeader project={project} active="issues" canWrite={true}>
        <a class="btn" href={`/${project.namespace}/${project.slug}/issues`}>
          Cancel
        </a>
      </ProjectHeader>
      <div class="page-header">
        <h1>New issue</h1>
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
