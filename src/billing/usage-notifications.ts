/**
 * "You are approaching a limit" — the missing middle between a usage page
 * nobody visits and a merge that suddenly blocks (PRD §8, Goal 10).
 *
 * ## Edge-triggered, not state-triggered
 *
 * The notice fires on the CROSSING of 80%, which is why `upsertUsage` returns
 * the post-write total: the totals either side of one write are what make "just
 * went past" distinguishable from "is past", without a second read and without
 * a job that scans everyone.
 *
 * ## The receipt is in KV, and the limit is part of its key
 *
 * A column on `usage_periods` would be at the wrong grain (per `source`) and on
 * the wrong subject (the recorded one), and a new table would pull in
 * `tests/backup-coverage.test.ts`, which requires every migration-created table
 * to be classified — a notification receipt is neither billing data nor worth
 * restoring. The limit is IN the key on purpose: raising someone's limit
 * mid-period drops them back under 80%, and a receipt keyed without the limit
 * would silence the warning for the second crossing, which is the case the
 * dedupe was supposed to make safe.
 *
 * ## Not on the events queue
 *
 * `events.project` is NOT NULL and a usage threshold is owner-scoped, and every
 * domain event fans out through `webhookHandler` — which would publish a
 * customer's billing state to whatever third-party endpoint a project happens to
 * have configured. If this ever goes on the queue it must be an internal event
 * type excluded from fan-out.
 *
 * Gated on `entitlementsEnabled` throughout: a self-hoster must never be nagged
 * about a limit they do not have.
 */
import { getUsageThresholdEmail } from "../email/templates";
import type { BillingSubject } from "../storage/costs";
import type { UsageWriteTotal } from "../storage/usage";
import { getUser } from "../storage/users";
import type { Env } from "../types";
import type { Logger } from "../utils/logger";
import { enforcementBinding, periodResetsAt, resolveEnforcementSubject } from "./enforcement";
import { RemoteEntitlements, UnlimitedEntitlements, entitlementsEnabled } from "./entitlements";
import { recordUsageBanner } from "./usage-banner";

/** Fraction of a limit that earns a warning. One threshold, so one receipt shape. */
export const USAGE_NOTICE_THRESHOLD = 0.8;

/** Percent form, used in the receipt key and the copy. */
const THRESHOLD_PERCENT = Math.round(USAGE_NOTICE_THRESHOLD * 100);

/** Versioned like the entitlements cache, so a key-shape change cannot be misread. */
const RECEIPT_PREFIX = "usage-notice:v1:";

/**
 * Long enough to outlive the period the crossing belongs to (a month plus the
 * grace the meter itself uses), short enough that receipts do not accumulate
 * forever. KV expires them; nothing sweeps.
 */
const RECEIPT_TTL_SECONDS = 40 * 24 * 60 * 60;

/** What a recording site hands over so a crossing can be noticed. */
export interface UsageNoticeInput {
  /** Whose `usage_periods` rows were just written. */
  recorded: BillingSubject;
  /** The user who ran the operation, when the site knows one (PRD §4a). */
  actorUserId?: string;
  period: string;
  /** Post-write totals from `upsertUsage`, including what this write added. */
  totals: readonly UsageWriteTotal[];
  /** Present on a request path; absent in the queue consumers, which run inline. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Notice any 80% crossing in a just-written batch of usage and email the actor.
 *
 * Best-effort by contract, like the recording it hangs off: every failure is
 * logged and swallowed, because a notification must never fail a merge.
 *
 * Delivery is `waitUntil` where a request context exists and inline where it
 * does not — the deploy runner and the post-merge check are queue consumers
 * with no request to hang work off.
 */
export function noticeUsageThresholds(env: Env, logger: Logger, input: UsageNoticeInput): void {
  if (!entitlementsEnabled(env)) return;
  if (input.totals.length === 0) return;
  const run = deliver(env, logger, input).catch((error) => {
    logger.warn("Usage threshold notification failed", {
      ownerId: input.recorded.ownerId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  if (input.waitUntil) input.waitUntil(run);
  // Deliberately NOT awaited when there is no `waitUntil`: the two queue
  // consumers that land here are mid-deploy and mid-post-merge, and an email
  // send is not something either should block a terminal write on. The promise
  // is best-effort and its failure path is above.
}

async function deliver(env: Env, logger: Logger, input: UsageNoticeInput): Promise<void> {
  // BYOK spend is not under the allowance at all (migration 049, Goal 5), so a
  // `byok` row can never approach a hosted limit and must not warn about one.
  const platform = input.totals.filter((total) => total.source === "platform" && total.added > 0);
  if (platform.length === 0) return;

  const subject = await resolveEnforcementSubject(env, logger, {
    ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
    owner: input.recorded,
  });
  if (!subject) return;

  // The totals in hand are the RECORDED subject's rows. When the enforcement
  // subject is somebody else — an actor charged for a spend recorded against a
  // free org (§4a) — those totals are the wrong denominator for their limit, and
  // warning off them would be a number about someone else's month. That case is
  // left to the 100% refusal, which names the limit at the moment it binds.
  if (subject.ownerId !== input.recorded.ownerId) {
    logger.debug("Usage threshold check skipped: recorded subject is not the enforcement subject", {
      recordedId: input.recorded.ownerId,
      subjectId: subject.ownerId,
    });
    return;
  }

  const resolved = await new RemoteEntitlements(env, logger).forOwner(
    subject.ownerId,
    subject.ownerType,
  );
  if (!resolved.success) {
    // Fails open like every other reader — unlimited has no 80%, so this warns
    // about nothing — but never silently: a warning nobody got because the
    // billing service was unreachable is the failure Goal 10 exists to prevent,
    // and it must be visible in the log rather than inferred from its absence.
    logger.warn("Usage threshold check fell back to unlimited: entitlements unreadable", {
      subjectId: subject.ownerId,
      subjectType: subject.ownerType,
      error: resolved.error.message,
    });
  }
  const entitlements = resolved.success ? resolved.data.entitlements : UnlimitedEntitlements;

  for (const total of platform) {
    const limit = entitlements.meters[total.meter];
    // Unlimited (-1) has no 80%, and a hard block (0) is not something anyone
    // can approach — they hit it on the first unit, where the refusal speaks.
    if (!Number.isInteger(limit) || limit <= 0) continue;
    const threshold = limit * USAGE_NOTICE_THRESHOLD;
    // AT or above, not the crossing itself. An edge trigger
    // (`before < threshold && quantity >= threshold`) fires exactly once per
    // period, which is correct only while the send succeeds: a delivery that
    // failed left the receipt unwritten to be retried, but every later write
    // already has `before >= threshold`, so it was skipped here — before the
    // receipt was ever consulted — and the notice was lost for the period after
    // all. The receipt below is what makes this once-per-period; this line only
    // decides whether the subject is over the line. Costs one KV read per meter
    // per recording once a subject is above 80%, which is the price of the
    // warning actually arriving.
    if (total.quantity < threshold) continue;

    const key =
      `${RECEIPT_PREFIX}${subject.ownerType}:${subject.ownerId}:${input.period}:` +
      `${total.meter}:${THRESHOLD_PERCENT}:${limit}`;
    if (await alreadySent(env, logger, key)) continue;

    // The in-app banner (Task 9.3) is written from the crossing this loop has
    // already detected, so a page render costs one KV read and no D1. Users
    // only: there is no org UI to render it in, so a pooled org's threshold
    // reaches its actor by email alone (PRD §8).
    if (subject.ownerType === "user") {
      await recordUsageBanner(env, logger, subject.ownerId, {
        meter: total.meter,
        used: total.quantity,
        limit,
        percent: THRESHOLD_PERCENT,
        period: input.period,
      });
    }

    // Per meter, because the crossing is edge-triggered on `markSent`: a mail
    // provider that rejects one meter's notice would otherwise throw out of the
    // loop, and a second meter that crossed in the same batch would lose both
    // its email and its banner for the rest of the period — one delivery
    // failure silencing a warning nobody gets a second chance at.
    try {
      // Only on a delivery that happened. `send` returns early — successfully,
      // without throwing — when there is no recipient, when EMAIL /
      // EMAIL_FROM_ADDRESS / DB is unconfigured, or when the user row cannot be
      // read. Marking the receipt on those would burn the once-per-period slot
      // on a notice nobody received, and the operator who then fixes the
      // configuration would still hear nothing for the rest of the month. This
      // is the same failure as the crossing-gate one above, one layer down: the
      // gate fix caught the throwing path and left the silent ones.
      if (
        await send(env, logger, {
          subject,
          actorUserId: input.actorUserId,
          meter: total.meter,
          used: total.quantity,
          limit,
          period: input.period,
        })
      ) {
        await markSent(env, logger, key);
      }
    } catch (error) {
      // Deliberately NOT marked sent: the receipt is what makes this
      // once-per-crossing, so leaving it unwritten is what lets the next
      // evaluation in this period try again.
      logger.warn("Usage threshold notice failed for one meter", {
        meter: total.meter,
        subjectId: subject.ownerId,
        subjectType: subject.ownerType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function alreadySent(env: Env, logger: Logger, key: string): Promise<boolean> {
  if (!env.STATE) return true;
  try {
    return (await env.STATE.get(key)) !== null;
  } catch (error) {
    // A receipt we cannot read is treated as SENT: a duplicate warning is a
    // worse failure than a missing one, and the 100% refusal still speaks.
    logger.warn("Usage threshold receipt unreadable; treating as already sent", {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

async function markSent(env: Env, logger: Logger, key: string): Promise<void> {
  if (!env.STATE) return;
  try {
    await env.STATE.put(key, String(Date.now()), { expirationTtl: RECEIPT_TTL_SECONDS });
  } catch (error) {
    logger.warn("Usage threshold receipt could not be written", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Mail the person whose allowance it is.
 *
 * An org has no email column (`migrations/003_orgs.sql`) and there is no org UI
 * to render a banner in, so under §4a the addressee is the actor — the person
 * whose allowance is being spent. `users.email` is `UNIQUE NOT NULL` and there
 * is no email-change route in the tree, so a user can only ever mail themselves:
 * this is not an enumeration or spam surface.
 */
async function send(
  env: Env,
  logger: Logger,
  opts: {
    subject: { ownerId: string; ownerType: "user" | "org" };
    actorUserId?: string;
    meter: string;
    used: number;
    limit: number;
    period: string;
  },
): Promise<boolean> {
  const recipientId =
    opts.actorUserId ?? (opts.subject.ownerType === "user" ? opts.subject.ownerId : undefined);
  if (!recipientId) return false;
  const fromAddress = env.EMAIL_FROM_ADDRESS;
  // Both halves are required and one of them was declared for staging only until
  // this work; without either, the send path returns early and the feature would
  // ship silently never sending. See wrangler.toml's [env.production.vars].
  if (!env.EMAIL || !fromAddress || !env.DB) return false;

  const user = await getUser(env.DB, recipientId, logger);
  if (!user.success) {
    logger.warn("Usage threshold notice not sent: recipient could not be resolved", {
      userId: recipientId,
    });
    return false;
  }

  const content = getUsageThresholdEmail({
    meter: opts.meter,
    used: opts.used,
    limit: opts.limit,
    percent: THRESHOLD_PERCENT,
    period: opts.period,
    resetsAt: periodResetsAt(opts.period),
    // What happens at 100% is a question about whether limits BIND, not about
    // whether they exist: during the observe-only month nothing is refused, and
    // a mail that says otherwise is teaching people to disbelieve it later.
    enforcing: enforcementBinding(env),
  });
  await env.EMAIL.send({
    to: user.data.email,
    from: { email: fromAddress, name: "Stratum" },
    subject: content.subject,
    text: content.text,
    html: content.html,
  });
  logger.info("Usage threshold notice sent", {
    userId: recipientId,
    meter: opts.meter,
    limit: opts.limit,
    period: opts.period,
  });
  return true;
}
