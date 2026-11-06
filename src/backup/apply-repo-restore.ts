import { RUN_MANIFEST_KEY, getBlob } from "../storage/backup-store";
import type { Env } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, fromPromise, ok } from "../utils/result";
import { type RestoreVerification, restoreProjectRepo } from "./repo-restore";
import type { RepoManifest } from "./repo-snapshot";

export interface RepoRestoreOptions {
  /** Overwrite the project's repo if it exists. Never combined with `drill`. */
  force?: boolean;
  /**
   * Restore to a generated scratch repo, verify it, and delete it. Never touches
   * the project's repo, so it is safe against a live instance.
   */
  drill?: boolean;
}

export interface RepoRestoreResult {
  runTs: string;
  projectId: string;
  mode: "drill" | "restore";
  /** The repo written to; for a drill, the scratch repo. */
  repoName?: string;
  tipSha?: string;
  verification: RestoreVerification;
  /** Drill only. False means the scratch repo named by `repoName` still exists. */
  scratchDeleted?: boolean;
  /** The snapshot held only some of the repo's branches: this many existed. */
  branchesTruncatedTotal?: number;
}

const NOT_VERIFIED: RestoreVerification = {
  ok: false,
  checked: 0,
  mismatches: [],
  error: "The restore did not report a verification",
};

function notFound(message: string): AppError {
  return new AppError(message, "NOT_FOUND", 404);
}

/**
 * Apply one project's backed-up repository from one run.
 *
 * The check is per repository, not `planRestore`'s for the run: a run that is
 * unhealthy because one repo failed still holds the only recent pack for every
 * other repo in its slice, and that is when this is most likely to be needed.
 * The run must be complete, since an incomplete one may still be writing, and
 * `reconstructRepo` proves the pack holds the recorded history before any push.
 *
 * This restores the Git repository only. It does not touch the project's
 * registry entry, so a deleted project also needs its KV entry back.
 */
export async function applyRepoRestore(
  env: Env,
  runTs: string,
  projectId: string,
  opts: RepoRestoreOptions,
  logger: Logger,
): Promise<Result<RepoRestoreResult, AppError>> {
  const bucket = env.BACKUPS;
  if (!bucket) return err(new AppError("Backups bucket not configured", "STORAGE_ERROR", 500));

  const runManifest = await getBlob(bucket, `${runTs}/${RUN_MANIFEST_KEY}`, env, logger);
  if (!runManifest.success) return runManifest;
  if (runManifest.data === null) {
    return err(notFound(`Backup run '${runTs}' does not exist or did not complete`));
  }

  const manifestBlob = await getBlob(
    bucket,
    `${runTs}/repos/${projectId}.manifest.json`,
    env,
    logger,
  );
  if (!manifestBlob.success) return manifestBlob;
  const pack = await getBlob(bucket, `${runTs}/repos/${projectId}.pack`, env, logger);
  if (!pack.success) return pack;
  // A rotating run holds only its slice, and a skipped repo has no pack at all.
  if (manifestBlob.data === null || pack.data === null || pack.data.byteLength === 0) {
    return err(notFound(`Run '${runTs}' holds no pack for project '${projectId}'`));
  }

  let manifest: RepoManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBlob.data)) as RepoManifest;
  } catch {
    return err(new AppError("Repo manifest did not parse as JSON", "BACKUP_ERROR", 500));
  }
  if (manifest.projectId !== projectId || !manifest.project) {
    return err(new AppError("Repo manifest does not match its project", "BACKUP_ERROR", 500));
  }

  const scratchName = opts.drill ? `restore-drill-${crypto.randomUUID()}` : undefined;
  const restored = await restoreProjectRepo(
    env,
    { pack: pack.data, manifest },
    {
      verify: true,
      ...(opts.force ? { force: true } : {}),
      ...(scratchName !== undefined ? { targetName: scratchName } : {}),
    },
    logger,
  );

  // Delete on failure too. A failed push already rolled the repo back, but a
  // timed-out one deliberately did not, and for a scratch repo there is nothing
  // to protect from the race that makes a live restore leave it in place.
  let scratchDeleted: boolean | undefined;
  if (scratchName !== undefined) {
    const deleted = await fromPromise(env.ARTIFACTS.delete(scratchName));
    scratchDeleted = deleted.success;
    if (!deleted.success) {
      logger.error("Restore drill could not delete its scratch repo", deleted.error, {
        scratchName,
      });
    }
  }
  if (!restored.success) return restored;

  return ok({
    runTs,
    projectId,
    mode: opts.drill ? "drill" : "restore",
    ...(scratchName !== undefined ? { repoName: scratchName } : {}),
    ...(restored.data.tipSha !== undefined ? { tipSha: restored.data.tipSha } : {}),
    verification: restored.data.verification ?? NOT_VERIFIED,
    ...(scratchDeleted !== undefined ? { scratchDeleted } : {}),
    ...(manifest.branchesTruncatedTotal !== undefined
      ? { branchesTruncatedTotal: manifest.branchesTruncatedTotal }
      : {}),
  });
}
