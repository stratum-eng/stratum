import type { EvalPolicy } from "../evaluation/types";
import { emitEvent } from "../queue/events";
import { updateChangeStatus } from "../storage/changes";
import { recordCosts } from "../storage/costs";
import { freshRepoToken, getCommitParent, readRepoFiles, revertToCommit } from "../storage/git-ops";
import type { Env, ProjectEntry } from "../types";
import type { Logger } from "../utils/logger";

const DEFAULT_POST_MERGE_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_IN_REASON = 500;

export type PostMergeStatus = "skipped" | "passed" | "failed" | "reverted";

export interface PostMergeResult {
  status: PostMergeStatus;
  reason?: string;
  revertCommit?: string;
}

/**
 * Run the policy's post-merge smoke command against the merged HEAD in a
 * sandbox. On failure, revert the merge (unless autoRevert is disabled) and
 * mark the change reverted.
 *
 * Never throws: the merge has already happened; this reports what followed.
 */
export async function runPostMergeCheck(
  env: Env,
  project: ProjectEntry,
  opts: { changeId: string; mergeCommit: string; policy: EvalPolicy },
  logger: Logger,
): Promise<PostMergeResult> {
  const merge = opts.policy.merge;
  const command = merge?.postMergeCommand;
  if (!command) return { status: "skipped" };

  if (!env.SANDBOX) {
    logger.warn("Post-merge command configured but SANDBOX binding is absent", {
      changeId: opts.changeId,
    });
    return { status: "skipped", reason: "Sandbox binding is not configured" };
  }

  // A write-scoped token: this may read the merged tree and, on failure, push a
  // revert. Minted fresh because no token is persisted.
  const tokenResult = await freshRepoToken(env.ARTIFACTS, project.remote, "write", logger);
  if (!tokenResult.success) {
    return { status: "skipped", reason: `Could not mint repo token: ${tokenResult.error.message}` };
  }
  const projectToken = tokenResult.data;

  let failureReason: string;
  try {
    const filesResult = await readRepoFiles(project.remote, projectToken, logger);
    if (!filesResult.success) {
      return {
        status: "skipped",
        reason: `Could not read merged tree: ${filesResult.error.message}`,
      };
    }

    const sandbox = await env.SANDBOX.create();
    try {
      for (const [path, content] of filesResult.data) {
        await sandbox.writeFile(path, content);
      }
      const runStartedAt = Date.now();
      const run = await sandbox.run(command, {
        timeout: merge?.postMergeTimeoutMs ?? DEFAULT_POST_MERGE_TIMEOUT_MS,
      });
      await recordCosts(
        env.DB,
        logger,
        { project: project.name, projectId: project.id, changeId: opts.changeId },
        [
          { kind: "sandbox_ms", quantity: Date.now() - runStartedAt },
          { kind: "git_ops", quantity: 1 },
        ],
      );
      if (run.exitCode === 0) {
        logger.info("Post-merge check passed", { changeId: opts.changeId });
        return { status: "passed" };
      }
      failureReason = (run.stdout + run.stderr).slice(0, MAX_OUTPUT_IN_REASON).trim();
    } finally {
      await sandbox.destroy();
    }
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error);
  }

  logger.warn("Post-merge check failed", { changeId: opts.changeId, reason: failureReason });

  if (merge?.autoRevert === false) {
    return { status: "failed", reason: failureReason };
  }

  // Revert to the merge commit's first parent — the pre-merge HEAD.
  const parentResult = await getCommitParent(
    project.remote,
    projectToken,
    opts.mergeCommit,
    logger,
  );
  if (!parentResult.success) {
    return {
      status: "failed",
      reason: `${failureReason} (auto-revert failed: ${parentResult.error.message})`,
    };
  }

  const revertResult = await revertToCommit(
    project.remote,
    projectToken,
    parentResult.data,
    `Revert merge ${opts.mergeCommit.slice(0, 7)}: post-merge check failed`,
    logger,
  );
  if (!revertResult.success) {
    return {
      status: "failed",
      reason: `${failureReason} (auto-revert failed: ${revertResult.error.message})`,
    };
  }

  const statusResult = await updateChangeStatus(env.DB, logger, opts.changeId, "reverted", {
    evalReason: `Post-merge check failed; merge reverted in ${revertResult.data.slice(0, 7)}`,
  });
  if (!statusResult.success) {
    logger.error("Failed to mark change reverted", statusResult.error, {
      changeId: opts.changeId,
    });
  }

  await emitEvent(
    env.DB,
    env.EVENTS_QUEUE ?? null,
    {
      type: "change.reverted",
      project: project.name,
      changeId: opts.changeId,
      revertCommit: revertResult.data,
    },
    { type: "system" },
    logger,
    project.id,
  );

  return { status: "reverted", reason: failureReason, revertCommit: revertResult.data };
}
