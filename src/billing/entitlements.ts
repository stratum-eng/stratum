/**
 * Entitlements — what one billing subject's plan allows (Stratum Cloud only).
 *
 * This is a cloud-only hook living in the AGPL tree, in the shape `src/beta/gate.ts`
 * established: the plan service itself lives in the cloud layer, core just asks it.
 * When `BILLING_SERVICE_URL` / `BILLING_SERVICE_SECRET` are unset — the default for
 * every OSS self-hoster — every function here is inert and every owner resolves to
 * `UnlimitedEntitlements`, which is exactly today's behavior.
 *
 * Three key sets, deliberately not one union, because they are not one kind of
 * thing and do not live in one place: a `MeterKey` is a monthly *flow* accumulated
 * in `usage_periods`, a `CountKey` is a *gauge* counted on demand, and a `RateKey`
 * is a *rate* over a short window, enforced out of KV or off the usage meter but
 * never out of the monthly aggregate. Collapsing them invites a limit to be
 * looked up from the wrong store.
 *
 * ## Fail OPEN — deliberately the opposite of the beta gate
 *
 * `validateInviteCode` (`src/beta/gate.ts`) fails CLOSED on timeout, non-OK or a
 * parse failure: a signup wall that opens under load is not a wall. Entitlements
 * do the reverse. On any failure to reach or understand the billing service we
 * serve the cached value, and with no cache `UnlimitedEntitlements`. A billing
 * outage that blocks a paying customer's merge is strictly worse than minutes of
 * unmetered usage; the hole is bounded by the cache TTL and is an accepted cost.
 *
 * Do not "correct" this to match the gate. The two hooks look alike and want
 * opposite failure modes, which is why both say so in their own doc comments.
 *
 * ## Reading a limit
 *
 * `-1` means unlimited. **`0` means a hard block** — not "unset", not "unlimited";
 * an owner whose limit is `0` may not consume that resource at all. Both readings
 * of `0` exist in the wild, so this file fixes one and callers can rely on it.
 * Any other value that is not a non-negative integer — a string, `NaN`, `1.5`,
 * `-7` — is DISCARDED in favor of the cached or default value for that field, and
 * never coerced: a limit derived from garbage is worse than a limit we admit we
 * do not have.
 *
 * NOTHING here enforces anything. Defining and fetching entitlements is separate
 * from consulting them (PRD §8) precisely so the fetch can be observed for a month
 * before it decides anything.
 */
import { METER_KEYS, type MeterKey } from "../storage/usage";
import type { Env } from "../types";
import { type AppError, ValidationError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/** A gauge counted on demand, not a monthly flow — there is no `private_projects` meter. */
export type CountKey = "private_projects";

/**
 * A bound on how often something may happen, rather than on how much it spends.
 *
 * The two members are enforced in different places on purpose, and the split is
 * the one PRD §4b argues: `requests_per_minute` stays on the KV request limiter,
 * where the bucket rolls as fast as KV goes stale, and `evaluations_per_hour`
 * lives on the `UsageMeter` Durable Object, because an hour-long window read
 * through a per-colo cache that is a minute stale is not a limit at all.
 */
export type RateKey = "requests_per_minute" | "evaluations_per_hour";

/**
 * Every meter a limit may be set on. Re-exported from the storage layer that
 * defines `MeterKey` rather than restated here: two lists that could drift are
 * two answers to "which meters exist", and `parseEntitlements` reads this one.
 */
export { METER_KEYS };

export const COUNT_KEYS: readonly CountKey[] = ["private_projects"];

export const RATE_KEYS: readonly RateKey[] = ["requests_per_minute", "evaluations_per_hour"];

/**
 * One billing subject's allowances.
 *
 * Every limit is `-1` (unlimited), `0` (hard block) or a positive integer. The
 * record is total over each key set on purpose: a missing key would make "no
 * limit configured" and "limit of zero" indistinguishable at the call site.
 */
export interface Entitlements {
  /** Opaque plan identifier as the billing service names it; for display and logs. */
  plan: string;
  /**
   * Whether an ORG on this plan pools its members' usage onto the org itself
   * (PRD §4a).
   *
   * Explicit rather than derived from {@link Entitlements.plan}, which is an
   * opaque display string: pooling decides WHOSE allowance a spend is checked
   * against, and inferring that from a name the billing service is free to
   * change is how a rename becomes a free-usage hole.
   *
   * It defaults to `false`, and that default is load bearing — it is the one
   * place this file does not fail open. `forOwner` never fetches and org
   * entitlements are never warmed by the auth path, so an org's plan is always
   * a cache miss on FIRST contact; reading an unknown plan as "pooled" would
   * make every org its own unlimited subject permanently, which is exactly the
   * hole the enforcement subject exists to close. Unknown therefore means free,
   * and the acting user is charged instead.
   */
  pooled: boolean;
  meters: Record<MeterKey, number>;
  counts: Record<CountKey, number>;
  rates: Record<RateKey, number>;
}

/**
 * Where a resolved value came from.
 *
 * Carried because observe-only telemetry that cannot tell "unlimited because that
 * is the plan" from "unlimited because the billing service timed out" cannot
 * measure anything: a month of measurement would be indistinguishable from a
 * month of outage.
 */
export type EntitlementsSource = "remote" | "cache" | "default";

export interface EntitlementsResolution {
  entitlements: Entitlements;
  source: EntitlementsSource;
}

export interface EntitlementsProvider {
  /**
   * The allowances in force for one billing subject.
   *
   * A `Result` rather than a throw per AGENTS.md ("errors are values"). Because
   * resolution fails open, the error arm is reserved for a caller mistake — an
   * unidentified subject — which must not silently resolve to "unlimited".
   */
  forOwner(
    ownerId: string,
    ownerType: "user" | "org",
  ): Promise<Result<EntitlementsResolution, AppError>>;
}

/** The value of a limit that is not a limit. */
export const UNLIMITED = -1;

/** The plan name reported when nobody has told us a real one. */
const DEFAULT_PLAN = "unlimited";

/**
 * The default in every sense: what a self-hoster always gets, and what a cloud
 * request falls back to when the billing service cannot be reached and nothing
 * is cached. Frozen because it is shared by every such resolution.
 */
export const UnlimitedEntitlements: Entitlements = Object.freeze({
  plan: DEFAULT_PLAN,
  meters: Object.freeze({
    llm_tokens_month: UNLIMITED,
    sandbox_ms_month: UNLIMITED,
    deploys_month: UNLIMITED,
  }),
  counts: Object.freeze({ private_projects: UNLIMITED }),
  rates: Object.freeze({ requests_per_minute: UNLIMITED, evaluations_per_hour: UNLIMITED }),
  // Never pooled by default: "we do not know this org's plan" must not read as
  // "this org pools", or an unknown org becomes a fresh allowance. See the
  // field's own doc comment.
  pooled: false,
});

/**
 * True only when the service is configured AND we hold a credential for it —
 * mirroring `betaGateEnabled`. A URL without a secret is a misconfiguration that
 * would produce a request the service rejects on every single hit, so it counts
 * as off rather than as half-on.
 */
export function entitlementsEnabled(env: Env): boolean {
  return !!env.BILLING_SERVICE_URL && !!env.BILLING_SERVICE_SECRET;
}

/**
 * Cap how long a warm can wait on the billing service. This runs off the response
 * path via `waitUntil`, so the timeout is not protecting a user's latency — it is
 * bounding how long a Worker invocation is kept alive by a hung dependency.
 */
const BILLING_TIMEOUT_MS = 5000;

/** Positive cache lifetime (PRD §4). Consequence: an upgrade takes effect up to this late. */
const CACHE_TTL_SECONDS = 300;

/**
 * Negative-cache and lock lifetime. Both are "as short as possible": KV's minimum
 * `expirationTtl` is 60 seconds, so this is the floor, not a tuned value. The
 * negative entry keeps a hard outage from being re-fetched once per request; the
 * lock keeps a cold cache from stampeding the service.
 */
const FAILURE_TTL_SECONDS = 60;

/**
 * Versioned so a shape change cannot be read back as the old shape.
 *
 * Bumped to v2 by the enforcement work: `pooled` and `evaluations_per_hour`
 * joined the payload, and a v1 entry read back through the new parser would
 * silently take the defaults for both — which for `pooled` is the safe answer
 * and for `evaluations_per_hour` is "unlimited". Neither is a value anybody
 * chose, so the old entries are abandoned rather than reinterpreted. The
 * billing service's response contract changes with it (private cloud layer).
 */
const KEY_PREFIX = "entitlements:v2:";

function cacheKey(ownerType: string, ownerId: string): string {
  return `${KEY_PREFIX}${ownerType}:${ownerId}`;
}

function negativeKey(ownerType: string, ownerId: string): string {
  return `${KEY_PREFIX}neg:${ownerType}:${ownerId}`;
}

function lockKey(ownerType: string, ownerId: string): string {
  return `${KEY_PREFIX}lock:${ownerType}:${ownerId}`;
}

function serviceUrl(env: Env, path: string): string {
  return `${(env.BILLING_SERVICE_URL ?? "").replace(/\/$/, "")}${path}`;
}

/**
 * One limit, or `null` when the service sent something that is not one.
 *
 * `Number.isInteger` rejects strings, `NaN` and both infinities in one check, so
 * a JSON `"100"` is discarded rather than becoming 100 — a limit we invented is
 * indistinguishable, downstream, from one the customer is paying for.
 */
function parseLimit(value: unknown): number | null {
  if (!Number.isInteger(value)) return null;
  const limit = value as number;
  if (limit < 0 && limit !== UNLIMITED) return null;
  return limit;
}

/**
 * Build entitlements field by field, keeping `fallback`'s value for anything the
 * payload does not supply validly.
 *
 * Field by field rather than all-or-nothing so one bad key does not throw away
 * the rest of a customer's plan — and never partially: every key is present in
 * the result because it was present in `fallback`.
 */
function parseEntitlements(payload: unknown, fallback: Entitlements): Entitlements {
  const record = (typeof payload === "object" && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
  const readGroup = <K extends string>(
    group: unknown,
    keys: readonly K[],
    defaults: Record<K, number>,
  ): Record<K, number> => {
    const source = (typeof group === "object" && group !== null ? group : {}) as Record<
      string,
      unknown
    >;
    const out = {} as Record<K, number>;
    for (const key of keys) {
      out[key] = parseLimit(source[key]) ?? defaults[key];
    }
    return out;
  };

  const plan = typeof record.plan === "string" && record.plan.trim() ? record.plan.trim() : null;
  return {
    plan: plan ?? fallback.plan,
    // Only a real boolean pools. A truthy string or a 1 is a payload we do not
    // understand, and the safe reading of that is "not positively known".
    pooled: typeof record.pooled === "boolean" ? record.pooled : fallback.pooled,
    meters: readGroup(record.meters, METER_KEYS, fallback.meters),
    counts: readGroup(record.counts, COUNT_KEYS, fallback.counts),
    rates: readGroup(record.rates, RATE_KEYS, fallback.rates),
  };
}

/**
 * Entitlements from the cloud billing service, cached in KV.
 *
 * `forOwner` is a CACHED READ and never touches the network: it is called on the
 * request path, and a cold cache there would put a 5-second dependency in front
 * of a merge. The network fetch happens in `refresh`, which `warmEntitlements`
 * runs off the response path after auth — that is what makes the cached read hit.
 */
export class RemoteEntitlements implements EntitlementsProvider {
  constructor(
    private readonly env: Env,
    private readonly logger: Logger,
  ) {}

  async forOwner(
    ownerId: string,
    ownerType: "user" | "org",
  ): Promise<Result<EntitlementsResolution, AppError>> {
    if (!ownerId) {
      // Not a fail-open case: an unidentified subject is a bug in the caller, and
      // answering "unlimited" would hide it behind exactly the behavior it breaks.
      return err(new ValidationError("Entitlements requested without an owner id", { ownerType }));
    }
    if (!entitlementsEnabled(this.env)) {
      return ok({ entitlements: UnlimitedEntitlements, source: "default" });
    }
    const cached = await this.readCache(ownerId, ownerType);
    if (cached) return ok({ entitlements: cached, source: "cache" });
    return ok({ entitlements: UnlimitedEntitlements, source: "default" });
  }

  /**
   * Ask the billing service and populate the cache.
   *
   * Fails open (see the module doc comment): a timeout, a non-OK status or an
   * unparseable body all serve the cached value, or `UnlimitedEntitlements` when
   * there is none, and record a negative-cache entry so an outage is not
   * re-fetched once per request.
   */
  async refresh(
    ownerId: string,
    ownerType: "user" | "org",
  ): Promise<Result<EntitlementsResolution, AppError>> {
    if (!ownerId) {
      return err(new ValidationError("Entitlements refresh without an owner id", { ownerType }));
    }
    if (!entitlementsEnabled(this.env)) {
      return ok({ entitlements: UnlimitedEntitlements, source: "default" });
    }

    const cached = await this.readCache(ownerId, ownerType);
    const fallback: EntitlementsResolution = cached
      ? { entitlements: cached, source: "cache" }
      : { entitlements: UnlimitedEntitlements, source: "default" };

    try {
      const url = `${serviceUrl(this.env, "/api/billing/entitlements")}?ownerId=${encodeURIComponent(
        ownerId,
      )}&ownerType=${encodeURIComponent(ownerType)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.env.BILLING_SERVICE_SECRET ?? ""}` },
        signal: AbortSignal.timeout(BILLING_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn("Entitlements lookup returned non-OK; failing open", {
          status: res.status,
          ownerId,
          source: fallback.source,
        });
        await this.markFailure(ownerId, ownerType);
        return ok(fallback);
      }
      const entitlements = parseEntitlements(await res.json(), fallback.entitlements);
      await this.writeCache(ownerId, ownerType, entitlements);
      return ok({ entitlements, source: "remote" });
    } catch (error) {
      // Never swallowed: an outage that is invisible is one nobody fixes, and the
      // free usage it hands out is only acceptable while it is being watched.
      this.logger.error(
        "Entitlements lookup failed; failing open",
        error instanceof Error ? error : undefined,
        { ownerId, ownerType, source: fallback.source },
      );
      await this.markFailure(ownerId, ownerType);
      return ok(fallback);
    }
  }

  private async readCache(ownerId: string, ownerType: string): Promise<Entitlements | null> {
    if (!this.env.STATE) return null;
    try {
      const raw = await this.env.STATE.get(cacheKey(ownerType, ownerId));
      if (!raw) return null;
      // Re-validated on the way out, not trusted because we wrote it: the cache
      // outlives deploys, so an entry written by an older shape must degrade to
      // the default rather than be cast into a limit nobody validated.
      return parseEntitlements(JSON.parse(raw), UnlimitedEntitlements);
    } catch (error) {
      this.logger.warn("Entitlements cache read failed; treating as a miss", {
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async writeCache(
    ownerId: string,
    ownerType: string,
    entitlements: Entitlements,
  ): Promise<void> {
    if (!this.env.STATE) return;
    try {
      await this.env.STATE.put(cacheKey(ownerType, ownerId), JSON.stringify(entitlements), {
        expirationTtl: CACHE_TTL_SECONDS,
      });
      await this.env.STATE.delete(negativeKey(ownerType, ownerId));
    } catch (error) {
      this.logger.warn("Entitlements cache write failed", {
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Record that the service just failed, in its OWN key: a failure must never
   * overwrite a good cached plan, or one blip would demote a paying customer to
   * the default for a full TTL.
   */
  private async markFailure(ownerId: string, ownerType: string): Promise<void> {
    if (!this.env.STATE) return;
    try {
      await this.env.STATE.put(negativeKey(ownerType, ownerId), String(Date.now()), {
        expirationTtl: FAILURE_TTL_SECONDS,
      });
    } catch {
      // A failure to record a failure changes nothing about the answer we already
      // have; the fetch failure itself was logged above.
    }
  }
}

/**
 * Refreshes in flight in THIS isolate, keyed by cache key.
 *
 * Two layers of single-flight because there are two stampedes. KV has no
 * compare-and-set, so its lock is best-effort and cross-isolate only — two
 * concurrent requests in one isolate can both read a null lock before either
 * writes it. This map closes that window exactly where it is widest: one isolate
 * handling a burst of requests for the same owner.
 */
const inFlightWarms = new Map<string, Promise<void>>();

/**
 * Warm one owner's entitlements cache off the response path.
 *
 * Called after auth resolves an identity, so `forOwner`'s cached read hits on
 * subsequent requests — without this the cached read would be permanently cold
 * and every enforcement site would see `source: "default"` forever.
 *
 * Fire-and-forget by construction: it schedules on `waitUntil` and returns
 * nothing. With no `ExecutionContext` (unit tests, non-Workers runtimes) it does
 * NOT fall back to awaiting inline — unlike the token `last_used` touches nearby,
 * which are cheap local writes. This one is a cross-network call, and putting it
 * on the request path is the exact latency this design avoids. Skipping it is
 * safe: readers fail open.
 */
export function warmEntitlements(
  env: Env,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  subject: { ownerId: string; ownerType: "user" | "org" },
  logger: Logger,
): void {
  if (!waitUntil) return;
  if (!subject.ownerId) return;
  if (!entitlementsEnabled(env)) return;
  if (!env.STATE) return;

  const key = cacheKey(subject.ownerType, subject.ownerId);
  const existing = inFlightWarms.get(key);
  if (existing) {
    waitUntil(existing);
    return;
  }
  const run = warmOnce(env, subject, logger).finally(() => {
    inFlightWarms.delete(key);
  });
  inFlightWarms.set(key, run);
  waitUntil(run);
}

async function warmOnce(
  env: Env,
  subject: { ownerId: string; ownerType: "user" | "org" },
  logger: Logger,
): Promise<void> {
  const { ownerId, ownerType } = subject;
  const kv = env.STATE;
  try {
    if (await kv.get(cacheKey(ownerType, ownerId))) return;
    // A recent failure is respected rather than retried: re-fetching per request
    // during an outage is how a fail-open dependency turns into a load generator.
    if (await kv.get(negativeKey(ownerType, ownerId))) return;
    if (await kv.get(lockKey(ownerType, ownerId))) return;
    await kv.put(lockKey(ownerType, ownerId), "1", { expirationTtl: FAILURE_TTL_SECONDS });
  } catch (error) {
    // The lock is an optimization. Losing it must not lose the warm, exactly as
    // the backup runner reasons about its own KV lock.
    logger.warn("Entitlements warm lock unavailable; proceeding without single-flight", {
      ownerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await new RemoteEntitlements(env, logger).refresh(ownerId, ownerType);

  try {
    // Released as soon as the answer is cached; the TTL is only the crash path.
    await kv.delete(lockKey(ownerType, ownerId));
  } catch {
    // Held locks expire on their own. A stuck one costs one TTL of staleness.
  }
}
