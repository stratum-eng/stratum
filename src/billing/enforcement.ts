/**
 * Consulting entitlements: the one place a limit turns into a decision.
 *
 * `entitlements.ts` defines and fetches allowances and enforces nothing. This
 * module is the other half — it evaluates a decision, records it, and hands the
 * call site an answer. Every metered call site goes through {@link checkMeter}
 * or {@link checkGauge} rather than reading a limit itself, so "what does the
 * plan allow", "what has been used", "who is this checked against" and "does
 * the answer bind" are decided once instead of five times.
 *
 * ## Everything here ships observe-only
 *
 * A decision is always *evaluated* and *recorded*; it is *binding* only when
 * `ENTITLEMENTS_ENFORCE=1`. Under observe-only a refusal still reserves — the
 * meter is told to count what it refuses ({@link checkMeter}) — still logs, and
 * still admits. That is the month of measurement PRD §8 asks for before anything
 * blocks, and the counting half is what makes it worth a month: a counter that
 * froze at the limit could report THAT people would be blocked and never BY HOW
 * MUCH, which is the number the whole exercise exists to produce. `admitted` is
 * what a caller acts on; `refused` is what the decision was, and the two differ
 * exactly when enforcement is off.
 *
 * ## Inert with `BILLING_SERVICE_URL` unset
 *
 * The first line of every entry point is `entitlementsEnabled`. With the billing
 * vars unset — every self-hoster — nothing here reads entitlements, nothing
 * touches the `USAGE_METER` binding, and no refusal can be produced.
 * `tests/enforcement.test.ts` asserts the binding is never touched in that
 * configuration, because "inert by default" is a claim that decays silently.
 *
 * ## The subject (PRD §4a)
 *
 * The subject a limit is CHECKED against is the acting user, not the subject the
 * spend is RECORDED against. See {@link resolveEnforcementSubject}.
 */
import {
  type MeterReserveOutcome,
  type RateMeterKey,
  type UsageMeterKey,
  rateWindowSeconds,
  usageMeterName,
} from "../queue/usage-meter";
import { resolveBillingSubject } from "../storage/costs";
import { type MeterKey, getOwnerMeterTotals, isMeterKey, usagePeriod } from "../storage/usage";
import type { Env } from "../types";
import type { Logger } from "../utils/logger";
import {
  type CountKey,
  type Entitlements,
  RemoteEntitlements,
  UNLIMITED,
  UnlimitedEntitlements,
  entitlementsEnabled,
  warmEntitlements,
} from "./entitlements";

/** Who a limit is checked against. Not necessarily who the spend is billed to. */
export interface EnforcementSubject {
  ownerId: string;
  ownerType: "user" | "org";
  /**
   * True only when this subject is an org that is *positively known* to pool
   * its members' usage on a paid plan. Never inferred; see
   * {@link resolveEnforcementSubject}.
   */
  pooled: boolean;
}

/** What one check decided, and whether that decision binds. */
export interface EnforcementDecision {
  /**
   * Whether the caller may proceed. Under observe-only this is `true` even for
   * a refusal — gate on this, and report {@link EnforcementDecision.refused}.
   */
  admitted: boolean;
  /** What the limit says, regardless of whether it binds. */
  refused: boolean;
  /** Whether `ENTITLEMENTS_ENFORCE=1` made this decision binding. */
  enforcing: boolean;
  /** Whether a limit was consulted at all (false when the seam is inert). */
  checked: boolean;
  /** Whether a reservation was taken and therefore needs settling. */
  reserved: boolean;
  /** The limit consulted: `-1` unlimited, `0` a hard block, else a ceiling. */
  limit: number;
  /** The subject's counter after this check, as the meter reported it. */
  count: number;
  /**
   * Present when refused: the user- and agent-facing copy naming what is
   * exhausted, when it resets and both remedies (PRD §4c). Never a bare error
   * string — this is the highest-intent moment in the funnel.
   */
  reason?: string;
}

/** Every entry point short-circuits to this when the seam is off. */
function inert(): EnforcementDecision {
  return {
    admitted: true,
    refused: false,
    enforcing: false,
    checked: false,
    reserved: false,
    limit: UNLIMITED,
    count: 0,
  };
}

/**
 * Whether a decision, once evaluated, is allowed to refuse anything.
 *
 * Two switches, not one (PRD Goal 3): metering is always on, enforcement is
 * opt-in on top of a configured billing service. `ENTITLEMENTS_ENFORCE=1` with
 * no service is a misconfiguration `entitlementsConfigError` reports; here it
 * simply cannot bind, because there is no limit to bind to.
 */
export function enforcementBinding(env: Env): boolean {
  return entitlementsEnabled(env) && env.ENTITLEMENTS_ENFORCE === "1";
}

/**
 * The subject a limit is checked against (PRD §4a).
 *
 * **The acting user, not the project's owner.** A project in an org namespace is
 * recorded against the org, and an org costs nothing to create and needs only
 * *write* access to put a project in — so an allowance keyed on the recorded
 * owner is one an exhausted user resets by making an org, or by being added to
 * someone else's. Keying the check on the person who ran the evaluation makes
 * the allowance follow the person: ten orgs do not help, and nobody can drain an
 * allowance that is not theirs.
 *
 * **An org pools only when positively known to be paid**, which is the one place
 * this PRD does not fail open, and the direction matters. `forOwner` is a cached
 * read that never fetches and nothing warms an org's entitlements before the
 * first project of that org is evaluated, so an org's plan is ALWAYS a miss on
 * first contact. Reading "unknown" as "own subject" would therefore make every
 * org its own permanently-unlimited allowance — the hole, reopened by the
 * safety mechanism. Unknown or uncached means free, and the actor is charged.
 * The cost of that direction is that during a billing outage a paying org's
 * members fall back to their personal limits: a degradation, and recoverable,
 * where the alternative is permanent.
 *
 * The org's entitlements are warmed here via `waitUntil` — the auth middleware
 * knows the caller but not the project, so it cannot do it — which is why the
 * first check for a given org resolves to the actor and a later one can pool.
 *
 * **With no actor at all** — the queue consumers — the recorded subject is the
 * only nameable one, and it is usable ONLY when it is a person. An org that is
 * not positively known to be paid must never become its own subject here: it
 * would get a counter of its own AND, since nothing warms an org's plan on that
 * path, a permanent cache miss resolving to `UnlimitedEntitlements` — a fresh,
 * permanently unlimited allowance per org, which is verbatim the hole §4a
 * exists to close. There is no safe substitute either: charging `orgs.owner_id`
 * is the aggregation §4a examined and rejected, because it hands an exhausted
 * member a fresh root and drains one person's allowance for a whole org. So the
 * check is reported UNAVAILABLE (`null`) and logged, rather than answered
 * wrongly. The cost is stated rather than hidden: an org-owned operation that
 * names nobody — today only a merge-triggered deploy — is not volume-checked
 * until either the org's plan is known to pool or the call site threads an
 * actor.
 *
 * @param opts.actorUserId - The user who ran the operation, when the site knows one
 * @param opts.owner - The project's recorded owner (`agent` walks to its user)
 * @param opts.waitUntil - Used to warm an org's plan off the response path
 * @returns The subject, or `null` when nobody can be named
 */
export async function resolveEnforcementSubject(
  env: Env,
  logger: Logger,
  opts: {
    actorUserId?: string;
    owner?: { ownerId?: string; ownerType?: "user" | "org" | "agent" };
    waitUntil?: (promise: Promise<unknown>) => void;
  },
): Promise<EnforcementSubject | null> {
  const { actorUserId, owner, waitUntil } = opts;

  if (owner?.ownerType === "org" && owner.ownerId) {
    const orgId = owner.ownerId;
    if (entitlementsEnabled(env)) {
      const resolved = await new RemoteEntitlements(env, logger).forOwner(orgId, "org");
      // `source: "default"` is "we have never heard about this org", not "this
      // org is on the default plan" — pooling on it would pool on ignorance.
      const pooled =
        resolved.success && resolved.data.source !== "default" && resolved.data.entitlements.pooled;
      if (pooled) {
        return { ownerId: orgId, ownerType: "org", pooled: true };
      }
      // Warmed for NEXT time, never awaited: a paid org pools from its second
      // evaluation onward, and the first one is charged to the actor.
      warmEntitlements(env, waitUntil, { ownerId: orgId, ownerType: "org" }, logger);
    }
  }

  if (actorUserId) return { ownerId: actorUserId, ownerType: "user", pooled: false };

  // No actor: a queue consumer, or a path that does not carry one. The recorded
  // subject is then the only nameable one, and only when it names a PERSON.
  if (!owner?.ownerId) return null;
  // Nothing below this line can produce a decision when the seam is off, so the
  // D1 hop the agent walk costs is not one a self-hoster should pay for.
  if (!entitlementsEnabled(env)) return null;
  // `resolveBillingSubject` also performs the agent -> owner walk, so an
  // agent-owned project resolves to the person who owns the agent.
  const recorded = await resolveBillingSubject(env.DB, logger, owner);
  if (!recorded) return null;
  if (recorded.ownerType === "user") return { ...recorded, pooled: false };

  // An org, with nobody to charge and no positive signal that it pools. Never
  // inferred into a subject of its own (see this function's doc comment): the
  // check is simply unavailable, and saying so is what keeps it from looking
  // like an allowance that was checked and passed.
  logger.warn("Entitlement check unavailable: an org-owned operation named no actor", {
    ownerId: recorded.ownerId,
    ownerType: recorded.ownerType,
  });
  return null;
}

/**
 * The subject's allowances, from the cached read only.
 *
 * Never fetches: this runs on the request path, where a cold billing service
 * would put a five-second dependency in front of a merge. A miss resolves to
 * `UnlimitedEntitlements`, which admits — the fail-open rule of the module it
 * reads from.
 */
async function entitlementsFor(
  env: Env,
  logger: Logger,
  subject: EnforcementSubject,
): Promise<Entitlements> {
  const resolved = await new RemoteEntitlements(env, logger).forOwner(
    subject.ownerId,
    subject.ownerType,
  );
  if (resolved.success) return resolved.data.entitlements;
  // Fails open, but never silently: admitting because the limits could not be
  // read is a different fact from admitting because the plan allows it, and a
  // month of observation that cannot tell them apart measures nothing.
  logger.warn("Entitlements unreadable; admitting against unlimited defaults", {
    subjectId: subject.ownerId,
    subjectType: subject.ownerType,
    error: resolved.error.message,
  });
  return UnlimitedEntitlements;
}

/**
 * Subjects whose D1 aggregate is being, or has been, reconciled into their
 * counter in THIS isolate, keyed `subjectType:subjectId:period`.
 *
 * The counter is authoritative for enforcement but it is not the ledger: a
 * subject that spent before the meter existed, or whose object was purged, or
 * whose spend was recorded by a path that never reserved, has a `usage_periods`
 * total the object has never seen. `setFloor` raises the counter to it (never
 * lowers — see the object's doc comment), and doing that once per isolate keeps
 * the D1 read off every single evaluation.
 *
 * The value is the in-flight PROMISE, not a bare marker, and that is the whole
 * correctness of it: a synchronous "remembered" flag lets a second request for
 * the same subject sail past and reserve against a counter the floor has not
 * landed in yet. Concurrent callers await the same reconcile instead.
 */
const reconciled = new Map<string, Promise<boolean>>();

/**
 * How many subject-periods one isolate remembers having reconciled. Bounded
 * because an isolate is long-lived and this map is otherwise append-only: a
 * busy instance would keep an entry per subject for the life of the process.
 * Oldest out first (a `Map` iterates in insertion order); the only cost of
 * forgetting one is a repeat of a read that raises nothing.
 */
const RECONCILE_MEMO_LIMIT = 1_000;

/**
 * Raise the subject's counters to the D1 aggregate, at most once per isolate —
 * and only once it has actually SUCCEEDED.
 *
 * A failed reconcile is forgotten rather than remembered: memoizing before the
 * read returned meant one D1 blip disabled the floor for that subject for the
 * life of the isolate, so a counter behind the ledger stayed behind it and the
 * subject spent the difference twice.
 *
 * `source = "platform"` is not optional here and not a detail: migration 049
 * keys usage on `(owner_id, period, meter, source)` exactly so a project paying
 * its own provider bill is not charged against the hosted allowance, and a sum
 * that omitted the filter would hand that distinction straight back (Goal 5).
 */
async function reconcileFloor(
  env: Env,
  logger: Logger,
  meterNamespace: NonNullable<Env["USAGE_METER"]>,
  subject: EnforcementSubject,
  period: string,
): Promise<void> {
  const key = `${subject.ownerType}:${subject.ownerId}:${period}`;
  const inFlight = reconciled.get(key);
  if (inFlight) {
    await inFlight;
    return;
  }
  const run = applyFloor(env, logger, meterNamespace, subject, period);
  reconciled.set(key, run);
  if (reconciled.size > RECONCILE_MEMO_LIMIT) {
    const oldest = reconciled.keys().next();
    if (!oldest.done) reconciled.delete(oldest.value);
  }
  if (!(await run)) reconciled.delete(key);
}

/**
 * The reconcile itself. Never rejects: a floor that could not be applied leaves
 * an allowance read too low, which is a billing problem, where a rejection here
 * would be a merge that failed because of metering.
 *
 * @returns Whether the floor landed, so the caller knows whether to remember it
 */
async function applyFloor(
  env: Env,
  logger: Logger,
  meterNamespace: NonNullable<Env["USAGE_METER"]>,
  subject: EnforcementSubject,
  period: string,
): Promise<boolean> {
  if (!env.DB) return false;
  try {
    const totals = await getOwnerMeterTotals(env.DB, logger, subject.ownerId, period, "platform");
    if (!totals.success) return false;
    const stub = meterNamespace.get(
      meterNamespace.idFromName(usageMeterName(subject.ownerType, subject.ownerId)),
    );
    for (const [meter, quantity] of Object.entries(totals.data)) {
      // The key set is validated by the read, so this is a narrowing and not a
      // trust decision; anything else in the table is not a meter this build
      // has a limit for, and must not be written into the counter.
      if (isMeterKey(meter) && typeof quantity === "number") {
        await stub.setFloor(meter, quantity, period);
      }
    }
    return true;
  } catch (error) {
    logger.warn("Usage floor could not be reconciled; the counter may lag the ledger", {
      subjectId: subject.ownerId,
      subjectType: subject.ownerType,
      period,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export interface MeterCheckOptions {
  subject: EnforcementSubject;
  meter: UsageMeterKey;
  /** Upper bound on what this operation will consume. Settled afterwards. */
  estimate: number;
  /** Caller's clock, so one operation's counters cannot straddle a boundary. */
  nowMs?: number;
  /** 'YYYY-MM' UTC; defaults to the month `nowMs` falls in. */
  period?: string;
  /** What is being gated, for the refusal copy (e.g. "AI review"). */
  what: string;
}

/**
 * Evaluate one metered limit for one subject: reserve an upper bound, record the
 * decision, and admit unless enforcement is on and the bound does not fit.
 *
 * The reservation is the point. An LLM call's true cost is known only from its
 * response, so checking a counter and then spending would be check-then-act
 * against a shared total; `reserve` admits or refuses the whole bound
 * atomically, and {@link settleMeter} hands back the difference.
 *
 * A BINDING refusal takes no reservation — the meter does not count what it
 * actually stops — so `reserved` is what the meter reports it counted, not what
 * the limit said. Under observe-only a refusal IS counted, because the spend
 * goes ahead regardless and an uncounted one is a measurement thrown away.
 */
export async function checkMeter(
  env: Env,
  logger: Logger,
  opts: MeterCheckOptions,
): Promise<EnforcementDecision> {
  if (!entitlementsEnabled(env)) return inert();
  const meterNamespace = env.USAGE_METER;
  if (!meterNamespace) {
    // Configured to enforce with nothing to count against. Logged rather than
    // refusing: `entitlementsConfigError` is where this gets fixed, and a
    // missing binding must not become a merge outage.
    logger.warn("Entitlement check skipped: USAGE_METER binding is not configured", {
      meter: opts.meter,
    });
    return inert();
  }

  const nowMs = opts.nowMs ?? Date.now();
  const period = opts.period ?? usagePeriod(new Date(nowMs));
  const entitlements = await entitlementsFor(env, logger, opts.subject);
  const limit = limitFor(entitlements, opts.meter);

  if (isMonthlyMeter(opts.meter)) {
    await reconcileFloor(env, logger, meterNamespace, opts.subject, period);
  }

  const stub = meterNamespace.get(
    meterNamespace.idFromName(usageMeterName(opts.subject.ownerType, opts.subject.ownerId)),
  );
  const enforcing = enforcementBinding(env);
  // Observe-only counts what it refuses. The refusal does not bind, so the
  // spend it did not stop still happens; a counter that froze at the limit
  // would leave the measurement period unable to answer the one question it
  // exists for — by how much would this subject have gone over?
  let outcome: MeterReserveOutcome;
  try {
    outcome = await stub.reserve(opts.meter, opts.estimate, limit, period, nowMs, {
      countRefused: !enforcing,
    });
  } catch (error) {
    // Fails open, for the reason the whole seam does: a meter that cannot be
    // reached is a billing outage, and a billing outage that blocks a paying
    // customer's merge is a worse failure than a spend that went uncounted.
    // Reported, never silent — `checked: false` keeps an unmeasured admission
    // out of the observe-only numbers rather than passing it off as a fit.
    logger.warn("Usage meter unreachable; admitting without a reservation", {
      subjectId: opts.subject.ownerId,
      subjectType: opts.subject.ownerType,
      meter: opts.meter,
      error: error instanceof Error ? error.message : String(error),
    });
    return inert();
  }
  const refused = !outcome.admitted;

  const decision: EnforcementDecision = {
    admitted: outcome.admitted || !enforcing,
    refused,
    enforcing,
    checked: true,
    reserved: outcome.counted,
    limit,
    count: outcome.count,
  };
  if (refused) {
    decision.reason = meterRefusalReason(opts.what, opts.meter, limit, period, nowMs);
  }
  record(logger, opts.subject, opts.meter, decision, entitlements.plan);
  return decision;
}

/**
 * Apply the true cost of a spend a {@link checkMeter} reservation covered.
 *
 * Call it in a `finally`. A provider call that throws has still consumed the
 * reservation, and leaving it standing would charge the subject the upper bound
 * for a call that never produced a token — a few of those and the allowance is
 * gone with nothing to show for it.
 */
export async function settleMeter(
  env: Env,
  logger: Logger,
  opts: {
    subject: EnforcementSubject;
    meter: UsageMeterKey;
    /** Signed difference between the true cost and the reserved bound. */
    delta: number;
    nowMs?: number;
    period?: string;
  },
): Promise<void> {
  if (!entitlementsEnabled(env)) return;
  const meterNamespace = env.USAGE_METER;
  if (!meterNamespace) return;
  if (!Number.isFinite(opts.delta) || opts.delta === 0) return;
  const nowMs = opts.nowMs ?? Date.now();
  const period = opts.period ?? usagePeriod(new Date(nowMs));
  const stub = meterNamespace.get(
    meterNamespace.idFromName(usageMeterName(opts.subject.ownerType, opts.subject.ownerId)),
  );
  try {
    await stub.settle(opts.meter, opts.delta, period, nowMs);
  } catch (error) {
    // Callers settle in a `finally`, so a throw here would replace whatever the
    // block was returning — including a successful evaluation — with a metering
    // error. The reservation stands uncorrected instead, which overcharges by
    // the difference and is the cheaper of the two failures.
    logger.warn("Usage meter unreachable; reservation left unsettled", {
      subjectId: opts.subject.ownerId,
      subjectType: opts.subject.ownerType,
      meter: opts.meter,
      delta: opts.delta,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Evaluate a counted gauge — a thing that exists rather than a thing that is
 * spent, so there is nothing to reserve and nothing to settle.
 *
 * @param opts.current - How many the subject already has, counted by the caller
 */
export async function checkGauge(
  env: Env,
  logger: Logger,
  opts: { subject: EnforcementSubject; count: CountKey; current: number; what: string },
): Promise<EnforcementDecision> {
  if (!entitlementsEnabled(env)) return inert();
  const entitlements = await entitlementsFor(env, logger, opts.subject);
  const limit = entitlements.counts[opts.count];
  const enforcing = enforcementBinding(env);
  // Same reading of a limit as the meter: `-1` unlimited, `0` a hard block,
  // anything not a usable limit admits rather than blocking on a bad payload.
  const usable = Number.isInteger(limit) && limit >= 0;
  const refused = usable && opts.current + 1 > limit;

  const decision: EnforcementDecision = {
    admitted: !refused || !enforcing,
    refused,
    enforcing,
    checked: true,
    reserved: false,
    limit,
    count: opts.current,
  };
  if (refused) decision.reason = gaugeRefusalReason(opts.what, limit);
  record(logger, opts.subject, opts.count, decision, entitlements.plan);
  return decision;
}

/**
 * Every decision is recorded, admitted or not.
 *
 * This is what makes observe-only worth a month: a log line per decision, with
 * the plan and whether the decision bound, is the difference between measuring
 * limits and guessing at them.
 */
function record(
  logger: Logger,
  subject: EnforcementSubject,
  meter: string,
  decision: EnforcementDecision,
  plan: string,
): void {
  logger.info("Entitlement decision", {
    subjectId: subject.ownerId,
    subjectType: subject.ownerType,
    pooled: subject.pooled,
    plan,
    meter,
    limit: decision.limit,
    count: decision.count,
    refused: decision.refused,
    enforcing: decision.enforcing,
    admitted: decision.admitted,
  });
}

function isMonthlyMeter(meter: UsageMeterKey): meter is MeterKey {
  return meter.endsWith("_month");
}

function limitFor(entitlements: Entitlements, meter: UsageMeterKey): number {
  return isMonthlyMeter(meter)
    ? entitlements.meters[meter]
    : entitlements.rates[meter as RateMeterKey];
}

/** First instant of the month after `period`, ISO 8601 — when a monthly meter frees up. */
export function periodResetsAt(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return "the start of next month";
  const year = Number(match[1]);
  const month = Number(match[2]);
  return new Date(Date.UTC(year, month, 1)).toISOString();
}

/**
 * The copy a blocked caller reads (PRD §4c, §8).
 *
 * It is product copy, not an error message: this is the moment somebody learns
 * a limit exists, and an agent over `/mcp` gets only this string. So it names
 * what is exhausted, when it resets, and BOTH ways out — and for the rate meter
 * it says plainly that a project's own key is not one of them, because that is
 * the remedy an agent would otherwise reach for first.
 */
function meterRefusalReason(
  what: string,
  meter: UsageMeterKey,
  limit: number,
  period: string,
  nowMs: number,
): string {
  if (meter === "evaluations_per_hour") {
    const resetsAt = new Date(nowMs + rateWindowSeconds(meter) * 1000).toISOString();
    return `${what} could not run: this account has used its hourly evaluation allowance (${limit} per hour). Capacity frees up as the window rolls, and in full by ${resetsAt}. Two ways forward: wait for the window, or raise this account's plan limits. Bringing your own provider key does NOT lift this one — it bounds how often an evaluation runs, not whose tokens it spends.`;
  }
  const remedy =
    meter === "llm_tokens_month"
      ? "set `provider:` on the llm evaluator in .stratum/policy.yaml to run reviews on this project's own API key"
      : "reduce this month's usage";
  return `${what} could not run: this account's ${meterLabel(meter)} for ${period} is used up (limit ${limit}). It resets at ${periodResetsAt(period)}. Two ways forward: ${remedy}, or raise this account's plan limits.`;
}

function gaugeRefusalReason(what: string, limit: number): string {
  return `${what} is not allowed: this account's plan allows ${limit} of them. Two ways forward: remove or make public one you already have, or raise this account's plan limits.`;
}

function meterLabel(meter: UsageMeterKey): string {
  switch (meter) {
    case "llm_tokens_month":
      return "monthly LLM token allowance";
    case "sandbox_ms_month":
      return "monthly sandbox time allowance";
    case "deploys_month":
      return "monthly deploy allowance";
    default:
      return meter;
  }
}
