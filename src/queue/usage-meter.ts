import { DurableObject } from "cloudflare:workers";
import { UNLIMITED } from "../billing/entitlements";
import type { MeterKey } from "../storage/usage";
import type { Env } from "../types";
import { type Logger, createLogger } from "../utils/logger";

/**
 * The monthly counters, all of them, under one key: `{ period, counts }`.
 *
 * One key per meter would make a rollover something to sweep; one key holding
 * the period makes it free, exactly as `MagicLinkRateLimiter`'s bucket does —
 * the first write of a new month overwrites the record and the previous month's
 * counts are gone without a delete.
 */
const PERIOD_KEY = "period";

/**
 * The windowed rate counters, kept apart from {@link PERIOD_KEY} because their
 * lifetimes are unrelated: an hourly window that straddles midnight on the 1st
 * must not be reset by the month rolling, and a month's counter must not be
 * dropped when the hour it happened to be written in expires.
 */
const RATE_KEY = "rate";

/**
 * How long after a window closes the object waits before erasing what belongs
 * to it. Longer than the precedent's minute because the window here is a
 * calendar month: a late `settle` for a spend that started before midnight on
 * the last day is ordinary, and erasing the record out from under it would
 * discard a correction rather than a stale count.
 */
const CLEANUP_GRACE_MS = 60 * 60 * 1000;

/**
 * A rate meter: a bound on burst over a rolling window, not a bound on the
 * month's spend. `reserve` with no `settle` is exactly that check.
 *
 * This lives here rather than in KV (PRD §4b) for one reason. KV reads come
 * from a per-colo edge cache whose staleness is about a minute, which is
 * tolerable for `rateLimitMiddleware` only because its bucket also rolls every
 * minute — staleness and window are the same size. Stretch the window to an
 * hour and staleness is 1/60th of it, so an N/hour limit admits roughly
 * N x colos x 60 to a distributed caller: not a loose limit, no limit at all,
 * against precisely the distributed burst this control exists to stop.
 */
export type RateMeterKey = "evaluations_per_hour";

/**
 * Everything this object counts: the monthly flows of `MeterKey`, plus the
 * rate meters above.
 *
 * The two are counted differently and the difference is deliberate. A monthly
 * meter is keyed on the caller's `period` string and reconciled against
 * `usage_periods`; a rate meter is keyed on wall-clock buckets and reconciled
 * against nothing, because no D1 aggregate of it exists.
 */
export type UsageMeterKey = MeterKey | RateMeterKey;

interface RateWindow {
  /** How far back the limit looks. */
  windowSeconds: number;
  /**
   * The granularity the window is summed at. SHORT on purpose: one bucket per
   * window is a fixed window, and a fixed window admits the whole allowance in
   * the first second of every new one — twice the limit across the boundary,
   * which is the burst the meter exists to bound.
   *
   * Twelve buckets do not eliminate that, they bound it: this is the ordinary
   * bucketed approximation of a sliding window, so a caller spending the whole
   * allowance at the very end of one bucket gets it back one bucket-width
   * before the hour is out — up to 2x the limit inside 55 minutes rather than
   * inside a second. Halving `bucketSeconds` halves the error and doubles the
   * stored keys. Say the bound out loud rather than claiming an exactness the
   * arithmetic does not have.
   */
  bucketSeconds: number;
}

const RATE_WINDOWS: Record<RateMeterKey, RateWindow> = {
  evaluations_per_hour: { windowSeconds: 60 * 60, bucketSeconds: 5 * 60 },
};

/**
 * How far back a rate meter's window looks, in seconds.
 *
 * Exported so the refusal copy can tell a caller when its burst allowance frees
 * up without restating the window — a message promising a reset the object does
 * not honour is worse than no message (PRD §4c).
 *
 * @param meter - The rate meter to describe
 * @returns The window length in seconds
 */
export function rateWindowSeconds(meter: RateMeterKey): number {
  return RATE_WINDOWS[meter].windowSeconds;
}

/** Bucket id (`floor(epochSeconds / bucketSeconds)`) -> quantity in that bucket. */
type RateBuckets = Record<string, number>;

interface PeriodRecord {
  /** 'YYYY-MM' UTC, from `usagePeriod`. The counts below belong to this month and no other. */
  period: string;
  counts: Partial<Record<UsageMeterKey, number>>;
}

interface RateRecord {
  meters: Partial<Record<RateMeterKey, RateBuckets>>;
}

export interface MeterReserveOutcome {
  admitted: boolean;
  /**
   * Whether the estimate was actually added to the counter, and therefore needs
   * settling.
   *
   * Not the same as {@link MeterReserveOutcome.admitted}, and the difference is
   * the whole point of `countRefused`: under observe-only a refused reservation
   * is still counted, so the month of measurement can say by HOW MUCH a subject
   * would have been blocked rather than only that it would have been. Callers
   * gate on `admitted` and settle on `counted`.
   */
  counted: boolean;
  /** The counter after this call. Reported for logging and telemetry; callers gate on `admitted`. */
  count: number;
}

export interface MeterSnapshot {
  /** Echoed back so a caller cannot mistake a rolled-over read for a live one. */
  period: string;
  /** Empty when this object holds nothing for `period` — "never used" and "used nothing" are one fact. */
  counts: Partial<Record<UsageMeterKey, number>>;
}

/**
 * Which instance an enforcement subject maps to.
 *
 * The type prefix is not decoration. This object is keyed on the ENFORCEMENT
 * subject (see the class doc comment), so a user and an org can both name one,
 * and the deletion cascade must be able to erase one without touching the
 * other: deleting a single org may not purge a counter that belongs to a
 * person. Distinct prefixes make that a property of the naming rather than of
 * whichever id generator happens not to collide today.
 *
 * @param subjectType - Whether the enforcement subject is a user or an org
 * @param subjectId - The subject's id
 * @returns The Durable Object name for that subject's counters
 */
export function usageMeterName(subjectType: "user" | "org", subjectId: string): string {
  return `${subjectType}:${subjectId}`;
}

/**
 * Serialized usage counters, one instance per ENFORCEMENT subject.
 *
 * ## What this is for
 *
 * A Workers KV read-modify-write lets N concurrent requests read the same total
 * and each write back "+1", so the counter advances by one and the cap bounds
 * sequential traffic only — the race `MagicLinkRateLimiter`'s doc comment
 * describes, and the one `rateLimitMiddleware` still has. A Durable Object
 * closes it: the runtime's input gate holds incoming events for an instance
 * while one of its storage operations is in flight, so the read and the write
 * below cannot interleave with another request against the same subject.
 * Serialization is per instance, so different subjects still run in parallel.
 *
 * ## Reserve, then settle
 *
 * An LLM call's true cost is known only from the response, so a plain increment
 * would leave enforcement doing check-then-act — the exact property the object
 * is bought for. `reserve` takes an UPPER BOUND before the spend and admits or
 * refuses it atomically; `settle` applies the signed difference once the real
 * cost is known. `MagicLinkRateLimiter.refund` is the model for the second half.
 *
 * ## The subject is the ENFORCEMENT subject, and this object does not choose it
 *
 * PRD §4a: the subject a limit is CHECKED against is not the subject a spend is
 * RECORDED against. Recording keeps naming the project's owner, because a
 * ledger must say what happened; a limit is checked against the acting user (or
 * an org positively known to hold a paid plan), because an allowance keyed on
 * the recorded owner is resettable — create an org, create a project in it, get
 * a fresh `usage_periods` subject and a fresh allowance.
 *
 * That resolution is a decision about plans and actors, and it is NOT made
 * here. The caller passes an already-resolved subject id and this object counts
 * against it. Keep it that way: a DO that resolved its own subject would need
 * the entitlements cache and the request's actor, and the one property it
 * exists to provide — that everything for one subject is serialized — would
 * then depend on a lookup that can be stale.
 *
 * ## Limits are caller-supplied
 *
 * As in the precedent, so the policy numbers stay next to the enforcement point
 * rather than being baked into storage. That is safe only because DO RPC is
 * reachable from Worker code alone: no request can name its own limit. **Do not
 * expose this class over `fetch`** — a `fetch` handler would make `limit` an
 * attacker-controlled input.
 *
 * ## Malformed input ADMITS — a deliberate deviation from the precedent
 *
 * `MagicLinkRateLimiter.reserve` returns `{admitted:false}` on a malformed
 * limit: fail closed, correct for a magic-link cap, where refusing a send is a
 * minor inconvenience and an unlimited endpoint is an abuse vector. It is wrong
 * here. The limits reaching this object come from a billing payload over the
 * network, and a `NaN` limit that refuses would block EVERY merge on the
 * instance for as long as the billing service kept sending it — an outage
 * caused by the metering, in a system whose entitlements layer fails open on
 * purpose for exactly this reason (`src/billing/entitlements.ts`). So a
 * malformed limit, estimate, period or clock admits, and says so in the log.
 *
 * Well-formed limits are NOT this branch: `-1` is unlimited (admit and count),
 * and `0` is a hard block (refuse). Only a value that is not a limit at all —
 * `NaN`, `1.5`, `-7`, an infinity — takes the admitting path.
 */
export class UsageMeter extends DurableObject<Env> {
  /**
   * Atomically admits or refuses an upper bound on a spend, and counts it.
   *
   * The whole bound has to fit: a reservation is admitted only when
   * `count + estimate` is within the limit, because the caller cannot know yet
   * that the spend will come in cheaper. `settle` gives back the difference.
   *
   * A rate meter (see {@link RateMeterKey}) takes the windowed path instead,
   * where `period` is not consulted at all — its window is wall-clock and does
   * not reset when the month does.
   *
   * @param meter - Which counter to charge
   * @param estimate - Upper bound on this spend; a non-usable value counts nothing and still admits
   * @param limit - The subject's allowance: `-1` unlimited, `0` a hard block, otherwise a ceiling
   * @param period - 'YYYY-MM' UTC, from `usagePeriod`; ignored by rate meters
   * @param nowMs - Caller's clock, so one request's counters cannot straddle a window boundary
   * @param opts.countRefused - Count the estimate even when the limit refuses it.
   *   Passed by an observe-only caller, whose refusals do not bind: a counter
   *   that stopped moving at the limit would freeze exactly when the measurement
   *   gets interesting, and `tokensReserved` would stay null so the true cost
   *   was never settled either. It never widens what is ADMITTED — `admitted`
   *   still reports what the limit says.
   * @returns Whether the reservation was admitted, whether it was counted, and
   *   the counter after this call
   */
  async reserve(
    meter: UsageMeterKey,
    estimate: number,
    limit: number,
    period: string,
    nowMs: number,
    opts: { countRefused?: boolean } = {},
  ): Promise<MeterReserveOutcome> {
    const usable = usableQuantity(estimate);
    if (usable === null) {
      // Counting nothing is the safe half of the deviation: a poisoned counter
      // (NaN never compares below a limit again) would block the subject for
      // the rest of the month, which is the outcome the deviation exists to
      // avoid. The limit still applies to what is already counted.
      warn("Usage meter estimate is not a usable quantity; reserving zero", {
        meter,
        estimate: String(estimate),
      });
    }
    const quantity = usable ?? 0;
    const countRefused = opts.countRefused === true;
    if (isRateMeter(meter)) return this.reserveRate(meter, quantity, limit, nowMs, countRefused);
    return this.reservePeriod(meter, quantity, limit, period, countRefused);
  }

  /**
   * Applies the real cost of a spend that was already reserved.
   *
   * **A negative delta is legitimate here**, and that reads as a contradiction
   * next to `upsertUsage`, which drops one, and migration 049, whose CHECK
   * forbids one. Both are right, because they hold different things. A
   * `usage_periods` row is the month's accumulated total, and a negative there
   * REFUNDS THE MONTH through the one statement that exists to make the month
   * non-refundable. This counter is the in-flight reservation ledger for a
   * single period: the negative it takes is the unused remainder of a bound
   * this same request reserved moments ago — 4,000 tokens reserved, 900 spent,
   * 3,100 handed back — and refusing it would leave every over-estimate
   * charged in full, which walls a subject off at a fraction of its allowance.
   * The floor at zero is what keeps the difference safe: a settle can never
   * hand back more than the counter holds.
   *
   * A settle for a period this object is no longer holding is dropped, as the
   * precedent's `refund` drops one whose window has rolled. The reservation it
   * corrects went with the rollover, so there is nothing to correct.
   *
   * @param meter - The counter the matching `reserve` charged
   * @param delta - Signed difference between the true cost and the reserved bound
   * @param period - The period the matching `reserve` used
   * @param nowMs - Caller's clock; used by rate meters to find the live bucket
   */
  async settle(meter: UsageMeterKey, delta: number, period: string, nowMs: number): Promise<void> {
    if (!Number.isFinite(delta)) {
      warn("Usage meter settle ignored: delta is not a finite number", { meter, delta });
      return;
    }
    if (isRateMeter(meter)) {
      await this.settleRate(meter, delta, nowMs);
      return;
    }
    const record = await this.ctx.storage.get<PeriodRecord>(PERIOD_KEY);
    if (record?.period !== period) {
      // The period rolled between reserve and settle, so the charge being
      // refunded is not in the live record. Logged rather than dropped: a
      // reservation that outlives its month leaves the old counter high, and
      // that has to be diagnosable from Workers Logs.
      warn("Usage meter settle ignored: period has rolled since the reservation", {
        meter,
        settlePeriod: period,
        livePeriod: record?.period ?? null,
      });
      return;
    }
    const current = record.counts[meter] ?? 0;
    await this.ctx.storage.put<PeriodRecord>(PERIOD_KEY, {
      period,
      counts: { ...record.counts, [meter]: Math.max(0, current + delta) },
    });
  }

  /**
   * Raises a counter to match the D1 aggregate. The reconcile write path.
   *
   * **Monotonic within a live period: it may raise, never lower** (PRD §3). The
   * counter is ahead of `usage_periods` by design — a reservation is taken
   * before the spend and the aggregate is written after it — so a reconcile
   * that treated D1 as authoritative would hand back every in-flight
   * reservation on the instance, once per reconcile. Lowering is a correction
   * to a CLOSED period, and it belongs in D1, not in a live counter.
   *
   * A floor for a period older than the one held is dropped for the same
   * reason: 'YYYY-MM' sorts chronologically, so a stale reconcile cannot
   * clobber the live month with last month's total.
   *
   * Rate meters are not reconcilable and are ignored here: there is no D1
   * aggregate of `evaluations_per_hour` to reconcile against, by design — an
   * hourly window is not something a monthly table can carry.
   *
   * WHICH rows the caller summed is a decision this object cannot make or
   * check, and getting it wrong is silent. It must be the ENFORCEMENT
   * subject's rows — the actor's, not the project owner's, since that is what
   * this instance counts — and `source = 'platform'` alone: migration 049 put
   * `source` in the primary key so that a project paying its own provider bill
   * is not charged against the hosted allowance, and a sum that omits the
   * filter hands that distinction straight back.
   *
   * @param meter - The monthly counter to raise
   * @param quantity - The aggregate's total for this subject, meter and period
   * @param period - 'YYYY-MM' UTC the quantity was summed over
   */
  async setFloor(meter: UsageMeterKey, quantity: number, period: string): Promise<void> {
    if (isRateMeter(meter)) {
      warn("Usage meter floor ignored: rate meters have no aggregate to reconcile", { meter });
      return;
    }
    const floor = usableQuantity(quantity);
    if (floor === null) {
      warn("Usage meter floor ignored: quantity is not a usable total", { meter, quantity });
      return;
    }
    const endsAt = periodEndMs(period);
    if (endsAt === null) {
      warn("Usage meter floor ignored: unparseable period", { meter, period });
      return;
    }
    const record = await this.ctx.storage.get<PeriodRecord>(PERIOD_KEY);
    if (record && record.period > period) return;
    const counts = record?.period === period ? record.counts : {};
    const current = counts[meter] ?? 0;
    if (record?.period === period && current >= floor) return;
    await this.ctx.storage.put<PeriodRecord>(PERIOD_KEY, {
      period,
      counts: { ...counts, [meter]: Math.max(current, floor) },
    });
    await this.armCleanup(endsAt + CLEANUP_GRACE_MS);
  }

  /**
   * This subject's monthly counters for one period.
   *
   * The period is an argument rather than "now" for the reason `nowMs` is one
   * on `reserve`: the caller decides which window it is asking about, so a read
   * cannot straddle a boundary and answer for half of each.
   *
   * Rate meters are deliberately absent. Which of their buckets are live
   * depends on a clock this method is not given, and a rate total answered
   * against the wrong instant is worse than no answer; `reserve` returns the
   * live count to the one caller that needs it.
   *
   * @param period - 'YYYY-MM' UTC, from `usagePeriod`
   * @returns The counters held for that period, empty when none are
   */
  async read(period: string): Promise<MeterSnapshot> {
    const record = await this.ctx.storage.get<PeriodRecord>(PERIOD_KEY);
    return { period, counts: record?.period === period ? record.counts : {} };
  }

  /**
   * Deletion-cascade RPC: DO storage is only reachable from inside the class,
   * so the ACCOUNT cascade calls this to drop the counters of a subject that no
   * longer exists. Deliberately not called by the project cascade — an
   * allowance a user can reset by deleting a project is not an allowance
   * (`src/storage/deletion.ts`, and migration 049's header).
   */
  async purge(): Promise<void> {
    // Clears the cleanup alarm along with the counters: `deleteAll` deletes an
    // object's alarm from compatibility date 2026-02-24, and this Worker is on
    // 2026-04-29, so a purged subject is left with nothing to wake it.
    await this.ctx.storage.deleteAll();
  }

  /**
   * Erases what has expired, so a subject seen once does not leave durable
   * state behind forever. Without it a per-owner monthly meter accumulates a
   * record per subject for the life of the deployment; this is what
   * `expirationTtl` did for the KV counters the precedent replaced.
   *
   * Selective rather than the precedent's flat `deleteAll` because two
   * independent lifetimes share this object: a flat wipe on the month's alarm
   * would erase a live hourly window, handing a caller a fresh burst allowance
   * every time a month ended. Uses `Date.now()` rather than a caller's clock —
   * nothing is being admitted or refused here, so there is no decision a
   * straddled boundary could corrupt.
   */
  override async alarm(): Promise<void> {
    const nowMs = Date.now();
    let nextAlarm: number | null = null;

    const record = await this.ctx.storage.get<PeriodRecord>(PERIOD_KEY);
    if (record) {
      const endsAt = periodEndMs(record.period);
      const expiresAt = endsAt === null ? null : endsAt + CLEANUP_GRACE_MS;
      // An unparseable period cannot expire on its own, so it is swept now
      // rather than pinning storage forever.
      if (expiresAt === null || expiresAt <= nowMs) await this.ctx.storage.delete(PERIOD_KEY);
      else nextAlarm = expiresAt;
    }

    const rates = await this.ctx.storage.get<RateRecord>(RATE_KEY);
    if (rates) {
      const pruned = pruneRates(rates, nowMs);
      if (pruned === null) {
        await this.ctx.storage.delete(RATE_KEY);
      } else {
        await this.ctx.storage.put<RateRecord>(RATE_KEY, pruned.record);
        nextAlarm = nextAlarm === null ? pruned.expiresAt : Math.max(nextAlarm, pruned.expiresAt);
      }
    }

    // Nothing left to expire: erase whatever remains (a key written by an
    // older shape of this class, say), which drops the alarm with it, so the
    // object costs nothing until it is next used. Re-arming goes through
    // `armCleanup` rather than `setAlarm` so the horizon clamp applies here
    // too — a stored period far enough in the future is exactly the input that
    // would otherwise strand this object's storage behind an alarm centuries
    // out.
    if (nextAlarm === null) await this.ctx.storage.deleteAll();
    else await this.armCleanup(nextAlarm);
  }

  private async reservePeriod(
    meter: UsageMeterKey,
    quantity: number,
    limit: number,
    period: string,
    countRefused: boolean,
  ): Promise<MeterReserveOutcome> {
    const endsAt = periodEndMs(period);
    if (endsAt === null) {
      warn("Usage meter reserve admitted: unparseable period", { meter, period });
      return { admitted: true, counted: false, count: 0 };
    }
    const record = await this.ctx.storage.get<PeriodRecord>(PERIOD_KEY);
    // A record from an earlier month reads as zero rather than being deleted:
    // the `put` below overwrites it, so the stale record costs nothing.
    const counts = record?.period === period ? record.counts : {};
    const current = counts[meter] ?? 0;
    const decision = limitAdmits(current, quantity, limit);
    if (decision.malformed) {
      warn("Usage meter reserve admitted: limit is not a usable limit", {
        meter,
        limit: String(limit),
      });
    }
    if (!decision.admitted && !countRefused) {
      return { admitted: false, counted: false, count: current };
    }
    const next = current + quantity;
    await this.ctx.storage.put<PeriodRecord>(PERIOD_KEY, {
      period,
      counts: { ...counts, [meter]: next },
    });
    // Re-armed on every count so the erase always trails the live period.
    await this.armCleanup(endsAt + CLEANUP_GRACE_MS);
    return { admitted: decision.admitted, counted: true, count: next };
  }

  private async reserveRate(
    meter: RateMeterKey,
    quantity: number,
    limit: number,
    nowMs: number,
    countRefused: boolean,
  ): Promise<MeterReserveOutcome> {
    if (!isUsableClock(nowMs)) {
      // Admit and count nothing, as with every other malformed input. Counting
      // it is what the earlier version did, and a bucket ~1000x in the future
      // (microseconds mistaken for milliseconds) then counted against every
      // window from here on, refusing the subject permanently.
      warn("Usage meter reserve admitted: clock is not a usable timestamp", {
        meter,
        nowMs: String(nowMs),
      });
      return { admitted: true, counted: false, count: 0 };
    }
    const window = RATE_WINDOWS[meter];
    const bucket = bucketId(nowMs, window.bucketSeconds);
    const record = await this.ctx.storage.get<RateRecord>(RATE_KEY);
    const live = liveBuckets(record?.meters[meter], bucket, window);
    const total = sum(live);
    const decision = limitAdmits(total, quantity, limit);
    if (decision.malformed) {
      warn("Usage meter reserve admitted: limit is not a usable limit", {
        meter,
        limit: String(limit),
      });
    }
    if (!decision.admitted && !countRefused) {
      return { admitted: false, counted: false, count: total };
    }
    const key = String(bucket);
    live[key] = (live[key] ?? 0) + quantity;
    await this.ctx.storage.put<RateRecord>(RATE_KEY, {
      meters: { ...record?.meters, [meter]: live },
    });
    await this.armCleanup(rateExpiresAt(bucket, window));
    return { admitted: decision.admitted, counted: true, count: total + quantity };
  }

  /**
   * Rate meters are reserve-with-no-settle by convention, so this exists only
   * for the caller that reserved an evaluation which then never ran.
   *
   * A refund DRAWS DOWN the live buckets rather than landing on the current
   * one. The earlier version added the delta to the bucket `nowMs` falls in,
   * which is empty whenever the settle outlives the reservation's bucket — the
   * normal case, since buckets are minutes and an LLM gate is seconds to
   * minutes. `Math.max(0, …)` then clamped the refund away and the original
   * charge sat in its own bucket for the rest of the window, so an evaluation
   * that failed three minutes after it was reserved still burned its slot for
   * the next hour.
   *
   * Oldest bucket first: the reservation is by definition older than its
   * settle, so that is where the charge most likely sits, and it is the choice
   * that cannot free capacity a later reservation is still holding. Per-bucket
   * floors of zero keep a refund from inventing headroom that was never taken.
   */
  private async settleRate(meter: RateMeterKey, delta: number, nowMs: number): Promise<void> {
    if (!isUsableClock(nowMs)) {
      warn("Usage meter settle ignored: clock is not a usable timestamp", {
        meter,
        nowMs: String(nowMs),
      });
      return;
    }
    const window = RATE_WINDOWS[meter];
    const bucket = bucketId(nowMs, window.bucketSeconds);
    const record = await this.ctx.storage.get<RateRecord>(RATE_KEY);
    if (!record) {
      warn("Usage meter rate settle ignored: no record for this subject", { meter, delta });
      return;
    }
    const live = liveBuckets(record.meters[meter], bucket, window);

    if (delta >= 0) {
      const key = String(bucket);
      live[key] = (live[key] ?? 0) + delta;
    } else {
      let owed = -delta;
      for (const key of Object.keys(live).sort((a, b) => Number(a) - Number(b))) {
        if (owed <= 0) break;
        const taken = Math.min(owed, live[key] ?? 0);
        live[key] = (live[key] ?? 0) - taken;
        owed -= taken;
      }
      if (owed > 0) {
        // More was given back than the window is holding — a settle without a
        // matching reserve, or one whose reservation has already aged out.
        // Refusing to go negative is right; saying so is what makes it
        // diagnosable rather than a counter that quietly disagrees with D1.
        warn("Usage meter rate refund exceeded the window's charge", {
          meter,
          delta,
          unapplied: owed,
        });
      }
    }

    await this.ctx.storage.put<RateRecord>(RATE_KEY, {
      meters: { ...record.meters, [meter]: live },
    });
  }

  /**
   * Arms the cleanup alarm for `atMs` unless a later one is already set. A DO
   * has one alarm and two lifetimes to sweep, so the later time wins and
   * `alarm()` re-arms for whatever it did not erase.
   */
  private async armCleanup(atMs: number): Promise<void> {
    // Capped, because `armCleanup` only ever RAISES the alarm: one bad input
    // that armed it centuries out could never be lowered by a later correct
    // call, and the subject's storage would never be swept.
    const ceiling = Date.now() + MAX_ALARM_HORIZON_MS;
    const at = Math.min(atMs, ceiling);
    if (at !== atMs) {
      warn("Usage meter cleanup alarm clamped to the horizon", { requestedAtMs: atMs, atMs: at });
    }
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing < at) await this.ctx.storage.setAlarm(at);
  }
}

/**
 * The band a caller's `nowMs` must fall in to be a timestamp at all.
 *
 * Deliberately an ABSOLUTE range rather than a tolerance around this object's
 * own clock. What this rejects is the wrong UNIT or the wrong epoch — seconds
 * (which land in 1970), microseconds or nanoseconds (which land tens of
 * thousands of years out) — not skew, which is real and must keep working. A
 * tolerance around `Date.now()` would also make the check depend on wall time,
 * so a test with a fixed synthetic clock would pass or fail by the calendar.
 *
 * The failure this closes: a microsecond value passes `Number.isFinite`, lands
 * a bucket ~1000x into the future where it counts against every later window
 * forever, and re-arms the cleanup alarm past the year 58000. The subject's
 * evaluations are refused permanently and its storage is stranded — the same
 * "metering causes the outage" failure the malformed-input deviation exists to
 * prevent, arriving through a value that looked finite.
 */
const MIN_PLAUSIBLE_MS = Date.UTC(2020, 0, 1);
const MAX_PLAUSIBLE_MS = Date.UTC(2200, 0, 1);

/**
 * The furthest ahead a cleanup alarm may ever be set. Longest month plus slack:
 * nothing this object sweeps has a lifetime beyond one period, so an alarm
 * further out than this is arithmetic on a bad input, and `armCleanup` only
 * ever RAISES — so one bad value could never be lowered by a later good one.
 */
const MAX_ALARM_HORIZON_MS = 40 * 24 * 60 * 60 * 1000;

/** Is `nowMs` a timestamp this object can do window arithmetic with? */
function isUsableClock(nowMs: number): boolean {
  return Number.isFinite(nowMs) && nowMs >= MIN_PLAUSIBLE_MS && nowMs <= MAX_PLAUSIBLE_MS;
}

function isRateMeter(meter: UsageMeterKey): meter is RateMeterKey {
  return meter in RATE_WINDOWS;
}

/**
 * A quantity that can safely be added to a counter, or null.
 *
 * `NaN` or an infinity would poison the counter permanently — no later
 * comparison against a limit could be true again — and a negative would refund
 * the period, which is what `reserve` is here to stop. `settle` is the only
 * signed path, and it clamps at zero.
 */
function usableQuantity(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Whether a reservation fits, and whether the limit was a limit at all.
 *
 * `malformed` is reported rather than folded into `admitted` so the caller's
 * log can tell "admitted under the allowance" from "admitted because the
 * billing payload was garbage" — the distinction `EntitlementsSource` exists
 * for one layer up, and a month of observation that cannot make it is a month
 * of unreadable data.
 */
function limitAdmits(
  current: number,
  quantity: number,
  limit: number,
): { admitted: boolean; malformed: boolean } {
  if (!Number.isInteger(limit) || limit < UNLIMITED) return { admitted: true, malformed: true };
  if (limit === UNLIMITED) return { admitted: true, malformed: false };
  // `0` is a hard block, not "unset" (see `src/billing/entitlements.ts`): a
  // subject limited to zero may not consume the resource at all, so a
  // zero-quantity reservation must not sneak past on the arithmetic below.
  if (limit === 0) return { admitted: false, malformed: false };
  return { admitted: current + quantity <= limit, malformed: false };
}

/** The instant a 'YYYY-MM' UTC period ends, or null when it is not one. */
function periodEndMs(period: string): number | null {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  // Date.UTC's month is 0-based, so passing the 1-based month lands on the
  // first instant of the NEXT month — the end of this one.
  return Date.UTC(year, month, 1);
}

function bucketId(nowMs: number, bucketSeconds: number): number {
  return Math.floor(nowMs / 1000 / bucketSeconds);
}

function bucketsPerWindow(window: RateWindow): number {
  return Math.max(1, Math.ceil(window.windowSeconds / window.bucketSeconds));
}

/** The buckets still inside the window ending at `bucket`, as a fresh object. */
function liveBuckets(
  buckets: RateBuckets | undefined,
  bucket: number,
  window: RateWindow,
): RateBuckets {
  const oldest = bucket - bucketsPerWindow(window) + 1;
  const live: RateBuckets = {};
  for (const [id, quantity] of Object.entries(buckets ?? {})) {
    const parsed = Number(id);
    // A bucket in the FUTURE is kept: a caller's clock that ran ahead once must
    // not have its reservation dropped by the next caller's slower clock.
    if (Number.isFinite(parsed) && parsed >= oldest) live[id] = quantity;
  }
  return live;
}

function sum(buckets: RateBuckets): number {
  let total = 0;
  for (const quantity of Object.values(buckets)) total += quantity;
  return total;
}

/** When a bucket stops counting toward any window, plus the cleanup grace. */
function rateExpiresAt(bucket: number, window: RateWindow): number {
  const bucketMs = window.bucketSeconds * 1000;
  return (bucket + bucketsPerWindow(window)) * bucketMs + CLEANUP_GRACE_MS;
}

/**
 * Drop every bucket that has fallen out of its window. Returns null when
 * nothing is left to keep, so the caller can erase the key rather than store an
 * empty shell.
 */
function pruneRates(
  record: RateRecord,
  nowMs: number,
): { record: RateRecord; expiresAt: number } | null {
  const meters: Partial<Record<RateMeterKey, RateBuckets>> = {};
  let expiresAt = 0;
  for (const [name, buckets] of Object.entries(record.meters ?? {})) {
    if (!isRateMeter(name as UsageMeterKey)) continue;
    const meter = name as RateMeterKey;
    const window = RATE_WINDOWS[meter];
    const live = liveBuckets(buckets, bucketId(nowMs, window.bucketSeconds), window);
    const ids = Object.keys(live);
    if (ids.length === 0) continue;
    meters[meter] = live;
    const newest = Math.max(...ids.map(Number));
    expiresAt = Math.max(expiresAt, rateExpiresAt(newest, window));
  }
  return expiresAt === 0 ? null : { record: { meters }, expiresAt };
}

// One logger per isolate rather than one per call: these paths are rare (a
// malformed input) but sit on the merge path, and `createLogger` builds a pino
// instance every time it is called.
let meterLogger: Logger | undefined;

/**
 * Every path that admits without counting, and every settle that cannot be
 * applied, logs. Each one silently ADMITS or silently keeps a charge (see the
 * class doc comment), and AGENTS.md forbids swallowing a failure. A limit that
 * stopped limiting, or a refund that never landed, must be visible in Workers
 * Logs rather than inferred from a bill.
 *
 * Values that may be `NaN` or an infinity are stringified by the caller: JSON
 * collapses all three to `null`, which would make the log unable to report the
 * exact value it exists to report.
 */
function warn(message: string, meta: Record<string, unknown>): void {
  meterLogger ??= createLogger({ component: "usage-meter" });
  meterLogger.warn(message, meta);
}
