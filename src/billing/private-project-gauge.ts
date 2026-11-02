import { countGaugeCharges } from "../storage/gauge-index";
import { listProjectsByNamespace } from "../storage/state";
import type { Env, ProjectEntry } from "../types";
import { getUserNamespace } from "../types";
import type { Logger } from "../utils/logger";
/**
 * The private-project gauge (PRD §8), shared by every path that creates a
 * private project: `POST /api/projects`, the single import route and bulk
 * import. A path that skipped it would be a way around the limit, so the count,
 * the decision and the subject a new entry is charged to all come from here.
 */
import type { EnforcementSubject } from "./enforcement";
import { checkGauge, releaseGauge, resolveEnforcementSubject } from "./enforcement";
import { entitlementsEnabled } from "./entitlements";

/**
 * The most charged projects outside the personal namespace that one private
 * creation will verify. Every indexed entry was written by the subject's own
 * creation, so reaching this is self-inflicted — and a plan with a finite limit
 * this large is not one this gauge exists for.
 */
export const MAX_GAUGE_CHARGES = 100;

/**
 * The hold TTL for a creation that lands inside its own request — `POST
 * /api/projects` and the single import route — where bulk import keeps the
 * meter's longer default because its repos land in the background.
 *
 * The slowest thing such a request does while holding is `initAndPush`, whose
 * push is bounded at 30s (`PUSH_TIMEOUT_MS`), plus an Artifacts create (and at
 * worst a delete and re-create) and a few KV and D1 writes: under a minute
 * even when everything is slow. Three minutes is comfortably above that. It
 * matters only when the release is lost — the request is cancelled longer than
 * `waitUntil`'s 30s after a client disconnect, or the release RPC fails — and
 * it is how long such a slot stays taken.
 */
export const SINGLE_CREATION_HOLD_TTL_MS = 3 * 60 * 1000;

/**
 * The key a creation is held and counted under: `namespace/slug`. One function
 * so the hold a route takes and the path the count reports cannot drift apart —
 * if they did, a landed project would be counted AND held.
 */
export function gaugePath(namespace: string, slug: string): string {
  return `${namespace}/${slug}`;
}

/**
 * What counting a subject's private projects produced. `complete: false` means
 * `count` is a lower bound — a read faulted, or verification stopped at
 * {@link MAX_GAUGE_CHARGES} — and never that it could be above the truth.
 */
export interface GaugeCount {
  count: number;
  complete: boolean;
  /** {@link gaugePath} of every project in `count`. */
  paths: string[];
}

/**
 * Count the private projects already charged to `subject`'s gauge.
 *
 * - **A pooled org** counts the private projects it owns, in its own namespace.
 * - **A user** counts their personal namespace (owned by them or charged to
 *   them) plus the `gauge-charge` index of projects they were charged for
 *   elsewhere — in an org that does not pool.
 *
 * **Nothing a third party controls is read.** Org membership is granted by the
 * org, not the member, so this never walks the orgs a user belongs to: being
 * added to a hundred orgs costs them nothing and cannot refuse them. The index
 * only grows by the subject's own creations (`src/storage/gauge-index.ts`).
 *
 * **Two failure directions, deliberately different.**
 * A read that *faults* fails OPEN, per the PRD's billing rule
 * (docs/research/monetization-and-byok.md, "Fail direction"): an outage of the
 * billing machinery must not block a customer's work. Only what could not be
 * read is dropped — the rest is a lower bound, and a lower bound already over
 * the limit refuses, because that is an answer, not a fault.
 * Past {@link MAX_GAUGE_CHARGES} verification stops: the verified charges are
 * added on top of the personal count, so the floor is never below anything
 * already counted, and the work per creation stays bounded. Reaching it takes
 * the subject's own creations, so no one else can move it.
 */
export async function countGaugedPrivateProjects(
  env: Env,
  logger: Logger,
  opts: { subject: EnforcementSubject; personalNamespace: string; targetNamespace: string },
): Promise<GaugeCount> {
  const { subject, personalNamespace, targetNamespace } = opts;
  const counts = (entry: ProjectEntry): boolean =>
    entry.visibility === "private" &&
    (entry.ownerId === subject.ownerId || entry.gaugeSubjectId === subject.ownerId);

  const home = subject.ownerType === "org" ? targetNamespace : personalNamespace;
  let complete = true;
  const paths: string[] = [];
  const listed = await listProjectsByNamespace(env.STATE, home, logger);
  if (listed.success) {
    for (const entry of listed.data) {
      if (counts(entry)) paths.push(gaugePath(entry.namespace, entry.slug));
    }
  } else {
    complete = false;
    logger.warn("Private project gauge: namespace unreadable; count is a lower bound", {
      subjectId: subject.ownerId,
      namespace: home,
    });
  }

  if (subject.ownerType === "user") {
    const charged = await countGaugeCharges(env.STATE, logger, {
      subjectId: subject.ownerId,
      excludeNamespace: personalNamespace,
      max: MAX_GAUGE_CHARGES,
    });
    if (charged.success) {
      // On overflow these are MAX_GAUGE_CHARGES verified entries, so personal
      // + them is a true floor, not a substitute for the personal count.
      paths.push(...charged.data.paths);
      if (charged.data.overflow) complete = false;
    } else {
      complete = false;
      logger.warn("Private project gauge: charge index unreadable; count is a lower bound", {
        subjectId: subject.ownerId,
      });
    }
  }
  return { count: paths.length, complete, paths };
}

/**
 * Ends the gauge holds one admission took: for `paths` only, or for every path
 * it was admitted for. Never rejects, and is a no-op when nothing was held.
 *
 * Idempotent: a path already released — or everything, after a release with
 * no `paths` — is not sent again. A route releases both in its own `finally`
 * and from {@link releaseWhenSettled}'s `waitUntil` backstop, so the second
 * call has to cost nothing.
 */
export type GaugeRelease = (paths?: string[]) => Promise<void>;

const NOTHING_HELD: GaugeRelease = async () => {};

/**
 * Keep a creation alive past a client disconnect, and release its gauge hold
 * once it settles, however it settles.
 *
 * A `finally` in the handler is not enough on its own. When the client goes
 * away the runtime may cancel whatever the request has not handed to
 * `waitUntil`, and a creation cancelled mid-flight never reaches its
 * `finally`, so the hold would stand for its whole TTL. In a pooled org, a
 * member firing and abandoning creations could tie up everyone's slots that
 * way. Handing the creation itself to `waitUntil` lets it run to the end — for
 * up to 30s after the disconnect — and the release chained on it runs whether
 * or not the handler's own one did.
 *
 * With no execution context (unit tests, some runtimes) this does nothing and
 * the handler's own `finally` is the only release, as it was before.
 *
 * @param work - The creation, from the moment its hold may have been taken
 * @param release - Reads the hold at call time, so a route can take the hold
 *   inside `work` after this has been registered
 * @param waitUntil - The request's `waitUntil`, from `getWaitUntil(c)`
 */
export function releaseWhenSettled(
  work: Promise<unknown>,
  release: () => Promise<void> | undefined,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
): void {
  if (!waitUntil) return;
  waitUntil(
    work.then(
      () => release(),
      () => release(),
    ),
  );
}

/**
 * Wrap a release so each path is sent at most once. See {@link GaugeRelease}.
 */
function once(send: (paths?: string[]) => Promise<void>): GaugeRelease {
  let all = false;
  const sent = new Set<string>();
  return async (paths) => {
    if (all) return;
    if (paths === undefined) {
      all = true;
      await send();
      return;
    }
    const fresh = paths.filter((path) => !sent.has(path));
    if (fresh.length === 0) return;
    for (const path of fresh) sent.add(path);
    await send(fresh);
  };
}

/** What {@link checkPrivateProjectGauge} decided. */
export type PrivateProjectGaugeResult =
  | {
      admitted: true;
      /**
       * The subject the new entries are charged to, to be stored as each
       * entry's `gaugeSubjectId`. Undefined when nothing was checked.
       */
      gaugeSubjectId?: string;
      /**
       * Call once each creation has landed or failed — from a `finally`, so no
       * exit path is missed. See {@link checkPrivateProjectGauge}.
       */
      release: GaugeRelease;
    }
  | { admitted: false; reason: string };

/**
 * Decide whether the private projects at `paths` may be created, and hold
 * their slots until they land.
 *
 * The private-project gauge (PRD §8): a thing that exists rather than a thing
 * that is spent, so what exists is counted on demand.
 *
 * **The counted set and the limit belong to the same subject**, which is the
 * only reading that is not a hole in one direction or the other. Counting the
 * TARGET namespace against the ACTOR's limit — what this did first — meant an
 * actor at their limit created a free org and got a count of zero, the "ten
 * orgs" reset §4a closes everywhere else; and the inverse bit just as hard,
 * since being added to a busy org exhausted your personal gauge against
 * projects you do not own. A project created into an org that does not pool
 * is charged to the actor but OWNED by the org, so counting by owner alone let
 * an actor create private projects there without limit. Each new entry
 * therefore records the subject it was charged to (`gaugeSubjectId`); see
 * `countGaugedPrivateProjects` for the counted set.
 *
 * **A count alone is check-then-act** (#384): two creations that count before
 * either one's entry is written are both admitted, and bulk import — checked
 * once, then created in the background — let back-to-back batches each count
 * against the same starting total. So the decision is made by the subject's
 * `UsageMeter` object, which serializes it and adds what was admitted but has
 * not landed (`checkGauge`'s `hold`). An admission's slots are held until the
 * caller's `release` — once a project's entry is written the count sees it, so
 * the hold has to go — or a TTL for a release that never arrives: three
 * minutes for an in-request creation ({@link SINGLE_CREATION_HOLD_TTL_MS}),
 * fifteen for bulk import's background repos. Routes also hand the creation to
 * `waitUntil` ({@link releaseWhenSettled}), so a client that disconnects does
 * not strand its hold. A hold whose path the count already includes is not
 * counted, so a late or lost release cannot charge a landed project twice.
 *
 * Residual limits, stated rather than claimed away. The listing is KV, so a
 * project written in another colo can stay invisible to a count for KV's
 * propagation delay after its hold is released — a window of seconds rather
 * than the whole creation, but not zero. A creation that outlives the TTL
 * stops being held. And with the meter unreachable the decision falls back to
 * the count alone (fail-open), which is exactly the race this otherwise closes.
 *
 * Gated on `entitlementsEnabled` FIRST: the listing is a KV list of a whole
 * namespace, and a self-hoster must not pay for it — or a meter call — to feed
 * a check that `checkGauge` would return `inert()` from anyway.
 *
 * @param opts.owner - Who will own the new projects: the actor, or an org
 * @param opts.targetNamespace - Where they will be created
 * @param opts.paths - {@link gaugePath} of each project to be created; a bulk
 *   import passes its whole batch, so a batch that would cross the limit is
 *   refused before any of it is made
 */
export async function checkPrivateProjectGauge(
  env: Env,
  logger: Logger,
  opts: {
    actorUserId: string;
    username: string;
    owner: { id: string; type: "user" | "org" };
    targetNamespace: string;
    paths: string[];
    /** {@link SINGLE_CREATION_HOLD_TTL_MS} for an in-request creation; the meter's default otherwise. */
    holdTtlMs?: number;
    waitUntil?: (promise: Promise<unknown>) => void;
  },
): Promise<PrivateProjectGaugeResult> {
  if (!entitlementsEnabled(env)) return { admitted: true, release: NOTHING_HELD };
  const subject = await resolveEnforcementSubject(env, logger, {
    actorUserId: opts.actorUserId,
    owner: { ownerId: opts.owner.id, ownerType: opts.owner.type },
    ...(opts.waitUntil ? { waitUntil: opts.waitUntil } : {}),
  });
  if (!subject) return { admitted: true, release: NOTHING_HELD };

  const counted = await countGaugedPrivateProjects(env, logger, {
    subject,
    personalNamespace: getUserNamespace(opts.username),
    targetNamespace: opts.targetNamespace,
  });
  // A lower bound is passed as-is: it refuses exactly the limits it already
  // meets, and an unlimited plan or observe-only behaves as usual.
  const adding = opts.paths.length;
  const token = crypto.randomUUID();
  const decision = await checkGauge(env, logger, {
    subject,
    count: "private_projects",
    current: counted.count,
    what:
      adding > 1 ? `Creating ${adding} more private projects` : "Creating another private project",
    hold: {
      token,
      paths: opts.paths,
      counted: counted.paths,
      ...(opts.holdTtlMs !== undefined ? { ttlMs: opts.holdTtlMs } : {}),
    },
  });
  if (!decision.admitted) {
    return { admitted: false, reason: decision.reason ?? "Private project limit reached" };
  }
  const release: GaugeRelease = decision.reserved
    ? once((paths) =>
        releaseGauge(env, logger, {
          subject,
          count: "private_projects",
          token,
          ...(paths !== undefined ? { paths } : {}),
        }),
      )
    : NOTHING_HELD;
  return { admitted: true, gaugeSubjectId: subject.ownerId, release };
}
