import type { FC } from "hono/jsx";
import {
  type Deployment,
  type DeploymentStatus,
  TERMINAL_DEPLOYMENT_STATUSES,
  UNRESOLVED_TARGET,
} from "../../storage/deployments";
import { ProjectHeader } from "../components/project-header";
import { Layout } from "../layout";

interface DeploymentsProject {
  name: string;
  namespace: string;
  slug: string;
  visibility?: string;
}

type PageUser = { id: string; email: string; username: string } | null;

interface DeploymentsPageProps {
  project: DeploymentsProject;
  deployments: Deployment[];
  /**
   * Writers get the action buttons *and* the log tail. The route strips
   * `logTail` for everyone else, so the page never assumes it is present.
   */
  canWrite: boolean;
  user?: PageUser;
}

interface DeploymentDetailPageProps {
  project: DeploymentsProject;
  deployment: Deployment;
  canWrite: boolean;
  user?: PageUser;
}

/**
 * Badge class per status, reusing the palette the rest of the UI already uses.
 *
 * `skipped` deliberately reads as neutral, not as a failure: it means the merge
 * had nothing configured to deploy, which is the normal state of most projects.
 * `superseded` is neutral for the same reason — a newer merge won the race.
 */
export function deploymentStatusClass(status: DeploymentStatus): string {
  switch (status) {
    case "pending_approval":
      return "badge-pending-approval";
    case "queued":
      return "badge-queued";
    case "running":
      return "badge-running";
    case "succeeded":
      return "badge-succeeded";
    case "failed":
      return "badge-failed";
    case "superseded":
      return "badge-superseded";
    case "skipped":
      return "badge-skipped";
  }
}

/** "pending approval" reads better than the wire value in a badge. */
export function deploymentStatusLabel(status: DeploymentStatus): string {
  return status.replace(/_/g, " ");
}

export function isTerminalStatus(status: DeploymentStatus): boolean {
  return (TERMINAL_DEPLOYMENT_STATUSES as readonly string[]).includes(status);
}

/** Elapsed provider time. Absent until the row reaches a terminal status. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

const EXAMPLE_POLICY = `deploys:
  - name: production
    target: vercel
    secrets: [VERCEL_TOKEN, VERCEL_PROJECT_ID]
    requiresApproval: false`;

/**
 * Shown instead of an empty table. A project with no deployments has almost
 * always never configured one, so the state that needs explaining is the
 * configuration, not the absence of rows.
 */
const EmptyState: FC = () => (
  <div class="empty-state">
    <p>No deployments yet.</p>
    <p class="empty-state-hint">
      Deployments run after a change merges. Add a <code>deploys:</code> block to{" "}
      <code>.stratum/policy.yaml</code> on the default branch:
    </p>
    <pre class="cli-hint">{EXAMPLE_POLICY}</pre>
    <p class="empty-state-hint">
      Provider credentials are stored per project under Settings → Deploy secrets, and referenced by
      name from <code>secrets:</code>.
    </p>
  </div>
);

/**
 * Approve and Retry as plain forms — no page in this UI depends on client JS.
 * Both post to `/api/deployments/:id/*`, the same routes a programmatic caller
 * uses: they answer a form submission with a redirect back here and a JSON
 * caller with the deployment, so there is one authorization gate per action
 * rather than a browser copy and an API copy.
 */
const RowActions: FC<{ deployment: Deployment }> = ({ deployment }) => {
  const api = `/api/deployments/${encodeURIComponent(deployment.id)}`;
  if (deployment.status === "pending_approval") {
    return (
      <form method="post" action={`${api}/approve`}>
        <button type="submit" class="btn btn-small btn-primary">
          Approve
        </button>
      </form>
    );
  }
  // Only a finished attempt can be retried: a queued or running row still has a
  // future, and retrying a `pending_approval` one would route around approval.
  if (isTerminalStatus(deployment.status)) {
    return (
      <form method="post" action={`${api}/retry`}>
        <button type="submit" class="btn btn-small">
          Retry
        </button>
      </form>
    );
  }
  return null;
};

export const DeploymentsPage: FC<DeploymentsPageProps> = ({
  project,
  deployments,
  canWrite,
  user,
}) => {
  const base = `/${project.namespace}/${project.slug}/deployments`;
  return (
    <Layout title={`Deployments — ${project.name}`} user={user}>
      <ProjectHeader project={project} active="deployments" canWrite={canWrite} />
      <div class="page-header">
        <h1>Deployments</h1>
      </div>

      {deployments.length === 0 ? (
        <EmptyState />
      ) : (
        <div class="card">
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Name</th>
                  <th>Target</th>
                  <th>Commit</th>
                  <th>Duration</th>
                  <th>Created</th>
                  {canWrite && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {deployments.map((deployment) => (
                  <tr key={deployment.id}>
                    <td>
                      <a href={`${base}/${deployment.id}`}>
                        <span class={`badge ${deploymentStatusClass(deployment.status)}`}>
                          {deploymentStatusLabel(deployment.status)}
                        </span>
                      </a>
                    </td>
                    <td>
                      {deployment.name}
                      {deployment.attempt > 1 && (
                        <span class="deploy-attempt"> · attempt {deployment.attempt}</span>
                      )}
                    </td>
                    <td class={deployment.target === UNRESOLVED_TARGET ? "deploy-target-none" : ""}>
                      {deployment.target}
                    </td>
                    <td class="mono" title={deployment.commitSha}>
                      {shortSha(deployment.commitSha)}
                    </td>
                    <td>{formatDuration(deployment.durationMs)}</td>
                    <td>{deployment.createdAt}</td>
                    {canWrite && (
                      <td>
                        <RowActions deployment={deployment} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Layout>
  );
};

export const DeploymentDetailPage: FC<DeploymentDetailPageProps> = ({
  project,
  deployment,
  canWrite,
  user,
}) => {
  const base = `/${project.namespace}/${project.slug}/deployments`;
  return (
    <Layout title={`${deployment.name} deployment — ${project.name}`} user={user}>
      <ProjectHeader project={project} active="deployments" canWrite={canWrite} />
      <div class="page-header">
        <h1>
          {deployment.name}{" "}
          <span class={`badge ${deploymentStatusClass(deployment.status)}`}>
            {deploymentStatusLabel(deployment.status)}
          </span>
        </h1>
        <a class="btn btn-small" href={base}>
          All deployments
        </a>
      </div>

      <div class="card">
        <dl class="detail-list">
          <dt>Target</dt>
          <dd>{deployment.target}</dd>
          <dt>Commit</dt>
          <dd class="mono">{deployment.commitSha}</dd>
          <dt>Attempt</dt>
          <dd>{deployment.attempt}</dd>
          <dt>Requested by</dt>
          <dd>{deployment.requestedById ?? deployment.requestedByType}</dd>
          {deployment.approvedBy !== undefined && (
            <>
              <dt>Approved by</dt>
              <dd>{deployment.approvedBy}</dd>
            </>
          )}
          <dt>Created</dt>
          <dd>{deployment.createdAt}</dd>
          {deployment.completedAt !== undefined && (
            <>
              <dt>Completed</dt>
              <dd>{deployment.completedAt}</dd>
            </>
          )}
          <dt>Duration</dt>
          <dd>{formatDuration(deployment.durationMs)}</dd>
          {deployment.url !== undefined && (
            <>
              <dt>URL</dt>
              <dd>
                <a href={deployment.url} rel="noopener noreferrer">
                  {deployment.url}
                </a>
              </dd>
            </>
          )}
          {deployment.changeId !== undefined && (
            <>
              <dt>Change</dt>
              <dd>
                <a href={`/changes/${deployment.changeId}`}>{deployment.changeId}</a>
              </dd>
            </>
          )}
        </dl>

        {deployment.reason !== undefined && <p class="deploy-reason">{deployment.reason}</p>}

        {canWrite && (
          <div class="action-row">
            <RowActions deployment={deployment} />
          </div>
        )}
      </div>

      {/* Only writers are served a log tail at all — it holds a redacted
          provider payload — so its absence is the normal case, not an error. */}
      {deployment.logTail !== undefined && (
        <div class="card">
          <h3 style={{ marginTop: 0 }}>Log tail</h3>
          <p class="settings-help">
            The last output from the provider, truncated and with known secret values redacted.
          </p>
          <pre class="deploy-log">{deployment.logTail}</pre>
        </div>
      )}
    </Layout>
  );
};
