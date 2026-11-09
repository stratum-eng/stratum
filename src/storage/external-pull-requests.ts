/**
 * Storage for pull requests brought in from a GitHub mirror (#420), migration
 * 080.
 *
 * One row per (project, pull request number), pointing at the change that
 * stands for the pull request. The change itself is an ordinary `changes` row
 * whose status is `external` until a maintainer imports it.
 *
 * Every transition is one statement or one batch, because the things that race
 * here are separate Worker invocations: two webhook deliveries for the same
 * pull request, a webhook and a maintainer's import, a merge and the closure
 * pass. Where a write must not happen twice, the condition is in the SQL.
 *
 * Nothing in this module reads GitHub or git. It stores what its callers have
 * already validated; see `src/github/mirror-pulls.ts` for what that means for
 * each field.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { AppError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/** GitHub's view of the pull request, as last reported. */
export type ExternalPrState = "open" | "closed" | "merged";

/**
 * Where closing the pull request on GitHub has got to, once its change merged.
 *
 * - `none` — nothing done yet.
 * - `commented` — the link back to the change is posted. GitHub is being given
 *   time to mark the pull request merged by itself before Stratum closes it.
 * - `done` — the pull request is merged or closed on GitHub.
 * - `failed` — retries are spent, or GitHub refused in a way no retry fixes.
 */
export type ExternalPrClosureState = "none" | "commented" | "done" | "failed";

/** One author of the commits a pull request carries. */
export interface CommitAuthor {
  name: string;
  email: string;
}

export interface ExternalPullRequest {
  projectId: string;
  prNumber: number;
  changeId: string;
  repoOwner: string;
  repoName: string;
  /** The GitHub login that opened the pull request. */
  authorLogin: string;
  /** The pull request's title. Data: shown escaped, never interpreted. */
  title: string;
  /** Newest head commit GitHub reported. */
  headSha: string;
  /** Head commit the workspace holds; absent until the first import. */
  importedHeadSha?: string;
  commits?: number;
  changedFiles?: number;
  /** Why the newest head cannot be imported, when it cannot. */
  refusalCode?: string;
  refusalReason?: string;
  /** Authors of the imported commits. */
  commitAuthors: CommitAuthor[];
  agreementConfirmedBy?: string;
  agreementConfirmedAt?: string;
  importedBy?: string;
  importedAt?: string;
  prState: ExternalPrState;
  closureState: ExternalPrClosureState;
  closureAttempts: number;
  closureError?: string;
  closureCommentId?: number;
  closureUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface ExternalPullRequestRow {
  project_id: string;
  pr_number: number;
  change_id: string;
  repo_owner: string;
  repo_name: string;
  author_login: string;
  title: string;
  head_sha: string;
  imported_head_sha: string | null;
  commits: number | null;
  changed_files: number | null;
  refusal_code: string | null;
  refusal_reason: string | null;
  commit_authors: string | null;
  agreement_confirmed_by: string | null;
  agreement_confirmed_at: string | null;
  imported_by: string | null;
  imported_at: string | null;
  pr_state: string;
  closure_state: string;
  closure_attempts: number;
  closure_error: string | null;
  closure_comment_id: number | null;
  closure_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Statuses a change does not leave because of something that happened to its
 * pull request. `promoted` is not among them: it is a layer-mode status a
 * mirrored project's change cannot reach, and if one somehow did, a closed
 * pull request should still close it.
 */
const SETTLED_CHANGE_STATUSES = ["merged", "rejected", "reverted"] as const;
const SETTLED_LIST = SETTLED_CHANGE_STATUSES.map((status) => `'${status}'`).join(", ");

function parseAuthors(raw: string | null): CommitAuthor[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): CommitAuthor[] => {
      const candidate = entry as { name?: unknown; email?: unknown } | null;
      return typeof candidate?.name === "string" && typeof candidate.email === "string"
        ? [{ name: candidate.name, email: candidate.email }]
        : [];
    });
  } catch {
    return [];
  }
}

function fromRow(row: ExternalPullRequestRow): ExternalPullRequest {
  const prState: ExternalPrState =
    row.pr_state === "closed" || row.pr_state === "merged" ? row.pr_state : "open";
  const closureState: ExternalPrClosureState =
    row.closure_state === "commented" ||
    row.closure_state === "done" ||
    row.closure_state === "failed"
      ? row.closure_state
      : "none";
  return {
    projectId: row.project_id,
    prNumber: row.pr_number,
    changeId: row.change_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    authorLogin: row.author_login,
    title: row.title,
    headSha: row.head_sha,
    ...(row.imported_head_sha !== null ? { importedHeadSha: row.imported_head_sha } : {}),
    ...(row.commits !== null ? { commits: row.commits } : {}),
    ...(row.changed_files !== null ? { changedFiles: row.changed_files } : {}),
    ...(row.refusal_code !== null ? { refusalCode: row.refusal_code } : {}),
    ...(row.refusal_reason !== null ? { refusalReason: row.refusal_reason } : {}),
    commitAuthors: parseAuthors(row.commit_authors),
    ...(row.agreement_confirmed_by !== null
      ? { agreementConfirmedBy: row.agreement_confirmed_by }
      : {}),
    ...(row.agreement_confirmed_at !== null
      ? { agreementConfirmedAt: row.agreement_confirmed_at }
      : {}),
    ...(row.imported_by !== null ? { importedBy: row.imported_by } : {}),
    ...(row.imported_at !== null ? { importedAt: row.imported_at } : {}),
    prState,
    closureState,
    closureAttempts: row.closure_attempts,
    ...(row.closure_error !== null ? { closureError: row.closure_error } : {}),
    ...(row.closure_comment_id !== null ? { closureCommentId: row.closure_comment_id } : {}),
    ...(row.closure_updated_at !== null ? { closureUpdatedAt: row.closure_updated_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function storageError(message: string, error: unknown, logger: Logger): AppError {
  logger.error(message, error instanceof Error ? error : undefined);
  return new AppError(message, "DATABASE_ERROR", 500);
}

/** Stored text is trimmed: these columns are rendered to people. */
const MAX_STORED_TEXT = 500;
const trim = (text: string): string =>
  text.length > MAX_STORED_TEXT ? `${text.slice(0, MAX_STORED_TEXT - 1)}…` : text;

/**
 * Reads the record for one pull request of a project.
 *
 * @returns The record, or null when the pull request was never brought in
 */
export async function getExternalPullRequest(
  db: D1Database,
  logger: Logger,
  projectId: string,
  prNumber: number,
): Promise<Result<ExternalPullRequest | null, AppError>> {
  try {
    const row = await db
      .prepare("SELECT * FROM external_pull_requests WHERE project_id = ? AND pr_number = ?")
      .bind(projectId, prNumber)
      .first<ExternalPullRequestRow>();
    return ok(row ? fromRow(row) : null);
  } catch (error) {
    return err(storageError("Failed to read external pull request", error, logger));
  }
}

/**
 * Reads the pull request a change stands for.
 *
 * @returns The record, or null for a change that did not come from a mirror
 */
export async function getExternalPullRequestByChange(
  db: D1Database,
  logger: Logger,
  changeId: string,
): Promise<Result<ExternalPullRequest | null, AppError>> {
  try {
    const row = await db
      .prepare("SELECT * FROM external_pull_requests WHERE change_id = ?")
      .bind(changeId)
      .first<ExternalPullRequestRow>();
    return ok(row ? fromRow(row) : null);
  } catch (error) {
    return err(storageError("Failed to read external pull request for change", error, logger));
  }
}

/** What a webhook knows about a pull request when it first sees it. */
export interface ExternalPullRequestFacts {
  projectId: string;
  /** `namespace/slug`, the form `changes.project` holds for every other change. */
  projectName: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
  authorLogin: string;
  title: string;
  headSha: string;
  commits?: number;
  changedFiles?: number;
  refusal?: { code: string; reason: string };
}

export type CreateExternalChangeOutcome =
  | { status: "created"; record: ExternalPullRequest }
  /** Another delivery created it first. */
  | { status: "exists"; record: ExternalPullRequest }
  /** The project already has `cap` external changes waiting. */
  | { status: "capped" };

/**
 * Creates the change for a pull request seen for the first time, or — with
 * `replace` — a fresh change for one whose previous change was closed.
 *
 * The cap is enforced in the INSERT itself, so two deliveries arriving together
 * cannot both slip under it, and the change and its record are written in one
 * batch, so neither exists without the other.
 *
 * The workspace named here does not exist yet. It is created by the first
 * import; until then the name only reserves it.
 *
 * @param cap - Most changes in status `external` the project may hold
 */
export async function createExternalChange(
  db: D1Database,
  logger: Logger,
  facts: ExternalPullRequestFacts,
  cap: number,
  options: { replace?: boolean } = {},
): Promise<Result<CreateExternalChangeOutcome, AppError>> {
  const changeId = newId("chg");
  const now = new Date().toISOString();
  // A full UUID, for the reason the gated push uses one: a short suffix can
  // collide, and a collision would point this change at someone else's
  // workspace.
  const workspace = `pr-${facts.prNumber}-${crypto.randomUUID()}`;
  const underCap =
    "(SELECT COUNT(*) FROM changes WHERE project_id = ? AND status = 'external') < ?";
  try {
    const insertChange = db
      .prepare(
        `INSERT INTO changes (id, project, project_id, workspace, status, created_at)
         SELECT ?, ?, ?, ?, 'external', ?
          WHERE ${underCap}
            AND ${
              options.replace === true
                ? `EXISTS (SELECT 1 FROM external_pull_requests e JOIN changes c ON c.id = e.change_id
                            WHERE e.project_id = ? AND e.pr_number = ? AND c.status IN (${SETTLED_LIST}))`
                : "NOT EXISTS (SELECT 1 FROM external_pull_requests WHERE project_id = ? AND pr_number = ?)"
            }`,
      )
      .bind(
        changeId,
        facts.projectName,
        facts.projectId,
        workspace,
        now,
        facts.projectId,
        cap,
        facts.projectId,
        facts.prNumber,
      );
    const created = "EXISTS (SELECT 1 FROM changes WHERE id = ?)";
    const writeRecord =
      options.replace === true
        ? db
            .prepare(
              `UPDATE external_pull_requests
                  SET change_id = ?, author_login = ?, title = ?, head_sha = ?,
                      imported_head_sha = NULL, commits = ?, changed_files = ?,
                      refusal_code = ?, refusal_reason = ?, commit_authors = NULL,
                      agreement_confirmed_by = NULL, agreement_confirmed_at = NULL,
                      imported_by = NULL, imported_at = NULL, pr_state = 'open',
                      closure_state = 'none', closure_attempts = 0, closure_error = NULL,
                      closure_comment_id = NULL, closure_updated_at = NULL, updated_at = ?
                WHERE project_id = ? AND pr_number = ? AND ${created}`,
            )
            .bind(
              changeId,
              facts.authorLogin,
              trim(facts.title),
              facts.headSha,
              facts.commits ?? null,
              facts.changedFiles ?? null,
              facts.refusal?.code ?? null,
              facts.refusal ? trim(facts.refusal.reason) : null,
              now,
              facts.projectId,
              facts.prNumber,
              changeId,
            )
        : db
            .prepare(
              `INSERT INTO external_pull_requests
                 (project_id, pr_number, change_id, repo_owner, repo_name, author_login, title,
                  head_sha, commits, changed_files, refusal_code, refusal_reason,
                  created_at, updated_at)
               SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                WHERE ${created}`,
            )
            .bind(
              facts.projectId,
              facts.prNumber,
              changeId,
              facts.repoOwner,
              facts.repoName,
              facts.authorLogin,
              trim(facts.title),
              facts.headSha,
              facts.commits ?? null,
              facts.changedFiles ?? null,
              facts.refusal?.code ?? null,
              facts.refusal ? trim(facts.refusal.reason) : null,
              now,
              now,
              changeId,
            );
    await db.batch([insertChange, writeRecord]);

    const stored = await getExternalPullRequest(db, logger, facts.projectId, facts.prNumber);
    if (!stored.success) return stored;
    if (stored.data !== null && stored.data.changeId === changeId) {
      return ok({ status: "created", record: stored.data });
    }
    // Nothing was written. Either the record was already there (a concurrent
    // delivery, or a replace whose change was not closed after all), or the
    // project is at its cap.
    if (stored.data !== null && options.replace !== true) {
      return ok({ status: "exists", record: stored.data });
    }
    if (stored.data !== null) {
      const live = await db
        .prepare(`SELECT 1 AS live FROM changes WHERE id = ? AND status NOT IN (${SETTLED_LIST})`)
        .bind(stored.data.changeId)
        .first<{ live: number }>();
      if (live) return ok({ status: "exists", record: stored.data });
    }
    return ok({ status: "capped" });
  } catch (error) {
    return err(storageError("Failed to create external change", error, logger));
  }
}

/**
 * Records a new head (or new title, or new counts) for a pull request.
 *
 * A refusal describes one head, so it is replaced along with it: cleared unless
 * the caller supplies one for the new head.
 */
export async function updateExternalPullRequestHead(
  db: D1Database,
  logger: Logger,
  input: {
    projectId: string;
    prNumber: number;
    headSha: string;
    title: string;
    commits?: number;
    changedFiles?: number;
    refusal?: { code: string; reason: string };
  },
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare(
        `UPDATE external_pull_requests
            SET head_sha = ?, title = ?, commits = ?, changed_files = ?,
                refusal_code = ?, refusal_reason = ?, pr_state = 'open', updated_at = ?
          WHERE project_id = ? AND pr_number = ?`,
      )
      .bind(
        input.headSha,
        trim(input.title),
        input.commits ?? null,
        input.changedFiles ?? null,
        input.refusal?.code ?? null,
        input.refusal ? trim(input.refusal.reason) : null,
        new Date().toISOString(),
        input.projectId,
        input.prNumber,
      )
      .run();
    return ok(undefined);
  } catch (error) {
    return err(storageError("Failed to update external pull request", error, logger));
  }
}

/**
 * Sends an imported change back to `external` because its pull request has new
 * commits, and dismisses the approvals given for the old ones.
 *
 * This is what makes the old revision's verdict and checks stop counting: an
 * `external` change is refused by every merge path whatever it has pinned, and
 * the next import pins a new revision that the old checks do not belong to.
 * Moving an `evaluating` change is deliberate too — its pending run then finds
 * the status changed and records nothing.
 *
 * @returns Whether the status moved, and whose approvals were dismissed
 */
export async function supersedeImportedChange(
  db: D1Database,
  logger: Logger,
  changeId: string,
): Promise<Result<{ superseded: boolean; dismissedReviewerIds: string[] }, AppError>> {
  try {
    const [moved, dismissed] = await db.batch<{ id?: string; reviewer_id?: string }>([
      db
        .prepare(
          `UPDATE changes SET status = 'external'
            WHERE id = ? AND status NOT IN (${SETTLED_LIST}, 'external')
        RETURNING id`,
        )
        .bind(changeId),
      // Runs second, in the same transaction, so it sees the status the first
      // statement left. An `external` change has no approvals worth keeping
      // whichever statement made it so.
      db
        .prepare(
          `DELETE FROM change_reviews
            WHERE change_id = ? AND verdict = 'approve'
              AND (SELECT status FROM changes WHERE id = ?) = 'external'
        RETURNING reviewer_id`,
        )
        .bind(changeId, changeId),
    ]);
    return ok({
      superseded: (moved?.results ?? []).length > 0,
      dismissedReviewerIds: (dismissed?.results ?? []).flatMap((row) =>
        typeof row.reviewer_id === "string" ? [row.reviewer_id] : [],
      ),
    });
  } catch (error) {
    return err(storageError("Failed to supersede imported change", error, logger));
  }
}

/**
 * Records that the pull request was closed (or merged) on GitHub, and closes
 * its change unless the change is already settled.
 *
 * A change Stratum merged stays `merged`: the `closed` event that follows
 * Stratum's own closing of the pull request must not turn it into `rejected`.
 * For such a change this also finishes the closure — but only once the link
 * back has been posted. GitHub can mark a pull request merged, and say so,
 * before the pass that comments on it has run; settling it here would mean the
 * comment is never written.
 *
 * @returns Whether the change was closed by this call
 */
export async function closeExternalPullRequest(
  db: D1Database,
  logger: Logger,
  input: { projectId: string; prNumber: number; changeId: string; prState: "closed" | "merged" },
): Promise<Result<{ changeClosed: boolean }, AppError>> {
  const now = new Date().toISOString();
  try {
    const [, closed] = await db.batch<{ id: string }>([
      db
        .prepare(
          `UPDATE external_pull_requests
              SET pr_state = ?, updated_at = ?,
                  closure_state = CASE
                    WHEN closure_state = 'commented'
                     AND (SELECT status FROM changes WHERE id = ?) = 'merged' THEN 'done'
                    ELSE closure_state END,
                  closure_updated_at = CASE
                    WHEN closure_state = 'commented'
                     AND (SELECT status FROM changes WHERE id = ?) = 'merged' THEN ?
                    ELSE closure_updated_at END
            WHERE project_id = ? AND pr_number = ? AND change_id = ?`,
        )
        .bind(
          input.prState,
          now,
          input.changeId,
          input.changeId,
          now,
          input.projectId,
          input.prNumber,
          input.changeId,
        ),
      db
        .prepare(
          `UPDATE changes SET status = 'rejected'
            WHERE id = ? AND status NOT IN (${SETTLED_LIST})
        RETURNING id`,
        )
        .bind(input.changeId),
    ]);
    return ok({ changeClosed: (closed?.results ?? []).length > 0 });
  } catch (error) {
    return err(storageError("Failed to close external pull request", error, logger));
  }
}

/** Records why the pull request's current head cannot be imported. */
export async function recordExternalRefusal(
  db: D1Database,
  logger: Logger,
  input: { projectId: string; prNumber: number; headSha: string; code: string; reason: string },
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare(
        `UPDATE external_pull_requests
            SET refusal_code = ?, refusal_reason = ?, head_sha = ?, updated_at = ?
          WHERE project_id = ? AND pr_number = ?`,
      )
      .bind(
        input.code,
        trim(input.reason),
        input.headSha,
        new Date().toISOString(),
        input.projectId,
        input.prNumber,
      )
      .run();
    return ok(undefined);
  } catch (error) {
    return err(storageError("Failed to record external pull request refusal", error, logger));
  }
}

/**
 * Records a completed import: what the workspace now holds, who brought it in,
 * and — where the project asks for it — who confirmed the contributor
 * agreement.
 *
 * `head_sha` is deliberately not written. It is the newest head GitHub has
 * reported, and a push that landed while the import ran may already have moved
 * it past what was imported; the caller compares the two afterwards.
 *
 * The importer becomes the change's author of record. That is what excludes
 * their own approval from `merge.requiredApprovals` and from the one approval a
 * change to protected config always needs: the person who chose to bring a
 * stranger's code in is not the independent reviewer of it.
 */
export async function recordExternalImport(
  db: D1Database,
  logger: Logger,
  input: {
    projectId: string;
    prNumber: number;
    changeId: string;
    importedHeadSha: string;
    importedBy: string;
    commitAuthors: CommitAuthor[];
    agreementConfirmed: boolean;
  },
): Promise<Result<void, AppError>> {
  const now = new Date().toISOString();
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE external_pull_requests
              SET imported_head_sha = ?, imported_by = ?, imported_at = ?,
                  commit_authors = ?, refusal_code = NULL, refusal_reason = NULL,
                  agreement_confirmed_by = CASE WHEN ? = 1 THEN ? ELSE agreement_confirmed_by END,
                  agreement_confirmed_at = CASE WHEN ? = 1 THEN ? ELSE agreement_confirmed_at END,
                  updated_at = ?
            WHERE project_id = ? AND pr_number = ? AND change_id = ?`,
        )
        .bind(
          input.importedHeadSha,
          input.importedBy,
          now,
          JSON.stringify(input.commitAuthors),
          input.agreementConfirmed ? 1 : 0,
          input.importedBy,
          input.agreementConfirmed ? 1 : 0,
          now,
          now,
          input.projectId,
          input.prNumber,
          input.changeId,
        ),
      db
        .prepare("UPDATE changes SET created_by_user_id = ? WHERE id = ? AND status = 'external'")
        .bind(input.importedBy, input.changeId),
    ]);
    return ok(undefined);
  } catch (error) {
    return err(storageError("Failed to record external import", error, logger));
  }
}

/** A merged change's pull request that still has to be settled on GitHub. */
export interface PullRequestToSettle {
  record: ExternalPullRequest;
  /** When the change merged in Stratum. */
  mergedAt: string;
}

/**
 * Pull requests of one project whose change has merged and which are not yet
 * settled on GitHub.
 *
 * A `commented` one is returned only once `commentedBefore` has passed since
 * its comment: that pause is what gives GitHub the chance to mark the pull
 * request merged by itself.
 */
export async function listPullRequestsToSettle(
  db: D1Database,
  logger: Logger,
  input: { projectId: string; commentedBefore: string; limit: number },
): Promise<Result<PullRequestToSettle[], AppError>> {
  try {
    const rows = await db
      .prepare(
        `SELECT e.*, c.merged_at AS change_merged_at
           FROM external_pull_requests e
           JOIN changes c ON c.id = e.change_id
          WHERE e.project_id = ?
            AND c.status = 'merged'
            AND (e.closure_state = 'none'
                 OR (e.closure_state = 'commented' AND e.closure_updated_at <= ?))
          ORDER BY e.updated_at ASC
          LIMIT ?`,
      )
      .bind(input.projectId, input.commentedBefore, input.limit)
      .all<ExternalPullRequestRow & { change_merged_at: string | null }>();
    return ok(
      rows.results.map((row) => ({
        record: fromRow(row),
        mergedAt: row.change_merged_at ?? row.updated_at,
      })),
    );
  } catch (error) {
    return err(storageError("Failed to list pull requests to settle", error, logger));
  }
}

/**
 * Projects that have a merged change whose pull request is not settled. The
 * five-minute sweep's entry point: it finds the projects, and each is then
 * settled against its own mirror.
 */
export async function listProjectsWithPullRequestsToSettle(
  db: D1Database,
  logger: Logger,
  limit: number,
): Promise<Result<string[], AppError>> {
  try {
    const rows = await db
      .prepare(
        `SELECT DISTINCT e.project_id AS project_id
           FROM external_pull_requests e
           JOIN changes c ON c.id = e.change_id
          WHERE c.status = 'merged' AND e.closure_state IN ('none', 'commented')
          LIMIT ?`,
      )
      .bind(limit)
      .all<{ project_id: string }>();
    return ok(rows.results.map((row) => row.project_id));
  } catch (error) {
    return err(storageError("Failed to list projects with pull requests to settle", error, logger));
  }
}

/**
 * Records one step of settling a pull request on GitHub.
 *
 * The write is conditional on the state the caller read, so two passes that
 * race (a mirror run and the sweep) cannot both advance the same pull request —
 * the second finds the state moved and writes nothing.
 *
 * @returns Whether this call made the transition
 */
export async function recordPullRequestClosure(
  db: D1Database,
  logger: Logger,
  input: {
    projectId: string;
    prNumber: number;
    from: ExternalPrClosureState;
    to: ExternalPrClosureState;
    commentId?: number;
    prState?: ExternalPrState;
    /** Set on a failed attempt; cleared by a successful step. */
    error?: string;
    /** Count this call as a failed attempt. */
    failedAttempt?: boolean;
  },
): Promise<Result<boolean, AppError>> {
  try {
    const result = await db
      .prepare(
        `UPDATE external_pull_requests
            SET closure_state = ?,
                closure_comment_id = COALESCE(?, closure_comment_id),
                pr_state = COALESCE(?, pr_state),
                closure_error = ?,
                closure_attempts = closure_attempts + ?,
                closure_updated_at = ?,
                updated_at = ?
          WHERE project_id = ? AND pr_number = ? AND closure_state = ?`,
      )
      .bind(
        input.to,
        input.commentId ?? null,
        input.prState ?? null,
        input.error !== undefined ? trim(input.error) : null,
        input.failedAttempt === true ? 1 : 0,
        new Date().toISOString(),
        new Date().toISOString(),
        input.projectId,
        input.prNumber,
        input.from,
      )
      .run();
    return ok((result.meta?.changes ?? 0) > 0);
  } catch (error) {
    return err(storageError("Failed to record pull request closure", error, logger));
  }
}

/**
 * Which of the given changes came from a mirror's pull request. One query for
 * a whole batch.
 */
export async function listExternalChangeIds(
  db: D1Database,
  logger: Logger,
  changeIds: string[],
): Promise<Result<Set<string>, AppError>> {
  if (changeIds.length === 0) return ok(new Set());
  try {
    const rows = await db
      .prepare(
        `SELECT change_id FROM external_pull_requests WHERE change_id IN (${changeIds
          .map(() => "?")
          .join(", ")})`,
      )
      .bind(...changeIds)
      .all<{ change_id: string }>();
    return ok(new Set(rows.results.map((row) => row.change_id)));
  } catch (error) {
    return err(storageError("Failed to look up external changes", error, logger));
  }
}
