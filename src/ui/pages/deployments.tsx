import type { FC } from "hono/jsx";
import {
  type Deployment,
  type DeploymentStatus,
  PIPELINE_TARGET,
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

/**
 * Whether a deployment can be rolled back to: it has to have been live. The
 * route enforces this (and who may do it); the page only decides whether to
 * offer the control.
 */
export function canRollBackTo(deployment: Deployment): boolean {
  return deployment.status === "succeeded" && deployment.target !== UNRESOLVED_TARGET;
}

/** A recorded version, shortened for a table cell. The full value is in the title. */
function shortVersion(version: string): string {
  return version.length > 12 ? `${version.slice(0, 12)}…` : version;
}

const EXAMPLE_PIPELINE = `deploy:
  environments:
    - name: staging
      steps:
        - name: deploy
          run: npx wrangler deploy --env staging
    - name: production
      requiresApproval: true
      steps:
        - name: deploy
          run: npx wrangler deploy --env production`;

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
    <p class="empty-state-hint">
      A project that needs a build, database migrations or staged environments declares a pipeline
      in <code>.stratum/ci.yaml</code> instead. It runs on the instance's CI executor, which holds
      the deploy credentials:
    </p>
    <pre class="cli-hint">{EXAMPLE_PIPELINE}</pre>
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
                  <th>Version</th>
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
                      {deployment.rollbackOf !== undefined && (
                        <span class="deploy-attempt"> · rollback</span>
                      )}
                    </td>
                    <td class={deployment.target === UNRESOLVED_TARGET ? "deploy-target-none" : ""}>
                      {deployment.target}
                    </td>
                    <td class="mono" title={deployment.commitSha}>
                      {shortSha(deployment.commitSha)}
                    </td>
                    <td class="mono" title={deployment.version}>
                      {deployment.version !== undefined ? shortVersion(deployment.version) : "—"}
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
          {deployment.version !== undefined && (
            <>
              <dt>Version</dt>
              <dd class="mono">{deployment.version}</dd>
            </>
          )}
          {deployment.rollbackOf !== undefined && (
            <>
              <dt>Rollback to</dt>
              <dd>
                <a href={`${base}/${deployment.rollbackOf}`}>{deployment.rollbackOf}</a>
              </dd>
            </>
          )}
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
            {/* A link to a confirmation page, not a button that acts: rolling
                back replaces what is live, and the page says what it will and
                will not do before anything happens. */}
            {canRollBackTo(deployment) && (
              <a class="btn btn-small" href={`${base}/${deployment.id}/rollback`}>
                Roll back to this deploy
              </a>
            )}
            {deployment.target === PIPELINE_TARGET && deployment.status !== "pending_approval" && (
              <a
                class="btn btn-small"
                href={`/api/deployments/${encodeURIComponent(deployment.id)}/log`}
              >
                Full log
              </a>
            )}
          </div>
        )}
      </div>

      {/* Only writers are served a log tail at all — it holds a redacted
          provider payload — so its absence is the normal case, not an error. */}
      {deployment.logTail !== undefined && (
        <div class="card">
          <h3 style={{ marginTop: 0 }}>Log tail</h3>
          <p class="settings-help">
            {deployment.target === PIPELINE_TARGET
              ? "How each step ended, and the end of the last step's output."
              : "The last output from the provider, truncated and with known secret values redacted."}
          </p>
          <pre class="deploy-log">{deployment.logTail}</pre>
        </div>
      )}
    </Layout>
  );
};

interface RollbackConfirmPageProps {
  project: DeploymentsProject;
  deployment: Deployment;
  user?: PageUser;
}

/**
 * The confirmation a rollback goes through. A plain page with a plain form:
 * the only thing on it that acts is the submit button, which posts
 * `confirm=yes` to the same route an API caller uses.
 *
 * It states the one thing people assume a rollback does and it does not.
 */
export const RollbackConfirmPage: FC<RollbackConfirmPageProps> = ({
  project,
  deployment,
  user,
}) => {
  const base = `/${project.namespace}/${project.slug}/deployments`;
  return (
    <Layout title={`Roll back ${deployment.name} — ${project.name}`} user={user}>
      <ProjectHeader project={project} active="deployments" canWrite={true} />
      <div class="page-header">
        <h1>Roll back {deployment.name}</h1>
      </div>
      <div class="card">
        <p>
          This starts a new deployment of <strong>{deployment.name}</strong> that puts back what
          this one deployed:
        </p>
        <dl class="detail-list">
          <dt>Commit</dt>
          <dd class="mono">{deployment.commitSha}</dd>
          {deployment.version !== undefined && (
            <>
              <dt>Version</dt>
              <dd class="mono">{deployment.version}</dd>
            </>
          )}
          <dt>Deployed</dt>
          <dd>{deployment.completedAt ?? deployment.createdAt}</dd>
        </dl>
        <p class="deploy-reason">
          <strong>Database migrations are not undone.</strong> Migrations are forward-only: the
          earlier code is deployed against the schema as it is now. If a later migration removed or
          changed something that code relies on, rolling back will not bring it back.
        </p>
        <p class="settings-help">
          The rollback waits its turn like any deployment of this environment, replaces any
          deployment of it that is still queued or waiting for approval, and does not promote to a
          later environment. It is recorded in the audit log under your name.
        </p>
        <form
          method="post"
          action={`/api/deployments/${encodeURIComponent(deployment.id)}/rollback`}
          class="action-row"
        >
          <input type="hidden" name="confirm" value="yes" />
          <button type="submit" class="btn btn-danger">
            Roll back {deployment.name} to this deploy
          </button>
          <a class="btn" href={`${base}/${deployment.id}`}>
            Cancel
          </a>
        </form>
      </div>
    </Layout>
  );
};
