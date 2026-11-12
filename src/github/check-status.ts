/**
 * Mirror a change's check runs onto its linked GitHub pull request as commit
 * statuses, one `stratum/check/<name>` context per check.
 *
 * The verdict already reaches the pull request as `stratum/evaluation`, but
 * checks finish after it, often minutes later, so without this a reviewer on
 * GitHub sees "passed" while a required check is still running or has failed.
 *
 * Best-effort throughout: GitHub is a mirror of the result, never its source,
 * and nothing here may fail the report, dispatch or promotion it follows.
 */

import { getChange } from "../storage/changes";
import { type CheckRun, type CheckStatus, listChecksForChange } from "../storage/checks";
import { projectPrincipal } from "../storage/github-installations";
import { getProject } from "../storage/state";
import type { Change, Env, ProjectEntry } from "../types";
import type { Logger } from "../utils/logger";
import { type GitHubAuthEnv, resolveGitHubToken } from "./app-auth";
import { GitHubClient, type SetStatusOpts } from "./client";
import { resolveGitHubRepo } from "./sync";

/** Prefix of every check's status context. */
export const CHECK_STATUS_CONTEXT_PREFIX = "stratum/check/";

/** GitHub caps a status description at 140 characters. */
const MAX_STATUS_DESCRIPTION_LENGTH = 140;

const STATE_FOR: Record<CheckStatus, SetStatusOpts["state"]> = {
  queued: "pending",
  running: "pending",
  passed: "success",
  failed: "failure",
  errored: "error",
};

const DEFAULT_DESCRIPTION: Record<CheckStatus, string> = {
  queued: "Queued",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  errored: "Errored",
};

function statusDescription(check: CheckRun): string {
  const text = check.summary?.replace(/\s+/g, " ").trim() || DEFAULT_DESCRIPTION[check.status];
  return text.length > MAX_STATUS_DESCRIPTION_LENGTH
    ? `${text.slice(0, MAX_STATUS_DESCRIPTION_LENGTH - 1)}…`
    : text;
}

/**
 * The newest attempt of each check on `revision`. Older attempts were
 * superseded by a re-run, and posting them after the newer one would make
 * GitHub show a result the change no longer has.
 */
export function latestChecksOn(checks: CheckRun[], revision: string): CheckRun[] {
  const newest = new Map<string, CheckRun>();
  for (const check of checks) {
    if (check.revision !== revision) continue;
    const seen = newest.get(check.name);
    if (seen === undefined || check.attempt > seen.attempt) newest.set(check.name, check);
  }
  return [...newest.values()];
}

/**
 * Post the given check runs to the change's pull request.
 *
 * Only runs on the revision the pull request's head actually is: a check on
 * a revision that was never pushed to GitHub, or that the head has since moved
 * past, has no commit there to attach to.
 */
export async function reportChecksToGitHub(
  env: GitHubAuthEnv,
  logger: Logger,
  args: { change: Change; project: ProjectEntry; checks: CheckRun[] },
): Promise<void> {
  const { change, project } = args;
  if (!change.githubPrNumber) return;
  const projectRepo = resolveGitHubRepo(project);
  if (!projectRepo) return;

  // Only a head this deployment recorded pushing. Without one, nothing says
  // the pull request is on the evaluated revision.
  const sha = change.githubHeadSha;
  if (sha === undefined || sha !== change.evaluatedSha) return;
  const checks = latestChecksOn(args.checks, sha);
  if (checks.length === 0) return;

  const owner = change.githubOwner ?? projectRepo.owner;
  const repo = change.githubRepo ?? projectRepo.repo;

  try {
    const token = await resolveGitHubToken(
      env,
      { owner, repo, principal: projectPrincipal(project), project },
      logger,
    );
    if (!token.success) {
      logger.warn("No GitHub credential; skipping check statuses", {
        changeId: change.id,
        error: token.error.message,
      });
      return;
    }
    const client = new GitHubClient(token.data.token, logger);
    for (const check of checks) {
      const result = await client.setStatus({
        owner,
        repo,
        sha,
        state: STATE_FOR[check.status],
        description: statusDescription(check),
        context: `${CHECK_STATUS_CONTEXT_PREFIX}${check.name}`,
        ...(check.detailsUrl !== undefined ? { target_url: check.detailsUrl } : {}),
      });
      if (!result.success) {
        logger.warn("Failed to set a check status on GitHub", {
          changeId: change.id,
          check: check.name,
          error: result.error,
        });
      }
    }
  } catch (error) {
    logger.warn("Reporting check statuses to GitHub threw; checks unaffected", {
      changeId: change.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Read a change, its project and its check runs, and post the runs to the
 * change's pull request. For callers that hold only a change id: a runner's
 * report, the deadline sweep, a dispatch.
 */
export async function syncChangeChecksToGitHub(
  env: Pick<Env, "DB" | "STATE"> & GitHubAuthEnv,
  logger: Logger,
  changeId: string,
): Promise<void> {
  try {
    const change = await getChange(env.DB, logger, changeId);
    if (!change.success) {
      if (change.error.code !== "NOT_FOUND") {
        logger.warn("Could not read the change to report its checks", {
          changeId,
          error: change.error.message,
        });
      }
      return;
    }
    // Most changes are never promoted; they cost one read and nothing else.
    if (!change.data.githubPrNumber) return;

    const [project, checks] = await Promise.all([
      getProject(env.STATE, change.data.project, logger),
      listChecksForChange(env.DB, logger, changeId),
    ]);
    if (!project.success || !checks.success) {
      logger.warn("Could not read the project or checks to report to GitHub", { changeId });
      return;
    }
    await reportChecksToGitHub(env, logger, {
      change: change.data,
      project: project.data,
      checks: checks.data,
    });
  } catch (error) {
    logger.warn("Syncing check statuses to GitHub threw; checks unaffected", {
      changeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
