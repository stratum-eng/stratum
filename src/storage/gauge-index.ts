import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { getProjectByPath } from "./state";

/**
 * A per-subject index of the private projects a gauge subject was charged for
 * OUTSIDE its own personal namespace — in practice, projects a user created in
 * an org that does not pool.
 *
 * It exists so the private-project count never has to walk namespaces the
 * subject merely belongs to. Org membership is granted by other people, so any
 * count that grows with membership lets a third party move someone else's
 * limit. An entry here is written only by the subject's own creation, which
 * makes the indexed set something only the subject controls.
 *
 * Entries are hints, not truth: every read re-checks the live project and
 * prunes an entry whose project is gone, public, or charged to someone else.
 * A deletion or visibility change therefore needs no hook here. The one
 * exception is a young entry with no project yet ({@link GAUGE_CHARGE_GRACE_MS}),
 * which counts: an abandoned creation can over-count for that window at most,
 * which beats the alternative of a concurrent read pruning a live charge.
 */
const GAUGE_CHARGE_PREFIX = "gauge-charge:";

/**
 * How long an entry whose project reads NOT_FOUND still counts, and is never
 * pruned. The entry is written before its project (see the creation route), so
 * a count landing in between — or on an edge KV has not reached yet — sees no
 * project behind a perfectly good charge. Same window and reasoning as
 * `CLAIM_GRACE_MS` in project-namespace.ts (not imported: that module reaches
 * this one through deletion.ts).
 */
export const GAUGE_CHARGE_GRACE_MS = 15 * 60 * 1000;

/** What an index entry stores. */
interface GaugeChargeValue {
  projectId: string;
  /** ISO time the entry was written; drives {@link GAUGE_CHARGE_GRACE_MS}. */
  createdAt: string;
}

function chargeKey(subjectId: string, namespace: string, slug: string): string {
  return `${GAUGE_CHARGE_PREFIX}${subjectId}:${namespace}:${slug}`;
}

/** Note that `subjectId` was charged for the private project at namespace/slug. */
export async function recordGaugeCharge(
  kv: KVNamespace,
  logger: Logger,
  opts: { subjectId: string; namespace: string; slug: string; projectId: string; nowMs?: number },
): Promise<Result<void, AppError>> {
  const value: GaugeChargeValue = {
    projectId: opts.projectId,
    createdAt: new Date(opts.nowMs ?? Date.now()).toISOString(),
  };
  try {
    await kv.put(chargeKey(opts.subjectId, opts.namespace, opts.slug), JSON.stringify(value));
    return ok(undefined);
  } catch (error) {
    const appError = new AppError(
      error instanceof Error ? error.message : "Failed to record gauge charge",
      "STORAGE_ERROR",
      500,
      { subjectId: opts.subjectId, namespace: opts.namespace, slug: opts.slug },
    );
    logger.error("Failed to record gauge charge", appError);
    return err(appError);
  }
}

/** Erase every charge indexed under `subjectId` — account erasure only. */
export async function deleteGaugeCharges(
  kv: KVNamespace,
  logger: Logger,
  subjectId: string,
): Promise<Result<void, AppError>> {
  const prefix = `${GAUGE_CHARGE_PREFIX}${subjectId}:`;
  try {
    // Collected before deleting: removing keys mid-walk can shift a cursor
    // past entries that have not been visited yet.
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await kv.list({ prefix, ...(cursor !== undefined ? { cursor } : {}) });
      for (const key of page.keys) names.push(key.name);
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor !== undefined);
    for (const name of names) await kv.delete(name);
    return ok(undefined);
  } catch (error) {
    const appError = new AppError(
      error instanceof Error ? error.message : "Failed to delete gauge charges",
      "STORAGE_ERROR",
      500,
      { subjectId },
    );
    logger.error("Failed to delete gauge charges", appError);
    return err(appError);
  }
}

/** Result of {@link countGaugeCharges}. */
export interface GaugeChargeCount {
  /** Verified private projects charged to the subject, at most `max`. */
  count: number;
  /** More than `max` entries remain after verification: `count` is a floor. */
  overflow: boolean;
}

/**
 * Count the indexed private projects still charged to `subjectId`, skipping any
 * in `excludeNamespace` (counted by the caller's own listing).
 *
 * Bounded: one KV list of at most `max + 1` keys and at most `max` project
 * reads. Invalid entries are pruned as they are found, so a backlog of stale
 * entries drains over successive reads instead of pinning the count.
 */
export async function countGaugeCharges(
  kv: KVNamespace,
  logger: Logger,
  opts: { subjectId: string; excludeNamespace: string; max: number; nowMs?: number },
): Promise<Result<GaugeChargeCount, AppError>> {
  const prefix = `${GAUGE_CHARGE_PREFIX}${opts.subjectId}:`;
  const nowMs = opts.nowMs ?? Date.now();
  // Whether an entry is inside its grace window. An unreadable or unparsable
  // value is treated as old, so it is verified like any other rather than
  // counting forever.
  const isYoung = async (key: string): Promise<boolean> => {
    const raw = await kv.get(key);
    if (raw === null) return false;
    try {
      const parsed = JSON.parse(raw) as Partial<GaugeChargeValue>;
      const age = nowMs - Date.parse(String(parsed.createdAt));
      return age >= 0 && age < GAUGE_CHARGE_GRACE_MS;
    } catch {
      return false;
    }
  };
  try {
    const listed = await kv.list({ prefix, limit: opts.max + 1 });
    const keys = listed.keys.map((k) => k.name);
    const checked = keys.slice(0, opts.max);
    const valid = await Promise.all(
      checked.map(async (key) => {
        const rest = key.slice(prefix.length);
        const sep = rest.lastIndexOf(":");
        const namespace = rest.slice(0, sep);
        const slug = rest.slice(sep + 1);
        if (namespace === opts.excludeNamespace) return false;
        const project = await getProjectByPath(kv, namespace, slug, logger);
        // No project yet behind a young entry: the creation is in flight, or
        // KV has not settled here. It counts as it stands and is not pruned.
        if (!project.success && project.error.code === "NOT_FOUND" && (await isYoung(key))) {
          return true;
        }
        const stillCharged =
          project.success &&
          project.data.visibility === "private" &&
          project.data.gaugeSubjectId === opts.subjectId;
        // Prune only what is known to be over: a project gone past the grace
        // window, or one that exists and is no longer charged here. An
        // unreadable entry is left for the next read rather than erased on a
        // transient fault.
        const knownStale = project.success || project.error.code === "NOT_FOUND";
        if (!stillCharged && knownStale) await kv.delete(key);
        return stillCharged;
      }),
    );
    const count = valid.filter(Boolean).length;
    const more = keys.length > opts.max || !listed.list_complete;
    return ok({ count, overflow: more && count === opts.max });
  } catch (error) {
    const appError = new AppError(
      error instanceof Error ? error.message : "Failed to count gauge charges",
      "STORAGE_ERROR",
      500,
      { subjectId: opts.subjectId },
    );
    logger.error("Failed to count gauge charges", appError);
    return err(appError);
  }
}
