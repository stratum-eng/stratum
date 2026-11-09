import type { FC } from "hono/jsx";
import type { UsageBannerNotice } from "../../billing/usage-banner";
import type { ChangeComment, ChangeReview } from "../../storage/change-reviews";
import type { CheckRunView, CheckStatus } from "../../storage/checks";
import type { CostSummaryEntry } from "../../storage/costs";
import { type DiffFile, DiffView, LineCommentThreads } from "../components/diff-view";
import { ProjectHeader } from "../components/project-header";
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
  /**
   * The newest run of each check on the evaluated revision (#414) — the same
   * set the merge gate reads. Empty for a project that declares no checks.
   */
  checks?: CheckRunView[];
  comments?: ChangeComment[];
  reviews?: ChangeReview[];
  costs?: CostSummaryEntry[];
  /** Parsed diff between workspace and project; null when unavailable. */
  diff?: DiffFile[] | null;
  /** Whether the current user may submit review verdicts. */
  canReview?: boolean;
  /** Namespaced project ref for the header; legacy changes may lack one. */
  projectRef?: { name: string; namespace: string; slug: string; visibility?: string } | null;
  user?: { id: string; email: string; username: string } | null;
  /** The 80% warning, when this account has one. See `Layout`. */
  usageNotice?: UsageBannerNotice | null;
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "open":
      return "badge badge-open";
    case "evaluating":
      return "badge badge-warning";
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

/** The badge class for a check's status, so each state reads at a glance. */
function checkBadgeClass(status: CheckStatus): string {
  switch (status) {
    case "queued":
      return "badge badge-queued";
    case "running":
      return "badge badge-running";
    case "passed":
      return "badge badge-approved";
    case "failed":
      return "badge badge-rejected";
    default:
      return "badge badge-error";
  }
}

const REVIEWABLE_STATUSES = ["open", "evaluating", "needs_changes", "accepted", "approved"];

/** Mirrors MERGEABLE_STATUSES in routes/changes.ts — the API rejects other statuses. */
const MERGEABLE_STATUSES = ["approved", "accepted", "promoted"];

/** No further actions apply: merged changes can't be rejected (API enforces it), and
 * rejecting an already rejected/reverted change is meaningless. */
const TERMINAL_STATUSES = ["merged", "rejected", "reverted"];

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
  checks = [],
  comments = [],
  reviews = [],
  costs = [],
  diff = null,
  canReview = false,
  projectRef = null,
  user,
  usageNotice,
}) => {
  // Line-anchored comments (and their replies) render as threads beneath the
  // diff; anchorless comments stay in the change-level discussion below.
  const lineComments = comments.filter((comment) => comment.file !== undefined);
  const discussionComments = comments.filter((comment) => comment.file === undefined);

  const hasGithubPr = change.githubPrUrl !== undefined;
  const canMerge = !hasGithubPr && canReview && MERGEABLE_STATUSES.includes(change.status);
  const canReject = !TERMINAL_STATUSES.includes(change.status);
  const hasActions = hasGithubPr || canMerge || canReject;
  // The API refuses an approval while a run is pending (#412) — nothing pins
  // the revision being looked at — so the button is not offered then.
  const isEvaluating = change.status === "evaluating";
  // A pending change refreshes itself only for a viewer with nothing to type
  // into: a meta refresh reloads the page, and with it any comment or review
  // draft in progress. Signed-in viewers get a link to reload when they choose.
  const isPending = change.status === "open" || isEvaluating;
  const autoRefresh = isPending && !user;
  // Mirrors the API: a re-run is refused while a run is being evaluated (its
  // checks are about to be dispatched anyway) and once the change is closed.
  const canRerunChecks = canReview && !isEvaluating && !TERMINAL_STATUSES.includes(change.status);

  return (
    <Layout
      title={`Change ${change.id}`}
      user={user}
      usageNotice={usageNotice}
      {...(autoRefresh ? { refreshSeconds: 10 } : {})}
    >
      {projectRef && <ProjectHeader project={projectRef} active="changes" canWrite={canReview} />}
      <div class="page-header">
        <h1>
          <span class="mono">{change.id}</span>{" "}
          <span class={statusBadgeClass(change.status)}>{change.status}</span>
        </h1>
        {isPending && !autoRefresh && (
          <p class="text-muted pending-refresh">
            {isEvaluating ? "Evaluation is in progress." : "Waiting for evaluation."}{" "}
            <a href={`/changes/${change.id}`}>Refresh</a> to see the verdict.
          </p>
        )}
        {!projectRef && (
          <a class="btn" href={`/p/${change.project}/changes`}>
            Back to changes
          </a>
        )}
      </div>

      {hasActions && (
        <div class="card">
          <h2>Actions</h2>
          <div class="action-row">
            {hasGithubPr ? (
              <a class="btn btn-primary" href={change.githubPrUrl} target="_blank" rel="noreferrer">
                Open GitHub PR
              </a>
            ) : (
              <>
                {canMerge && (
                  <form method="post" action={`/api/changes/${change.id}/merge`}>
                    <button type="submit" class="btn btn-primary">
                      Merge change
                    </button>
                  </form>
                )}
                {(change.status === "accepted" || change.status === "promoted") && (
                  <form method="post" action={`/api/changes/${change.id}/github-pr`}>
                    <button type="submit" class="btn btn-primary">
                      Promote to GitHub
                    </button>
                  </form>
                )}
                {(change.status === "open" ||
                  change.status === "evaluating" ||
                  change.status === "needs_changes") && (
                  <form method="post" action={`/api/changes/${change.id}/evaluate`}>
                    <button type="submit" class="btn">
                      Run evaluations again
                    </button>
                  </form>
                )}
              </>
            )}
            {canReject && (
              <form method="post" action={`/api/changes/${change.id}/reject`}>
                <button type="submit" class="btn btn-danger">
                  Reject change
                </button>
              </form>
            )}
          </div>
        </div>
      )}

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
        {change.status === "evaluating" && (
          <p class="text-muted">
            Evaluation in progress. This page refreshes every 10 seconds; the change cannot be
            merged until the result is recorded.
          </p>
        )}
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
          <div class="table-scroll">
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
          </div>
        )}
      </div>

      {checks.length > 0 && (
        <div class="card">
          <h2>Checks</h2>
          <p class="text-muted">
            Reported by the project's runner for revision{" "}
            <span class="mono">{checks[0]?.revision.slice(0, 12)}</span>. A required check blocks
            the merge until it has passed.
          </p>
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Status</th>
                  <th>Summary</th>
                  {canRerunChecks && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {checks.map((check) => (
                  <tr key={check.id}>
                    <td>
                      {check.name}
                      {check.attempt > 1 && (
                        <span class="text-muted"> (attempt {check.attempt})</span>
                      )}
                    </td>
                    <td>
                      <span class={checkBadgeClass(check.status)}>{check.status}</span>
                    </td>
                    <td>
                      {check.summary ?? "—"}
                      {check.detailsUrl !== undefined && (
                        <>
                          {" "}
                          <a href={check.detailsUrl} target="_blank" rel="noreferrer noopener">
                            Details
                          </a>
                        </>
                      )}
                    </td>
                    {canRerunChecks && (
                      <td>
                        <form
                          method="post"
                          action={`/api/changes/${change.id}/checks/${check.id}/rerun`}
                        >
                          <button type="submit" class="btn">
                            Re-run
                          </button>
                        </form>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

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

      {diff !== null && (
        <div class="card">
          <h2>Files changed</h2>
          <DiffView files={diff} />
        </div>
      )}

      {lineComments.length > 0 && (
        <div class="card">
          <h2>Line comments</h2>
          <LineCommentThreads
            changeId={change.id}
            comments={lineComments}
            files={diff ?? []}
            canComment={!!user}
            canResolveAny={canReview}
            {...(user ? { viewerId: user.id } : {})}
          />
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
                ) : review.verdict === "comment" ? (
                  <span class="badge">commented</span>
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
            {isEvaluating ? (
              <p class="text-muted">Approval opens once evaluation has finished.</p>
            ) : (
              <form method="post" action={`/api/changes/${change.id}/reviews`}>
                <input type="hidden" name="verdict" value="approve" />
                <button type="submit" class="btn btn-primary">
                  Approve
                </button>
              </form>
            )}
            <form method="post" action={`/api/changes/${change.id}/reviews`}>
              <input type="hidden" name="verdict" value="request_changes" />
              <button type="submit" class="btn btn-danger">
                Request changes
              </button>
            </form>
            <form
              method="post"
              action={`/api/changes/${change.id}/reviews`}
              class="comment-form review-comment-form"
            >
              <input type="hidden" name="verdict" value="comment" />
              <textarea
                name="comment"
                rows={2}
                placeholder="Comment without a verdict…"
                aria-label="Review comment without a verdict"
                required
              />
              <button type="submit" class="btn">
                Comment
              </button>
            </form>
          </div>
        )}
      </div>

      <div class="card">
        <h2>Comments</h2>
        {discussionComments.length === 0 ? (
          <p class="review-empty">No comments yet.</p>
        ) : (
          <ul class="comment-list">
            {discussionComments.map((comment) => (
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
