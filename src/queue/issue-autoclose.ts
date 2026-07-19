import type { EventRecord } from "../storage/events";
import { closeIssue, listOpenIssuesByChange } from "../storage/issues";
import type { Env } from "../types";
import type { Logger } from "../utils/logger";
import { emitEvent } from "./events";

/**
 * When a Change merges, close every open issue linked to it and emit
 * issue.closed events. Per-issue failures are logged and skipped — a close
 * failure must not retry the whole merged event (other handlers already ran).
 */
export async function autoCloseLinkedIssues(
  env: Env,
  event: EventRecord,
  logger: Logger,
): Promise<void> {
  if (event.type !== "change.merged") return;

  const changeId = event.payload.changeId;
  if (typeof changeId !== "string" || !changeId) return;

  const issuesResult = await listOpenIssuesByChange(env.DB, logger, changeId);
  if (!issuesResult.success) return;

  for (const issue of issuesResult.data) {
    const closeResult = await closeIssue(env.DB, logger, issue.project, issue.number, "system");
    if (!closeResult.success) {
      logger.warn("Failed to auto-close linked issue", {
        project: issue.project,
        issueNumber: issue.number,
        changeId,
      });
      continue;
    }
    logger.info("Issue auto-closed by merged change", {
      project: issue.project,
      issueNumber: issue.number,
      changeId,
    });
    await emitEvent(
      env.DB,
      env.EVENTS_QUEUE ?? null,
      {
        type: "issue.closed",
        project: issue.project,
        issueNumber: issue.number,
        title: issue.title,
        changeId,
      },
      { type: "system" },
      logger,
      issue.projectId,
    );
  }
}
