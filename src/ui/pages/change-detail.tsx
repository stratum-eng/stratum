import type { FC } from "hono/jsx";
import type { ChangeComment, ChangeReview } from "../../storage/change-reviews";
import type { CostSummaryEntry } from "../../storage/costs";
import { Layout } from "../layout";

interface ChangeDetailProps {
  change: {
    id: string;
    project: string;
    workspace: string;
    status: string;
    evalScore?: number;
    evalPassed?: boolean;
    evalReason?: string;
    createdAt: string;
    mergedAt?: string;
    githubPrUrl?: string;
  };
  evalRuns: Array<{
    id: string;
    evaluatorType: string;
    score: number;
    passed: boolean;
    reason: string;
    issues?: string[];
    ranAt: string;
  }>;
  provenance: {
    commitSha: string;
    workspace: string;
    agentId?: string;
    evalScore?: number;
    mergedAt: string;
  } | null;
  comments?: ChangeComment[];
  reviews?: ChangeReview[];
  costs?: CostSummaryEntry[];
  /** Whether the current user may submit review verdicts. */
  canReview?: boolean;
  user?: { id: string; email: string; username: string } | null;
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "open":
      return "badge badge-open";
    case "approved":
    case "accepted":
      return "badge badge-approved";
    case "promoted":
      return "badge badge-merged";
    case "needs_changes":
      return "badge badge-rejected";
    case "merged":
      return "badge badge-merged";
    case "rejected":
    case "reverted":
      return "badge badge-rejected";
    default:
      return "badge";
  }
}

const REVIEWABLE_STATUSES = ["open", "needs_changes", "accepted", "approved"];

function describeCost(entry: CostSummaryEntry): string {
  const prefix = entry.estimated ? "~" : "";
  switch (entry.kind) {
    case "llm_tokens":
      return `${prefix}${Math.round(entry.total).toLocaleString()} LLM tokens`;
    case "sandbox_ms":
      return `${prefix}${(entry.total / 1000).toFixed(1)}s sandbox time`;
    case "git_ops":
      return `${prefix}${Math.round(entry.total)} git operations`;
    default:
      return `${prefix}${entry.total} ${entry.kind}`;
  }
}

export const ChangeDetailPage: FC<ChangeDetailProps> = ({
  change,
  evalRuns,
  provenance,
  comments = [],
  reviews = [],
  costs = [],
  canReview = false,
  user,
}) => {
  return (
    <Layout title={`Change ${change.id}`} user={user}>
      <div class="page-header">
        <h1>
          <span class="mono">{change.id}</span>{" "}
          <span class={statusBadgeClass(change.status)}>{change.status}</span>
        </h1>
        <a class="btn" href={`/p/${change.project}/changes`}>
          Back to changes
        </a>
      </div>

      <div class="card">
        <h2>Actions</h2>
        <div class="action-row">
          {change.githubPrUrl !== undefined ? (
            <a class="btn btn-primary" href={change.githubPrUrl} target="_blank" rel="noreferrer">
              Open GitHub PR
            </a>
          ) : (
            <>
              {(change.status === "accepted" || change.status === "promoted") && (
                <form method="post" action={`/api/changes/${change.id}/github-pr`}>
                  <button type="submit" class="btn btn-primary">
                    Promote to GitHub
                  </button>
                </form>
              )}
              {(change.status === "open" || change.status === "needs_changes") && (
                <form method="post" action={`/api/changes/${change.id}/evaluate`}>
                  <button type="submit" class="btn">
                    Run evaluations again
                  </button>
                </form>
              )}
            </>
          )}
          <form method="post" action={`/api/changes/${change.id}/reject`}>
            <button type="submit" class="btn btn-danger">
              Reject change
            </button>
          </form>
        </div>
      </div>

      <div class="card">
        <dl class="detail-list">
          <dt>Project</dt>
          <dd>
            <a href={`/p/${change.project}`}>{change.project}</a>
          </dd>
          <dt>Workspace</dt>
          <dd>{change.workspace}</dd>
          <dt>Created</dt>
          <dd>{new Date(change.createdAt).toLocaleString()}</dd>
          {change.mergedAt !== undefined && (
            <>
              <dt>Merged</dt>
              <dd>{new Date(change.mergedAt).toLocaleString()}</dd>
            </>
          )}
        </dl>
      </div>

      <div class="card">
        <h2>Eval result</h2>
        <dl class="detail-list">
          <dt>Score</dt>
          <dd>{change.evalScore !== undefined ? `${Math.round(change.evalScore * 100)}%` : "—"}</dd>
          <dt>Passed</dt>
          <dd>
            {change.evalPassed !== undefined ? (
              change.evalPassed ? (
                <span class="badge badge-approved">passed</span>
              ) : (
                <span class="badge badge-rejected">failed</span>
              )
            ) : (
              "—"
            )}
          </dd>
          {change.evalReason !== undefined && (
            <>
              <dt>Reason</dt>
              <dd>{change.evalReason}</dd>
            </>
          )}
        </dl>
      </div>

      <div class="card">
        <h2>Evaluator evidence</h2>
        {evalRuns.length === 0 ? (
          <div class="empty-state">
            <p>No evaluator evidence recorded.</p>
          </div>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>Evaluator</th>
                <th>Status</th>
                <th>Score</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {evalRuns.map((run) => (
                <tr key={run.id}>
                  <td>{run.evaluatorType}</td>
                  <td>
                    {run.passed ? (
                      <span class="badge badge-approved">passed</span>
                    ) : (
                      <span class="badge badge-rejected">failed</span>
                    )}
                  </td>
                  <td>{Math.round(run.score * 100)}%</td>
                  <td>
                    {run.reason}
                    {run.issues !== undefined && run.issues.length > 0 && (
                      <ul class="issue-list">
                        {run.issues.map((issue) => (
                          <li key={issue}>{issue}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {provenance !== null && (
        <div class="card">
          <h2>Provenance</h2>
          <dl class="detail-list">
            <dt>Commit</dt>
            <dd class="mono">{provenance.commitSha}</dd>
            <dt>Workspace</dt>
            <dd>{provenance.workspace}</dd>
            {provenance.agentId !== undefined && (
              <>
                <dt>Agent</dt>
                <dd>{provenance.agentId}</dd>
              </>
            )}
            <dt>Merged</dt>
            <dd>{new Date(provenance.mergedAt).toLocaleString()}</dd>
          </dl>
        </div>
      )}

      {costs.length > 0 && (
        <div class="card">
          <h2>Resource usage</h2>
          <ul class="cost-list">
            {costs.map((entry) => (
              <li key={entry.kind}>{describeCost(entry)}</li>
            ))}
          </ul>
        </div>
      )}

      <div class="card">
        <h2>Reviews</h2>
        {reviews.length === 0 ? (
          <p class="review-empty">No reviews yet.</p>
        ) : (
          <ul class="review-list">
            {reviews.map((review) => (
              <li key={review.id} class="review-item">
                {review.verdict === "approve" ? (
                  <span class="badge badge-approved">approved</span>
                ) : (
                  <span class="badge badge-rejected">changes requested</span>
                )}
                <span class="review-reviewer mono">{review.reviewerId}</span>
                {review.comment && <span class="review-comment">{review.comment}</span>}
                <span class="review-time">{new Date(review.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
        {canReview && REVIEWABLE_STATUSES.includes(change.status) && (
          <div class="review-actions">
            <form method="post" action={`/api/changes/${change.id}/reviews`}>
              <input type="hidden" name="verdict" value="approve" />
              <button type="submit" class="btn btn-primary">
                Approve
              </button>
            </form>
            <form method="post" action={`/api/changes/${change.id}/reviews`}>
              <input type="hidden" name="verdict" value="request_changes" />
              <button type="submit" class="btn btn-danger">
                Request changes
              </button>
            </form>
          </div>
        )}
      </div>

      <div class="card">
        <h2>Comments</h2>
        {comments.length === 0 ? (
          <p class="review-empty">No comments yet.</p>
        ) : (
          <ul class="comment-list">
            {comments.map((comment) => (
              <li key={comment.id} class="comment-item">
                <div class="comment-meta">
                  <span class={`activity-actor activity-actor-${comment.authorType}`}>
                    {comment.authorType}
                  </span>
                  <span class="mono">{comment.authorId}</span>
                  <span class="review-time">{new Date(comment.createdAt).toLocaleString()}</span>
                </div>
                <pre class="comment-body">{comment.body}</pre>
              </li>
            ))}
          </ul>
        )}
        {user && (
          <form method="post" action={`/api/changes/${change.id}/comments`} class="comment-form">
            <textarea name="body" rows={3} placeholder="Leave a comment…" required />
            <button type="submit" class="btn">
              Comment
            </button>
          </form>
        )}
      </div>

      {(change.status === "accepted" ||
        change.status === "approved" ||
        change.status === "promoted") && (
        <div class="action-row">
          <form method="post" action={`/api/changes/${change.id}/merge`}>
            <button type="submit" class="btn">
              Merge into Stratum repo
            </button>
          </form>
        </div>
      )}
    </Layout>
  );
};
