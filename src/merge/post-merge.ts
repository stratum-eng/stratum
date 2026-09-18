import { materializeTree } from "../evaluation/sandbox-evaluator";
import type { EvalPolicy } from "../evaluation/types";
import { emitEvent } from "../queue/events";
import { updateChangeStatus } from "../storage/changes";
import { recordCosts, resolveBillingSubject } from "../storage/costs";
import { freshRepoToken, getCommitParent, readRepoFiles, revertToCommit } from "../storage/git-ops";
import type { Env, ProjectEntry } from "../types";
import { projectDefaultBranch } from "../types";
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
  const branch = projectDefaultBranch(project);

  let failureReason: string;
  try {
    // `ref` is undefined here on purpose: the smoke check reads the tree the
    // merge just produced, i.e. the branch tip, not a pinned commit.
    const filesResult = await readRepoFiles(
      project.remote,
      projectToken,
      logger,
      undefined,
      branch,
    );
    if (!filesResult.success) {
      return {
        status: "skipped",
        reason: `Could not read merged tree: ${filesResult.error.message}`,
      };
    }

    const sandbox = await env.SANDBOX.create();
    try {
      // readRepoFiles hands back raw bytes (a tree can hold binaries) while
      // the sandbox's writeFile only carries strings; `materializeTree` owns
      // that boundary — base64 for anything that is not valid UTF-8, decoded
      // back to real bytes in the sandbox before the post-merge command runs.
      // A failure there throws and is reported as a post-merge failure below,
      // exactly as an inline decode failure was.
      await materializeTree(sandbox, filesResult.data, {
        decodeTimeoutMs: merge?.postMergeTimeoutMs ?? DEFAULT_POST_MERGE_TIMEOUT_MS,
      });
      const runStartedAt = Date.now();
      const run = await sandbox.run(command, {
        timeout: merge?.postMergeTimeoutMs ?? DEFAULT_POST_MERGE_TIMEOUT_MS,
      });
      const subject = await resolveBillingSubject(env.DB, logger, project);
      await recordCosts(
        env.DB,
        logger,
        {
          project: project.name,
          projectId: project.id,
          changeId: opts.changeId,
          ...(subject ?? {}),
          // No `waitUntil`: this runs in the merge queue consumer, with no
          // request to hang background work off, so delivery is best-effort
          // inline (PRD §8). No actor either — a queue message names no user,
          // so the check falls back to the recorded subject.
          notify: { env },
        },
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
    branch,
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
    branch,
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
