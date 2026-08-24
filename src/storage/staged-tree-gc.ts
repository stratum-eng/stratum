import type { Change } from "../types";
import { stagedTreeShaKey } from "./git-ops";

type StagedTreeChangeRef = Pick<
  Change,
  "projectId" | "workspace" | "workspaceHeadSha" | "evaluatedSha"
>;

/**
 * Delete the immutable staged-tree copy for the commit a change was evaluated
 * against. The latest-tip key is deliberately left alone: the workspace may
 * already have advanced to a newer commit that another change still needs.
 *
 * Returns the deleted key, or null for legacy changes that do not carry enough
 * identity to address a sha-keyed staged tree safely.
 */
export async function deletePinnedStagedTreeForChange(
  bucket: R2Bucket,
  change: StagedTreeChangeRef,
  fallbackProjectId?: string,
): Promise<string | null> {
  const projectId = change.projectId ?? fallbackProjectId;
  const pinnedSha = change.workspaceHeadSha ?? change.evaluatedSha;
  if (projectId === undefined || pinnedSha === undefined) return null;

  const key = stagedTreeShaKey(projectId, change.workspace, pinnedSha);
  await bucket.delete(key);
  return key;
}
