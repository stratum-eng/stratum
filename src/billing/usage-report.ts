/**
 * What one account has consumed against what its plan allows.
 *
 * The single read behind both visibility surfaces of PRD §8 and §4c — the
 * server-rendered `/settings/usage` page and the `stratum_get_usage` MCP tool —
 * so a human and an agent are never shown two different answers to the same
 * question.
 *
 * Three properties are load bearing, and all three are easy to get wrong:
 *
 * - **The subject is the §4a ENFORCEMENT subject**, resolved through
 *   {@link resolveEnforcementSubject}, not the recorded billing subject. A
 *   limit is checked against the acting person, so a page that reported the
 *   recorded owner's totals would show a number no limit is ever compared to.
 *   That is not the same as reading the actor's `usage_periods` rows, and the
 *   difference is the reason {@link UsageReport.usedSource} exists: for a
 *   project in an org namespace the LEDGER records the ORG (deliberately — a
 *   ledger says what happened) while the CHECK charges the actor's counter. A
 *   user working only in org namespaces has no rows of their own at all, so a
 *   page summing D1 alone showed them `0 of 10,000` while the counter refusing
 *   them was full. So `used` is the counter where there is one, floored by the
 *   ledger — which is exactly the pair `checkMeter` compares against a limit,
 *   since `reconcileFloor` raises the counter to the same filtered D1 sum.
 * - **Consumption is `source = 'platform'` only.** Migration 049 keys usage on
 *   `(owner_id, period, meter, source)` precisely so BYOK spend accumulates
 *   apart, and Goal 5 says it is not under the hosted allowance. Summing both
 *   would tell someone their own provider bill had eaten an allowance it never
 *   touched. BYOK is reported as its OWN figure, for information, never folded
 *   into `used`.
 * - **`-1` is unlimited and says so.** A self-hoster's every limit is `-1`
 *   (`UnlimitedEntitlements`), so a renderer that turned a limit into a
 *   percentage would show them an empty or a divide-by-zero bar on every row
 *   and look broken. {@link UsageMeterReport.unlimited} is the flag a caller
 *   branches on, and `percentUsed` is `null` rather than a made-up number.
 *
 * Read-only throughout: nothing here reserves, settles, records or mutates.
 */
import { usageMeterName } from "../queue/usage-meter";
import { type MeterKey, getOwnerMeterTotals, isMeterKey, usagePeriod } from "../storage/usage";
import type { Env } from "../types";
import { type AppError, ValidationError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { periodResetsAt, resolveEnforcementSubject } from "./enforcement";
import {
  METER_KEYS,
  RATE_KEYS,
  type RateKey,
  RemoteEntitlements,
  UNLIMITED,
  UnlimitedEntitlements,
  entitlementsEnabled,
} from "./entitlements";

/** One meter's consumption this period, and the allowance it is measured against. */
export interface UsageMeterReport {
  meter: MeterKey;
  /** Hosted consumption — `source = 'platform'`, the only kind a limit binds. */
  used: number;
  /**
   * Bring-your-own-key consumption, reported apart and never added to
   * {@link UsageMeterReport.used}: it is spent on the project's own provider
   * account and no allowance applies to it (Goal 5).
   */
  byok: number;
  /** `-1` unlimited, `0` a hard block, otherwise the ceiling. */
  limit: number;
  /** True when `limit` is `-1`. Callers render words, not an empty bar. */
  unlimited: boolean;
  /** True when `limit` is `0` — not "unset", a plan that forbids this outright. */
  blocked: boolean;
  /** `used / limit` as a percentage, or `null` when there is no finite limit. */
  percentUsed: number | null;
  /** What is left of a finite allowance, floored at zero; `null` when unlimited. */
  remaining: number | null;
}

/** A rate ceiling. Reported as a limit only — its window lives on the meter object, not in D1. */
export interface UsageRateReport {
  rate: RateKey;
  limit: number;
  unlimited: boolean;
}

export interface UsageReport {
  /** Whose allowance this is — the §4a enforcement subject. */
  subject: { ownerId: string; ownerType: "user" | "org" };
  /**
   * Where the `used` figures came from, so a surface can say which it is
   * showing instead of implying a precision it does not have.
   *
   * `"meter"` is the live enforcement counter, the number a limit is actually
   * compared against, floored by the ledger. `"ledger"` is `usage_periods`
   * alone — every self-hoster, and any instance whose meter binding is missing
   * or unreadable — which counts spend RECORDED against this subject and so
   * omits work done in an org namespace, where the org is the recorded owner.
   */
  usedSource: "meter" | "ledger";
  /** Opaque plan name from the billing service; `"unlimited"` when there is none. */
  plan: string;
  /**
   * Whether any allowance is in force at all. False for every self-hoster (no
   * `BILLING_SERVICE_URL`), which is why the page must read as "unlimited"
   * rather than as "we could not load your usage".
   */
  metered: boolean;
  /** 'YYYY-MM' UTC. */
  period: string;
  /** ISO 8601 instant the monthly meters roll over. */
  resetsAt: string;
  meters: UsageMeterReport[];
  rates: UsageRateReport[];
}

/**
 * A short display name per meter, for a column heading or a banner sentence.
 *
 * Deliberately not `enforcement.ts`'s `meterLabel`, which builds the fragment
 * "monthly LLM token allowance" for the middle of a refusal sentence. This one
 * is a heading; sharing one string would make one of the two read badly.
 */
export function meterTitle(meter: MeterKey): string {
  switch (meter) {
    case "llm_tokens_month":
      return "LLM tokens";
    case "sandbox_ms_month":
      return "Sandbox time";
    case "deploys_month":
      return "Deploys";
    default:
      return meter;
  }
}

function meterEntry(
  meter: MeterKey,
  limit: number,
  platform: Partial<Record<MeterKey, number>>,
  byok: Partial<Record<MeterKey, number>>,
  counter: Partial<Record<MeterKey, number>> | null,
): UsageMeterReport {
  // The higher of the two, which is what a limit check sees: the counter leads
  // the ledger (a reservation is taken before the spend, and it holds the
  // actor's org-namespace work, which the ledger records against the org),
  // while `reconcileFloor` raises the counter to the ledger whenever the ledger
  // is ahead. Neither alone is the number that refuses somebody.
  const used = Math.max(platform[meter] ?? 0, counter?.[meter] ?? 0);
  // A limit the billing service never sent, or sent as garbage, has already
  // been discarded by `parseEntitlements`; anything still non-integer here is
  // treated as "no usable limit" for the same reason `checkGauge` does — a
  // limit derived from garbage must not render as a bar someone acts on.
  const usable = Number.isInteger(limit);
  const unlimited = !usable || limit === UNLIMITED;
  const finite = usable && limit > 0;
  return {
    meter,
    used,
    byok: byok[meter] ?? 0,
    limit,
    unlimited,
    blocked: usable && limit === 0,
    percentUsed: finite ? Math.round((used / limit) * 100) : null,
    remaining: finite ? Math.max(0, limit - used) : null,
  };
}

/**
 * Build one account's usage report for a period.
 *
 * @param opts.actorUserId - The signed-in user, or an agent's owner (§4a)
 * @param opts.at - The moment whose period to report; defaults to now
 * @param opts.includeByok - Read the `byok` totals too. The page shows them as
 *   a separate labelled figure; the MCP tool does not ask for them, and the
 *   flag keeps that read off a path that would only discard it.
 * @returns The report, or the error that stopped it. A caller mistake (no
 *   actor) is an error rather than an empty report — "you have used nothing"
 *   is a claim, and it must not be made about nobody.
 */
export async function buildUsageReport(
  env: Env,
  logger: Logger,
  opts: { actorUserId: string; at?: Date; includeByok?: boolean },
): Promise<Result<UsageReport, AppError>> {
  if (!opts.actorUserId) {
    return err(new ValidationError("Usage requested without an actor"));
  }
  const at = opts.at ?? new Date();
  const period = usagePeriod(at);

  // No project in hand, so this resolves to the actor itself and performs no
  // I/O — which is exactly §4a's answer for "whose allowance is this page
  // about": the person reading it, never an org they happen to belong to.
  const subject = await resolveEnforcementSubject(env, logger, { actorUserId: opts.actorUserId });
  if (!subject) {
    return err(new ValidationError("Usage subject could not be resolved"));
  }

  const resolved = await new RemoteEntitlements(env, logger).forOwner(
    subject.ownerId,
    subject.ownerType,
  );
  if (!resolved.success) {
    // Fails open exactly as every other reader does: an unreachable billing
    // service shows unlimited rather than a page full of errors. Logged, not
    // dropped — a page telling somebody they have no limits because the limits
    // could not be read must be diagnosable from the log (AGENTS.md).
    logger.warn("Usage report fell back to unlimited: entitlements unreadable", {
      subjectId: subject.ownerId,
      subjectType: subject.ownerType,
      error: resolved.error.message,
    });
  }
  const entitlements = resolved.success ? resolved.data.entitlements : UnlimitedEntitlements;

  // The same read `reconcileFloor` performs before a limit check, with the same
  // `source` filter. Anything else would be a second definition of "used". It
  // is the FLOOR under the figure reported, not the figure itself — see below.
  const platform = await getOwnerMeterTotals(env.DB, logger, subject.ownerId, period, "platform");
  if (!platform.success) return err(platform.error);

  const counter = await readMeterCounts(env, logger, subject, period);

  let byok: Partial<Record<MeterKey, number>> = {};
  if (opts.includeByok) {
    const read = await getOwnerMeterTotals(env.DB, logger, subject.ownerId, period, "byok");
    // A failed BYOK read is not worth failing the page over: it is an
    // informational figure beside the allowance, not the allowance itself.
    if (read.success) byok = read.data;
  }

  return ok({
    subject: { ownerId: subject.ownerId, ownerType: subject.ownerType },
    usedSource: counter === null ? "ledger" : "meter",
    plan: entitlements.plan,
    metered: entitlementsEnabled(env),
    period,
    resetsAt: periodResetsAt(period),
    meters: METER_KEYS.map((meter) =>
      meterEntry(meter, entitlements.meters[meter], platform.data, byok, counter),
    ),
    rates: RATE_KEYS.map((rate) => {
      const limit = entitlements.rates[rate];
      return { rate, limit, unlimited: !Number.isInteger(limit) || limit === UNLIMITED };
    }),
  });
}

/**
 * This subject's live enforcement counters for the period, or `null` when there
 * are none to read.
 *
 * `null` is not a failure to hide: it is every self-hosted instance (no billing
 * service, so nothing ever reserved), an instance whose `USAGE_METER` binding is
 * missing, and an object that could not be reached. The caller reports which of
 * the two numbers it is showing rather than silently presenting one as the
 * other.
 *
 * Read-only: this is `read`, never `reserve`, so looking at the usage page
 * cannot consume any part of an allowance.
 */
async function readMeterCounts(
  env: Env,
  logger: Logger,
  subject: { ownerId: string; ownerType: "user" | "org" },
  period: string,
): Promise<Partial<Record<MeterKey, number>> | null> {
  if (!entitlementsEnabled(env)) return null;
  const namespace = env.USAGE_METER;
  if (!namespace) return null;
  try {
    const stub = namespace.get(
      namespace.idFromName(usageMeterName(subject.ownerType, subject.ownerId)),
    );
    const snapshot = await stub.read(period);
    const counts: Partial<Record<MeterKey, number>> = {};
    for (const [meter, quantity] of Object.entries(snapshot.counts)) {
      if (isMeterKey(meter) && typeof quantity === "number") counts[meter] = quantity;
    }
    return counts;
  } catch (error) {
    logger.warn("Usage counters unreadable; reporting the ledger instead", {
      subjectId: subject.ownerId,
      subjectType: subject.ownerType,
      period,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
