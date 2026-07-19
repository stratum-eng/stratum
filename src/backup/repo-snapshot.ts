import git from "isomorphic-git";
import { type NodeFS, cloneRepo, extractTreeObjects, freshRepoToken } from "../storage/git-ops";
import { packObjects } from "../storage/object-loader";
import type { Env, ProjectEntry } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export const DEFAULT_MAX_BACKUP_BYTES = 128 * 1024 * 1024;

export interface RepoManifest {
  projectId: string;
  /** Full identity so restore can recreate the correctly-named Artifacts repo
   * without depending on KV (which is backed up separately). */
  project: ProjectEntry;
  tipSha: string;
  objectCount: number;
  byteCount: number;
  capturedAt: string;
}

export interface RepoSnapshot {
  pack: Uint8Array;
  manifest: RepoManifest;
}

export type SnapshotResult =
  | { status: "ok"; snapshot: RepoSnapshot }
  | { status: "skipped"; reason: string };

interface WalkResult {
  objects: { oid: string; bytes: Uint8Array }[];
  tipSha: string;
}

/**
 * Collect the FULL set of objects reachable from HEAD (every commit + its tree +
 * blobs, deduped) so the resulting pack is reachability-closed and restores to a
 * faithful repo (original tip sha, parents present). Aborts with a "too large"
 * skip once the running byte total exceeds `maxBytes`, before packing — the guard
 * bounds the pack we build, though a pathological repo can still OOM the clone.
 * Operates on an already-cloned fs so it is testable without Artifacts.
 */
export async function walkRepoObjects(
  fs: NodeFS,
  dir: string,
  maxBytes: number,
  logger: Logger,
): Promise<Result<WalkResult | { tooLarge: true } | { empty: true }, AppError>> {
  // A repo with no commits has no HEAD ref, so git.log throws a NotFoundError:
  // treat that as an empty repo (skip). Any OTHER error is a real read failure
  // (transient or a corrupt object) and must surface as a failure, not be
  // silently mislabeled "empty" — which would advance the coverage cursor and
  // never retry the repo.
  let log: Awaited<ReturnType<typeof git.log>>;
  try {
    log = await git.log({ fs, dir, depth: -1 });
  } catch (error) {
    if (error instanceof Error && error.name === "NotFoundError") {
      logger.debug("Repo has no commits; skipping as empty", { dir });
      return ok({ empty: true });
    }
    logger.error("Failed to read repo log", error instanceof Error ? error : undefined, { dir });
    return err(new AppError("Failed to read repo log", "GIT_ERROR", 500));
  }
  if (log.length === 0) return ok({ empty: true });

  try {
    const tipSha = log[0]?.oid;
    if (!tipSha) return ok({ empty: true });

    const seen = new Set<string>();
    const objects: { oid: string; bytes: Uint8Array }[] = [];
    let byteCount = 0;

    const add = (oid: string, bytes: Uint8Array): boolean => {
      if (seen.has(oid)) return true;
      seen.add(oid);
      objects.push({ oid, bytes });
      byteCount += bytes.byteLength;
      return byteCount <= maxBytes;
    };

    for (const entry of log) {
      const commitObj = await git.readObject({ fs, dir, oid: entry.oid, format: "wrapped" });
      if (!add(entry.oid, commitObj.object as Uint8Array)) return ok({ tooLarge: true });

      const treeObjects = await extractTreeObjects(fs, dir, entry.commit.tree);
      for (const o of treeObjects) {
        if (!add(o.oid, o.bytes)) return ok({ tooLarge: true });
      }
    }

    logger.debug("Walked repo objects", { tipSha, objectCount: objects.length, byteCount });
    return ok({ objects, tipSha });
  } catch (error) {
    logger.error("Failed to walk repo objects", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to walk repo objects", "GIT_ERROR", 500));
  }
}

/** Assemble a snapshot from a walked object set. Pure — the unit under test. */
export function buildSnapshot(
  project: ProjectEntry,
  walk: WalkResult,
  capturedAt: string,
): RepoSnapshot {
  const byteCount = walk.objects.reduce((n, o) => n + o.bytes.byteLength, 0);
  return {
    pack: packObjects(walk.objects),
    manifest: {
      projectId: project.id,
      project,
      tipSha: walk.tipSha,
      objectCount: walk.objects.length,
      byteCount,
      capturedAt,
    },
  };
}

/**
 * Snapshot one project's repo: clone (the sole Artifacts-coupled call), walk the
 * full reachable object set, and pack it with a manifest carrying the tip sha and
 * full identity. Returns a skip (not an error) for empty or over-cap repos.
 */
export async function snapshotRepo(
  env: Env,
  project: ProjectEntry,
  capturedAt: string,
  logger: Logger,
): Promise<Result<SnapshotResult, AppError>> {
  const parsed = env.MAX_BACKUP_BYTES ? Number(env.MAX_BACKUP_BYTES) : DEFAULT_MAX_BACKUP_BYTES;
  // A NaN cap makes every `byteCount <= maxBytes` check false, silently skipping
  // every repo as "too large"; fall back to the default on garbage input.
  const maxBytes = Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_BACKUP_BYTES;

  const token = await freshRepoToken(env.ARTIFACTS, project.remote, "read", logger);
  if (!token.success) return err(token.error);

  const clone = await cloneRepo(project.remote, token.data, logger);
  if (!clone.success) return err(clone.error);

  const walk = await walkRepoObjects(clone.data.fs, clone.data.dir, maxBytes, logger);
  if (!walk.success) return err(walk.error);
  if ("empty" in walk.data) return ok({ status: "skipped", reason: "empty" });
  if ("tooLarge" in walk.data) return ok({ status: "skipped", reason: "too large" });

  return ok({ status: "ok", snapshot: buildSnapshot(project, walk.data, capturedAt) });
}
