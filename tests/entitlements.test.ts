import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Entitlements,
  RemoteEntitlements,
  UnlimitedEntitlements,
  entitlementsEnabled,
  warmEntitlements,
} from "../src/billing/entitlements";
import type { Env } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

type FakeKV = ReturnType<typeof makeFakeKV>;

function env(overrides: Partial<Env> = {}): { env: Env; kv: FakeKV } {
  const kv = makeFakeKV();
  return {
    env: {
      STATE: kv,
      BILLING_SERVICE_URL: "https://billing.test/",
      BILLING_SERVICE_SECRET: "shh",
      ...overrides,
    } as Env,
    kv,
  };
}

/** Configured with a KV binding but no billing service — the self-hoster default. */
function unconfiguredEnv(): Env {
  return env({ BILLING_SERVICE_URL: undefined, BILLING_SERVICE_SECRET: undefined }).env;
}

const CACHE_KEY = "entitlements:v2:user:usr_1";
const NEGATIVE_KEY = "entitlements:v2:neg:user:usr_1";
const LOCK_KEY = "entitlements:v2:lock:user:usr_1";

const paidPlan: Entitlements = {
  plan: "pro",
  pooled: true,
  meters: { llm_tokens_month: 1_000_000, sandbox_ms_month: 60_000, deploys_month: 100 },
  counts: { private_projects: 25 },
  rates: { requests_per_minute: 2_000, evaluations_per_hour: 200 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("entitlementsEnabled", () => {
  it("is off by default (self-hoster, no env)", () => {
    expect(entitlementsEnabled({} as Env)).toBe(false);
  });

  it("is off when only the URL is set", () => {
    expect(entitlementsEnabled({ BILLING_SERVICE_URL: "https://billing.test" } as Env)).toBe(false);
  });

  it("is off when only the secret is set", () => {
    expect(entitlementsEnabled({ BILLING_SERVICE_SECRET: "shh" } as Env)).toBe(false);
  });

  it("is on only when both are configured", () => {
    expect(
      entitlementsEnabled({
        BILLING_SERVICE_URL: "https://billing.test",
        BILLING_SERVICE_SECRET: "shh",
      } as Env),
    ).toBe(true);
  });
});

describe("RemoteEntitlements.forOwner", () => {
  it("returns the unlimited default, tagged 'default', when the hook is unconfigured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = new RemoteEntitlements(unconfiguredEnv(), noopLogger);
    const result = await provider.forOwner("usr_1", "user");
    expect(result.success && result.data.source).toBe("default");
    expect(result.success && result.data.entitlements).toEqual(UnlimitedEntitlements);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("errors rather than silently answering 'unlimited' for an unidentified owner", async () => {
    const { env: e } = env();
    const result = await new RemoteEntitlements(e, noopLogger).forOwner("", "user");
    expect(result.success).toBe(false);
    expect(!result.success && result.error.code).toBe("VALIDATION_ERROR");
  });

  it("serves a warm cache and tags it 'cache'", async () => {
    const { env: e, kv } = env();
    kv.store.set(CACHE_KEY, JSON.stringify(paidPlan));
    const result = await new RemoteEntitlements(e, noopLogger).forOwner("usr_1", "user");
    expect(result.success && result.data.source).toBe("cache");
    expect(result.success && result.data.entitlements).toEqual(paidPlan);
  });

  it("is a cached read only — a cold cache never reaches the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { env: e } = env();
    const result = await new RemoteEntitlements(e, noopLogger).forOwner("usr_1", "user");
    expect(result.success && result.data.source).toBe("default");
    expect(result.success && result.data.entitlements).toEqual(UnlimitedEntitlements);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats an unparseable cache entry as a miss", async () => {
    const { env: e, kv } = env();
    kv.store.set(CACHE_KEY, "{not json");
    const result = await new RemoteEntitlements(e, noopLogger).forOwner("usr_1", "user");
    expect(result.success && result.data.source).toBe("default");
  });
});

describe("RemoteEntitlements.refresh", () => {
  it("returns the remote value tagged 'remote' and caches it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(paidPlan));
    const { env: e, kv } = env();
    const result = await new RemoteEntitlements(e, noopLogger).refresh("usr_1", "user");
    expect(result.success && result.data.source).toBe("remote");
    expect(result.success && result.data.entitlements).toEqual(paidPlan);
    expect(JSON.parse(String(kv.store.get(CACHE_KEY)))).toEqual(paidPlan);

    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toBe("https://billing.test/api/billing/entitlements?ownerId=usr_1&ownerType=user");
    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer shh");
  });

  it("keeps 0 as a hard block and discards string / NaN / negative limits", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        plan: "starter",
        meters: {
          llm_tokens_month: 0,
          sandbox_ms_month: "50000",
          deploys_month: Number.NaN,
        },
        counts: { private_projects: -7 },
        rates: { requests_per_minute: 1.5 },
      }),
    );
    const { env: e } = env();
    const result = await new RemoteEntitlements(e, noopLogger).refresh("usr_1", "user");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.source).toBe("remote");
    expect(result.data.entitlements).toEqual({
      plan: "starter",
      // A payload that says nothing about pooling is not a payload that pools.
      pooled: false,
      // 0 survives: it is a hard block, not "unset".
      meters: { llm_tokens_month: 0, sandbox_ms_month: -1, deploys_month: -1 },
      counts: { private_projects: -1 },
      rates: { requests_per_minute: -1, evaluations_per_hour: -1 },
    });
  });

  it("discards bad fields in favour of the CACHED value, not the default", async () => {
    const { env: e, kv } = env();
    kv.store.set(CACHE_KEY, JSON.stringify(paidPlan));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ meters: { llm_tokens_month: "lots", sandbox_ms_month: 10 } }),
    );
    const result = await new RemoteEntitlements(e, noopLogger).refresh("usr_1", "user");
    expect(result.success && result.data.entitlements).toEqual({
      ...paidPlan,
      meters: { ...paidPlan.meters, sandbox_ms_month: 10 },
    });
  });

  it("fails OPEN to the warm cache on a non-OK response, without clobbering it", async () => {
    const { env: e, kv } = env();
    kv.store.set(CACHE_KEY, JSON.stringify(paidPlan));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 503 }));
    const result = await new RemoteEntitlements(e, noopLogger).refresh("usr_1", "user");
    expect(result.success && result.data.source).toBe("cache");
    expect(result.success && result.data.entitlements).toEqual(paidPlan);
    expect(JSON.parse(String(kv.store.get(CACHE_KEY)))).toEqual(paidPlan);
    expect(kv.store.get(NEGATIVE_KEY)).toBeDefined();
  });

  it("fails OPEN to unlimited when the request throws and nothing is cached", async () => {
    const { env: e, kv } = env();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("The operation timed out"));
    const result = await new RemoteEntitlements(e, noopLogger).refresh("usr_1", "user");
    expect(result.success && result.data.source).toBe("default");
    expect(result.success && result.data.entitlements).toEqual(UnlimitedEntitlements);
    expect(kv.store.get(NEGATIVE_KEY)).toBeDefined();
  });

  it("fails OPEN on an unparseable body", async () => {
    const { env: e } = env();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>oops</html>"));
    const result = await new RemoteEntitlements(e, noopLogger).refresh("usr_1", "user");
    expect(result.success && result.data.source).toBe("default");
  });

  it("does nothing and reports 'default' when the hook is unconfigured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await new RemoteEntitlements({} as Env, noopLogger).refresh("usr_1", "user");
    expect(result.success && result.data.source).toBe("default");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("warmEntitlements", () => {
  function collector(): { waitUntil: (p: Promise<unknown>) => void; settle: () => Promise<void> } {
    const pending: Promise<unknown>[] = [];
    return {
      waitUntil: (p) => {
        pending.push(p);
      },
      settle: async () => {
        await Promise.all(pending);
      },
    };
  }

  it("warms the cache so a later forOwner reads it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(paidPlan));
    const { env: e } = env();
    const ctx = collector();
    warmEntitlements(e, ctx.waitUntil, { ownerId: "usr_1", ownerType: "user" }, noopLogger);
    await ctx.settle();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const read = await new RemoteEntitlements(e, noopLogger).forOwner("usr_1", "user");
    expect(read.success && read.data.source).toBe("cache");
    expect(read.success && read.data.entitlements).toEqual(paidPlan);
  });

  it("single-flights concurrent cold warms into one request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(paidPlan));
    const { env: e } = env();
    const ctx = collector();
    const subject = { ownerId: "usr_1", ownerType: "user" as const };
    warmEntitlements(e, ctx.waitUntil, subject, noopLogger);
    warmEntitlements(e, ctx.waitUntil, subject, noopLogger);
    warmEntitlements(e, ctx.waitUntil, subject, noopLogger);
    await ctx.settle();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("respects a lock another isolate holds", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { env: e, kv } = env();
    kv.store.set(LOCK_KEY, "1");
    const ctx = collector();
    warmEntitlements(e, ctx.waitUntil, { ownerId: "usr_1", ownerType: "user" }, noopLogger);
    await ctx.settle();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("releases its own lock once the answer is cached", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(paidPlan));
    const { env: e, kv } = env();
    const ctx = collector();
    warmEntitlements(e, ctx.waitUntil, { ownerId: "usr_1", ownerType: "user" }, noopLogger);
    await ctx.settle();
    expect(kv.store.has(LOCK_KEY)).toBe(false);
  });

  it("does not re-fetch while a negative-cache entry stands", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { env: e, kv } = env();
    kv.store.set(NEGATIVE_KEY, String(Date.now()));
    const ctx = collector();
    warmEntitlements(e, ctx.waitUntil, { ownerId: "usr_1", ownerType: "user" }, noopLogger);
    await ctx.settle();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips a warm cache", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { env: e, kv } = env();
    kv.store.set(CACHE_KEY, JSON.stringify(paidPlan));
    const ctx = collector();
    warmEntitlements(e, ctx.waitUntil, { ownerId: "usr_1", ownerType: "user" }, noopLogger);
    await ctx.settle();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is inert with no execution context, unconfigured env, or no owner", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { env: e } = env();
    const ctx = collector();
    warmEntitlements(e, undefined, { ownerId: "usr_1", ownerType: "user" }, noopLogger);
    warmEntitlements(
      unconfiguredEnv(),
      ctx.waitUntil,
      { ownerId: "usr_1", ownerType: "user" },
      noopLogger,
    );
    warmEntitlements(e, ctx.waitUntil, { ownerId: "", ownerType: "user" }, noopLogger);
    await ctx.settle();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
