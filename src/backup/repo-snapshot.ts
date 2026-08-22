import git from "isomorphic-git";
import { type NodeFS, cloneRepo, extractTreeObjects, freshRepoToken } from "../storage/git-ops";
import { packObjects } from "../storage/object-loader";
import type { Env, ProjectEntry } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export const DEFAULT_MAX_BACKUP_BYTES = 128 * 1024 * 1024;

/** A tag ref captured in a snapshot: refs/tags/<name> → oid (the annotated tag
 * object for annotated tags, the target itself for lightweight ones). */
export interface TagRefRecord {
  name: string;
  oid: string;
}

export interface RepoManifest {
  projectId: string;
  /** Full identity so restore can recreate the correctly-named Artifacts repo
   * without depending on KV (which is backed up separately). */
  project: ProjectEntry;
  tipSha: string;
  objectCount: number;
  byteCount: number;
  capturedAt: string;
  /** Tag refs captured with the pack (#182). OPTIONAL for backward
   * compatibility: manifests written before tag support omit it, and restore
   * must treat a missing field as "no tags". */
  tags?: TagRefRecord[];
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
  tags: TagRefRecord[];
}

/**
 * Collects all objects reachable from the repository tip and tags.
 *
 * The FULL reachable set is collected -- every commit, its tree, and its blobs,
 * deduped -- so the resulting pack is closed under reachability and restores to
 * a faithful repo with the original tip sha and its parents present. Every
 * `refs/tags/*` tip is walked too (#182): annotated tag objects themselves, and
 * anything reachable only from a tag, would otherwise be missing from the pack.
 *
 * Aborts with a "too large" skip once the running byte total exceeds `maxBytes`,
 * before packing. That bounds the pack being built, not the clone -- a
 * pathological repo can still exhaust memory earlier, during the clone itself.
 *
 * Operates on an already-cloned fs, so it is testable without Artifacts.
 *
 * @param fs - The filesystem containing the cloned repository
 * @param dir - The repository directory
 * @param maxBytes - Maximum total size of collected objects
 * @returns A result containing the walked objects and tag references, an empty or oversized status, or a Git error
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

    /**
     * Staging layer for one tag's traversal.
     *
     * A tag is only recorded once its whole closure resolves, but the objects
     * were being added as the walk went. When a later read failed, the tag was
     * skipped while its objects and bytes stayed behind — junk in the pack that
     * nothing references, and, worse, bytes that could push `byteCount` past
     * `maxBytes` and turn a skippable tag into a whole-backup `tooLarge`.
     *
     * While staged, `add` never reports over-budget: whether the tag resolves
     * at all is what decides between `tooLarge` and skipping it, and that is
     * only known once the walk finishes. The verdict moves to `commitStaged`.
     */
    let staged: {
      seen: Set<string>;
      objects: { oid: string; bytes: Uint8Array }[];
      bytes: number;
      over: boolean;
    } | null = null;

    const beginStaged = (): void => {
      staged = { seen: new Set(), objects: [], bytes: 0, over: false };
    };
    const rollbackStaged = (): void => {
      staged = null;
    };
    /** Merge the staged objects into the snapshot; false = over budget. */
    const commitStaged = (): boolean => {
      const s = staged;
      staged = null;
      if (!s || s.over) return !s;
      for (const o of s.objects) {
        seen.add(o.oid);
        objects.push(o);
        byteCount += o.bytes.byteLength;
      }
      return true;
    };

    const has = (oid: string): boolean => seen.has(oid) || staged?.seen.has(oid) === true;

    const add = (oid: string, bytes: Uint8Array): boolean => {
      if (has(oid)) return true;
      if (staged) {
        staged.seen.add(oid);
        // Past the budget we stop retaining bytes but keep walking, so memory
        // stays bounded while the walk still settles whether the tag resolves.
        if (!staged.over) {
          staged.objects.push({ oid, bytes });
          staged.bytes += bytes.byteLength;
          if (byteCount + staged.bytes > maxBytes) staged.over = true;
        }
        return true;
      }
      seen.add(oid);
      objects.push({ oid, bytes });
      byteCount += bytes.byteLength;
      return byteCount <= maxBytes;
    };

    /** Add one object's wrapped bytes; false = over budget (never while staged). */
    const addWrapped = async (oid: string): Promise<boolean> => {
      const obj = await git.readObject({ fs, dir, oid, format: "wrapped" });
      return add(oid, obj.object as Uint8Array);
    };

    /** Add a commit's full history (commits + trees + blobs); false = over budget.
     * `prefetched` lets the HEAD traversal reuse the log it already read. */
    const addCommitHistory = async (
      tip: string,
      prefetched?: Awaited<ReturnType<typeof git.log>>,
    ): Promise<boolean> => {
      const entries = prefetched ?? (await git.log({ fs, dir, ref: tip, depth: -1 }));
      for (const entry of entries) {
        if (has(entry.oid)) continue;
        if (!(await addWrapped(entry.oid))) return false;
        for (const o of await extractTreeObjects(fs, dir, entry.commit.tree)) {
          if (!add(o.oid, o.bytes)) return false;
        }
      }
      return true;
    };

    /**
     * Add a commit and its ancestry, stopping at commits already collected.
     *
     * `addCommitHistory` walks the whole history via `git.log` every time it is
     * called. That is right for HEAD, which is walked once from an already
     * fetched log, but wrong per tag: N tags on a long history cost N full
     * walks even when nearly every commit is already collected.
     *
     * The stop condition is a frontier, not a single boundary. A merge commit
     * can have one parent already collected and another not, so every parent is
     * enqueued and each path stops independently. Stopping at the first
     * already-collected commit would silently drop the unseen side.
     *
     * Sound because whatever added a commit added its full ancestry at the same
     * time, so an already-collected commit needs no re-walk.
     */
    const addCommitAncestry = async (tip: string): Promise<void> => {
      const queue = [tip];
      const queued = new Set<string>([tip]);
      while (queue.length > 0) {
        const oid = queue.shift() as string;
        if (has(oid)) continue;
        const read = await git.readCommit({ fs, dir, oid });
        await addWrapped(oid);
        for (const o of await extractTreeObjects(fs, dir, read.commit.tree)) {
          add(o.oid, o.bytes);
        }
        for (const parent of read.commit.parent) {
          if (!queued.has(parent)) {
            queued.add(parent);
            queue.push(parent);
          }
        }
      }
    };

    if (!(await addCommitHistory(tipSha, log))) return ok({ tooLarge: true });

    // Tags: walk every refs/tags/* tip too. A tag whose objects are missing
    // locally (e.g. the clone could not deliver them) is SKIPPED with a warning
    // rather than recorded — recording it would restore a dangling ref, and the
    // pack must stay closed under reachability.
    const tags: TagRefRecord[] = [];
    let tagNames: string[] = [];
    try {
      tagNames = await git.listTags({ fs, dir });
    } catch (error) {
      // No tags is normal; an unreadable ref store is not. Log so the two are
      // distinguishable, then back up the repo without tags rather than failing.
      logger.warn("Failed to list tags for snapshot; backing up without tag refs", {
        dir,
        error: error instanceof Error ? error.message : String(error),
      });
      tagNames = [];
    }
    for (const name of [...tagNames].sort()) {
      let refOid: string;
      try {
        refOid = await git.resolveRef({ fs, dir, ref: `refs/tags/${name}` });
      } catch {
        logger.warn("Backup: skipping unreadable tag ref", { name });
        continue;
      }
      // Staged: nothing this tag adds reaches the snapshot until its whole
      // closure resolves, so a tag skipped below leaves no objects and spends
      // no budget. The over-budget verdict comes from commitStaged, not from
      // the add calls, which is why none of them are checked here.
      beginStaged();
      try {
        // Peel annotated tags (adding each tag object in the chain) down to the
        // target, then close the pack over the target's reachability. A
        // visited-oid set (not a fixed hop cap) so a valid, unusually long
        // tag-of-tag chain still snapshots correctly instead of being dropped.
        let current = refOid;
        let target: string | null = null;
        // The peel already read the target and knows its type; re-reading it
        // afterwards was a second decode of the same object.
        let targetType: Awaited<ReturnType<typeof git.readObject>>["type"] | null = null;
        const visited = new Set<string>();
        while (target === null) {
          if (visited.has(current)) throw new Error(`tag ${name}: cyclic tag chain`);
          visited.add(current);
          const parsed = await git.readObject({ fs, dir, oid: current });
          if (parsed.type === "tag") {
            await addWrapped(current);
            current = (parsed.object as { object: string }).object;
          } else {
            target = current;
            targetType = parsed.type;
          }
        }
        if (targetType === "commit") {
          await addCommitAncestry(target);
        } else if (targetType === "tree") {
          for (const o of await extractTreeObjects(fs, dir, target)) {
            add(o.oid, o.bytes);
          }
        } else {
          await addWrapped(target);
        }
        // The tag resolved, so its bytes are real and the budget applies.
        if (!commitStaged()) return ok({ tooLarge: true });
        tags.push({ name, oid: refOid });
      } catch (error) {
        rollbackStaged();
        logger.warn("Backup: skipping unresolvable tag", {
          name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.debug("Walked repo objects", {
      tipSha,
      objectCount: objects.length,
      byteCount,
      tagCount: tags.length,
    });
    return ok({ objects, tipSha, tags });
  } catch (error) {
    logger.error("Failed to walk repo objects", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to walk repo objects", "GIT_ERROR", 500));
  }
}

/**
 * Builds a repository snapshot from walked objects and capture metadata.
 *
 * Pure, and the unit most of the snapshot tests exercise directly. The manifest
 * carries `tipSha` and the whole project record rather than just an id, because
 * restore has to work without consulting live state — a snapshot must stay
 * restorable after the project entry has changed or been deleted.
 *
 * @param project - The project associated with the snapshot
 * @param walk - The collected repository objects, tip commit, and tag references
 * @param capturedAt - The snapshot capture timestamp
 * @returns A packed repository snapshot with its manifest
 */
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
      tags: walk.tags,
    },
  };
}

/**
 * Creates a full-history repository snapshot with its manifest and tag
 * references.
 *
 * The clone is the sole Artifacts-coupled call in the snapshot path. Empty and
 * over-cap repositories return a *skip*, not an error: neither is a fault, and
 * failing the whole backup run because one repo is empty or oversized would
 * lose the snapshots of every other project in the same run.
 *
 * @param project - The project whose repository is being snapshotted
 * @param capturedAt - Timestamp recorded in the snapshot manifest
 * @returns A successful snapshot, a skipped result for empty or oversized repositories, or an application error
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

  // Full history: a shallow clone would drop ancestors past depth 50, yielding a
  // pack that can't restore the repo to its true tip. Tags are fetched too
  // (#182) so refs/tags/* and their objects land in the snapshot.
  //
  // Known trade-off: `maxBytes` is enforced by walkRepoObjects AFTER the clone,
  // so an over-cap repo is loaded into MemoryFS before it is skipped. This is
  // inherent to full-history backup — restorability requires the whole history,
  // and the smart-HTTP fetch (isomorphic-git) gives no way to know a repo's size
  // before fetching it, so there is no correctness-preserving pre-clone guard. A
  // bounded/streaming fetch that aborts mid-clone would be the real fix (tracked
  // as a follow-up); for now MAX_BACKUP_BYTES should be set well under the
  // Worker's memory budget so a normal repo never approaches it.
  const clone = await cloneRepo(project.remote, token.data, logger, {
    fullHistory: true,
    includeTags: true,
  });
  if (!clone.success) return err(clone.error);

  const walk = await walkRepoObjects(clone.data.fs, clone.data.dir, maxBytes, logger);
  if (!walk.success) return err(walk.error);
  if ("empty" in walk.data) return ok({ status: "skipped", reason: "empty" });
  if ("tooLarge" in walk.data) return ok({ status: "skipped", reason: "too large" });

  return ok({ status: "ok", snapshot: buildSnapshot(project, walk.data, capturedAt) });
}
