/**
 * The UsageMeter Durable Object.
 *
 * The concurrency suite at the bottom is the object's entire justification: a
 * KV counter admits N concurrent reservations against a cap of one, and every
 * other property here could be had from a D1 UPSERT. Its ungated twin is what
 * keeps that claim honest.
 */
import { describe, expect, it } from "vitest";
import type { UsageMeter } from "../src/queue/usage-meter";
import { usageMeterName } from "../src/queue/usage-meter";
import type { Env } from "../src/types";
import { makeUsageMeters } from "./helpers/usage-meter";

const PERIOD = "2026-09";
const NEXT_PERIOD = "2026-10";
/** Mid-month, so nothing here depends on a boundary except the tests that mean to. */
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * The object's RPC surface, derived from the class rather than restated, so a
 * signature change there fails this suite instead of being absorbed by a
 * hand-written interface that has quietly gone out of date.
 */
type MeterStub = Pick<UsageMeter, "reserve" | "settle" | "read" | "setFloor" | "purge">;

function stubFor(namespace: NonNullable<Env["USAGE_METER"]>, name: string): MeterStub {
  return namespace.get(namespace.idFromName(name));
}

function meter(opts: { gated?: boolean } = {}) {
  const meters = makeUsageMeters(opts);
  return { ...meters, stub: stubFor(meters.namespace, "user:usr_1") };
}

describe("UsageMeter.reserve", () => {
  it("admits reservations while the whole bound fits, then refuses", async () => {
    const { stub } = meter();

    const first = await stub.reserve("llm_tokens_month", 400, 1000, PERIOD, NOW);
    const second = await stub.reserve("llm_tokens_month", 400, 1000, PERIOD, NOW);
    // 800 + 400 would exceed 1000. The bound is what is reserved, so it has to
    // fit whole: the caller cannot yet know the spend will come in cheaper.
    const third = await stub.reserve("llm_tokens_month", 400, 1000, PERIOD, NOW);

    expect([first, second, third].map((o) => o.admitted)).toEqual([true, true, false]);
    expect([first, second, third].map((o) => o.count)).toEqual([400, 800, 800]);
  });

  it("refuses a single reservation larger than the whole allowance", async () => {
    const { stub } = meter();

    const outcome = await stub.reserve("llm_tokens_month", 5000, 1000, PERIOD, NOW);

    expect(outcome).toEqual({ admitted: false, counted: false, count: 0 });
    // A refusal writes nothing, so the counter is untouched for the next caller.
    expect((await stub.read(PERIOD)).counts.llm_tokens_month).toBeUndefined();
  });

  it("counts meters independently", async () => {
    const { stub } = meter();

    await stub.reserve("llm_tokens_month", 900, 1000, PERIOD, NOW);
    const deploys = await stub.reserve("deploys_month", 1, 5, PERIOD, NOW);

    expect(deploys).toEqual({ admitted: true, counted: true, count: 1 });
    expect((await stub.read(PERIOD)).counts).toEqual({ llm_tokens_month: 900, deploys_month: 1 });
  });

  it("treats -1 as unlimited: admits and still counts", async () => {
    const { stub } = meter();

    const outcome = await stub.reserve("llm_tokens_month", 10_000_000, -1, PERIOD, NOW);

    // Counting under an unlimited plan is the point of the observe-only period:
    // an unmetered "unlimited" would make a month of measurement worthless.
    expect(outcome).toEqual({ admitted: true, counted: true, count: 10_000_000 });
  });

  it("counts a refusal when the caller says the refusal does not bind", async () => {
    // Observe-only (`countRefused`). The refusal is still reported — the limit
    // says what it says — but the quantity is counted, because the spend it did
    // not stop still happens and an uncounted one is a measurement thrown away.
    const { stub } = meter();

    const first = await stub.reserve("llm_tokens_month", 900, 1000, PERIOD, NOW, {
      countRefused: true,
    });
    const over = await stub.reserve("llm_tokens_month", 900, 1000, PERIOD, NOW, {
      countRefused: true,
    });

    expect(first).toEqual({ admitted: true, counted: true, count: 900 });
    expect(over).toEqual({ admitted: false, counted: true, count: 1800 });
    expect((await stub.read(PERIOD)).counts.llm_tokens_month).toBe(1800);
  });

  it("counts a refused rate reservation too, on the same terms", async () => {
    const { stub } = meter();

    for (let i = 0; i < 3; i++) {
      await stub.reserve("evaluations_per_hour", 1, 3, PERIOD, NOW, { countRefused: true });
    }
    const over = await stub.reserve("evaluations_per_hour", 1, 3, PERIOD, NOW, {
      countRefused: true,
    });

    expect(over).toEqual({ admitted: false, counted: true, count: 4 });
  });

  it("treats 0 as a hard block, including for a zero-cost reservation", async () => {
    const { stub } = meter();

    expect((await stub.reserve("llm_tokens_month", 100, 0, PERIOD, NOW)).admitted).toBe(false);
    // `0` means "may not consume this resource at all" (src/billing/entitlements.ts),
    // so it must not be defeated by an estimate that happens to be zero.
    expect((await stub.reserve("llm_tokens_month", 0, 0, PERIOD, NOW)).admitted).toBe(false);
  });
});

describe("UsageMeter malformed input", () => {
  // The deliberate deviation from MagicLinkRateLimiter, which REFUSES on a bad
  // limit. Here the limits arrive from a billing service over the network, so a
  // refusing meter would turn one bad payload into a total merge outage.

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a fraction", 1.5],
    ["a negative that is not -1", -7],
  ])("admits when the limit is %s", async (_label, limit) => {
    const { stub } = meter();

    const outcome = await stub.reserve("llm_tokens_month", 500, limit as number, PERIOD, NOW);

    expect(outcome).toEqual({ admitted: true, counted: true, count: 500 });
  });

  it("keeps admitting under a malformed limit rather than degrading to a block", async () => {
    const { stub } = meter();

    for (let i = 0; i < 20; i++) {
      expect((await stub.reserve("llm_tokens_month", 1000, Number.NaN, PERIOD, NOW)).admitted).toBe(
        true,
      );
    }
  });

  it("admits a malformed estimate and counts nothing, leaving the counter usable", async () => {
    const { stub } = meter();

    await stub.reserve("llm_tokens_month", 100, 1000, PERIOD, NOW);
    const bad = await stub.reserve("llm_tokens_month", Number.NaN, 1000, PERIOD, NOW);

    // A NaN added to the counter would never compare below a limit again — the
    // subject would be blocked for the rest of the month by a bad estimate.
    expect(bad).toEqual({ admitted: true, counted: true, count: 100 });
    expect((await stub.read(PERIOD)).counts.llm_tokens_month).toBe(100);
    expect((await stub.reserve("llm_tokens_month", 950, 1000, PERIOD, NOW)).admitted).toBe(false);
  });

  it("admits, and writes nothing, when the period is not a period", async () => {
    const { stub, storages } = meter();

    expect((await stub.reserve("llm_tokens_month", 100, 10, "not-a-month", NOW)).admitted).toBe(
      true,
    );
    expect((await stub.reserve("llm_tokens_month", 100, 10, "2026-13", NOW)).admitted).toBe(true);

    const storage = storages.get("user:usr_1");
    expect(await storage?.get("period")).toBeUndefined();
  });

  it("ignores a settle whose delta is not a finite number", async () => {
    const { stub } = meter();

    await stub.reserve("llm_tokens_month", 500, 1000, PERIOD, NOW);
    await stub.settle("llm_tokens_month", Number.NaN, PERIOD, NOW);

    expect((await stub.read(PERIOD)).counts.llm_tokens_month).toBe(500);
  });
});

describe("UsageMeter.settle", () => {
  it("hands back the unused remainder of a reservation", async () => {
    const { stub } = meter();

    // The shape Task 8 will use: reserve maxDiffChars/4 + max output, then
    // settle the difference once the provider reports real token counts.
    const reserved = await stub.reserve("llm_tokens_month", 4000, 10_000, PERIOD, NOW);
    expect(reserved.admitted).toBe(true);
    await stub.settle("llm_tokens_month", -3100, PERIOD, NOW);

    expect((await stub.read(PERIOD)).counts.llm_tokens_month).toBe(900);
  });

  it("returns the whole reservation when the provider call fails", async () => {
    const { stub } = meter();

    // 10 reservations of 1000 exhaust the allowance...
    for (let i = 0; i < 10; i++) {
      expect((await stub.reserve("llm_tokens_month", 1000, 10_000, PERIOD, NOW)).admitted).toBe(
        true,
      );
    }
    expect((await stub.reserve("llm_tokens_month", 1000, 10_000, PERIOD, NOW)).admitted).toBe(
      false,
    );

    // ...and a provider that returned nothing spent nothing, so the caller
    // settles the full negative delta and the allowance comes back.
    await stub.settle("llm_tokens_month", -1000, PERIOD, NOW);

    expect((await stub.read(PERIOD)).counts.llm_tokens_month).toBe(9000);
    expect((await stub.reserve("llm_tokens_month", 1000, 10_000, PERIOD, NOW)).admitted).toBe(true);
  });

  it("charges a spend that came in over the reserved bound", async () => {
    const { stub } = meter();

    await stub.reserve("llm_tokens_month", 1000, 10_000, PERIOD, NOW);
    await stub.settle("llm_tokens_month", 250, PERIOD, NOW);

    expect((await stub.read(PERIOD)).counts.llm_tokens_month).toBe(1250);
  });

  it("never drives a counter below zero", async () => {
    const { stub } = meter();

    await stub.reserve("llm_tokens_month", 100, 10_000, PERIOD, NOW);
    await stub.settle("llm_tokens_month", -500, PERIOD, NOW);

    expect((await stub.read(PERIOD)).counts.llm_tokens_month).toBe(0);
  });

  it("drops a settle for a period this object is no longer holding", async () => {
    const { stub } = meter();

    await stub.reserve("llm_tokens_month", 500, 10_000, PERIOD, NOW);
    // The month rolled between the reserve and the settle; crediting the new
    // month for last month's over-estimate would carry an allowance forward.
    await stub.reserve("llm_tokens_month", 100, 10_000, NEXT_PERIOD, NOW + 31 * 24 * HOUR_MS);
    await stub.settle("llm_tokens_month", -400, PERIOD, NOW);

    expect((await stub.read(NEXT_PERIOD)).counts.llm_tokens_month).toBe(100);
  });
});

describe("UsageMeter period rollover", () => {
  it("starts the next period from zero and forgets the last one", async () => {
    const { stub } = meter();

    for (let i = 0; i < 10; i++) {
      await stub.reserve("llm_tokens_month", 100, 1000, PERIOD, NOW);
    }
    expect((await stub.reserve("llm_tokens_month", 100, 1000, PERIOD, NOW)).admitted).toBe(false);

    const rolled = await stub.reserve(
      "llm_tokens_month",
      100,
      1000,
      NEXT_PERIOD,
      NOW + 31 * 24 * HOUR_MS,
    );

    expect(rolled).toEqual({ admitted: true, counted: true, count: 100 });
    // One key holds the period, so the rollover overwrote the old counts
    // instead of leaving a record per month for something to sweep.
    expect((await stub.read(PERIOD)).counts).toEqual({});
  });

  it("reads a period it holds nothing for as empty, not as the live one", async () => {
    const { stub } = meter();

    await stub.reserve("llm_tokens_month", 100, 1000, PERIOD, NOW);

    expect(await stub.read(NEXT_PERIOD)).toEqual({ period: NEXT_PERIOD, counts: {} });
  });
});

describe("UsageMeter.setFloor", () => {
  it("raises the counter to the aggregate", async () => {
    const { stub } = meter();

    await stub.reserve("llm_tokens_month", 100, 10_000, PERIOD, NOW);
    await stub.setFloor("llm_tokens_month", 4200, PERIOD);

    expect((await stub.read(PERIOD)).counts.llm_tokens_month).toBe(4200);
  });

  it("never lowers a live period, however far behind the aggregate is", async () => {
    const { stub } = meter();

    await stub.reserve("llm_tokens_month", 9000, 10_000, PERIOD, NOW);
    // D1 lags: the aggregate is written after the spend, the reservation before
    // it. A reconcile that treated D1 as authoritative would hand back every
    // in-flight reservation on the instance.
    await stub.setFloor("llm_tokens_month", 10, PERIOD);

    expect((await stub.read(PERIOD)).counts.llm_tokens_month).toBe(9000);
    expect((await stub.reserve("llm_tokens_month", 2000, 10_000, PERIOD, NOW)).admitted).toBe(
      false,
    );
  });

  it("establishes the counter for a period it holds nothing for", async () => {
    const { stub } = meter();

    // The cold-start case: a fresh object reconciling against a month of spend
    // that D1 already knows about.
    await stub.setFloor("llm_tokens_month", 7500, PERIOD);

    expect((await stub.read(PERIOD)).counts.llm_tokens_month).toBe(7500);
    expect((await stub.reserve("llm_tokens_month", 3000, 10_000, PERIOD, NOW)).admitted).toBe(
      false,
    );
  });

  it("ignores a floor for a period older than the one it holds", async () => {
    const { stub } = meter();

    await stub.reserve("llm_tokens_month", 100, 10_000, NEXT_PERIOD, NOW + 31 * 24 * HOUR_MS);
    await stub.setFloor("llm_tokens_month", 9999, PERIOD);

    // 'YYYY-MM' sorts chronologically, so a late reconcile for a closed month
    // cannot clobber the live one with last month's total.
    expect((await stub.read(NEXT_PERIOD)).counts.llm_tokens_month).toBe(100);
  });

  it("ignores a malformed quantity", async () => {
    const { stub } = meter();

    await stub.reserve("llm_tokens_month", 100, 10_000, PERIOD, NOW);
    await stub.setFloor("llm_tokens_month", Number.NaN, PERIOD);
    await stub.setFloor("llm_tokens_month", -5, PERIOD);

    expect((await stub.read(PERIOD)).counts.llm_tokens_month).toBe(100);
  });

  it("ignores a floor for a rate meter, which has no aggregate", async () => {
    const { stub } = meter();

    await stub.setFloor("evaluations_per_hour", 500, PERIOD);

    expect((await stub.read(PERIOD)).counts).toEqual({});
    expect((await stub.reserve("evaluations_per_hour", 1, 5, PERIOD, NOW)).count).toBe(1);
  });
});

describe("UsageMeter evaluations_per_hour", () => {
  it("admits up to the hourly limit and then refuses", async () => {
    const { stub } = meter();

    const outcomes = [];
    for (let i = 0; i < 5; i++) {
      outcomes.push(await stub.reserve("evaluations_per_hour", 1, 3, PERIOD, NOW));
    }

    expect(outcomes.map((o) => o.admitted)).toEqual([true, true, true, false, false]);
    expect(outcomes.map((o) => o.count)).toEqual([1, 2, 3, 3, 3]);
  });

  it("sums short buckets across the window instead of resetting on the hour", async () => {
    const { stub } = meter();
    // One minute before the top of an hour, so a fixed hourly bucket would roll
    // between these two calls.
    const beforeTheHour = NOW - MINUTE_MS;

    for (let i = 0; i < 12; i++) {
      expect(
        (await stub.reserve("evaluations_per_hour", 1, 12, PERIOD, beforeTheHour)).admitted,
      ).toBe(true);
    }

    // The window slides, so the allowance spent at 11:59 is still spent at
    // 12:00. A single hourly bucket would have admitted 12 more here — 24 in
    // one minute against a limit of 12 per hour, the burst this meter exists
    // to bound.
    expect((await stub.reserve("evaluations_per_hour", 1, 12, PERIOD, NOW)).admitted).toBe(false);
    expect(
      (await stub.reserve("evaluations_per_hour", 1, 12, PERIOD, NOW + 30 * MINUTE_MS)).admitted,
    ).toBe(false);
  });

  it("gives the allowance back once the window has fully passed", async () => {
    const { stub } = meter();

    for (let i = 0; i < 12; i++) {
      await stub.reserve("evaluations_per_hour", 1, 12, PERIOD, NOW);
    }
    expect((await stub.reserve("evaluations_per_hour", 1, 12, PERIOD, NOW)).admitted).toBe(false);

    const later = await stub.reserve("evaluations_per_hour", 1, 12, PERIOD, NOW + HOUR_MS);

    expect(later).toEqual({ admitted: true, counted: true, count: 1 });
  });

  it("is not reset by the month rolling", async () => {
    const { stub } = meter();

    for (let i = 0; i < 3; i++) {
      await stub.reserve("evaluations_per_hour", 1, 3, PERIOD, NOW);
    }

    // A rate window that straddles midnight on the 1st is still the same
    // window; the period the caller passes has nothing to do with it.
    expect((await stub.reserve("evaluations_per_hour", 1, 3, NEXT_PERIOD, NOW)).admitted).toBe(
      false,
    );
  });

  it("keeps the month's counters out of the rate window and vice versa", async () => {
    const { stub } = meter();

    await stub.reserve("evaluations_per_hour", 1, 10, PERIOD, NOW);
    await stub.reserve("llm_tokens_month", 500, 10_000, PERIOD, NOW);

    // The rate meter is windowed, so it is deliberately not in `read`.
    expect((await stub.read(PERIOD)).counts).toEqual({ llm_tokens_month: 500 });
  });

  it("returns a rate reservation on a negative settle", async () => {
    const { stub } = meter();

    for (let i = 0; i < 3; i++) {
      await stub.reserve("evaluations_per_hour", 1, 3, PERIOD, NOW);
    }
    expect((await stub.reserve("evaluations_per_hour", 1, 3, PERIOD, NOW)).admitted).toBe(false);

    await stub.settle("evaluations_per_hour", -1, PERIOD, NOW);

    expect((await stub.reserve("evaluations_per_hour", 1, 3, PERIOD, NOW)).admitted).toBe(true);
  });

  it("returns a rate reservation settled in a LATER bucket than it was taken in", async () => {
    // The refund used to be added to the bucket `nowMs` falls in, which is
    // empty once the settle outlives the reservation's bucket — the normal
    // case, since buckets are minutes and an evaluation is seconds to minutes.
    // Math.max(0, …) then clamped the refund away and the charge sat in its own
    // bucket for the rest of the hour, so a provider call that failed three
    // minutes in still burned its slot until the window rolled.
    const { stub } = meter();
    const sixMinutes = 6 * 60 * 1000;

    for (let i = 0; i < 3; i++) {
      await stub.reserve("evaluations_per_hour", 1, 3, PERIOD, NOW);
    }
    expect((await stub.reserve("evaluations_per_hour", 1, 3, PERIOD, NOW)).admitted).toBe(false);

    await stub.settle("evaluations_per_hour", -1, PERIOD, NOW + sixMinutes);

    const after = await stub.reserve("evaluations_per_hour", 1, 3, PERIOD, NOW + sixMinutes);
    expect(after.admitted).toBe(true);
  });

  it("refuses to refund more than the window is holding", async () => {
    const { stub } = meter();
    await stub.reserve("evaluations_per_hour", 1, 5, PERIOD, NOW);

    await stub.settle("evaluations_per_hour", -4, PERIOD, NOW);

    // Back to empty, not negative — a refund must not invent headroom.
    const outcome = await stub.reserve("evaluations_per_hour", 5, 5, PERIOD, NOW);
    expect(outcome.admitted).toBe(true);
    expect(outcome.count).toBe(5);
  });

  it.each([
    ["microseconds mistaken for milliseconds", NOW * 1000],
    ["seconds mistaken for milliseconds", Math.floor(NOW / 1000)],
  ])("admits and counts nothing for a clock in %s", async (_label, badClock) => {
    // Finite, so the old `Number.isFinite` guard let it through: the bucket
    // landed ~1000x into the future, counted against every later window, and
    // refused the subject permanently while arming a cleanup alarm past the
    // year 58000. Admitting and counting nothing is the same treatment every
    // other malformed input gets.
    const { stub } = meter();

    const bad = await stub.reserve("evaluations_per_hour", 1, 1, PERIOD, badClock);
    expect(bad).toEqual({ admitted: true, counted: false, count: 0 });

    // And the good clock that follows is unaffected — the whole allowance is
    // still there, which is what "counts nothing" has to mean.
    const good = await stub.reserve("evaluations_per_hour", 1, 1, PERIOD, NOW);
    expect(good.admitted).toBe(true);
  });

  it("admits when the clock is not a usable timestamp", async () => {
    const { stub } = meter();

    const outcome = await stub.reserve("evaluations_per_hour", 1, 1, PERIOD, Number.NaN);

    expect(outcome).toEqual({ admitted: true, counted: false, count: 0 });
  });
});

describe("UsageMeter cleanup", () => {
  it("arms the alarm past the end of the live period", async () => {
    const { stub, storages } = meter();

    await stub.reserve("llm_tokens_month", 100, 1000, PERIOD, NOW);

    const alarm = await storages.get("user:usr_1")?.getAlarm();
    expect(alarm).toBeGreaterThan(Date.UTC(2026, 9, 1));
  });

  it("erases a closed period on the alarm, so a monthly meter is not forever", async () => {
    const { stub, instances, storages } = meter();
    const closed = "2020-01";

    await stub.reserve("llm_tokens_month", 100, 1000, closed, Date.UTC(2020, 0, 15));
    const instance = instances.get("user:usr_1");
    const storage = storages.get("user:usr_1");
    if (!instance || !storage) throw new Error("instance not created");

    await instance.alarm();

    expect(await storage.get("period")).toBeUndefined();
    expect(await storage.getAlarm()).toBeNull();
  });

  it("keeps a live hourly window when a closed period is swept", async () => {
    const { stub, instances, storages } = meter();
    const closed = "2020-01";

    await stub.reserve("llm_tokens_month", 100, 1000, closed, Date.UTC(2020, 0, 15));
    // The rate reservation is live NOW; the precedent's flat deleteAll would
    // erase it along with the closed month and hand back a fresh burst.
    for (let i = 0; i < 3; i++) {
      await stub.reserve("evaluations_per_hour", 1, 3, PERIOD, Date.now());
    }
    const instance = instances.get("user:usr_1");
    const storage = storages.get("user:usr_1");
    if (!instance || !storage) throw new Error("instance not created");

    await instance.alarm();

    expect(await storage.get("period")).toBeUndefined();
    expect(await storage.get("rate")).toBeDefined();
    expect(await storage.getAlarm()).not.toBeNull();
    expect((await stub.reserve("evaluations_per_hour", 1, 3, PERIOD, Date.now())).admitted).toBe(
      false,
    );
  });

  it("erases an expired rate window", async () => {
    const { stub, instances, storages } = meter();

    await stub.reserve("evaluations_per_hour", 1, 3, PERIOD, Date.now() - 4 * HOUR_MS);
    const instance = instances.get("user:usr_1");
    const storage = storages.get("user:usr_1");
    if (!instance || !storage) throw new Error("instance not created");

    await instance.alarm();

    expect(await storage.get("rate")).toBeUndefined();
    expect(await storage.getAlarm()).toBeNull();
  });

  it("purges everything for the deletion cascade", async () => {
    const { stub, storages } = meter();

    await stub.reserve("llm_tokens_month", 100, 1000, PERIOD, NOW);
    await stub.reserve("evaluations_per_hour", 1, 3, PERIOD, NOW);
    await stub.purge();

    const storage = storages.get("user:usr_1");
    expect(await storage?.get("period")).toBeUndefined();
    expect(await storage?.get("rate")).toBeUndefined();
    expect((await stub.read(PERIOD)).counts).toEqual({});
    // A purged subject must not be left with something to wake it: the cleanup
    // alarm goes with the storage it was arming a sweep of.
    expect(await storage?.getAlarm()).toBeNull();
  });

  it("clamps the sweep's re-arm to the horizon, as the reserve path does", async () => {
    // The sweep re-arms from a period read out of storage, so a record written
    // far enough ahead — an older shape of this class, a corrected clock, a bad
    // caller — would arm an alarm the same distance out. `armCleanup` only ever
    // raises, so that alarm could never be talked back down and the object's
    // storage would be stranded behind it.
    const { stub, instances, storages } = meter();
    const distant = "2199-12";

    await stub.reserve("llm_tokens_month", 100, 1000, distant, NOW);
    const instance = instances.get("user:usr_1");
    const storage = storages.get("user:usr_1");
    if (!instance || !storage) throw new Error("instance not created");

    await instance.alarm();

    // Still held — the period has not closed, so there is nothing to erase.
    expect(await storage.get("period")).toBeDefined();
    const alarm = await storage.getAlarm();
    expect(alarm).not.toBeNull();
    expect(alarm).toBeLessThanOrEqual(Date.now() + 41 * 24 * HOUR_MS);
  });
});

describe("usageMeterName", () => {
  it("puts users and orgs in separate namespaces", () => {
    // The deletion cascade relies on this: purging one org must be unable to
    // name a person's counter, and vice versa. Without the prefix, that would
    // rest on two id generators never colliding.
    expect(usageMeterName("user", "abc")).toBe("user:abc");
    expect(usageMeterName("org", "abc")).toBe("org:abc");
    expect(usageMeterName("user", "abc")).not.toBe(usageMeterName("org", "abc"));
  });

  it("keeps two subjects' counters in different instances", async () => {
    const { namespace, instances } = makeUsageMeters();
    const user = stubFor(namespace, usageMeterName("user", "abc"));
    const org = stubFor(namespace, usageMeterName("org", "abc"));

    await user.reserve("llm_tokens_month", 900, 1000, PERIOD, NOW);
    const orgOutcome = await org.reserve("llm_tokens_month", 900, 1000, PERIOD, NOW);

    expect(orgOutcome).toEqual({ admitted: true, counted: true, count: 900 });
    expect([...instances.keys()].sort()).toEqual(["org:abc", "user:abc"]);
  });
});

describe("UsageMeter concurrency", () => {
  it("holds the allowance when 50 reservations run at once", async () => {
    const { stub } = meter();

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => stub.reserve("llm_tokens_month", 10, 100, PERIOD, NOW)),
    );

    expect(outcomes.filter((o) => o.admitted)).toHaveLength(10);
    // Counts are 10..100 with no repeats — no two admissions read the same value.
    expect(
      outcomes
        .filter((o) => o.admitted)
        .map((o) => o.count)
        .sort((a, b) => a - b),
    ).toEqual(Array.from({ length: 10 }, (_, i) => (i + 1) * 10));
  });

  it("over-admits without the input gate, proving the assertion above is not vacuous", async () => {
    // The same 50 reservations against an UNGATED instance: a read-then-write,
    // which is what a KV counter (or a Worker-side read followed by a DO write)
    // gives you. If this ever stops over-admitting, the harness has stopped
    // modelling concurrency and the test above proves nothing.
    const { stub } = meter({ gated: false });

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => stub.reserve("llm_tokens_month", 10, 100, PERIOD, NOW)),
    );

    expect(outcomes.filter((o) => o.admitted).length).toBeGreaterThan(10);
  });

  it("holds an hourly rate limit under a concurrent burst", async () => {
    const { stub } = meter();

    const outcomes = await Promise.all(
      Array.from({ length: 40 }, () => stub.reserve("evaluations_per_hour", 1, 12, PERIOD, NOW)),
    );

    expect(outcomes.filter((o) => o.admitted)).toHaveLength(12);
  });

  it("over-admits the rate limit without the input gate", async () => {
    const { stub } = meter({ gated: false });

    const outcomes = await Promise.all(
      Array.from({ length: 40 }, () => stub.reserve("evaluations_per_hour", 1, 12, PERIOD, NOW)),
    );

    expect(outcomes.filter((o) => o.admitted).length).toBeGreaterThan(12);
  });

  it("keeps subjects independent, so one busy subject cannot refuse another", async () => {
    const { namespace } = makeUsageMeters();
    const a = stubFor(namespace, usageMeterName("user", "a"));
    const b = stubFor(namespace, usageMeterName("user", "b"));

    const outcomes = await Promise.all([
      ...Array.from({ length: 20 }, () => a.reserve("llm_tokens_month", 10, 100, PERIOD, NOW)),
      ...Array.from({ length: 20 }, () => b.reserve("llm_tokens_month", 10, 100, PERIOD, NOW)),
    ]);

    expect(outcomes.filter((o) => o.admitted)).toHaveLength(20);
  });
});

describe("UsageMeter surface", () => {
  it("exposes no fetch handler", async () => {
    const { instances, stub } = meter();
    await stub.read(PERIOD);
    const instance = instances.get("user:usr_1");

    // Limits are caller-supplied, which is safe only while the class is
    // reachable from Worker code alone. A `fetch` handler would make `limit` an
    // attacker-controlled input.
    expect((instance as unknown as { fetch?: unknown })?.fetch).toBeUndefined();
  });
});
