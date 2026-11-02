import type { FC } from "hono/jsx";
import type { ProjectSecretSummary } from "../../storage/project-secrets";
import { ProjectHeader } from "../components/project-header";
import { Layout } from "../layout";

interface ProjectSettingsProps {
  project: {
    name: string;
    namespace: string;
    slug: string;
    visibility?: string;
    createdAt: string;
    sourceUrl?: string;
    lastSyncedAt?: string;
    autoSyncEnabled?: boolean;
  };
  isOwner: boolean;
  /**
   * Names and metadata only. There is no read path for a secret value anywhere
   * in the codebase, so the page could not render one even if it wanted to —
   * see `src/storage/project-secrets.ts`.
   */
  secrets?: ProjectSecretSummary[];
  /**
   * The secret listing failed. Rendered as its own state because an empty list
   * and a failed lookup are different facts: "you have none" versus "we could
   * not tell", and showing the former after a storage error invites an admin to
   * re-paste credentials that are already stored.
   */
  secretsUnavailable?: boolean;
  /**
   * Deploy credentials are admin-only and refused to agent identities, which is
   * stricter than the write access this page otherwise requires.
   */
  canManageSecrets?: boolean;
  /** Set after a failed add, so the reason survives the redirect back here. */
  secretError?: string;
  user?: { id: string; email: string; username: string } | null;
}

export const ProjectSettingsPage: FC<ProjectSettingsProps> = ({
  project,
  isOwner,
  secrets,
  secretsUnavailable,
  canManageSecrets,
  secretError,
  user,
}) => {
  const base = `/${project.namespace}/${project.slug}`;
  // The secret forms post to the API router: it holds the one copy of the
  // admin-and-not-an-agent gate, and answers a form submission with a redirect
  // back to this page rather than JSON.
  const secretsApi = `/api/projects/${project.namespace}/${project.slug}/secrets`;
  return (
    <Layout title={`Settings — ${project.name}`} user={user}>
      <ProjectHeader project={project} active="settings" canWrite={true} />

      <div class="card">
        <h3 style={{ marginTop: 0 }}>General</h3>
        <dl class="detail-list">
          <dt>Name</dt>
          <dd>{project.name}</dd>
          <dt>Path</dt>
          <dd>
            {project.namespace}/{project.slug}
          </dd>
          <dt>Visibility</dt>
          <dd>{project.visibility ?? "private"}</dd>
          <dt>Created</dt>
          <dd>{new Date(project.createdAt).toLocaleDateString()}</dd>
        </dl>
      </div>

      {project.sourceUrl && (
        <div class="card">
          <h3 style={{ marginTop: 0 }}>Upstream sync</h3>
          <p class="settings-help">
            This project was imported from{" "}
            <a href={project.sourceUrl} target="_blank" rel="noopener noreferrer">
              {project.sourceUrl.replace(/^https?:\/\//, "")}
            </a>
            . Sync pulls new upstream commits into the project.
          </p>
          <div class="action-row">
            <a class="btn" href={`${base}/sync`}>
              Sync settings &amp; history
            </a>
          </div>
        </div>
      )}

      <div class="card">
        <h3 style={{ marginTop: 0 }}>Webhooks</h3>
        <p class="settings-help">
          Deliver signed JSON payloads to your endpoints when events happen in this project.
        </p>
        <div class="action-row">
          <a class="btn" href={`${base}/webhooks`}>
            Manage webhooks
          </a>
        </div>
      </div>

      <div class="card">
        <h3 style={{ marginTop: 0 }}>Deployments</h3>
        <p class="settings-help">
          Post-merge deploys declared under <code>deploys:</code> in{" "}
          <code>.stratum/policy.yaml</code>, with their history and log tails.
        </p>
        <div class="action-row">
          <a class="btn" href={`${base}/deployments`}>
            View deployments
          </a>
        </div>
      </div>

      {canManageSecrets && (
        <div class="card" id="secrets">
          <h3 style={{ marginTop: 0 }}>Deploy secrets</h3>
          <p class="settings-help">
            Provider credentials the deploy runner resolves by name from a deploy's{" "}
            <code>secrets:</code> list. Values are encrypted at rest and are never shown again — not
            here, not through the API. Replace one by adding it under the same name.
          </p>
          {secretError !== undefined && (
            <p class="settings-help settings-help-error">{secretError}</p>
          )}
          <form method="post" action={secretsApi} class="secret-form">
            <label>
              Name
              <input
                type="text"
                name="name"
                placeholder="VERCEL_TOKEN"
                pattern="[A-Z][A-Z0-9_]{0,63}"
                title="Uppercase letters, digits and underscores; must start with a letter"
                required
                autocomplete="off"
              />
            </label>
            <label>
              Value
              {/* type=password so the value is not shoulder-surfed while typing;
                  it is never re-rendered, so nothing is ever masked back. */}
              <input type="password" name="value" required autocomplete="off" />
            </label>
            <button type="submit" class="btn btn-primary">
              Save secret
            </button>
          </form>

          {secretsUnavailable ? (
            <p class="settings-help settings-help-error" style="margin-top: 1rem;">
              Could not load this project's secrets. They are still stored — this is a read failure,
              not an empty list. Reload the page; adding a secret under an existing name would
              replace it.
            </p>
          ) : secrets === undefined || secrets.length === 0 ? (
            <p class="settings-help" style="margin-top: 1rem;">
              No deploy secrets stored for this project.
            </p>
          ) : (
            <div class="table-scroll" style="margin-top: 1rem;">
              <table class="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Added</th>
                    <th>Last updated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {secrets.map((secret) => (
                    <tr key={secret.name}>
                      <td class="mono">{secret.name}</td>
                      <td>{secret.createdAt}</td>
                      <td>{secret.updatedAt}</td>
                      <td>
                        <form
                          method="post"
                          action={`${secretsApi}/${encodeURIComponent(secret.name)}/delete`}
                        >
                          <button type="submit" class="btn btn-small btn-danger">
                            Delete
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {isOwner && (
        <div class="card danger-zone">
          <h3 style={{ marginTop: 0 }}>Danger Zone</h3>
          <p>
            Permanently delete this project and every byte tied to it — repo, forks, changes, and
            all metadata. This cannot be undone. Type{" "}
            <code>
              {project.namespace}/{project.slug}
            </code>{" "}
            to confirm.
          </p>
          <form method="post" action={`/api/projects/${project.namespace}/${project.slug}/delete`}>
            <input
              type="text"
              name="confirm"
              required
              autocomplete="off"
              placeholder={`${project.namespace}/${project.slug}`}
            />
            <button type="submit" class="btn btn-danger">
              Delete project
            </button>
          </form>
        </div>
      )}
    </Layout>
  );
};
