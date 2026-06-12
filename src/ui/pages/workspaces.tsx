import type { FC } from "hono/jsx";
import { Layout } from "../layout";

interface WorkspacesProps {
  project: {
    name: string;
    namespace: string;
    slug: string;
  };
  workspaces: Array<{ name: string; createdAt: string }>;
  user?: { id: string; email: string; username: string } | null;
}

export const WorkspacesPage: FC<WorkspacesProps> = ({ project, workspaces, user }) => {
  return (
    <Layout title={`Workspaces — ${project.name}`} user={user}>
      <div class="page-header">
        <h1>Workspaces</h1>
        <a class="btn" href={`/${project.namespace}/${project.slug}`}>
          Back to repo
        </a>
      </div>

      {workspaces.length === 0 ? (
        <div class="empty-state">
          <p>No workspaces yet.</p>
        </div>
      ) : (
        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {workspaces.map((ws) => (
                <tr key={ws.name}>
                  <td>{ws.name}</td>
                  <td>{new Date(ws.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  );
};
