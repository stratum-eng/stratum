import type { FC } from "hono/jsx";
import type { UsageBannerNotice } from "../../billing/usage-banner";
import type { ExternalPullRequestView } from "../../github/mirror-pulls";
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
    /** What the change is, in its opener's words. */
    title?: string;
    description?: string;
    status: string;
    evalScore?: number;
    evalPassed?: boolean;
    evalReason?: string;
    createdAt: string;
    mergedAt?: string;
    githubPrUrl?: string;
    githubPrNumber?: number;
    /** `"open"` while the pull request can still be acted on. */
    githubPrState?: string;
    /** Whether the pull request is a draft; absent when not known. */
    githubPrDraft?: boolean;
    /** The workspace commit the verdict is for. */
    evaluatedSha?: string;
    /** Username of the person the change belongs to. */
    openedBy?: string;
    agentId?: string;
    agentModel?: string;
  };
  /**
   * What the diff was taken from, when the diff could be loaded: the commits
   * the workspace adds and how far it is behind the project.
   */
  diffContext?: {
    commits: Array<{ oid: string; subject: string; authorName: string; authoredAt: string }>;
    behindBy: number;
    /** The commit the workspace forked from; the diff starts here. */
    forkPoint: string;
    branch: string;
  } | null;
  evalRuns: EvalRunView[];
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
  /**
   * The pull request this change came from, when it came from the project's
   * GitHub mirror (#420). Its title and author are a stranger's text: rendered
   * as text, like everything else here, and never as markup or a link target.
   */
  externalPullRequest?: ExternalPullRequestView | null;
  /** Whether importing needs the contributor agreement confirmed. */
  requireContributorAgreement?: boolean;
  /** Outcome of the last import attempt, already resolved to a fixed message. */
  importNotice?: string;
  /** Whether the current user may submit review verdicts. */
  canReview?: boolean;
  /** Namespaced project ref for the header; legacy changes may lack one. */
  projectRef?: { name: string; namespace: string; slug: string; visibility?: string } | null;
  user?: { id: string; email: string; username: string } | null;
  /** The 80% warning, when this account has one. See `Layout`. */
  usageNotice?: UsageBannerNotice | null;
}

interface EvalRunView {
  id: string;
  evaluatorType: string;
  score: number;
  passed: boolean;
  reason: string;
  issues?: string[];
  ranAt: string;
  /** Runs recorded by one evaluation share a round. Absent on old rows. */
  roundId?: string;
}

/**
 * Split runs into the latest evaluation and the ones before it. A change that
 * was evaluated twice has two sets of rows, and listing them together reads as
 * one evaluation that both failed and passed.
 *
 * The merge gate does not take the latest evaluation whole: for each evaluator
 * it takes that evaluator's newest result (src/merge/protection.ts). When the
 * latest evaluation did not run an evaluator an earlier one did, the earlier
 * result still decides the merge. Those are `stillCounted`, and a page that
 * folded them away as replaced would hide the thing blocking the change.
 */
export function splitEvalRounds(runs: EvalRunView[]): {
  latest: EvalRunView[];
  stillCounted: EvalRunView[];
  earlier: EvalRunView[][];
} {
  const rounds = new Map<string, EvalRunView[]>();
  for (const run of runs) {
    const key = run.roundId ?? run.ranAt;
    rounds.set(key, [...(rounds.get(key) ?? []), run]);
  }
  // By the key the merge gate compares, so the page and the gate agree on
  // which evaluation is the latest. Two rounds can share a `ranAt`; a
  // `roundId` starts with it and still tells them apart.
  const newestFirst = [...rounds.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([, round]) => round);
  const latest = newestFirst[0] ?? [];
  const earlier = newestFirst.slice(1);

  const decided = new Set(latest.map((run) => run.evaluatorType));
  const stillCounted: EvalRunView[] = [];
  for (const round of earlier) {
    const carried = round.filter((run) => !decided.has(run.evaluatorType));
    stillCounted.push(...carried);
    // Only after the whole round: every run of a type within one round counts.
    for (const run of carried) decided.add(run.evaluatorType);
  }
  return { latest, stillCounted, earlier };
}

/**
 * What to head the page with: the change's own title, else the subject of its
 * first commit (the nearest thing to a title its author wrote), else the
 * workspace it came from. `commits` is newest first.
 */
function headlineFor(
  title: string | undefined,
  commits: Array<{ subject: string }> | undefined,
  workspace: string,
): string {
  const firstCommit = commits?.[commits.length - 1]?.subject.trim();
  return title ?? (firstCommit || `Change from workspace ${workspace}`);
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const EvalRunTable: FC<{ runs: EvalRunView[] }> = ({ runs }) => (
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
        {runs.map((run) => (
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
);

function statusBadgeClass(status: string): string {
  switch (status) {
    case "open":
      return "badge badge-open";
    case "evaluating":
      return "badge badge-warning";
    case "external":
      return "badge badge-queued";
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

/**
 * The pull request an external change stands for, and the one control that
 * turns it into an ordinary change (#420).
 *
 * The import control is a plain form: it works with JavaScript off, and the
 * contributor-agreement checkbox is `required`, so a browser will not submit
 * without it — the server refuses without it regardless. The hidden `headSha`
 * pins the import to the commits this page showed.
 */
const ExternalPullRequestCard: FC<{
  changeId: string;
  status: string;
  pullRequest: ExternalPullRequestView;
  requireContributorAgreement: boolean;
  canImport: boolean;
  notice?: string;
}> = ({ changeId, status, pullRequest, requireContributorAgreement, canImport, notice }) => {
  const waiting = status === "external";
  const reimport = pullRequest.importedHeadSha !== null;
  return (
    <div class="card" id="pull-request">
      <h2>Pull request from the GitHub mirror</h2>
      <p class="text-muted">
        Opened on GitHub by someone outside this project. Its commits are untrusted until a
        maintainer imports them: nothing is evaluated, no CI runs and nothing can merge before that.
      </p>
      {notice !== undefined && <p class="settings-help">{notice}</p>}
      <dl class="detail-list">
        <dt>Pull request</dt>
        <dd>
          <a href={pullRequest.url} target="_blank" rel="noopener noreferrer">
            {pullRequest.repo}#{pullRequest.number}
          </a>{" "}
          <span class="badge">{pullRequest.state}</span>
        </dd>
        <dt>Title</dt>
        <dd>{pullRequest.title}</dd>
        <dt>Author</dt>
        <dd>{pullRequest.author} (GitHub)</dd>
        <dt>Head commit</dt>
        <dd>
          <code>{pullRequest.headSha.slice(0, 12)}</code>
          {pullRequest.commits !== null && ` · ${pullRequest.commits} commits`}
          {pullRequest.changedFiles !== null && ` · ${pullRequest.changedFiles} files changed`}
        </dd>
        {pullRequest.importedAt !== null && pullRequest.importedHeadSha !== null && (
          <>
            <dt>Imported</dt>
            <dd>
              <code>{pullRequest.importedHeadSha.slice(0, 12)}</code> at{" "}
              {new Date(pullRequest.importedAt).toLocaleString()}
            </dd>
          </>
        )}
        {pullRequest.agreementConfirmedAt !== null && (
          <>
            <dt>Contributor agreement</dt>
            <dd>
              Confirmed by a maintainer at{" "}
              {new Date(pullRequest.agreementConfirmedAt).toLocaleString()}
            </dd>
          </>
        )}
        {pullRequest.closure.state === "failed" && (
          <>
            <dt>Closing on GitHub</dt>
            <dd class="settings-help-error">
              The pull request could not be commented on or closed:{" "}
              {pullRequest.closure.error ?? "unknown error"}
            </dd>
          </>
        )}
      </dl>
      {waiting && reimport && (
        <p class="text-muted">
          The pull request has commits newer than the ones that were imported. The earlier verdict,
          checks and approvals no longer apply; import again to evaluate the new commits.
        </p>
      )}
      {waiting && pullRequest.refusal !== null && (
        <p class="settings-help-error">
          This pull request cannot be imported as it stands: {pullRequest.refusal.reason}. (
          <code>{pullRequest.refusal.code}</code>)
        </p>
      )}
      {waiting && pullRequest.refusal === null && pullRequest.state === "open" && canImport && (
        <form method="post" action={`/api/changes/${changeId}/import`} class="comment-form">
          <input type="hidden" name="headSha" value={pullRequest.headSha} />
          {requireContributorAgreement && (
            <label>
              <input type="checkbox" name="agreementConfirmed" required /> I confirm that{" "}
              {pullRequest.author} has agreed to this project's contributor agreement. This is
              recorded in the audit log under my name.
            </label>
          )}
          <button type="submit" class="btn btn-primary">
            {reimport ? "Import new commits" : "Import pull request"}
          </button>
        </form>
      )}
    </div>
  );
};

export const ChangeDetailPage: FC<ChangeDetailProps> = ({
  change,
  evalRuns,
  provenance,
  checks = [],
  comments = [],
  reviews = [],
  costs = [],
  diff = null,
  externalPullRequest = null,
  requireContributorAgreement = false,
  importNotice,
  diffContext = null,
  canReview = false,
  projectRef = null,
  user,
  usageNotice,
}) => {
  // Line-anchored comments (and their replies) render as threads beneath the
  // diff; anchorless comments stay in the change-level discussion below.
  const lineComments = comments.filter((comment) => comment.file !== undefined);
  const discussionComments = comments.filter((comment) => comment.file === undefined);

  const headline = headlineFor(change.title, diffContext?.commits, change.workspace);
  const rounds = splitEvalRounds(evalRuns);
  const latestRanAt = rounds.latest[0]?.ranAt;
  const additions = (diff ?? []).reduce((sum, file) => sum + file.additions, 0);
  const deletions = (diff ?? []).reduce((sum, file) => sum + file.deletions, 0);

  const hasGithubPr = change.githubPrUrl !== undefined;
  // Offered while the pull request is a draft, and also when that is not known
  // (promoted before the flag was recorded): the action finds nothing to do on
  // one that is already ready.
  const canMarkReady =
    hasGithubPr &&
    canReview &&
    change.status === "promoted" &&
    change.githubPrState !== "closed" &&
    change.githubPrDraft !== false;
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
          {headline} <span class={statusBadgeClass(change.status)}>{change.status}</span>
        </h1>
        <p class="text-muted">
          <span class="mono">{change.id}</span>
          {change.openedBy !== undefined && <> · opened by {change.openedBy}</>}
          {change.agentId !== undefined && (
            <>
              {" "}
              · agent <span class="mono">{change.agentId}</span>
              {change.agentModel !== undefined && <> ({change.agentModel})</>}
            </>
          )}
        </p>
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

      {change.description !== undefined && (
        <div class="card">
          <h2>Description</h2>
          <pre class="comment-body">{change.description}</pre>
        </div>
      )}

      {externalPullRequest && (
        <ExternalPullRequestCard
          changeId={change.id}
          status={change.status}
          pullRequest={externalPullRequest}
          requireContributorAgreement={requireContributorAgreement}
          canImport={canReview}
          {...(importNotice !== undefined ? { notice: importNotice } : {})}
        />
      )}

      {hasActions && (
        <div class="card">
          <h2>Actions</h2>
          {hasGithubPr && (
            <p class="text-muted">
              This change was promoted to GitHub
              {change.githubPrNumber !== undefined && (
                <> as pull request #{change.githubPrNumber}</>
              )}
              {change.githubPrDraft === true && ", still as a draft"}. Review and merging happen
              there, and Stratum reports this evaluation on the pull request.
            </p>
          )}
          <div class="action-row">
            {hasGithubPr ? (
              <>
                <a
                  class="btn btn-primary"
                  href={change.githubPrUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open GitHub PR
                </a>
                {canMarkReady && (
                  <form method="post" action={`/api/changes/${change.id}/github-pr/ready`}>
                    <button type="submit" class="btn">
                      Mark ready for review
                    </button>
                  </form>
                )}
              </>
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
          <>
            <p class="text-muted">
              The latest evaluation
              {latestRanAt !== undefined && <>, run {new Date(latestRanAt).toLocaleString()}</>}
              {change.evaluatedSha !== undefined && (
                <>
                  , of revision <span class="mono">{change.evaluatedSha.slice(0, 12)}</span>
                </>
              )}
              . The result above is this one.
            </p>
            <EvalRunTable runs={rounds.latest} />
            {rounds.stillCounted.length > 0 && (
              <>
                <p class="text-muted">
                  Still counted from an earlier evaluation. The latest one did not run{" "}
                  {rounds.stillCounted.length === 1 ? "this evaluator" : "these evaluators"}, so
                  merging is decided on{" "}
                  {rounds.stillCounted.length === 1 ? "this result" : "these results"} as well.
                </p>
                <EvalRunTable runs={rounds.stillCounted} />
              </>
            )}
            {rounds.earlier.length > 0 && (
              <details class="earlier-runs">
                <summary>
                  {plural(rounds.earlier.length, "earlier evaluation")}
                  {rounds.stillCounted.length === 0
                    ? ", replaced by the one above"
                    : ", replaced except for the results shown above"}
                </summary>
                {rounds.earlier.map((round) => (
                  <div key={round[0]?.id}>
                    <p class="text-muted">
                      Run {round[0] ? new Date(round[0].ranAt).toLocaleString() : ""}
                    </p>
                    <EvalRunTable runs={round} />
                  </div>
                ))}
              </details>
            )}
          </>
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
          <p class="text-muted">
            {plural(diff.length, "file")} changed, +{additions} −{deletions}
            {diffContext !== null && diffContext.commits.length > 0 && (
              <>, in {plural(diffContext.commits.length, "commit")}</>
            )}
            .
            {diffContext !== null && diffContext.behindBy > 0 && (
              <>
                {" "}
                The workspace is {plural(diffContext.behindBy, "commit")} behind{" "}
                {diffContext.branch}. This is what the workspace changed since it forked at{" "}
                <span class="mono">{diffContext.forkPoint.slice(0, 12)}</span>; the newer commits on{" "}
                {diffContext.branch} are not part of it.
              </>
            )}
          </p>
          {diffContext !== null && diffContext.commits.length > 0 && (
            <ul class="commit-list">
              {diffContext.commits.map((commit) => (
                <li key={commit.oid}>
                  <span class="mono">{commit.oid.slice(0, 12)}</span> {commit.subject}{" "}
                  <span class="text-muted">({commit.authorName})</span>
                </li>
              ))}
            </ul>
          )}
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
    </Layout>
  );
};
