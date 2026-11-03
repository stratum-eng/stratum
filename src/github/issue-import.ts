/**
 * GitHub issue importer (#421): the queue job.
 *
 * A run is a chain of queue messages, one per page of GitHub's issue listing.
 * Each message imports its page — issues, their labels and comments — records
 * progress on the run, and enqueues the next page. A rate limit re-enqueues the
 * same page with a delay; every write is an idempotent upsert keyed by the
 * GitHub number (see `storage/github-issue-import.ts`), so re-processing a page
 * after a wait or a redelivery creates nothing twice.
 *
 * What is deliberately not done: imported issues emit no `issue.opened` events.
 * A bulk import would otherwise fire one webhook delivery per historical issue
 * at every subscriber, for issues nobody just opened.
 */

import { isTargetDeleting } from "../storage/deletion";
import {
  type IssueImportProgress,
  type IssueImportRun,
  findUserByGitHubId,
  getIssueImportRun,
  loadCommentMap,
  loadIssueNumberMap,
  recordIssueImportProgress,
  upsertImportedComment,
  upsertImportedIssue,
} from "../storage/github-issue-import";
import { getProjectByPath } from "../storage/state";
import type { Env, IssueImportJobMessage, ProjectEntry } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { GitHubClient, type GitHubPageResult } from "./client";
import { resolveIssueImportToken } from "./issue-import-credential";
import {
  type GitHubAuthor,
  parseGitHubComment,
  parseGitHubIssue,
  rewriteIssueReferences,
} from "./issue-import-transform";
import { resolveGitHubRepo } from "./sync";

/**
 * Issues per queue message. Small enough that a page whose every issue has a
 * page of comments stays far below a Worker invocation's subrequest budget.
 */
export const ISSUES_PER_PAGE = 25;
const COMMENTS_PER_PAGE = 100;
/** 3,000 comments on one issue is the most a single page will copy. */
const MAX_COMMENT_PAGES = 30;
/** Wait when GitHub rate-limits without saying until when (secondary limits). */
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 60;
/** Cloudflare Queues' ceiling on a message delay. */
const MAX_QUEUE_DELAY_SECONDS = 12 * 60 * 60;

export type IssueImportEnv = Pick<Env, "DB" | "STATE" | "IMPORT_QUEUE" | "GITHUB_TOKEN">;

/** What one message did, for the queue handler and the tests. */
export type IssueImportOutcome =
  /** The last page was imported; the run is complete. */
  | "completed"
  /** This page was imported and the next one enqueued. */
  | "continued"
  /** GitHub rate-limited us; this page was re-enqueued with a delay. */
  | "waiting"
  /** The run failed and was marked so. */
  | "failed"
  /** Nothing to do: unknown, finished, or superseded run/page. */
  | "skipped";

/** `owner/repo` as runs and the number map key it. */
export function githubRepoKey(project: ProjectEntry): string | null {
  const repo = resolveGitHubRepo(project);
  return repo ? `${repo.owner}/${repo.repo}` : null;
}

/** Queue the first page of a freshly created run. */
export async function enqueueIssueImportPage(
  queue: IssueImportEnv["IMPORT_QUEUE"],
  message: Omit<IssueImportJobMessage, "type" | "timestamp">,
  delaySeconds?: number,
): Promise<Result<void, AppError>> {
  if (!queue) {
    return err(new AppError("IMPORT_QUEUE is not configured", "QUEUE_UNAVAILABLE", 503));
  }
  const body: IssueImportJobMessage = {
    type: "github.issues.import",
    ...message,
    timestamp: new Date().toISOString(),
  };
  try {
    await queue.send(body, delaySeconds !== undefined ? { delaySeconds } : undefined);
    return ok(undefined);
  } catch (error) {
    return err(
      new AppError(
        error instanceof Error ? error.message : "Failed to enqueue issue import page",
        "QUEUE_SEND_FAILED",
        503,
      ),
    );
  }
}

/** Validate a queue body as an issue-import message, or null when it is not one. */
export function parseIssueImportMessage(body: unknown): IssueImportJobMessage | null {
  if (typeof body !== "object" || body === null) return null;
  const msg = body as Record<string, unknown>;
  if (msg.type !== "github.issues.import") return null;
  if (
    typeof msg.runId !== "string" ||
    typeof msg.projectId !== "string" ||
    typeof msg.namespace !== "string" ||
    typeof msg.slug !== "string" ||
    typeof msg.timestamp !== "string" ||
    typeof msg.page !== "number" ||
    !Number.isInteger(msg.page) ||
    msg.page < 1
  ) {
    return null;
  }
  return {
    type: "github.issues.import",
    runId: msg.runId,
    projectId: msg.projectId,
    namespace: msg.namespace,
    slug: msg.slug,
    page: msg.page,
    timestamp: msg.timestamp,
  };
}

function rateLimitDelaySeconds(result: Extract<GitHubPageResult, { success: false }>): number {
  if (result.rateLimitResetAt === undefined) return DEFAULT_RATE_LIMIT_WAIT_SECONDS;
  const seconds = Math.ceil((result.rateLimitResetAt - Date.now()) / 1000) + 5;
  return Math.min(Math.max(seconds, DEFAULT_RATE_LIMIT_WAIT_SECONDS), MAX_QUEUE_DELAY_SECONDS);
}

/**
 * Resolves GitHub authors to Stratum users once per message: most pages repeat
 * the same handful of people, and each lookup is a D1 round trip.
 */
function makeAuthorResolver(db: D1Database, logger: Logger, importerId: string) {
  const cache = new Map<string, string | null>();
  return async (
    author: GitHubAuthor,
  ): Promise<Result<{ authorId: string; externalAuthor: string | null }, AppError>> => {
    let userId: string | null = null;
    if (author.id !== null) {
      const cached = cache.get(author.id);
      if (cached !== undefined) {
        userId = cached;
      } else {
        const found = await findUserByGitHubId(db, logger, author.id);
        if (!found.success) return found;
        userId = found.data;
        cache.set(author.id, userId);
      }
    }
    // No linked account: the importer is the accountable author on record, and
    // the GitHub login is what the pages show.
    return ok(
      userId !== null
        ? { authorId: userId, externalAuthor: null }
        : { authorId: importerId, externalAuthor: author.login },
    );
  };
}

interface PageContext {
  env: IssueImportEnv;
  logger: Logger;
  run: IssueImportRun;
  project: ProjectEntry;
  owner: string;
  repo: string;
  client: GitHubClient;
}

type PageStep =
  | { kind: "done"; progress: IssueImportProgress; itemCount: number }
  | { kind: "rate-limited"; progress: IssueImportProgress; delaySeconds: number }
  | { kind: "error"; progress: IssueImportProgress; message: string };

/** Import every comment of one issue. */
async function importComments(
  ctx: PageContext,
  issueId: string,
  githubNumber: number,
  numberMap: Map<number, number>,
  resolveAuthor: ReturnType<typeof makeAuthorResolver>,
): Promise<
  | { kind: "done"; imported: number }
  | { kind: "rate-limited"; imported: number; delaySeconds: number }
  | { kind: "error"; imported: number; message: string }
> {
  const { env, logger, client, owner, repo, run } = ctx;
  const commentMap = await loadCommentMap(env.DB, logger, issueId);
  if (!commentMap.success) return { kind: "error", imported: 0, message: "database error" };
  let imported = 0;
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const listing = await client.listIssueCommentsPage(
      owner,
      repo,
      githubNumber,
      page,
      COMMENTS_PER_PAGE,
    );
    if (!listing.success) {
      return listing.rateLimited
        ? { kind: "rate-limited", imported, delaySeconds: rateLimitDelaySeconds(listing) }
        : {
            kind: "error",
            imported,
            message: `GitHub refused the comments of #${githubNumber} (HTTP ${listing.status})`,
          };
    }
    for (const raw of listing.items) {
      const comment = parseGitHubComment(raw);
      if (!comment) {
        logger.warn("Skipping malformed GitHub comment", { runId: run.id, githubNumber });
        continue;
      }
      const author = await resolveAuthor(comment.author);
      if (!author.success) return { kind: "error", imported, message: "database error" };
      const written = await upsertImportedComment(
        env.DB,
        logger,
        {
          issueId,
          githubCommentId: comment.id,
          githubUrl: comment.htmlUrl,
          body: rewriteIssueReferences(comment.body, numberMap, run.githubRepo),
          authorId: author.data.authorId,
          externalAuthor: author.data.externalAuthor,
          createdAt: comment.createdAt,
        },
        commentMap.data.get(comment.id),
      );
      if (!written.success) return { kind: "error", imported, message: "database error" };
      commentMap.data.set(comment.id, written.data.commentId);
      if (written.data.created) imported++;
    }
    if (listing.items.length < COMMENTS_PER_PAGE) break;
  }
  return { kind: "done", imported };
}

/** Import one page of GitHub's issue listing. */
async function importPage(ctx: PageContext, page: number): Promise<PageStep> {
  const { env, logger, client, owner, repo, run, project } = ctx;
  const progress: Required<
    Pick<
      IssueImportProgress,
      "issuesCreated" | "issuesUpdated" | "commentsImported" | "pullsSkipped"
    >
  > = { issuesCreated: 0, issuesUpdated: 0, commentsImported: 0, pullsSkipped: 0 };

  const listing = await client.listRepoIssuesPage(owner, repo, page, ISSUES_PER_PAGE);
  if (!listing.success) {
    return listing.rateLimited
      ? { kind: "rate-limited", progress, delaySeconds: rateLimitDelaySeconds(listing) }
      : {
          kind: "error",
          progress,
          message: `GitHub refused the issue listing (HTTP ${listing.status})`,
        };
  }

  const mapResult = await loadIssueNumberMap(env.DB, logger, project.id, run.githubRepo);
  if (!mapResult.success) return { kind: "error", progress, message: "database error" };
  const existing = mapResult.data;
  const numberMap = new Map([...existing].map(([gh, entry]) => [gh, entry.number]));
  const resolveAuthor = makeAuthorResolver(env.DB, logger, run.initiatedBy);

  for (const raw of listing.items) {
    const issue = parseGitHubIssue(raw);
    if (!issue) {
      logger.warn("Skipping malformed GitHub issue", { runId: run.id, page });
      continue;
    }
    if (issue.isPullRequest) {
      progress.pullsSkipped++;
      continue;
    }
    const author = await resolveAuthor(issue.author);
    if (!author.success) return { kind: "error", progress, message: "database error" };

    const written = await upsertImportedIssue(
      env.DB,
      logger,
      {
        projectId: project.id,
        projectName: project.name,
        githubRepo: run.githubRepo,
        githubNumber: issue.number,
        githubUrl: issue.htmlUrl,
        title: issue.title,
        body:
          issue.body === null
            ? null
            : rewriteIssueReferences(issue.body, numberMap, run.githubRepo),
        status: issue.state,
        labels: issue.labels,
        authorId: author.data.authorId,
        externalAuthor: author.data.externalAuthor,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        closedAt: issue.closedAt,
      },
      existing.get(issue.number),
    );
    if (!written.success) return { kind: "error", progress, message: "database error" };
    if (written.data.created) progress.issuesCreated++;
    else progress.issuesUpdated++;
    existing.set(issue.number, { issueId: written.data.issueId, number: written.data.number });
    numberMap.set(issue.number, written.data.number);

    if (issue.commentCount > 0) {
      const comments = await importComments(
        ctx,
        written.data.issueId,
        issue.number,
        numberMap,
        resolveAuthor,
      );
      progress.commentsImported += comments.imported;
      if (comments.kind === "rate-limited") {
        return { kind: "rate-limited", progress, delaySeconds: comments.delaySeconds };
      }
      if (comments.kind === "error") {
        return { kind: "error", progress, message: comments.message };
      }
    }
  }
  return { kind: "done", progress, itemCount: listing.items.length };
}

async function failRun(
  env: IssueImportEnv,
  logger: Logger,
  runId: string,
  message: string,
  progress: IssueImportProgress = {},
): Promise<IssueImportOutcome> {
  logger.warn("GitHub issue import failed", { runId, reason: message });
  await recordIssueImportProgress(env.DB, logger, runId, {
    ...progress,
    status: "failed",
    message,
  });
  return "failed";
}

/**
 * Process one queue message. Returns an error only when the outcome could not
 * be recorded (a D1 failure reading the run), which the caller retries; every
 * other failure is written to the run and reported as `"failed"`.
 */
export async function processIssueImportMessage(
  env: Env,
  message: IssueImportJobMessage,
  logger: Logger,
): Promise<Result<IssueImportOutcome, AppError>> {
  const runResult = await getIssueImportRun(env.DB, logger, message.runId);
  if (!runResult.success) return runResult;
  const run = runResult.data;
  // A run that is over, or a page the run has already moved past (a redelivered
  // message), is not reprocessed: a stale page re-enqueuing its successor would
  // fork the chain into two.
  if (!run || run.status === "completed" || run.status === "failed") return ok("skipped");
  if (message.page < run.nextPage) return ok("skipped");

  const projectResult = await getProjectByPath(env.STATE, message.namespace, message.slug, logger);
  if (
    !projectResult.success ||
    projectResult.data.id !== message.projectId ||
    projectResult.data.id !== run.projectId
  ) {
    return ok(await failRun(env, logger, run.id, "The project no longer exists at this path"));
  }
  const project = projectResult.data;
  if (await isTargetDeleting(env, project, logger)) {
    return ok(await failRun(env, logger, run.id, "The project is being deleted"));
  }

  const repo = resolveGitHubRepo(project);
  if (!repo || `${repo.owner}/${repo.repo}`.toLowerCase() !== run.githubRepo.toLowerCase()) {
    return ok(
      await failRun(env, logger, run.id, "The project's GitHub source changed during the import"),
    );
  }
  const token = await resolveIssueImportToken(env, project);
  if (!token.success) return ok(await failRun(env, logger, run.id, token.error.message));

  const client = new GitHubClient(token.data, logger);
  // Re-checked on every page, not only when the run was queued: a run spans
  // many messages and rate-limit waits, and a repository made private midway
  // must stop being copied with the instance credential. Fails closed — a
  // failed check counts as "not public".
  const visibility = await client.getRepoVisibility(repo.owner, repo.repo);
  if (!visibility.success || visibility.private) {
    return ok(
      await failRun(
        env,
        logger,
        run.id,
        visibility.success
          ? "The GitHub repository is no longer public"
          : "Could not confirm the GitHub repository is still public",
      ),
    );
  }

  await recordIssueImportProgress(env.DB, logger, run.id, { status: "running", message: null });

  const step = await importPage(
    {
      env,
      logger,
      run,
      project,
      owner: repo.owner,
      repo: repo.repo,
      client,
    },
    message.page,
  );

  if (step.kind === "error") {
    return ok(await failRun(env, logger, run.id, step.message, step.progress));
  }

  if (step.kind === "rate-limited") {
    const resumeAt = new Date(Date.now() + step.delaySeconds * 1000).toISOString();
    const requeued = await enqueueIssueImportPage(
      env.IMPORT_QUEUE,
      {
        runId: run.id,
        projectId: project.id,
        namespace: message.namespace,
        slug: message.slug,
        page: message.page,
      },
      step.delaySeconds,
    );
    if (!requeued.success) {
      return ok(await failRun(env, logger, run.id, requeued.error.message, step.progress));
    }
    await recordIssueImportProgress(env.DB, logger, run.id, {
      ...step.progress,
      message: `Waiting for GitHub's rate limit; resuming around ${resumeAt}`,
    });
    return ok("waiting");
  }

  // A short page is the last one. (A full last page costs one extra message
  // that finds an empty page and lands here too.)
  if (step.itemCount < ISSUES_PER_PAGE) {
    await recordIssueImportProgress(env.DB, logger, run.id, {
      ...step.progress,
      status: "completed",
      nextPage: message.page + 1,
      message: null,
    });
    logger.info("GitHub issue import completed", { runId: run.id, projectId: project.id });
    return ok("completed");
  }

  // Advance the run before enqueueing, so a redelivery of this message is
  // recognised as stale (page < nextPage) instead of starting a second chain.
  await recordIssueImportProgress(env.DB, logger, run.id, {
    ...step.progress,
    nextPage: message.page + 1,
  });
  const queued = await enqueueIssueImportPage(env.IMPORT_QUEUE, {
    runId: run.id,
    projectId: project.id,
    namespace: message.namespace,
    slug: message.slug,
    page: message.page + 1,
  });
  if (!queued.success) return ok(await failRun(env, logger, run.id, queued.error.message));
  return ok("continued");
}
