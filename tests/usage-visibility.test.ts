/**
 * Task 9: usage visibility — the `/settings/usage` read, the 80% banner, and
 * the `stratum_get_usage` MCP tool.
 *
 * The markup is deliberately untested: `vitest.config.ts` includes only `.ts`
 * files in coverage, so a `.tsx` page earns none, and a snapshot of JSX proves
 * nothing the type checker has not already. What is tested is
 * everything the page and the tool BOTH depend on being right — whose rows are
 * summed, which `source` is counted, and how an unlimited limit reads — plus
 * the tool end to end through the real Worker, because "scoped to the caller"
 * is a claim about authorization and not about a data structure.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadUsageBanner } from "../src/billing/usage-banner";
import { noticeUsageThresholds } from "../src/billing/usage-notifications";
import { buildUsageReport } from "../src/billing/usage-report";
import app from "../src/index";
import type { StratumClient } from "../src/mcp/client";
import { buildTools } from "../src/mcp/tools";
import { upsertUsage, usagePeriod } from "../src/storage/usage";
import type { Env } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1 } from "./helpers/sqlite-d1";
import { makeUsageMeters } from "./helpers/usage-meter";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const ORIGIN = "https://stratum.test";
const USER_TOKEN = "stratum_user_11111111111111111111111111111111";
const PERIOD = "2026-09";
const AT = new Date("2026-09-15T00:00:00.000Z");

let db: D1Database;
let kv: ReturnType<typeof makeFakeKV>;

/** A self-hosted instance: no billing service, so nothing is metered. */
function selfHosted(): Env {
  return { DB: db, STATE: kv } as unknown as Env;
}

/** A cloud instance with the billing seam configured, and no usage meter bound. */
function cloud(): Env {
  return {
    DB: db,
    STATE: kv,
    BILLING_SERVICE_URL: "https://billing.test",
    BILLING_SERVICE_SECRET: "s3cret",
  } as unknown as Env;
}

/** A cloud instance with the enforcement counters the checks actually read. */
function metered(): { env: Env; meters: ReturnType<typeof makeUsageMeters> } {
  const meters = makeUsageMeters();
  return { env: { ...cloud(), USAGE_METER: meters.namespace } as unknown as Env, meters };
}

/**
 * Seed the entitlements cache directly. `forOwner` is a cached read that never
 * fetches, so this is the only way a limit reaches a reader — and it is exactly
 * how one reaches it in production, where `warmEntitlements` writes the entry.
 */
async function cacheLimits(ownerId: string, meters: Record<string, number>): Promise<void> {
  await kv.put(
    `entitlements:v2:user:${ownerId}`,
    JSON.stringify({
      plan: "free",
      pooled: false,
      meters: { llm_tokens_month: -1, sandbox_ms_month: -1, deploys_month: -1, ...meters },
      counts: { private_projects: -1 },
      rates: { requests_per_minute: 1000, evaluations_per_hour: 60 },
    }),
  );
}

async function record(
  ownerId: string,
  meter: "llm_tokens_month" | "sandbox_ms_month",
  quantity: number,
  source: "platform" | "byok",
  period = PERIOD,
): Promise<void> {
  const result = await upsertUsage(db, logger, { ownerId, ownerType: "user" }, period, [
    { meter, quantity, source },
  ]);
  if (!result.success) throw new Error("usage seed failed");
}

beforeEach(async () => {
  db = makeSqliteD1().db;
  kv = makeFakeKV();
  await db
    .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
    .bind("usr_1", "alice@test", "alice", await hashToken(USER_TOKEN))
    .run();
});

/** How many `usage_periods` totals reads a spied `prepare` saw. */
function totalsReads(prepare: { mock: { calls: unknown[][] } }): number {
  return prepare.mock.calls.filter(
    (call) => typeof call[0] === "string" && call[0].includes("FROM usage_periods"),
  ).length;
}

describe("buildUsageReport", () => {
  it("states an unlimited limit as unlimited rather than as an empty bar", async () => {
    // The self-hoster's whole experience of this page: every limit is -1, and a
    // renderer handed a percentage would draw three empty bars and look broken.
    await record("usr_1", "llm_tokens_month", 4200, "platform");

    const report = await buildUsageReport(selfHosted(), logger, { actorUserId: "usr_1", at: AT });
    if (!report.success) throw report.error;

    expect(report.data.metered).toBe(false);
    expect(report.data.period).toBe(PERIOD);
    expect(report.data.resetsAt).toBe("2026-10-01T00:00:00.000Z");

    const llm = report.data.meters.find((m) => m.meter === "llm_tokens_month");
    expect(llm).toMatchObject({ used: 4200, limit: -1, unlimited: true, blocked: false });
    // Not 0, not 100, not Infinity — there is no fraction of "no limit".
    expect(llm?.percentUsed).toBeNull();
    expect(llm?.remaining).toBeNull();
    // Every meter, so no row on the page can quietly render a bar.
    expect(report.data.meters.every((m) => m.unlimited && m.percentUsed === null)).toBe(true);
    expect(report.data.rates.every((r) => r.unlimited)).toBe(true);
  });

  it("measures consumption against a finite limit", async () => {
    await cacheLimits("usr_1", { llm_tokens_month: 1000 });
    await record("usr_1", "llm_tokens_month", 800, "platform");

    const report = await buildUsageReport(cloud(), logger, { actorUserId: "usr_1", at: AT });
    if (!report.success) throw report.error;

    expect(report.data.metered).toBe(true);
    expect(report.data.plan).toBe("free");
    expect(report.data.meters.find((m) => m.meter === "llm_tokens_month")).toMatchObject({
      used: 800,
      limit: 1000,
      unlimited: false,
      percentUsed: 80,
      remaining: 200,
    });
    expect(report.data.rates.find((r) => r.rate === "evaluations_per_hour")).toMatchObject({
      limit: 60,
      unlimited: false,
    });
  });

  it("reads a hard block of 0 as a block, not as 'unset'", async () => {
    await cacheLimits("usr_1", { deploys_month: 0 });

    const report = await buildUsageReport(cloud(), logger, { actorUserId: "usr_1", at: AT });
    if (!report.success) throw report.error;

    expect(report.data.meters.find((m) => m.meter === "deploys_month")).toMatchObject({
      limit: 0,
      blocked: true,
      unlimited: false,
      percentUsed: null,
      remaining: null,
    });
  });

  it("does not count BYOK spend as hosted consumption", async () => {
    // Goal 5: a project paying its own provider bill must not see that spend
    // eat an allowance it never touched. Migration 049 keys `source` into the
    // primary key precisely so this sum can exclude it.
    await cacheLimits("usr_1", { llm_tokens_month: 1000 });
    await record("usr_1", "llm_tokens_month", 100, "platform");
    await record("usr_1", "llm_tokens_month", 50_000, "byok");

    const report = await buildUsageReport(cloud(), logger, {
      actorUserId: "usr_1",
      at: AT,
      includeByok: true,
    });
    if (!report.success) throw report.error;

    const llm = report.data.meters.find((m) => m.meter === "llm_tokens_month");
    expect(llm?.used).toBe(100);
    expect(llm?.percentUsed).toBe(10);
    expect(llm?.remaining).toBe(900);
    // Reported, clearly apart, and never folded into `used`.
    expect(llm?.byok).toBe(50_000);
  });

  it("omits the BYOK read entirely when the caller did not ask for it", async () => {
    await record("usr_1", "llm_tokens_month", 7, "byok");
    // `byok: 0` alone would pass just as well if the read were issued and its
    // result discarded, which is the opposite of what the flag is for. So the
    // assertion is on the STATEMENT: one totals read, not two.
    const prepare = vi.spyOn(db, "prepare");

    const report = await buildUsageReport(cloud(), logger, { actorUserId: "usr_1", at: AT });
    if (!report.success) throw report.error;
    expect(report.data.meters.find((m) => m.meter === "llm_tokens_month")).toMatchObject({
      used: 0,
      byok: 0,
    });
    expect(totalsReads(prepare)).toBe(1);
    prepare.mockRestore();
  });

  it("issues exactly one more read when the caller does ask for BYOK", async () => {
    await record("usr_1", "llm_tokens_month", 7, "byok");
    const prepare = vi.spyOn(db, "prepare");

    const report = await buildUsageReport(cloud(), logger, {
      actorUserId: "usr_1",
      at: AT,
      includeByok: true,
    });
    if (!report.success) throw report.error;
    expect(report.data.meters.find((m) => m.meter === "llm_tokens_month")?.byok).toBe(7);
    expect(totalsReads(prepare)).toBe(2);
    prepare.mockRestore();
  });

  it("reads the actor's own rows and nobody else's", async () => {
    await record("usr_1", "llm_tokens_month", 11, "platform");
    await record("usr_2", "llm_tokens_month", 9_999, "platform");

    const report = await buildUsageReport(cloud(), logger, { actorUserId: "usr_1", at: AT });
    if (!report.success) throw report.error;
    expect(report.data.subject).toEqual({ ownerId: "usr_1", ownerType: "user" });
    expect(report.data.meters.find((m) => m.meter === "llm_tokens_month")?.used).toBe(11);
  });

  it("refuses to report usage for nobody", async () => {
    const report = await buildUsageReport(cloud(), logger, { actorUserId: "", at: AT });
    expect(report.success).toBe(false);
  });
});

describe("what `used` is, when the ledger and the counter disagree", () => {
  // The bug this closes: for a project in an org namespace the LEDGER records
  // the org while the CHECK charges the actor's counter, so a user working only
  // in org namespaces was shown "0 of 10,000" by a page summing D1 alone —
  // while the counter refusing them was full.
  it("reports the live counter, which is the number a limit is compared against", async () => {
    await cacheLimits("usr_1", { llm_tokens_month: 10_000 });
    const { env, meters } = metered();
    const stub = meters.namespace.get(meters.namespace.idFromName("user:usr_1"));
    await stub.reserve("llm_tokens_month", 8_000, 10_000, PERIOD, AT.getTime());
    // Not one usage_periods row for this user: the spend was recorded against
    // the org that owns the project.
    await record("org_acme", "llm_tokens_month", 8_000, "platform");

    const report = await buildUsageReport(env, logger, { actorUserId: "usr_1", at: AT });
    if (!report.success) throw report.error;

    expect(report.data.usedSource).toBe("meter");
    expect(report.data.meters.find((m) => m.meter === "llm_tokens_month")).toMatchObject({
      used: 8_000,
      remaining: 2_000,
      percentUsed: 80,
    });
  });

  it("floors the counter with the ledger, exactly as a check does", async () => {
    // `reconcileFloor` raises the counter to the D1 sum before a limit check, so
    // a ledger ahead of a cold counter is what the next check will see.
    await cacheLimits("usr_1", { llm_tokens_month: 10_000 });
    await record("usr_1", "llm_tokens_month", 4_200, "platform");
    const { env } = metered();

    const report = await buildUsageReport(env, logger, { actorUserId: "usr_1", at: AT });
    if (!report.success) throw report.error;
    expect(report.data.meters.find((m) => m.meter === "llm_tokens_month")?.used).toBe(4_200);
  });

  it("says it is reporting the ledger when there are no counters to read", async () => {
    // Every self-hoster, and any instance whose meter binding is missing: the
    // figure is still real, it just means something narrower, and the page and
    // the tool say which they are showing rather than implying the other.
    await record("usr_1", "llm_tokens_month", 4_200, "platform");

    const report = await buildUsageReport(selfHosted(), logger, { actorUserId: "usr_1", at: AT });
    if (!report.success) throw report.error;
    expect(report.data.usedSource).toBe("ledger");
    expect(report.data.meters.find((m) => m.meter === "llm_tokens_month")?.used).toBe(4_200);
  });
});

describe("the 80% banner", () => {
  /** Drive one write's totals through the notification path and settle its work. */
  async function notice(quantity: number, added: number): Promise<void> {
    const pending: Array<Promise<unknown>> = [];
    noticeUsageThresholds(cloud(), logger, {
      recorded: { ownerId: "usr_1", ownerType: "user" },
      actorUserId: "usr_1",
      period: PERIOD,
      totals: [{ meter: "llm_tokens_month", source: "platform", quantity, added }],
      waitUntil: (promise) => pending.push(promise),
    });
    await Promise.all(pending);
  }

  beforeEach(async () => {
    await cacheLimits("usr_1", { llm_tokens_month: 1000 });
  });

  it("appears on the crossing at 80%", async () => {
    await notice(800, 800);

    const banner = await loadUsageBanner(cloud(), logger, "usr_1", PERIOD);
    expect(banner).toMatchObject({
      meter: "llm_tokens_month",
      used: 800,
      limit: 1000,
      percent: 80,
      period: PERIOD,
    });
  });

  it("does not appear below 80%", async () => {
    await notice(799, 799);
    expect(await loadUsageBanner(cloud(), logger, "usr_1", PERIOD)).toBeNull();
  });

  it("retries a later write when the first delivery failed", async () => {
    // The regression this replaced: the gate was the CROSSING
    // (`before < threshold && quantity >= threshold`), which fires once per
    // period. That is right only while the send succeeds — a failed delivery
    // left the receipt unwritten to be retried, but every later write already
    // had `before >= threshold` and was skipped before the receipt was read, so
    // the notice was lost for the period anyway. The receipt is the
    // once-per-period guard; this gate only asks whether the subject is over.
    const env = cloud();
    let attempts = 0;
    const failingOnce = {
      send: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("mail provider unavailable");
      },
    } as unknown as Env["EMAIL"];

    const drive = async (quantity: number, added: number) => {
      const pending: Array<Promise<unknown>> = [];
      // `send` returns early without EMAIL_FROM_ADDRESS, so the stub would
      // never be reached and the test would pass on a delivery that never
      // happened — which is how the first version of it measured nothing.
      noticeUsageThresholds(
        { ...env, EMAIL: failingOnce, EMAIL_FROM_ADDRESS: "noreply@stratum.test" } as Env,
        logger,
        {
          recorded: { ownerId: "usr_1", ownerType: "user" },
          actorUserId: "usr_1",
          period: PERIOD,
          totals: [{ meter: "llm_tokens_month", source: "platform", quantity, added }],
          waitUntil: (promise) => pending.push(promise),
        },
      );
      await Promise.all(pending);
    };

    await drive(800, 800); // crosses; the send throws and writes no receipt
    await drive(850, 50); // already over the line — this is the write that used to be skipped

    expect(attempts).toBe(2);
  });

  it("does not appear for a month it was not about", async () => {
    // The period is in the key, so a new month reads as "no banner" with
    // nothing sweeping the old one.
    await notice(900, 900);
    expect(await loadUsageBanner(cloud(), logger, "usr_1", "2026-10")).toBeNull();
  });

  it("keeps a second meter's crossing instead of overwriting the first", async () => {
    // One slot per (user, period) meant the deploy warning silently replaced
    // the token warning, and the reader was told about one of the two.
    await cacheLimits("usr_1", { llm_tokens_month: 1000, deploys_month: 10 });
    const pending: Array<Promise<unknown>> = [];
    noticeUsageThresholds(cloud(), logger, {
      recorded: { ownerId: "usr_1", ownerType: "user" },
      actorUserId: "usr_1",
      period: PERIOD,
      totals: [
        { meter: "llm_tokens_month", source: "platform", quantity: 800, added: 800 },
        { meter: "deploys_month", source: "platform", quantity: 9, added: 9 },
      ],
      waitUntil: (promise) => pending.push(promise),
    });
    await Promise.all(pending);

    // Both are stored; the one nearest its limit is the one worth the banner.
    const stored = JSON.parse(kv.store.get(`usage-banner:v2:usr_1:${PERIOD}`) ?? "{}") as {
      notices: Array<{ meter: string }>;
    };
    expect(stored.notices.map((n) => n.meter).sort()).toEqual([
      "deploys_month",
      "llm_tokens_month",
    ]);
    expect((await loadUsageBanner(cloud(), logger, "usr_1", PERIOD))?.meter).toBe("deploys_month");
  });

  it("does not promise a refusal while the account is only being measured", async () => {
    await notice(800, 800);

    const observing = await loadUsageBanner(cloud(), logger, "usr_1", PERIOD);
    const binding = await loadUsageBanner(
      { ...cloud(), ENTITLEMENTS_ENFORCE: "1" } as Env,
      logger,
      "usr_1",
      PERIOD,
    );

    // The banner's last sentence turns on this, and the copy it was written for
    // is the mode where nothing is refused at all.
    expect(observing?.enforcing).toBe(false);
    expect(binding?.enforcing).toBe(true);
  });

  it("is never shown on a self-hosted instance, and costs no read there", async () => {
    await notice(900, 900);
    const env = selfHosted();
    const get = vi.spyOn(kv, "get");
    expect(await loadUsageBanner(env, logger, "usr_1", PERIOD)).toBeNull();
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
  });

  it("costs no read at all for a signed-out visitor", async () => {
    const get = vi.spyOn(kv, "get");
    expect(await loadUsageBanner(cloud(), logger, undefined, PERIOD)).toBeNull();
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
  });
});

describe("stratum_get_usage", () => {
  it("is a read-only tool that says so, and has no billing-mutating sibling", async () => {
    const tools = buildTools({} as StratumClient);
    const usage = tools.find((t) => t.name === "stratum_get_usage");

    expect(usage).toBeDefined();
    // No arguments: it reports on the caller, so there is nothing to pass and
    // nothing to point at somebody else.
    expect(Object.keys(usage?.schema ?? {})).toHaveLength(0);
    expect(usage?.description).toContain("Read-only");
    expect(usage?.description).toMatch(/cannot raise a limit|nothing here can raise a limit/i);

    // PRD §4c: an agent that can raise its own limit does not have one.
    for (const forbidden of [
      "stratum_upgrade_plan",
      "stratum_buy_topup",
      "stratum_set_provider_key",
    ]) {
      expect(tools.map((t) => t.name)).not.toContain(forbidden);
    }
  });

  it("returns the caller's own meters, limits, period and reset over MCP", async () => {
    // End to end through the real Worker: "scoped to the caller" is a claim
    // about authorization, and a fake client would prove nothing about it.
    // The tool reports the CURRENT period, which is whatever month the suite
    // runs in — seeding a fixed one would pass in September and fail in October.
    const now = usagePeriod();
    await record("usr_1", "llm_tokens_month", 321, "platform", now);
    await record("usr_2", "llm_tokens_month", 9_999, "platform", now);

    const env = { DB: db, STATE: undefined, ARTIFACTS: undefined } as unknown as Env;
    const response = await app.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${USER_TOKEN}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "stratum_get_usage", arguments: {} },
        }),
      }),
      env,
    );

    const reply = (await response.json()) as {
      result?: { content?: Array<{ text: string }>; isError?: boolean };
    };
    expect(reply.result?.isError).toBeUndefined();
    const body = JSON.parse(reply.result?.content?.[0]?.text ?? "{}") as {
      subject: { ownerId: string };
      period: string;
      resetsAt: string;
      meters: Array<{ meter: string; used: number; unlimited: boolean }>;
      rates: Array<{ rate: string }>;
    };

    expect(body.subject.ownerId).toBe("usr_1");
    expect(body.period).toBe(now);
    expect(Date.parse(body.resetsAt)).not.toBeNaN();
    expect(body.meters.map((m) => m.meter)).toEqual([
      "llm_tokens_month",
      "sandbox_ms_month",
      "deploys_month",
    ]);
    expect(body.rates.map((r) => r.rate)).toEqual(["requests_per_minute", "evaluations_per_hour"]);
    // usr_2's 9,999 belongs to usr_2. Only a row keyed on the caller may show up.
    expect(body.meters.find((m) => m.meter === "llm_tokens_month")?.used).toBe(321);
    expect(body.meters.every((m) => m.used !== 9_999)).toBe(true);
  });
});
