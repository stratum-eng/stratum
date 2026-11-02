/**
 * Enforcement: the decision layer that turns an entitlement into an answer.
 *
 * Four claims carry this suite, and each of them is the kind that decays
 * silently if nothing asserts it:
 *
 * - **Inert by default.** With `BILLING_SERVICE_URL` unset nothing is fetched,
 *   the `USAGE_METER` binding is never touched, and no refusal can be produced.
 * - **A refusal is a FAILING gate, never an absent one.** An exhausted allowance
 *   that skipped the LLM evaluator would stop a policy requiring AI review from
 *   requiring it, exactly when someone ran out of credit.
 * - **Observe-only admits while recording.** Everything ships evaluating and
 *   logging decisions that bind only under `ENTITLEMENTS_ENFORCE=1`.
 * - **The subject is the actor** (PRD §4a), an org pools only when positively
 *   known to be paid, and every usage read for a check is `source = 'platform'`.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkGauge,
  checkMeter,
  resolveEnforcementSubject,
  settleMeter,
} from "../src/billing/enforcement";
import { type Entitlements, UNLIMITED, UnlimitedEntitlements } from "../src/billing/entitlements";
import {
  MAX_GAUGE_CHARGES,
  SINGLE_CREATION_HOLD_TTL_MS,
  checkPrivateProjectGauge,
  releaseWhenSettled,
} from "../src/billing/private-project-gauge";
import { runDeployMessage } from "../src/deploy/runner";
import { LLMEvaluator } from "../src/evaluation/llm-evaluator";
import type { LlmProvider } from "../src/evaluation/llm-provider";
import type { EvalPolicy, EvaluationContext } from "../src/evaluation/types";
import { rateLimitMiddleware } from "../src/middleware/rate-limit";
import { GAUGE_HOLD_TTL_MS, UsageMeter } from "../src/queue/usage-meter";
import { bulkImportRouter } from "../src/routes/bulk-import";
import { projectsRouter } from "../src/routes/projects";
import { recordCosts } from "../src/storage/costs";
import { insertDeployment } from "../src/storage/deployments";
import { GAUGE_CHARGE_GRACE_MS, recordGaugeCharge } from "../src/storage/gauge-index";
import { getProjectByPath, setProject } from "../src/storage/state";
import { getOwnerMeterTotals, upsertUsage } from "../src/storage/usage";
import type { Env, ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { ok } from "../src/utils/result";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1 } from "./helpers/sqlite-d1";
import { makeUsageMeters } from "./helpers/usage-meter";

// Only the initial push is stubbed, so a private creation that passes the gauge
// can complete; everything else in git-ops stays real.
vi.mock("../src/storage/git-ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage/git-ops")>()),
  initAndPush: vi.fn(async () => ({ success: true, data: "sha_init" })),
}));

const PERIOD = "2026-09";
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);

const logged: Array<{ message: string; meta?: Record<string, unknown> }> = [];
const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn((message: string, meta?: Record<string, unknown>) => {
    logged.push({ message, ...(meta ? { meta } : {}) });
  }),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

type Meters = ReturnType<typeof makeUsageMeters>;
type FakeKV = ReturnType<typeof makeFakeKV>;

let db: D1Database;
let raw: ReturnType<typeof makeSqliteD1>["raw"];
let kv: FakeKV;
let meters: Meters;
let scheduled: Array<Promise<unknown>>;

/** Unique per test, so the module-level "already reconciled" memo cannot leak. */
let seq = 0;
function nextUserId(): string {
  seq += 1;
  return `usr_${seq}_${Math.random().toString(36).slice(2, 8)}`;
}

beforeEach(() => {
  const made = makeSqliteD1();
  db = made.db;
  raw = made.raw;
  kv = makeFakeKV();
  meters = makeUsageMeters();
  scheduled = [];
  logged.length = 0;
  vi.clearAllMocks();
  // Paths through LLMEvaluator read the wall clock for the period; pin it to
  // NOW so assertions against PERIOD don't rot when the calendar moves on.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    STATE: kv,
    USAGE_METER: meters.namespace,
    BILLING_SERVICE_URL: "https://billing.test",
    BILLING_SERVICE_SECRET: "shh",
    ...overrides,
  } as unknown as Env;
}

/** An env with the billing service unconfigured — every self-hoster. */
function selfHostedEnv(overrides: Partial<Env> = {}): Env {
  return makeEnv({
    BILLING_SERVICE_URL: undefined,
    BILLING_SERVICE_SECRET: undefined,
    ...overrides,
  });
}

/** A plan with one monthly token allowance and everything else unlimited. */
function tokenPlan(limit: number): Entitlements {
  return plan({ meters: { ...UnlimitedEntitlements.meters, llm_tokens_month: limit } });
}

/** The plan a subject that has spent its whole monthly token allowance is on. */
function exhaustedTokens(): Entitlements {
  return tokenPlan(0);
}

function plan(overrides: Partial<Entitlements> = {}): Entitlements {
  return {
    ...UnlimitedEntitlements,
    plan: "free",
    meters: { ...UnlimitedEntitlements.meters },
    counts: { ...UnlimitedEntitlements.counts },
    rates: { ...UnlimitedEntitlements.rates },
    ...overrides,
  };
}

/** Seed the entitlements cache the way a warm would, so `forOwner` hits. */
function cachePlan(ownerType: "user" | "org", ownerId: string, entitlements: Entitlements): void {
  kv.store.set(`entitlements:v2:${ownerType}:${ownerId}`, JSON.stringify(entitlements));
}

function createUser(id: string): string {
  raw
    .prepare("INSERT INTO users (id, email, token_hash) VALUES (?, ?, ?)")
    .run(id, `${id}@example.test`, `hash-${id}`);
  return id;
}

function llmProvider(text = JSON.stringify({ score: 1, passed: true, reason: "fine" })) {
  return {
    run: vi.fn(async () => ok({ text, usage: { inputTokens: 100, outputTokens: 20 } })),
  } as unknown as LlmProvider & { run: ReturnType<typeof vi.fn> };
}

const POLICY: EvalPolicy = { evaluators: [{ type: "llm" }] };

function billingContext(ownerId: string, actorUserId?: string): EvaluationContext {
  return {
    billing: {
      ownerId,
      ownerType: "user",
      projectId: "prj_1",
      ...(actorUserId ? { actorUserId } : {}),
    },
  };
}

describe("inert with BILLING_SERVICE_URL unset (PRD Goal 3)", () => {
  it("never touches the meter binding from the LLM gate", async () => {
    const userId = nextUserId();
    // A plan that would refuse everything, cached — proving the short-circuit is
    // the missing service and not the absence of a limit.
    cachePlan("user", userId, exhaustedTokens());
    const provider = llmProvider();

    const result = await new LLMEvaluator(provider, "platform", {
      env: selfHostedEnv(),
    }).evaluate("diff", POLICY, logger, billingContext(userId, userId));

    expect(result.success && result.data.passed).toBe(true);
    expect(provider.run).toHaveBeenCalledTimes(1);
    expect(meters.calls).toEqual([]);
  });

  it("issues no request of any kind: the billing service is never called", async () => {
    // `entitlementsEnabled` is the first line of every entry point, and the
    // claim it protects is not "no refusal" but "no dependency": a self-hoster's
    // merge path must not acquire a network call to a service they do not run.
    const userId = nextUserId();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = llmProvider();

    await new LLMEvaluator(provider, "platform", { env: selfHostedEnv() }).evaluate(
      "diff",
      POLICY,
      logger,
      billingContext(userId, userId),
    );
    await checkGauge(selfHostedEnv(), logger, {
      subject: { ownerId: userId, ownerType: "user", pooled: false },
      count: "private_projects",
      current: 99,
      what: "Creating another private project",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("never touches the meter binding from a direct check", async () => {
    const decision = await checkMeter(selfHostedEnv(), logger, {
      subject: { ownerId: nextUserId(), ownerType: "user", pooled: false },
      meter: "llm_tokens_month",
      estimate: 10_000,
      nowMs: NOW,
      period: PERIOD,
      what: "AI review",
    });

    expect(decision).toMatchObject({ admitted: true, refused: false, checked: false });
    expect(meters.calls).toEqual([]);
  });
});

describe("the enforcement subject (PRD §4a)", () => {
  it("charges the acting user, not the org the project is recorded against", async () => {
    const actor = nextUserId();
    const subject = await resolveEnforcementSubject(makeEnv(), logger, {
      actorUserId: actor,
      owner: { ownerId: "org_1", ownerType: "org" },
    });

    expect(subject).toEqual({ ownerId: actor, ownerType: "user", pooled: false });
  });

  it("treats an UNCACHED org plan as free and charges the actor", async () => {
    const actor = nextUserId();
    // Nothing cached for the org: the first check for any org is always a miss,
    // because nothing warms org entitlements before this point. Reading that as
    // "the org is its own subject" is the hole this direction closes.
    const subject = await resolveEnforcementSubject(makeEnv(), logger, {
      actorUserId: actor,
      owner: { ownerId: "org_cold", ownerType: "org" },
      waitUntil: (promise) => scheduled.push(promise),
    });

    expect(subject?.ownerId).toBe(actor);
    // ...and the warm was scheduled, so a paid org can pool from next time.
    expect(scheduled.length).toBeGreaterThan(0);
    await Promise.allSettled(scheduled);
  });

  it("treats a cached org plan that does not pool as free", async () => {
    const actor = nextUserId();
    cachePlan("org", "org_solo", plan({ pooled: false }));

    const subject = await resolveEnforcementSubject(makeEnv(), logger, {
      actorUserId: actor,
      owner: { ownerId: "org_solo", ownerType: "org" },
    });

    expect(subject?.ownerId).toBe(actor);
  });

  it("pools onto an org that is positively known to pool", async () => {
    cachePlan("org", "org_paid", plan({ plan: "team", pooled: true }));

    const subject = await resolveEnforcementSubject(makeEnv(), logger, {
      actorUserId: nextUserId(),
      owner: { ownerId: "org_paid", ownerType: "org" },
    });

    expect(subject).toEqual({ ownerId: "org_paid", ownerType: "org", pooled: true });
  });

  it("walks an agent to its owning user when no actor is named", async () => {
    const owner = createUser(nextUserId());
    raw
      .prepare("INSERT INTO agents (id, name, owner_id, token_hash) VALUES (?, ?, ?, ?)")
      .run("agt_1", "bot", owner, "hash");

    const subject = await resolveEnforcementSubject(makeEnv(), logger, {
      owner: { ownerId: "agt_1", ownerType: "agent" },
    });

    expect(subject).toEqual({ ownerId: owner, ownerType: "user", pooled: false });
  });

  it("names nobody when there is neither an actor nor a resolvable owner", async () => {
    expect(await resolveEnforcementSubject(makeEnv(), logger, {})).toBeNull();
  });

  it("reports the check unavailable for an org with no actor, not a new subject", async () => {
    // The §4a hole in its exact shape: no actor (a queue consumer), an
    // org-owned project, and nothing cached about the org's plan. Reading the
    // recorded owner as the subject here would give the org a counter of its
    // own AND a permanent cache miss resolving to unlimited — a fresh,
    // permanently unlimited allowance for every org anyone cares to create.
    const subject = await resolveEnforcementSubject(makeEnv(), logger, {
      owner: { ownerId: "org_no_actor", ownerType: "org" },
    });

    expect(subject).toBeNull();
  });

  it("still pools onto a PAID org with no actor, because that signal is positive", async () => {
    cachePlan("org", "org_paid_queue", plan({ plan: "team", pooled: true }));

    const subject = await resolveEnforcementSubject(makeEnv(), logger, {
      owner: { ownerId: "org_paid_queue", ownerType: "org" },
    });

    expect(subject).toEqual({ ownerId: "org_paid_queue", ownerType: "org", pooled: true });
  });

  it("costs no D1 walk at all when the billing service is unconfigured", async () => {
    // The agent walk is a D1 read on the deploy path, and with the seam off it
    // feeds a check that cannot refuse anything. A self-hoster does not pay it.
    const prepare = vi.spyOn(db, "prepare");
    const subject = await resolveEnforcementSubject(selfHostedEnv(), logger, {
      owner: { ownerId: "agt_1", ownerType: "agent" },
    });

    expect(subject).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
  });
});

describe("reserve and settle", () => {
  it("reserves the whole bound and settles the difference back", async () => {
    const userId = nextUserId();
    const subject = { ownerId: userId, ownerType: "user" as const, pooled: false };
    cachePlan("user", userId, tokenPlan(10_000));

    const decision = await checkMeter(makeEnv(), logger, {
      subject,
      meter: "llm_tokens_month",
      estimate: 7_000,
      nowMs: NOW,
      period: PERIOD,
      what: "AI review",
    });
    expect(decision).toMatchObject({ admitted: true, reserved: true, count: 7_000 });

    await settleMeter(makeEnv(), logger, {
      subject,
      meter: "llm_tokens_month",
      delta: 900 - 7_000,
      nowMs: NOW,
      period: PERIOD,
    });

    const stub = meters.namespace.get(meters.namespace.idFromName(`user:${userId}`));
    expect((await stub.read(PERIOD)).counts.llm_tokens_month).toBe(900);
  });

  it("settles in a finally, so a thrown provider call cannot leak the reservation", async () => {
    const userId = nextUserId();
    cachePlan("user", userId, tokenPlan(100_000));
    const provider = {
      run: vi.fn(async () => {
        throw new Error("connection reset");
      }),
    } as unknown as LlmProvider;

    const result = await new LLMEvaluator(provider, "platform", { env: makeEnv() }).evaluate(
      "diff",
      POLICY,
      logger,
      billingContext(userId, userId),
    );

    expect(result.success).toBe(false);
    const stub = meters.namespace.get(meters.namespace.idFromName(`user:${userId}`));
    // The whole reservation came back: nothing was spent, so nothing is charged.
    expect((await stub.read(PERIOD)).counts.llm_tokens_month).toBe(0);
  });
});

describe("observe-only keeps measuring past the limit", () => {
  it("counts a refused reservation, so the overage is measurable", async () => {
    const userId = nextUserId();
    const subject = { ownerId: userId, ownerType: "user" as const, pooled: false };
    cachePlan("user", userId, tokenPlan(1_000));
    const env = makeEnv();
    const spend = async (estimate: number) =>
      await checkMeter(env, logger, {
        subject,
        meter: "llm_tokens_month",
        estimate,
        nowMs: NOW,
        period: PERIOD,
        what: "AI review",
      });

    const under = await spend(900);
    const over = await spend(900);
    const further = await spend(900);

    // Every one of them ran: nothing binds. What must not happen is the counter
    // stopping at the limit — the month of measurement exists to answer "by how
    // much would this account have been blocked", and a frozen counter cannot.
    expect([under.admitted, over.admitted, further.admitted]).toEqual([true, true, true]);
    expect([under.refused, over.refused, further.refused]).toEqual([false, true, true]);
    expect(further.count).toBe(2_700);
    const stub = meters.namespace.get(meters.namespace.idFromName(`user:${userId}`));
    expect((await stub.read(PERIOD)).counts.llm_tokens_month).toBe(2_700);
  });

  it("reports a refusal it counted as reserved, so the true cost is still settled", async () => {
    const userId = nextUserId();
    const subject = { ownerId: userId, ownerType: "user" as const, pooled: false };
    cachePlan("user", userId, tokenPlan(0));

    const decision = await checkMeter(makeEnv(), logger, {
      subject,
      meter: "llm_tokens_month",
      estimate: 4_000,
      nowMs: NOW,
      period: PERIOD,
      what: "AI review",
    });
    // Refused, admitted, and RESERVED: without the last one `tokensReserved`
    // stays null and the 3,100 unused tokens of that estimate are never handed
    // back, so the counter drifts to the reservation instead of the spend.
    expect(decision).toMatchObject({ admitted: true, refused: true, reserved: true });

    await settleMeter(makeEnv(), logger, {
      subject,
      meter: "llm_tokens_month",
      delta: 900 - 4_000,
      nowMs: NOW,
      period: PERIOD,
    });
    const stub = meters.namespace.get(meters.namespace.idFromName(`user:${userId}`));
    expect((await stub.read(PERIOD)).counts.llm_tokens_month).toBe(900);
  });

  it("counts nothing it refuses once enforcement binds", async () => {
    const userId = nextUserId();
    const subject = { ownerId: userId, ownerType: "user" as const, pooled: false };
    cachePlan("user", userId, tokenPlan(1_000));

    const env = makeEnv({ ENTITLEMENTS_ENFORCE: "1" } as Partial<Env>);
    const decision = await checkMeter(env, logger, {
      subject,
      meter: "llm_tokens_month",
      estimate: 4_000,
      nowMs: NOW,
      period: PERIOD,
      what: "AI review",
    });

    expect(decision).toMatchObject({ admitted: false, refused: true, reserved: false });
    const stub = meters.namespace.get(meters.namespace.idFromName(`user:${userId}`));
    expect((await stub.read(PERIOD)).counts.llm_tokens_month).toBeUndefined();
  });
});

describe("an unreachable meter is not a merge outage", () => {
  it("still returns the evaluator's verdict when the meter RPC throws", async () => {
    const userId = nextUserId();
    cachePlan("user", userId, tokenPlan(100_000));
    const provider = llmProvider();
    // The failure the meter's malformed-input deviation exists to prevent,
    // arriving through the settle instead: an unreachable Durable Object in a
    // `finally` would replace the Result with a rejection, reject the
    // `Promise.all` in `runEvaluation`, and fail change creation outright.
    const exploding = {
      idFromName: meters.namespace.idFromName.bind(meters.namespace),
      get: (id: unknown) => {
        const stub = meters.namespace.get(id as never);
        return {
          ...stub,
          reserve: stub.reserve.bind(stub),
          read: stub.read.bind(stub),
          setFloor: stub.setFloor.bind(stub),
          settle: async () => {
            throw new Error("durable object unreachable");
          },
        };
      },
    } as unknown as Env["USAGE_METER"];

    const result = await new LLMEvaluator(provider, "platform", {
      env: makeEnv({ USAGE_METER: exploding } as Partial<Env>),
    }).evaluate("diff", POLICY, logger, billingContext(userId, userId));

    expect(result.success && result.data.passed).toBe(true);
    expect(provider.run).toHaveBeenCalledTimes(1);
  });

  it("still runs the gate when the RESERVE RPC throws, under enforcement", async () => {
    const userId = nextUserId();
    cachePlan("user", userId, tokenPlan(100_000));
    const provider = llmProvider();
    // The symmetric case, and the worse one: `checkMeter` awaits `reserve`
    // BEFORE the provider call and with `ENTITLEMENTS_ENFORCE=1` on, so an
    // unreachable object here would turn a billing outage into a refused merge
    // for a customer who is paying. Entitlements fail OPEN; that is the rule
    // this pins.
    const exploding = {
      idFromName: meters.namespace.idFromName.bind(meters.namespace),
      get: (id: unknown) => {
        const stub = meters.namespace.get(id as never);
        return {
          ...stub,
          read: stub.read.bind(stub),
          setFloor: stub.setFloor.bind(stub),
          settle: stub.settle.bind(stub),
          reserve: async () => {
            throw new Error("durable object unreachable");
          },
        };
      },
    } as unknown as Env["USAGE_METER"];

    const result = await new LLMEvaluator(provider, "platform", {
      env: makeEnv({ USAGE_METER: exploding, ENTITLEMENTS_ENFORCE: "1" } as Partial<Env>),
    }).evaluate("diff", POLICY, logger, billingContext(userId, userId));

    expect(result.success && result.data.passed).toBe(true);
    expect(provider.run).toHaveBeenCalledTimes(1);
  });
});

describe("the LLM gate under an exhausted allowance", () => {
  it("returns a FAILING gate naming cause and remedies, and never calls the provider", async () => {
    const userId = nextUserId();
    cachePlan("user", userId, exhaustedTokens());
    const provider = llmProvider();

    const result = await new LLMEvaluator(provider, "platform", {
      env: makeEnv({ ENTITLEMENTS_ENFORCE: "1" } as Partial<Env>),
    }).evaluate("diff", POLICY, logger, billingContext(userId, userId));

    expect(result.success).toBe(true);
    if (!result.success) return;
    // A gate that ran and failed — NOT a gate that vanished. The evaluator is
    // still in the set and still reports a verdict.
    expect(result.data.passed).toBe(false);
    expect(result.data.score).toBe(0);
    expect(result.data.reason).toContain("monthly LLM token allowance");
    // Both remedies, per PRD §4c: bring your own key, or raise the plan.
    expect(result.data.reason).toContain("provider:");
    expect(result.data.reason).toContain("plan limits");
    // ...and when it resets.
    expect(result.data.reason).toContain("2026-10-01");
    expect(provider.run).not.toHaveBeenCalled();
  });

  it("admits while recording the decision when enforcement is off", async () => {
    const userId = nextUserId();
    cachePlan("user", userId, exhaustedTokens());
    const provider = llmProvider();

    const result = await new LLMEvaluator(provider, "platform", { env: makeEnv() }).evaluate(
      "diff",
      POLICY,
      logger,
      billingContext(userId, userId),
    );

    expect(result.success && result.data.passed).toBe(true);
    expect(provider.run).toHaveBeenCalledTimes(1);
    // Recorded even though it admitted: a month of observation that logs nothing
    // measures nothing.
    const decision = logged.find(
      (entry) => entry.message === "Entitlement decision" && entry.meta?.refused === true,
    );
    expect(decision?.meta).toMatchObject({ enforcing: false, admitted: true, limit: 0 });
  });

  it("refuses on the hourly evaluation rate even under BYOK (PRD §4b)", async () => {
    const userId = nextUserId();
    cachePlan(
      "user",
      userId,
      plan({ rates: { requests_per_minute: UNLIMITED, evaluations_per_hour: 0 } }),
    );
    const provider = llmProvider();

    const result = await new LLMEvaluator(provider, "byok", {
      env: makeEnv({ ENTITLEMENTS_ENFORCE: "1" } as Partial<Env>),
    }).evaluate("diff", POLICY, logger, billingContext(userId, userId));

    expect(result.success && result.data.passed).toBe(false);
    expect(result.success && result.data.reason).toContain("hourly evaluation allowance");
    // The string says so out loud, because it is the remedy an agent reaches for.
    expect(result.success && result.data.reason).toContain("does NOT lift this one");
    expect(provider.run).not.toHaveBeenCalled();
  });

  it("does not charge a BYOK run against the hosted token allowance", async () => {
    const userId = nextUserId();
    cachePlan("user", userId, exhaustedTokens());
    const provider = llmProvider();

    const result = await new LLMEvaluator(provider, "byok", {
      env: makeEnv({ ENTITLEMENTS_ENFORCE: "1" } as Partial<Env>),
    }).evaluate("diff", POLICY, logger, billingContext(userId, userId));

    // The token allowance is the one thing BYOK lifts: the project is paying.
    expect(result.success && result.data.passed).toBe(true);
    expect(provider.run).toHaveBeenCalledTimes(1);
  });
});

describe("usage reads for a limit check (PRD §4a, Goal 5)", () => {
  it("sums platform rows only, so BYOK spend is not charged to the hosted allowance", async () => {
    const userId = nextUserId();
    const subject = { ownerId: userId, ownerType: "user" as const, pooled: false };
    await upsertUsage(db, logger, subject, PERIOD, [
      { meter: "llm_tokens_month", quantity: 600, source: "platform" },
      { meter: "llm_tokens_month", quantity: 5_000, source: "byok" },
    ]);

    const totals = await getOwnerMeterTotals(db, logger, userId, PERIOD, "platform");
    expect(totals.success && totals.data.llm_tokens_month).toBe(600);

    // And the counter is seeded from that same filtered total, so a project on
    // its own key cannot exhaust the hosted meter.
    cachePlan("user", userId, tokenPlan(10_000));
    const decision = await checkMeter(makeEnv(), logger, {
      subject,
      meter: "llm_tokens_month",
      estimate: 100,
      nowMs: NOW,
      period: PERIOD,
      what: "AI review",
    });
    expect(decision.count).toBe(700);
  });
});

describe("reconciling the counter against the ledger", () => {
  it("retries after a failed read instead of disabling the floor for the isolate", async () => {
    // The memo used to be written BEFORE the read returned, so one D1 blip left
    // that subject's counter unreconciled for the life of the isolate — and the
    // ledger's spend was then free to be spent a second time.
    const userId = nextUserId();
    const subject = { ownerId: userId, ownerType: "user" as const, pooled: false };
    cachePlan("user", userId, tokenPlan(10_000));
    await upsertUsage(db, logger, subject, PERIOD, [
      { meter: "llm_tokens_month", quantity: 600, source: "platform" },
    ]);
    const check = async () =>
      await checkMeter(makeEnv(), logger, {
        subject,
        meter: "llm_tokens_month",
        estimate: 100,
        nowMs: NOW,
        period: PERIOD,
        what: "AI review",
      });

    const prepare = vi.spyOn(db, "prepare").mockImplementationOnce(() => {
      throw new Error("D1 unavailable");
    });
    const blind = await check();
    prepare.mockRestore();
    const reconciled = await check();

    // The first check could not see the ledger; the second one must.
    expect(blind.count).toBe(100);
    expect(reconciled.count).toBe(700);
  });
});

describe("the private project gauge through POST /projects (PRD §4a)", () => {
  const ORG_ID = "org_acme";

  function projectApp(userId: string, username: string, artifacts?: Env["ARTIFACTS"]) {
    const application = new Hono<{ Bindings: Env }>();
    application.use("*", async (c, next) => {
      c.set("userId", userId);
      c.set("username", username);
      await next();
    });
    application.route("/projects", projectsRouter);
    return (body: Record<string, unknown>, as: "json" | "form" = "json") =>
      application.fetch(
        new Request("https://t.test/projects", {
          method: "POST",
          ...(as === "json"
            ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
            : {
                body: new URLSearchParams(
                  Object.entries(body).map(([key, value]): [string, string] => [
                    key,
                    String(value),
                  ]),
                ),
              }),
        }),
        makeEnv({
          ENTITLEMENTS_ENFORCE: "1",
          // Never reached by a refusal; a creation that gets past the gauge
          // fails here instead, which is how "not refused" is asserted.
          ARTIFACTS: artifacts ?? {
            create: async () => {
              throw new Error("artifacts unavailable in this test");
            },
          },
        } as unknown as Partial<Env>),
      );
  }

  async function seedProject(
    namespace: string,
    slug: string,
    owner: { ownerId: string; ownerType: "user" | "org" },
    gaugeSubjectId?: string,
  ): Promise<void> {
    const stored = await setProject(
      kv,
      {
        id: `prj_${namespace}_${slug}`,
        name: slug,
        slug,
        namespace,
        ownerId: owner.ownerId,
        ownerType: owner.ownerType,
        remote: "https://acct.artifacts.cloudflare.net/git/acct/x.git",
        createdAt: "2026-09-01T00:00:00.000Z",
        visibility: "private",
        ...(gaugeSubjectId !== undefined ? { gaugeSubjectId } : {}),
      },
      logger,
    );
    if (!stored.success) throw stored.error;
  }

  function seedOrg(memberId: string): void {
    raw
      .prepare("INSERT INTO orgs (id, name, slug, owner_id) VALUES (?, ?, ?, ?)")
      .run(ORG_ID, "Acme", "acme", memberId);
    raw
      .prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'admin')")
      .run(ORG_ID, memberId);
  }

  it("is not reset by creating the project in an org namespace", async () => {
    // The vector §4a closes, in the surface that still had it: an actor at
    // their limit made a free org and got a count of zero, because the count
    // was taken over the TARGET namespace and the limit over the ACTOR.
    const userId = createUser(nextUserId());
    seedOrg(userId);
    cachePlan("user", userId, plan({ counts: { private_projects: 2 } }));
    await seedProject("@alice", "one", { ownerId: userId, ownerType: "user" });
    await seedProject("@alice", "two", { ownerId: userId, ownerType: "user" });

    const response = await projectApp(
      userId,
      "alice",
    )({
      name: "three",
      visibility: "private",
      org: "acme",
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("plan allows 2");
  });

  /** An org project charged to `actor`, indexed as the creation route does. */
  async function seedChargedOrgProject(slug: string, actor: string, nowMs = NOW): Promise<void> {
    await seedProject("@acme", slug, { ownerId: ORG_ID, ownerType: "org" }, actor);
    const indexed = await recordGaugeCharge(kv, logger, {
      subjectId: actor,
      namespace: "@acme",
      slug,
      projectId: `prj_@acme_${slug}`,
      nowMs,
    });
    if (!indexed.success) throw indexed.error;
  }

  /** Make KV `list` throw for one key prefix, and behave normally otherwise. */
  function failListingsUnder(prefix: string): void {
    const realList = kv.list.bind(kv);
    vi.spyOn(kv, "list").mockImplementation(async (opts) => {
      if (opts?.prefix?.startsWith(prefix)) throw new Error("kv down");
      return realList({ prefix: opts?.prefix ?? undefined });
    });
  }

  it("counts private projects the actor created in an org that does not pool", async () => {
    // The org owns them, but the actor was charged for them: counting by owner
    // alone let an actor create private projects there without limit.
    const userId = createUser(nextUserId());
    seedOrg(userId);
    cachePlan("user", userId, plan({ counts: { private_projects: 2 } }));
    await seedChargedOrgProject("one", userId);
    await seedChargedOrgProject("two", userId);

    const response = await projectApp(
      userId,
      "alice",
    )({
      name: "three",
      visibility: "private",
      org: "acme",
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("plan allows 2");
  });

  it("is not refused, and lists no org, after being added to many orgs by others", async () => {
    // Membership is granted by the org, not the member. A count that walked
    // memberships would let anyone exhaust — or cap out — someone else's limit.
    const userId = createUser(nextUserId());
    const otherId = createUser(nextUserId());
    cachePlan("user", userId, plan({ counts: { private_projects: 2 } }));
    for (let i = 0; i < 150; i++) {
      raw
        .prepare("INSERT INTO orgs (id, name, slug, owner_id) VALUES (?, ?, ?, ?)")
        .run(`org_${i}`, `Org ${i}`, `org-${i}`, otherId);
      raw
        .prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'member')")
        .run(`org_${i}`, userId);
    }
    await seedProject("@org-0", "theirs", { ownerId: "org_0", ownerType: "org" }, otherId);
    const list = vi.spyOn(kv, "list");

    const response = await projectApp(userId, "alice")({ name: "mine", visibility: "private" });

    // Past the gauge: the creation fails later, at the repository.
    expect(response.status).not.toBe(403);
    const prefixes = list.mock.calls.map(([opts]) => opts?.prefix ?? "");
    expect(prefixes.some((p) => p.startsWith("project:@org-"))).toBe(false);
  });

  it("verifies at most the cap and refuses on the floor it reached", async () => {
    const userId = createUser(nextUserId());
    seedOrg(userId);
    cachePlan("user", userId, plan({ counts: { private_projects: 5 } }));
    for (let i = 0; i < MAX_GAUGE_CHARGES + 10; i++) await seedChargedOrgProject(`p${i}`, userId);
    const get = vi.spyOn(kv, "get");

    const response = await projectApp(userId, "alice")({ name: "x", visibility: "private" });

    expect(response.status).toBe(403);
    const projectReads = get.mock.calls.filter(([key]) => String(key).startsWith("project:@acme:"));
    expect(projectReads.length).toBeLessThanOrEqual(MAX_GAUGE_CHARGES);
  });

  it("keeps the personal count under the overflow floor", async () => {
    // Overflow used to report MAX_GAUGE_CHARGES alone, dropping the personal
    // projects already counted; the floor must be personal + cap.
    const userId = createUser(nextUserId());
    seedOrg(userId);
    cachePlan("user", userId, plan({ counts: { private_projects: MAX_GAUGE_CHARGES + 2 } }));
    for (const slug of ["one", "two", "three"]) {
      await seedProject("@alice", slug, { ownerId: userId, ownerType: "user" });
    }
    for (let i = 0; i < MAX_GAUGE_CHARGES + 10; i++) await seedChargedOrgProject(`p${i}`, userId);

    const response = await projectApp(userId, "alice")({ name: "x", visibility: "private" });

    expect(response.status).toBe(403);
  });

  it("does not create a charged org project when its index entry cannot be written", async () => {
    const userId = createUser(nextUserId());
    seedOrg(userId);
    cachePlan("user", userId, plan({ counts: { private_projects: 2 } }));
    const realPut = kv.put.bind(kv);
    vi.spyOn(kv, "put").mockImplementation(async (key, value) => {
      if (String(key).startsWith("gauge-charge:")) throw new Error("kv down");
      return realPut(key, value as string);
    });
    const artifacts = {
      create: async (name: string) => ({
        name,
        remote: `https://artifacts.test/${name}.git`,
        token: "tok",
      }),
    } as unknown as Env["ARTIFACTS"];

    const response = await projectApp(
      userId,
      "alice",
      artifacts,
    )({
      name: "fresh",
      visibility: "private",
      org: "acme",
    });

    expect(response.status).toBe(500);
    expect(await kv.get("project:@acme:fresh")).toBeNull();
  });

  it("prunes a charge whose project is gone past the grace window", async () => {
    const userId = createUser(nextUserId());
    seedOrg(userId);
    cachePlan("user", userId, plan({ counts: { private_projects: 2 } }));
    await seedChargedOrgProject("one", userId);
    await seedChargedOrgProject("gone", userId, NOW - GAUGE_CHARGE_GRACE_MS - 1);
    await kv.delete("project:@acme:gone");

    const response = await projectApp(userId, "alice")({ name: "two", visibility: "private" });

    expect(response.status).not.toBe(403);
    expect(await kv.get(`gauge-charge:${userId}:@acme:gone`)).toBeNull();
    expect(await kv.get(`gauge-charge:${userId}:@acme:one`)).not.toBeNull();
  });

  it("counts, and keeps, a young charge whose project is not written yet", async () => {
    // The window between the index write and setProject: a concurrent count
    // that pruned here would leave the project it is about to store uncounted.
    const userId = createUser(nextUserId());
    seedOrg(userId);
    cachePlan("user", userId, plan({ counts: { private_projects: 1 } }));
    const indexed = await recordGaugeCharge(kv, logger, {
      subjectId: userId,
      namespace: "@acme",
      slug: "in-flight",
      projectId: "prj_in_flight",
    });
    if (!indexed.success) throw indexed.error;

    const response = await projectApp(userId, "alice")({ name: "other", visibility: "private" });

    expect(response.status).toBe(403);
    expect(await kv.get(`gauge-charge:${userId}:@acme:in-flight`)).not.toBeNull();
  });

  it("still refuses when a faulted read leaves a lower bound already at the limit", async () => {
    const userId = createUser(nextUserId());
    cachePlan("user", userId, plan({ counts: { private_projects: 2 } }));
    await seedProject("@alice", "one", { ownerId: userId, ownerType: "user" });
    await seedProject("@alice", "two", { ownerId: userId, ownerType: "user" });
    failListingsUnder("gauge-charge:");

    const response = await projectApp(userId, "alice")({ name: "three", visibility: "private" });

    expect(response.status).toBe(403);
  });

  it("fails open when a faulted read leaves the count under the limit", async () => {
    // The PRD's billing rule: an outage of the counting machinery must not
    // block work. Admitted here means it got past the gauge to the repository.
    const userId = createUser(nextUserId());
    seedOrg(userId);
    cachePlan("user", userId, plan({ counts: { private_projects: 2 } }));
    await seedChargedOrgProject("one", userId);
    await seedChargedOrgProject("two", userId);
    failListingsUnder("gauge-charge:");

    const response = await projectApp(userId, "alice")({ name: "three", visibility: "private" });

    expect(response.status).not.toBe(403);
  });

  it("records and indexes the charge on a private project created into an org", async () => {
    const userId = createUser(nextUserId());
    seedOrg(userId);
    cachePlan("user", userId, plan({ counts: { private_projects: 2 } }));
    const artifacts = {
      create: async (name: string) => ({
        name,
        remote: `https://artifacts.test/${name}.git`,
        token: "tok",
      }),
    } as unknown as Env["ARTIFACTS"];

    const response = await projectApp(
      userId,
      "alice",
      artifacts,
    )({
      name: "fresh",
      visibility: "private",
      org: "acme",
    });

    expect(response.status).toBe(201);
    const stored = JSON.parse((await kv.get("project:@acme:fresh")) ?? "null") as ProjectEntry;
    expect(stored).toMatchObject({ ownerId: ORG_ID, ownerType: "org", gaugeSubjectId: userId });
    const charge = JSON.parse((await kv.get(`gauge-charge:${userId}:@acme:fresh`)) ?? "null");
    expect(charge).toMatchObject({ projectId: stored.id });
  });

  it("sends a browser form submission back to the form, not to a JSON 403", async () => {
    const userId = createUser(nextUserId());
    cachePlan("user", userId, plan({ counts: { private_projects: 2 } }));
    await seedProject("@alice", "one", { ownerId: userId, ownerType: "user" });
    await seedProject("@alice", "two", { ownerId: userId, ownerType: "user" });

    const response = await projectApp(userId, "alice")(
      { name: "three", visibility: "private" },
      "form",
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/new?error=private_project_limit");
  });

  it("does not spend your gauge on projects you do not own", async () => {
    // The inverse, which bit just as hard: being added to a busy org exhausted
    // your personal allowance against an org's private projects.
    const userId = createUser(nextUserId());
    seedOrg(userId);
    cachePlan("user", userId, plan({ counts: { private_projects: 2 } }));
    for (const slug of ["a", "b", "c", "d", "e"]) {
      await seedProject("@acme", slug, { ownerId: ORG_ID, ownerType: "org" });
    }

    const response = await projectApp(
      userId,
      "bob",
    )({
      name: "mine",
      visibility: "private",
      org: "acme",
    });

    // Not refused: this actor owns none of those five. The creation fails
    // further on, at the repository, which is proof it got past the gauge.
    expect(response.status).not.toBe(403);
  });

  it("costs a self-hoster no namespace listing at all", async () => {
    // The listing is a KV list of a whole namespace, on every private project
    // creation, feeding a check that is inert with no billing service.
    const userId = createUser(nextUserId());
    const list = vi.spyOn(kv, "list");
    const application = new Hono<{ Bindings: Env }>();
    application.use("*", async (c, next) => {
      c.set("userId", userId);
      c.set("username", "carol");
      await next();
    });
    application.route("/projects", projectsRouter);

    await application.fetch(
      new Request("https://t.test/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "solo", visibility: "private" }),
      }),
      selfHostedEnv({
        ARTIFACTS: {
          create: async () => {
            throw new Error("artifacts unavailable in this test");
          },
        },
      } as unknown as Partial<Env>),
    );

    expect(list).not.toHaveBeenCalled();
    list.mockRestore();
  });
});

describe("the private project gauge through the import routes", () => {
  const SOURCE = "https://github.com/octo/widget";

  function authed(userId: string, username: string) {
    const application = new Hono<{ Bindings: Env }>();
    application.use("*", async (c, next) => {
      c.set("userId", userId);
      c.set("username", username);
      await next();
    });
    application.route("/projects", projectsRouter);
    application.route("/bulk-import", bulkImportRouter);
    return (path: string, body: unknown) =>
      application.fetch(
        new Request(`https://t.test${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        makeEnv({
          ENTITLEMENTS_ENFORCE: "1",
          // A request that gets past the gauge fails here instead, which is
          // how "not refused" is asserted.
          ARTIFACTS: {
            create: async () => {
              throw new Error("artifacts unavailable in this test");
            },
          },
          IMPORT_QUEUE: { send: vi.fn() },
        } as unknown as Partial<Env>),
      );
  }

  async function seedPrivate(namespace: string, slug: string, ownerId: string): Promise<void> {
    const stored = await setProject(
      kv,
      {
        id: `prj_${slug}`,
        name: slug,
        slug,
        namespace,
        ownerId,
        ownerType: "user",
        remote: "https://acct.artifacts.cloudflare.net/git/acct/x.git",
        createdAt: "2026-09-01T00:00:00.000Z",
        visibility: "private",
      },
      logger,
    );
    if (!stored.success) throw stored.error;
  }

  it("refuses a private single import at the limit, before anything is created", async () => {
    const userId = createUser(nextUserId());
    cachePlan("user", userId, plan({ counts: { private_projects: 1 } }));
    await seedPrivate("@alice", "one", userId);

    const response = await authed(userId, "alice")("/projects/@alice/two/import", {
      url: SOURCE,
      branch: "main",
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("plan allows 1");
    expect(raw.prepare("SELECT COUNT(*) AS n FROM import_jobs").get()).toEqual({ n: 0 });
    expect((await getProjectByPath(kv, "@alice", "two", logger)).success).toBe(false);
  });

  it("admits a private single import under the limit, and a public one at it", async () => {
    const userId = createUser(nextUserId());
    cachePlan("user", userId, plan({ counts: { private_projects: 1 } }));
    const post = authed(userId, "alice");

    const under = await post("/projects/@alice/two/import", { url: SOURCE, branch: "main" });
    expect(under.status).not.toBe(403);

    await seedPrivate("@alice", "one", userId);
    const pub = await post("/projects/@alice/three/import", {
      url: SOURCE,
      branch: "main",
      visibility: "public",
    });
    expect(pub.status).not.toBe(403);
  });

  it("refuses a bulk import whose private repos would cross the limit, all of it", async () => {
    const userId = createUser(nextUserId());
    cachePlan("user", userId, plan({ counts: { private_projects: 2 } }));
    await seedPrivate("@alice", "one", userId);

    const response = await authed(userId, "alice")("/bulk-import", {
      repos: [
        { url: "https://github.com/octo/a", slug: "a", branch: "main" },
        { url: "https://github.com/octo/b", slug: "b", branch: "main" },
      ],
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Creating 2 more private projects");
    expect(raw.prepare("SELECT COUNT(*) AS n FROM import_jobs").get()).toEqual({ n: 0 });
  });

  it("refuses a bulk entry whose visibility is neither private nor public", async () => {
    // Access checks treat anything but "public" as private; an unrecognised
    // value must not slip past a gauge that counts only "private".
    const userId = createUser(nextUserId());
    cachePlan("user", userId, plan({ counts: { private_projects: 0 } }));

    const response = await authed(userId, "alice")("/bulk-import", {
      repos: [
        { url: "https://github.com/octo/a", slug: "a", branch: "main", visibility: "PRIVATE" },
      ],
    });

    expect(response.status).toBe(400);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM import_jobs").get()).toEqual({ n: 0 });
  });

  it("refuses a bulk import with two entries for the same project", async () => {
    const userId = createUser(nextUserId());
    cachePlan("user", userId, plan({ counts: { private_projects: 5 } }));

    const response = await authed(userId, "alice")("/bulk-import", {
      repos: [
        { url: "https://github.com/octo/a", slug: "same", branch: "main" },
        { url: "https://github.com/octo/b", slug: "same", branch: "main" },
      ],
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Duplicate import target");
  });

  it("does not charge a bulk import for public repos or projects that already exist", async () => {
    const userId = createUser(nextUserId());
    cachePlan("user", userId, plan({ counts: { private_projects: 2 } }));
    await seedPrivate("@alice", "one", userId);

    // One already exists (a re-run), one is public, one is new: only the new
    // private one counts, and 1 + 1 fits a limit of 2.
    const response = await authed(userId, "alice")("/bulk-import", {
      repos: [
        { url: "https://github.com/octo/one", slug: "one", branch: "main" },
        { url: "https://github.com/octo/b", slug: "b", branch: "main", visibility: "public" },
        { url: "https://github.com/octo/c", slug: "c", branch: "main" },
      ],
    });

    expect(response.status).toBe(201);
  });
});

describe("the private project gauge", () => {
  it("refuses one over the limit and admits under it", async () => {
    const userId = nextUserId();
    cachePlan("user", userId, plan({ counts: { private_projects: 2 } }));
    const env = makeEnv({ ENTITLEMENTS_ENFORCE: "1" } as Partial<Env>);
    const subject = { ownerId: userId, ownerType: "user" as const, pooled: false };

    const under = await checkGauge(env, logger, {
      subject,
      count: "private_projects",
      current: 1,
      what: "Creating another private project",
    });
    const over = await checkGauge(env, logger, {
      subject,
      count: "private_projects",
      current: 2,
      what: "Creating another private project",
    });

    expect(under.admitted).toBe(true);
    expect(over.admitted).toBe(false);
    expect(over.reason).toContain("plan allows 2");
  });
});

describe("the private project gauge holds what it admits (#384)", () => {
  // A count alone is check-then-act: two creations that count before either
  // one's entry is written both see room, and a bulk import is checked once
  // and then created in the background. These are the races the hold closes,
  // the double count it must not introduce, and the fail-open it must keep.

  /** A user who exists in D1 under `username`, so a creation can land. */
  function createNamedUser(username: string): string {
    const userId = createUser(nextUserId());
    raw.prepare("UPDATE users SET username = ? WHERE id = ?").run(username, userId);
    return userId;
  }

  /** ARTIFACTS whose `create` waits for `open()` and then fails. */
  function blockedArtifacts() {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const create = vi.fn(async () => {
      await gate;
      throw new Error("artifacts unavailable in this test");
    });
    return { artifacts: { create } as unknown as Env["ARTIFACTS"], create, open };
  }

  /** ARTIFACTS that succeed, so a creation lands. */
  const landingArtifacts = {
    create: async (name: string) => ({
      name,
      remote: `https://artifacts.test/${name}.git`,
      token: "tok",
    }),
  } as unknown as Env["ARTIFACTS"];

  /** ARTIFACTS that fail straight away, so a creation fails after admission. */
  const failingArtifacts = {
    create: async () => {
      throw new Error("artifacts unavailable in this test");
    },
  } as unknown as Env["ARTIFACTS"];

  function app(userId: string, username: string, env: Partial<Env>) {
    const application = new Hono<{ Bindings: Env }>();
    application.use("*", async (c, next) => {
      c.set("userId", userId);
      c.set("username", username);
      await next();
    });
    application.route("/projects", projectsRouter);
    application.route("/bulk-import", bulkImportRouter);
    // An execution context, so bulk import's background batch is handed to
    // `waitUntil` and a test can wait for it to finish.
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => {
        scheduled.push(promise);
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    return (path: string, body: unknown) =>
      application.fetch(
        new Request(`https://t.test${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        makeEnv({ IMPORT_QUEUE: { send: vi.fn() }, ...env } as unknown as Partial<Env>),
        ctx,
      );
  }

  async function seedPrivate(namespace: string, slug: string, ownerId: string): Promise<void> {
    const stored = await setProject(
      kv,
      {
        id: `prj_${slug}`,
        name: slug,
        slug,
        namespace,
        ownerId,
        ownerType: "user",
        remote: "https://acct.artifacts.cloudflare.net/git/acct/x.git",
        createdAt: "2026-09-01T00:00:00.000Z",
        visibility: "private",
      },
      logger,
    );
    if (!stored.success) throw stored.error;
  }

  /** The holds standing on `userId`'s meter. */
  async function holdsFor(userId: string): Promise<Array<{ path: string; expiresAt: number }>> {
    const record = await meters.storages
      .get(`user:${userId}`)
      ?.get<{ holds: Array<{ path: string; expiresAt: number }> }>("gauge");
    return record?.holds ?? [];
  }

  /** A namespace whose stubs throw on every gauge RPC: an unreachable meter. */
  function unreachableMeter(): NonNullable<Env["USAGE_METER"]> {
    const stub = {
      reserveGauge: async () => {
        throw new Error("meter unreachable");
      },
      releaseGauge: async () => {
        throw new Error("meter unreachable");
      },
    };
    return {
      idFromName: (name: string) => name,
      get: () => stub,
    } as unknown as NonNullable<Env["USAGE_METER"]>;
  }

  it("admits exactly one of two concurrent creations at one under the limit", async () => {
    const userId = createNamedUser("alice");
    cachePlan("user", userId, plan({ counts: { private_projects: 2 } }));
    await seedPrivate("@alice", "one", userId);
    const { artifacts, create, open } = blockedArtifacts();
    const post = app(userId, "alice", { ENTITLEMENTS_ENFORCE: "1", ARTIFACTS: artifacts });

    const a = post("/projects", { name: "two", visibility: "private" });
    const b = post("/projects", { name: "three", visibility: "private" });
    // The admitted one is parked inside ARTIFACTS.create, so whichever settles
    // first is the one the gauge turned away.
    const first = await Promise.race([a, b]);
    expect(first.status).toBe(403);
    expect(create).toHaveBeenCalledTimes(1);

    open();
    const statuses = (await Promise.all([a, b])).map((r) => r.status).sort();
    expect(statuses).toEqual([403, 500]);
  });

  it("refuses a second bulk import sent before the first one's projects land", async () => {
    const userId = createNamedUser("alice");
    cachePlan("user", userId, plan({ counts: { private_projects: 3 } }));
    const { artifacts, open } = blockedArtifacts();
    const post = app(userId, "alice", { ENTITLEMENTS_ENFORCE: "1", ARTIFACTS: artifacts });

    const first = await post("/bulk-import", {
      repos: [
        { url: "https://github.com/octo/a", slug: "a", branch: "main" },
        { url: "https://github.com/octo/b", slug: "b", branch: "main" },
      ],
    });
    // Nothing from the first batch is written yet, so a count alone sees zero
    // and admits this one too — 4 against a limit of 3.
    const second = await post("/bulk-import", {
      repos: [
        { url: "https://github.com/octo/c", slug: "c", branch: "main" },
        { url: "https://github.com/octo/d", slug: "d", branch: "main" },
      ],
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(403);
    expect(await second.text()).toContain("Creating 2 more private projects");
    // A bulk batch lands in the background, so it keeps the long TTL.
    expect((await holdsFor(userId)).map((h) => h.expiresAt)).toEqual([
      NOW + GAUGE_HOLD_TTL_MS,
      NOW + GAUGE_HOLD_TTL_MS,
    ]);

    // Each repo of the first batch fails, and gives its own slot back.
    open();
    await Promise.all(scheduled);
    expect(await holdsFor(userId)).toEqual([]);
  });

  it("releases on landing, so a landed project is not counted twice", async () => {
    const userId = createNamedUser("alice");
    cachePlan("user", userId, plan({ counts: { private_projects: 2 } }));
    const post = app(userId, "alice", { ENTITLEMENTS_ENFORCE: "1", ARTIFACTS: landingArtifacts });

    const one = await post("/projects", { name: "one", visibility: "private" });
    expect(one.status).toBe(201);
    expect(await holdsFor(userId)).toEqual([]);

    const two = await post("/projects", { name: "two", visibility: "private" });
    const three = await post("/projects", { name: "three", visibility: "private" });
    expect(two.status).toBe(201);
    expect(three.status).toBe(403);
  });

  it("does not count a landed project twice when its release never arrived", async () => {
    // The project is written and its hold is still standing: the count has it,
    // and the hold names its path, so it must be counted once.
    const userId = createNamedUser("alice");
    cachePlan("user", userId, plan({ counts: { private_projects: 2 } }));
    const release = vi
      .spyOn(UsageMeter.prototype, "releaseGauge")
      .mockRejectedValue(new Error("meter unreachable"));
    const post = app(userId, "alice", { ENTITLEMENTS_ENFORCE: "1", ARTIFACTS: landingArtifacts });

    const one = await post("/projects", { name: "one", visibility: "private" });
    expect(one.status).toBe(201);
    expect(await holdsFor(userId)).toHaveLength(1);

    const two = await post("/projects", { name: "two", visibility: "private" });
    expect(two.status).toBe(201);
    release.mockRestore();
  });

  it("releases the hold of a creation that failed after it was admitted", async () => {
    const userId = createNamedUser("alice");
    cachePlan("user", userId, plan({ counts: { private_projects: 1 } }));
    const post = app(userId, "alice", { ENTITLEMENTS_ENFORCE: "1", ARTIFACTS: failingArtifacts });

    const failed = await post("/projects", { name: "one", visibility: "private" });
    expect(failed.status).toBe(500);
    expect(await holdsFor(userId)).toEqual([]);

    // Not refused: the failed creation left no slot behind.
    const retry = await post("/projects", { name: "one", visibility: "private" });
    expect(retry.status).toBe(500);
  });

  it("releases a single import's hold on every exit", async () => {
    const userId = createNamedUser("alice");
    cachePlan("user", userId, plan({ counts: { private_projects: 1 } }));
    const post = app(userId, "alice", { ENTITLEMENTS_ENFORCE: "1", ARTIFACTS: failingArtifacts });

    const failed = await post("/projects/@alice/two/import", {
      url: "https://github.com/octo/widget",
      branch: "main",
    });

    expect(failed.status).toBe(500);
    expect(await holdsFor(userId)).toEqual([]);
  });

  it("stops counting a hold nobody released once it is stale", async () => {
    const userId = createNamedUser("alice");
    cachePlan("user", userId, plan({ counts: { private_projects: 1 } }));
    const env = makeEnv({ ENTITLEMENTS_ENFORCE: "1" } as Partial<Env>);
    const check = () =>
      checkPrivateProjectGauge(env, logger, {
        actorUserId: userId,
        username: "alice",
        owner: { id: userId, type: "user" },
        targetNamespace: "@alice",
        paths: ["@alice/abandoned"],
      });

    // Admitted and never released — an isolate evicted mid-creation.
    expect((await check()).admitted).toBe(true);
    expect((await check()).admitted).toBe(false);

    vi.setSystemTime(NOW + GAUGE_HOLD_TTL_MS + 1);
    expect((await check()).admitted).toBe(true);
  });

  it("fails open to the count alone when the meter is unreachable", async () => {
    // Exactly the behaviour before holds existed: the race is back, but no
    // creation the count admits is blocked by a metering outage.
    const userId = createNamedUser("alice");
    cachePlan("user", userId, plan({ counts: { private_projects: 2 } }));
    await seedPrivate("@alice", "one", userId);
    const { artifacts, create, open } = blockedArtifacts();
    const post = app(userId, "alice", {
      ENTITLEMENTS_ENFORCE: "1",
      ARTIFACTS: artifacts,
      USAGE_METER: unreachableMeter(),
    });

    const a = post("/projects", { name: "two", visibility: "private" });
    const b = post("/projects", { name: "three", visibility: "private" });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    open();
    expect((await Promise.all([a, b])).map((r) => r.status)).toEqual([500, 500]);

    // The count still answers on its own: at the limit is still refused.
    await seedPrivate("@alice", "two", userId);
    const atLimit = await post("/projects", { name: "four", visibility: "private" });
    expect(atLimit.status).toBe(403);
  });

  it("keeps admitting under observe-only, and still holds what it admits", async () => {
    const userId = createNamedUser("alice");
    cachePlan("user", userId, plan({ counts: { private_projects: 1 } }));
    await seedPrivate("@alice", "one", userId);
    const { artifacts, create, open } = blockedArtifacts();
    const post = app(userId, "alice", { ARTIFACTS: artifacts });

    const a = post("/projects", { name: "two", visibility: "private" });
    const b = post("/projects", { name: "three", visibility: "private" });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    // Both creations are past the gauge and both are held, so the next
    // decision measures against the total that will actually exist.
    expect(await holdsFor(userId)).toHaveLength(2);

    open();
    expect((await Promise.all([a, b])).map((r) => r.status)).toEqual([500, 500]);
    expect(await holdsFor(userId)).toEqual([]);
  });

  it("holds a single creation on the shorter TTL", async () => {
    const userId = createNamedUser("alice");
    cachePlan("user", userId, plan({ counts: { private_projects: 3 } }));
    const { artifacts, create, open } = blockedArtifacts();
    const post = app(userId, "alice", { ENTITLEMENTS_ENFORCE: "1", ARTIFACTS: artifacts });

    const created = post("/projects", { name: "one", visibility: "private" });
    const imported = post("/projects/@alice/two/import", {
      url: "https://github.com/octo/widget",
      branch: "main",
    });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));

    expect(SINGLE_CREATION_HOLD_TTL_MS).toBeLessThan(GAUGE_HOLD_TTL_MS);
    // `vi.waitFor` steps the faked clock while polling, so allow its slack.
    const ttls = (await holdsFor(userId)).map((h) => h.expiresAt - NOW);
    expect(ttls).toHaveLength(2);
    for (const ttl of ttls) {
      expect(ttl).toBeGreaterThanOrEqual(SINGLE_CREATION_HOLD_TTL_MS);
      expect(ttl).toBeLessThan(SINGLE_CREATION_HOLD_TTL_MS + 60_000);
    }
    open();
    await Promise.all([created, imported]);
  });

  it("releases through waitUntil a creation whose client walked away", async () => {
    // The response is never awaited — the client disconnected. What the
    // runtime keeps alive is what was handed to `waitUntil`, so that alone
    // has to carry the creation to its release.
    const userId = createNamedUser("alice");
    cachePlan("user", userId, plan({ counts: { private_projects: 1 } }));
    const { artifacts, create, open } = blockedArtifacts();
    const post = app(userId, "alice", { ENTITLEMENTS_ENFORCE: "1", ARTIFACTS: artifacts });

    void post("/projects", { name: "one", visibility: "private" });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(await holdsFor(userId)).toHaveLength(1);
    expect(scheduled).toHaveLength(1);

    open();
    await Promise.all(scheduled);
    expect(await holdsFor(userId)).toEqual([]);
  });

  it("runs the waitUntil release even when the handler's own never does", async () => {
    // The cancelled-handler case, isolated: the in-request `finally` never
    // runs, and the backstop registered with `waitUntil` still releases.
    let settle!: () => void;
    const work = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const release = vi.fn(async () => {});
    const registered: Array<Promise<unknown>> = [];

    releaseWhenSettled(work, release, (promise) => {
      registered.push(promise);
    });
    expect(release).not.toHaveBeenCalled();

    settle();
    await Promise.all(registered);
    expect(release).toHaveBeenCalledTimes(1);

    // A creation that throws is released too.
    const failed = vi.fn(async () => {});
    const later: Array<Promise<unknown>> = [];
    releaseWhenSettled(Promise.reject(new Error("boom")), failed, (promise) => {
      later.push(promise);
    });
    await Promise.all(later);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("sends each release once, however many times it is called", async () => {
    const userId = createNamedUser("alice");
    cachePlan("user", userId, plan({ counts: { private_projects: 5 } }));
    const env = makeEnv({ ENTITLEMENTS_ENFORCE: "1" } as Partial<Env>);
    const rpc = vi.spyOn(UsageMeter.prototype, "releaseGauge");
    const check = (paths: string[]) =>
      checkPrivateProjectGauge(env, logger, {
        actorUserId: userId,
        username: "alice",
        owner: { id: userId, type: "user" },
        targetNamespace: "@alice",
        paths,
      });

    const single = await check(["@alice/one"]);
    if (!single.admitted) throw new Error("expected admission");
    await single.release();
    await single.release();
    expect(rpc).toHaveBeenCalledTimes(1);

    const batch = await check(["@alice/a", "@alice/b"]);
    if (!batch.admitted) throw new Error("expected admission");
    await batch.release(["@alice/a"]);
    await batch.release(["@alice/a"]);
    await batch.release(["@alice/a", "@alice/b"]);
    await batch.release();
    await batch.release();
    // a; then only b; then the whole admission once.
    expect(rpc.mock.calls.slice(1).map((call) => call[2])).toEqual([
      ["@alice/a"],
      ["@alice/b"],
      undefined,
    ]);
    expect(await holdsFor(userId)).toEqual([]);
    rpc.mockRestore();
  });

  it("makes no meter call at all for a self-hoster", async () => {
    const userId = createNamedUser("alice");
    const post = (path: string, body: unknown) =>
      app(
        userId,
        "alice",
        selfHostedEnv({ ARTIFACTS: failingArtifacts } as unknown as Partial<Env>),
      )(path, body);

    await post("/projects", { name: "solo", visibility: "private" });
    await post("/projects/@alice/imported/import", {
      url: "https://github.com/octo/widget",
      branch: "main",
    });
    await post("/bulk-import", {
      repos: [{ url: "https://github.com/octo/a", slug: "a", branch: "main" }],
    });
    await Promise.all(scheduled);

    expect(meters.calls).toEqual([]);
  });
});

describe("rateLimitMiddleware's default limit", () => {
  function app(env: Env, userId?: string) {
    const application = new Hono<{ Bindings: Env }>();
    application.use("*", async (c, next) => {
      if (userId) c.set("userId", userId);
      await next();
    });
    application.use("*", rateLimitMiddleware());
    application.get("/x", (c) => c.text("ok"));
    return (path = "/x") => application.fetch(new Request(`https://t.test${path}`), env);
  }

  it("falls back to today's 1000 when the entitlements cache misses", async () => {
    const response = await app(makeEnv(), nextUserId())();
    expect(response.headers.get("X-RateLimit-Limit")).toBe("1000");
  });

  it("keeps today's numbers entirely when the billing service is unconfigured", async () => {
    const response = await app(selfHostedEnv(), nextUserId())();
    expect(response.headers.get("X-RateLimit-Limit")).toBe("1000");
  });

  it("uses a cached plan's own rate when enforcement is on", async () => {
    const userId = nextUserId();
    cachePlan(
      "user",
      userId,
      plan({ rates: { requests_per_minute: 25, evaluations_per_hour: 10 } }),
    );
    const response = await app(makeEnv({ ENTITLEMENTS_ENFORCE: "1" } as Partial<Env>), userId)();
    expect(response.headers.get("X-RateLimit-Limit")).toBe("25");
  });

  it("never tightens while observing: a lower plan limit does not bind", async () => {
    const userId = nextUserId();
    cachePlan(
      "user",
      userId,
      plan({ rates: { requests_per_minute: 25, evaluations_per_hour: 10 } }),
    );
    const response = await app(makeEnv(), userId)();
    expect(response.headers.get("X-RateLimit-Limit")).toBe("1000");
  });

  it("leaves an agent on its own bucket at today's numbers", async () => {
    const application = new Hono<{ Bindings: Env }>();
    application.use("*", async (c, next) => {
      c.set("agentId", "agt_1");
      await next();
    });
    application.use("*", rateLimitMiddleware());
    application.get("/x", (c) => c.text("ok"));
    const response = await application.fetch(
      new Request("https://t.test/x"),
      makeEnv({ ENTITLEMENTS_ENFORCE: "1" } as Partial<Env>),
    );
    expect(response.headers.get("X-RateLimit-Limit")).toBe("1000");
  });
});

describe("the deploy volume check", () => {
  const PROJECT_ID = "prj_deploy_enforce";
  const REMOTE = "https://acct.artifacts.cloudflare.net/git/acct/api.git";
  const SHA = "a".repeat(40);

  async function deployProject(ownerId: string): Promise<ProjectEntry> {
    const project: ProjectEntry = {
      id: PROJECT_ID,
      name: "api",
      slug: "api",
      namespace: "@alice",
      ownerId,
      ownerType: "user",
      remote: REMOTE,
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    const stored = await setProject(kv, project, logger);
    if (!stored.success) throw stored.error;
    return project;
  }

  it("writes a persisted failed row with a named reason, and acks", async () => {
    const userId = createUser(nextUserId());
    await deployProject(userId);
    cachePlan(
      "user",
      userId,
      plan({ meters: { ...UnlimitedEntitlements.meters, deploys_month: 0 } }),
    );

    const inserted = await insertDeployment(db, logger, {
      projectId: PROJECT_ID,
      project: "api",
      commitSha: SHA,
      name: "production",
      target: "vercel",
      requestedByType: "user",
      requestedById: userId,
      now: "2026-09-15T00:00:00.000Z",
    });
    if (!inserted.success || !inserted.data.inserted) throw new Error("fixture insert failed");

    const result = await runDeployMessage(
      makeEnv({
        ENTITLEMENTS_ENFORCE: "1",
        ARTIFACTS: {
          get: async () => ({ createToken: async () => ({ plaintext: "repo-token" }) }),
        },
      } as unknown as Partial<Env>),
      { kind: "deployment", projectId: PROJECT_ID, deploymentId: inserted.data.deployment.id },
      logger,
      {
        now: () => NOW,
        readFiles: async () =>
          ok(
            new Map([
              [
                ".stratum/policy.yaml",
                new TextEncoder().encode(
                  "evaluators: []\ndeploys:\n  - name: production\n    target: vercel\n",
                ),
              ],
            ]),
          ),
        // A provider call would be a bug: the refusal happens before the claim.
        fetch: vi.fn(async () => new Response("{}", { status: 200 })),
      },
    );

    // Acked, not retried: redelivery cannot change a limit.
    expect(result.success).toBe(true);
    const row = raw
      .prepare("SELECT status, reason FROM deployments WHERE id = ?")
      .get(inserted.data.deployment.id) as { status: string; reason: string };
    expect(row.status).toBe("failed");
    expect(row.reason).toContain("monthly deploy allowance");
  });

  it("gives the reserved unit back when this attempt does not run the deploy", async () => {
    // A deploy meter has no natural settle, so a reservation taken by an
    // attempt that stops before the claim is a unit charged to nobody's deploy.
    // Two or three of those per deploy is an allowance that empties itself.
    const userId = createUser(nextUserId());
    await deployProject(userId);
    cachePlan(
      "user",
      userId,
      plan({ meters: { ...UnlimitedEntitlements.meters, deploys_month: 5 } }),
    );

    const inserted = await insertDeployment(db, logger, {
      projectId: PROJECT_ID,
      project: "api",
      commitSha: SHA,
      name: "production",
      target: "vercel",
      requestedByType: "user",
      requestedById: userId,
      now: "2026-09-15T00:00:00.000Z",
    });
    if (!inserted.success || !inserted.data.inserted) throw new Error("fixture insert failed");
    // Someone else holds the lease: this attempt reserves, cannot claim, and
    // returns the row to its owner.
    raw
      .prepare("UPDATE deployments SET status = 'running', lease_expires_at = ? WHERE id = ?")
      .run("2099-01-01T00:00:00.000Z", inserted.data.deployment.id);

    await runDeployMessage(
      makeEnv({
        ENTITLEMENTS_ENFORCE: "1",
        ARTIFACTS: {
          get: async () => ({ createToken: async () => ({ plaintext: "repo-token" }) }),
        },
      } as unknown as Partial<Env>),
      { kind: "deployment", projectId: PROJECT_ID, deploymentId: inserted.data.deployment.id },
      logger,
      {
        now: () => NOW,
        readFiles: async () =>
          ok(
            new Map([
              [
                ".stratum/policy.yaml",
                new TextEncoder().encode(
                  "evaluators: []\ndeploys:\n  - name: production\n    target: vercel\n",
                ),
              ],
            ]),
          ),
        fetch: vi.fn(async () => new Response("{}", { status: 200 })),
      },
    );

    const stub = meters.namespace.get(meters.namespace.idFromName(`user:${userId}`));
    expect((await stub.read(PERIOD)).counts.deploys_month).toBe(0);
  });
});

describe("the 80% threshold notification", () => {
  function envWithEmail(): { env: Env; send: ReturnType<typeof vi.fn> } {
    const send = vi.fn(async () => undefined);
    return {
      env: makeEnv({
        EMAIL: { send } as unknown as Env["EMAIL"],
        EMAIL_FROM_ADDRESS: "noreply@stratum.test",
      }),
      send,
    };
  }

  async function spend(env: Env, ownerId: string, quantity: number): Promise<void> {
    await recordCosts(
      db,
      logger,
      {
        project: "api",
        projectId: "prj_1",
        ownerId,
        ownerType: "user",
        notify: {
          env,
          actorUserId: ownerId,
          waitUntil: (promise) => scheduled.push(promise),
        },
      },
      [{ kind: "llm_tokens", quantity }],
    );
    await Promise.allSettled(scheduled);
    scheduled.length = 0;
  }

  it("fires once on the crossing and not again inside the same period", async () => {
    const userId = createUser(nextUserId());
    const { env, send } = envWithEmail();
    cachePlan("user", userId, tokenPlan(1_000));

    // 700 of 1000 is under 80%: approaching is not crossing.
    await spend(env, userId, 700);
    expect(send).not.toHaveBeenCalled();

    // 850 crosses.
    await spend(env, userId, 150);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ to: `${userId}@example.test` });

    // Still past the threshold, but the edge has already been reported.
    await spend(env, userId, 50);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("re-arms when the limit is raised mid-period: the limit is in the receipt key", async () => {
    const userId = createUser(nextUserId());
    const { env, send } = envWithEmail();
    cachePlan("user", userId, tokenPlan(1_000));

    await spend(env, userId, 850);
    expect(send).toHaveBeenCalledTimes(1);

    // The plan is upgraded: 850 is now well under 80% of 2000, so the next
    // crossing is a real one and must not be silenced by the first receipt.
    cachePlan("user", userId, tokenPlan(2_000));
    await spend(env, userId, 800);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("ignores BYOK spend, which is not under the allowance at all", async () => {
    const userId = createUser(nextUserId());
    const { env, send } = envWithEmail();
    cachePlan("user", userId, tokenPlan(1_000));

    await recordCosts(
      db,
      logger,
      {
        project: "api",
        ownerId: userId,
        ownerType: "user",
        notify: { env, actorUserId: userId, waitUntil: (promise) => scheduled.push(promise) },
      },
      [{ kind: "llm_tokens", quantity: 950, source: "byok" }],
    );
    await Promise.allSettled(scheduled);

    expect(send).not.toHaveBeenCalled();
  });

  it("says nothing at all when the billing service is unconfigured", async () => {
    const userId = createUser(nextUserId());
    const send = vi.fn(async () => undefined);
    const env = selfHostedEnv({
      EMAIL: { send } as unknown as Env["EMAIL"],
      EMAIL_FROM_ADDRESS: "noreply@stratum.test",
    });
    cachePlan("user", userId, tokenPlan(1_000));

    await spend(env, userId, 950);
    expect(send).not.toHaveBeenCalled();
  });
});
