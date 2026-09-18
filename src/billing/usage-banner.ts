/**
 * The 80% banner: the same crossing the email announces, shown on the pages a
 * signed-in user actually visits (PRD §8, Task 9.3).
 *
 * ## Why it is a stored receipt and not a computed check
 *
 * "Are you near a limit?" is a question about D1 (`usage_periods`) and the
 * billing service, and asking it on every page render would put a database
 * read and an entitlements lookup in front of every dashboard, project and
 * change page — for a banner that is absent for almost everyone, almost
 * always. So nothing is computed here. `usage-notifications.ts` already
 * detects the crossing exactly once, on the write that causes it, from the
 * totals `upsertUsage` returns; {@link recordUsageBanner} stores what it
 * found, and rendering costs **one KV `get`** and no D1 at all.
 *
 * The cost is bounded further: {@link loadUsageBanner} returns immediately —
 * with no KV read whatsoever — when there is no signed-in user or when
 * `entitlementsEnabled` is false, so a self-hoster's pages are byte-for-byte
 * as cheap as before.
 *
 * ## Users only
 *
 * There is no org UI in this application, so an org's threshold reaches its
 * actor by email alone (PRD §8). A banner is therefore written only when the
 * enforcement subject IS a user, and is keyed on that user.
 *
 * ## One entry per (user, period), holding one notice per meter
 *
 * A key per meter would cost one KV read per meter on every page render, for a
 * banner that is absent for almost everyone; a single notice per period silently
 * lost the first crossing when a second meter crossed. So the entry holds a
 * notice per meter and the reader renders the one nearest its limit — still one
 * `get`, and no crossing is overwritten by another.
 *
 * ## What it costs in freshness, stated rather than discovered
 *
 * The stored notice is a SNAPSHOT of the crossing, not a live figure: at 80% of
 * 1,000 it says "800 of 1,000", and it still says that at 999. So it understates
 * how little headroom is left for the rest of the period — and it overstates the
 * usage if the account's limit is RAISED mid-period, until the period rolls.
 * Both are why the banner reports a threshold that was crossed rather than a
 * balance, and why it links to `/settings/usage`, which reads live figures. The
 * alternative — re-reading entitlements and usage per page — is the cost this
 * design exists to avoid.
 */
import { type MeterKey, isMeterKey } from "../storage/usage";
import type { Env } from "../types";
import type { Logger } from "../utils/logger";
import { enforcementBinding } from "./enforcement";
import { entitlementsEnabled } from "./entitlements";

/** One crossing, as it is stored. Every field is display data. */
export interface StoredUsageBanner {
  meter: MeterKey;
  /** Hosted consumption at the moment of the crossing. */
  used: number;
  /** The limit in force then. See the freshness note in the module doc. */
  limit: number;
  /** The threshold that was crossed, as a percentage (80). */
  percent: number;
  /** 'YYYY-MM' UTC — the period the figures belong to. */
  period: string;
}

/** What a rendered banner says: a stored crossing plus what it means right now. */
export interface UsageBannerNotice extends StoredUsageBanner {
  /**
   * Whether limits actually bind on this instance right now
   * (`enforcementBinding`). Decided at READ time and never stored: the copy has
   * to say "is refused" or "nothing is refused yet", and during the observe-only
   * month the second one is the true sentence. A stored flag would keep
   * asserting whichever mode was on when the crossing happened.
   */
  enforcing: boolean;
}

/**
 * Versioned like the entitlements cache: a shape change must not read back as
 * the old shape. Bumped to v2 when the entry became one notice per METER — a v1
 * entry is a bare notice and would parse as an empty set of them.
 */
const BANNER_PREFIX = "usage-banner:v2:";

/**
 * A month plus the grace the meter itself allows. The period is IN the key, so
 * a new month silently reads as "no banner" without anything sweeping the old
 * one; the TTL is only what stops KV accumulating them forever.
 */
const BANNER_TTL_SECONDS = 40 * 24 * 60 * 60;

function bannerKey(userId: string, period: string): string {
  return `${BANNER_PREFIX}${userId}:${period}`;
}

/**
 * Store the crossing so the next page render can show it, keeping any crossing
 * already recorded for another meter this period.
 *
 * Read-modify-write rather than a blind put, because the entry is per period and
 * a second meter's crossing used to overwrite the first — the user was warned
 * about tokens and never about deploys. The race a read-modify-write admits is
 * bounded to nothing worse than that same lost banner: crossings are
 * edge-triggered and deduped by their own receipt, so at most one write per
 * (meter, limit) exists to be lost, and the 100% refusal still speaks.
 *
 * Best-effort by contract, like everything on the notification path: a banner
 * that cannot be written must never fail the merge whose usage produced it.
 */
export async function recordUsageBanner(
  env: Env,
  logger: Logger,
  userId: string,
  notice: StoredUsageBanner,
): Promise<void> {
  if (!env.STATE || !userId) return;
  const key = bannerKey(userId, notice.period);
  try {
    const existing = parseEntry(await readJson(env, key), notice.period);
    const merged = existing.filter((entry) => entry.meter !== notice.meter);
    merged.push(notice);
    await env.STATE.put(key, JSON.stringify({ notices: merged }), {
      expirationTtl: BANNER_TTL_SECONDS,
    });
  } catch (error) {
    logger.warn("Usage banner could not be stored", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The banner to render for this user right now, or `null`.
 *
 * One KV read, and none at all when the seam is off or nobody is signed in.
 * Every failure and every unrecognised value resolves to `null`: a page is not
 * worth failing for a notice, and a half-parsed one would render nonsense.
 *
 * When several meters have crossed, the one FURTHEST through its allowance is
 * shown: one banner is the shared chrome's budget, and the meter nearest the
 * wall is the one worth the reader's attention.
 *
 * @param userId - The signed-in user; agents are not shown pages
 * @param period - 'YYYY-MM' UTC; the caller passes the period it is rendering
 */
export async function loadUsageBanner(
  env: Env,
  logger: Logger,
  userId: string | undefined,
  period: string,
): Promise<UsageBannerNotice | null> {
  if (!userId) return null;
  if (!entitlementsEnabled(env)) return null;
  if (!env.STATE) return null;
  try {
    const notices = parseEntry(await readJson(env, bannerKey(userId, period)), period);
    let worst: StoredUsageBanner | null = null;
    for (const notice of notices) {
      if (!worst || notice.used / notice.limit > worst.used / worst.limit) worst = notice;
    }
    return worst === null ? null : { ...worst, enforcing: enforcementBinding(env) };
  } catch (error) {
    logger.debug("Usage banner unreadable; rendering without it", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** The stored entry, or `null`. Throws nothing a caller has not already caught. */
async function readJson(env: Env, key: string): Promise<unknown> {
  const raw = await env.STATE?.get(key);
  return raw ? JSON.parse(raw) : null;
}

/**
 * Validated on the way out, not trusted because we wrote it: the entry outlives
 * deploys, and a notice from an older shape must vanish rather than render as
 * "NaN% of undefined". An unrecognised entry reads as "no crossings", which is
 * also what a v1 entry does — the prefix is versioned, so it cannot be read at
 * all, and this is the belt to that brace.
 */
function parseEntry(value: unknown, period: string): StoredUsageBanner[] {
  if (typeof value !== "object" || value === null) return [];
  const { notices } = value as { notices?: unknown };
  if (!Array.isArray(notices)) return [];
  const parsed: StoredUsageBanner[] = [];
  for (const entry of notices) {
    const notice = parseNotice(entry, period);
    if (notice) parsed.push(notice);
  }
  return parsed;
}

function parseNotice(value: unknown, period: string): StoredUsageBanner | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { meter, used, limit, percent } = record;
  // Validated against the known set, not cast: `meterTitle` and the page both
  // key off it, and a meter this build does not have a name for renders as a
  // raw column value in the shared chrome of every page.
  if (!isMeterKey(meter)) return null;
  if (!Number.isFinite(used) || !Number.isFinite(limit) || !Number.isFinite(percent)) return null;
  if ((limit as number) <= 0) return null;
  return {
    meter,
    used: used as number,
    limit: limit as number,
    percent: percent as number,
    // The key already pins the period; echoing the caller's keeps a mismatched
    // stored value from being displayed against the month it was not about.
    period,
  };
}
