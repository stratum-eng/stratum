import type { FC } from "hono/jsx";
import type { IssueImportRun } from "../../storage/github-issue-import";
import type { ProjectSecretSummary } from "../../storage/project-secrets";
import { FieldError, fieldAttrs } from "../components/field-error";
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
  /**
   * The field `secretError` is about, when it is about one: the message then
   * renders under that field instead of above the form.
   */
  secretErrorField?: "name" | "value" | undefined;
  /**
   * The GitHub issue import card (#421), present only for project admins of a
   * GitHub-sourced project. `notice` is the outcome of the last form post.
   */
  issueImport?: {
    githubRepo: string;
    latestRun: IssueImportRun | null;
    notice?: string;
  };
  user?: { id: string; email: string; username: string } | null;
}

/** One line describing an import run's state, counters included. */
function describeRun(run: IssueImportRun): string {
  const counts = `${run.issuesCreated} created, ${run.issuesUpdated} updated, ${run.commentsImported} comments, ${run.pullsSkipped} pull requests skipped`;
  switch (run.status) {
    case "queued":
      return "Queued — waiting for the import worker.";
    case "running":
      return `Running (${counts}).`;
    case "completed":
      return `Completed ${new Date(run.completedAt ?? run.updatedAt).toLocaleString()} (${counts}).`;
    case "failed":
      return `Failed (${counts}).`;
  }
}

export const ProjectSettingsPage: FC<ProjectSettingsProps> = ({
  project,
  isOwner,
  secrets,
  secretsUnavailable,
  canManageSecrets,
  secretError,
  secretErrorField,
  issueImport,
  user,
}) => {
  const nameError = secretErrorField === "name" ? secretError : undefined;
  const valueError = secretErrorField === "value" ? secretError : undefined;
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

      {issueImport && (
        <div class="card" id="issue-import">
          <h3 style={{ marginTop: 0 }}>Import GitHub issues</h3>
          <p class="settings-help">
            Copy the issues of <code>{issueImport.githubRepo}</code> — titles, descriptions, state,
            labels and comments, each linked back to GitHub — into this project's issue tracker.
            Pull requests are skipped. Running it again updates what was already imported instead of
            duplicating it, so you can catch up right before switching over.
          </p>
          {issueImport.notice !== undefined && <p class="settings-help">{issueImport.notice}</p>}
          {issueImport.latestRun && (
            <p class="settings-help">
              Last import: {describeRun(issueImport.latestRun)}
              {issueImport.latestRun.message !== undefined && ` ${issueImport.latestRun.message}`}
            </p>
          )}
          <form
            method="post"
            action={`/api/projects/${project.namespace}/${project.slug}/issues/import/github`}
          >
            <button type="submit" class="btn">
              {issueImport.latestRun ? "Import issues again" : "Import issues"}
            </button>
          </form>
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
          {secretError !== undefined && secretErrorField === undefined && (
            <p class="settings-help settings-help-error">{secretError}</p>
          )}
          {/* `novalidate`: the secrets route checks the name and value and
              sends the form back here with the reason under the field. */}
          <form method="post" action={secretsApi} class="secret-form" novalidate>
            <div class="secret-field">
              <label>
                Name
                <input
                  {...fieldAttrs("secret-name", nameError)}
                  type="text"
                  name="name"
                  placeholder="VERCEL_TOKEN"
                  pattern="[A-Z][A-Z0-9_]{0,63}"
                  required
                  autocomplete="off"
                />
              </label>
              <FieldError for="secret-name" message={nameError} />
            </div>
            <div class="secret-field">
              <label>
                Value
                {/* type=password so the value is not shoulder-surfed while typing;
                    it is never re-rendered, so nothing is ever masked back. */}
                <input
                  {...fieldAttrs("secret-value", valueError)}
                  type="password"
                  name="value"
                  required
                  autocomplete="off"
                />
              </label>
              <FieldError for="secret-value" message={valueError} />
            </div>
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
