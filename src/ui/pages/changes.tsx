import type { FC } from "hono/jsx";
import type { UsageBannerNotice } from "../../billing/usage-banner";
import { ProjectHeader } from "../components/project-header";
import { Layout } from "../layout";

interface ChangesProps {
  project: {
    name: string;
    namespace: string;
    slug: string;
    visibility?: string;
  };
  canWrite?: boolean;
  changes: Array<{
    id: string;
    workspace: string;
    status: string;
    evalScore?: number;
    evalPassed?: boolean;
    createdAt: string;
  }>;
  user?: { id: string; email: string; username: string } | null;
  /** The 80% warning, when this account has one. See `Layout`. */
  usageNotice?: UsageBannerNotice | null;
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "open":
      return "badge badge-open";
    case "approved":
    case "accepted":
      return "badge badge-approved";
    case "merged":
    case "promoted":
      return "badge badge-merged";
    case "rejected":
    case "reverted":
    case "needs_changes":
      return "badge badge-rejected";
    default:
      return "badge";
  }
}

export const ChangesPage: FC<ChangesProps> = ({
  project,
  changes,
  canWrite,
  user,
  usageNotice,
}) => {
  return (
    <Layout title={`Changes — ${project.name}`} user={user} usageNotice={usageNotice}>
      <ProjectHeader project={project} active="changes" canWrite={canWrite ?? false} />

      {changes.length === 0 ? (
        <div class="empty-state">
          <p>No changes yet.</p>
          <p class="empty-state-hint">
            Changes are proposed from a workspace — a private fork of this project — and gated on
            tests and review before they merge. From your terminal:
          </p>
          <pre class="cli-hint">
            {`stratum workspace create ${project.namespace}/${project.slug}
stratum change create --project ${project.namespace}/${project.slug} --workspace <name>`}
          </pre>
          <p class="empty-state-hint">
            <a href="https://docs.usestratum.dev" target="_blank" rel="noopener noreferrer">
              CLI setup guide →
            </a>
          </p>
        </div>
      ) : (
        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Status</th>
                <th>Eval score</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((change) => (
                <tr key={change.id}>
                  <td>
                    <a href={`/changes/${change.id}`}>{change.workspace}</a>
                  </td>
                  <td>
                    <span class={statusBadgeClass(change.status)}>{change.status}</span>
                  </td>
                  <td>
                    {change.evalScore !== undefined
                      ? `${Math.round(change.evalScore * 100)}%`
                      : "—"}
                  </td>
                  <td>{new Date(change.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  );
};
