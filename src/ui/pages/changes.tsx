import type { FC } from "hono/jsx";
import { Layout } from "../layout";

interface ChangesProps {
  project: {
    name: string;
    namespace: string;
    slug: string;
  };
  changes: Array<{
    id: string;
    workspace: string;
    status: string;
    evalScore?: number;
    evalPassed?: boolean;
    createdAt: string;
  }>;
  user?: { id: string; email: string; username: string } | null;
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

export const ChangesPage: FC<ChangesProps> = ({ project, changes, user }) => {
  return (
    <Layout title={`Changes — ${project.name}`} user={user}>
      <div class="page-header">
        <h1>Changes</h1>
        <a class="btn" href={`/${project.namespace}/${project.slug}`}>
          Back to repo
        </a>
      </div>

      {changes.length === 0 ? (
        <div class="empty-state">
          <p>No changes yet.</p>
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
