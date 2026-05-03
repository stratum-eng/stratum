import type { FC } from "hono/jsx";
import type { ImportProgress } from "../../types";
import { ImportProgressCard } from "../components/import-progress";
import { Layout } from "../layout";

interface RepoProps {
  project: { name: string; namespace: string; slug: string; remote: string; createdAt: string };
  files: string[];
  log: Array<{ sha: string; message: string; author: string; timestamp: number }>;
  readme?: string | null;
  user?: { id: string; email: string } | null;
  importProgress?: ImportProgress | null;
}

export const RepoPage: FC<RepoProps> = ({ project, files, log, readme, user, importProgress }) => {
  return (
    <Layout title={project.name} user={user}>
      <div class="page-header">
        <h1>{project.name}</h1>
        <a class="btn btn-primary" href={`/${project.namespace}/${project.slug}/changes`}>
          View changes
        </a>
      </div>

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
        {files.length === 0 ? (
          <div class="empty-state">
            <p>No files in this repository.</p>
          </div>
        ) : (
          <ul class="file-list">
            {files.map((file) => (
              <li key={file} class="file-item">
                {file}
              </li>
            ))}
          </ul>
        )}
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
