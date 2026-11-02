/**
 * Closed-beta gate (Stratum Cloud only).
 *
 * This is the ONLY core hook into the referral/beta program. The program itself
 * lives in the cloud/landing layer; core just calls it. When the gate env vars
 * are unset (the default for OSS self-hosters) every function here is inert and
 * account creation is unchanged.
 *
 * - betaGateEnabled: is the gate switched on and pointed at a service?
 * - validateInviteCode: is this code redeemable? (pre-createUser check)
 * - admitUser: record the redemption + mint the user's 5 codes (post-createUser)
 * - admitAndDeliverCodes: admitUser plus the best-effort email of those codes
 * - fetchInviteCodes: read back the codes a user already holds (profile page)
 */
import { getInviteCodesEmail } from "../email/templates";
import type { Env } from "../types";
import type { Logger } from "../utils/logger";

export interface InviteValidation {
  valid: boolean;
  referrerUserId: string | null;
}

export interface AdmitResult {
  codes: string[];
  referrerUserId: string | null;
}

// Cap how long a signup can wait on the referral service. validateInviteCode
// runs inline in the signup request, so a hung service must not hang signup.
const REFERRAL_TIMEOUT_MS = 5000;

/** True only when the gate is explicitly enabled AND a service URL is configured. */
export function betaGateEnabled(env: Env): boolean {
  return env.BETA_GATE === "1" && !!env.REFERRAL_SERVICE_URL;
}

function serviceUrl(env: Env, path: string): string {
  return `${(env.REFERRAL_SERVICE_URL ?? "").replace(/\/$/, "")}${path}`;
}

/**
 * Check whether an invite code can currently be redeemed. Fails closed
 * ({ valid: false }) on any network/parse error so a service outage cannot
 * silently let ungated users through the beta wall.
 */
export async function validateInviteCode(
  env: Env,
  code: string,
  logger: Logger,
): Promise<InviteValidation> {
  const trimmed = (code ?? "").trim().toUpperCase();
  if (!trimmed) return { valid: false, referrerUserId: null };

  try {
    const res = await fetch(serviceUrl(env, "/api/referral/validate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: trimmed }),
      signal: AbortSignal.timeout(REFERRAL_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn("Invite validation returned non-OK", { status: res.status });
      return { valid: false, referrerUserId: null };
    }
    const data = (await res.json()) as InviteValidation;
    return {
      valid: data.valid === true,
      referrerUserId: data.referrerUserId ?? null,
    };
  } catch (error) {
    logger.error("Invite validation request failed", error instanceof Error ? error : undefined);
    return { valid: false, referrerUserId: null };
  }
}

/**
 * Record a redemption and mint the new user's 5 shareable codes. Called AFTER
 * the account is created, so a failure here must never throw into the signup
 * path — the user already exists. Returns an empty code list on failure; callers
 * should log and continue (codes can be re-fetched later via the service).
 */
export async function admitUser(
  env: Env,
  params: { userId: string; email: string; code: string; source: string },
  logger: Logger,
): Promise<AdmitResult> {
  try {
    const res = await fetch(serviceUrl(env, "/api/referral/admit"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.REFERRAL_SERVICE_SECRET ?? ""}`,
      },
      body: JSON.stringify({
        userId: params.userId,
        email: params.email,
        code: params.code.trim().toUpperCase(),
        source: params.source,
      }),
      signal: AbortSignal.timeout(REFERRAL_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.error("admitUser returned non-OK", undefined, { status: res.status });
      return { codes: [], referrerUserId: null };
    }
    const data = (await res.json()) as {
      codes?: string[];
      referrerUserId?: string | null;
    };
    return {
      codes: Array.isArray(data.codes) ? data.codes : [],
      referrerUserId: data.referrerUserId ?? null,
    };
  } catch (error) {
    logger.error("admitUser request failed", error instanceof Error ? error : undefined, {
      userId: params.userId,
    });
    return { codes: [], referrerUserId: null };
  }
}

/**
 * Redeem the invite code, mint the user's shareable codes, and email them.
 * Best-effort — failures are logged and swallowed so a created account is never
 * left in a broken state by a referral-service hiccup. Shared by every signup
 * path (magic link, GitHub, Google) so they cannot drift on what "admitted"
 * means.
 */
export async function admitAndDeliverCodes(
  env: Env,
  params: { userId: string; email: string; inviteCode: string; source: string },
  logger: Logger,
): Promise<void> {
  try {
    const result = await admitUser(
      env,
      {
        userId: params.userId,
        email: params.email,
        code: params.inviteCode,
        source: params.source,
      },
      logger,
    );
    if (result.codes.length === 0) {
      logger.warn("No invite codes minted for new user", { userId: params.userId });
      return;
    }
    const fromAddress = env.EMAIL_FROM_ADDRESS;
    if (!env.EMAIL || !fromAddress) return;
    const emailContent = getInviteCodesEmail({
      email: params.email,
      codes: result.codes,
      shareBaseUrl: env.REFERRAL_SERVICE_URL,
    });
    await env.EMAIL.send({
      to: params.email,
      from: { email: fromAddress, name: "Stratum" },
      subject: emailContent.subject,
      text: emailContent.text,
      html: emailContent.html,
    });
  } catch (err) {
    logger.error("Failed to deliver invite codes", err instanceof Error ? err : undefined, {
      userId: params.userId,
    });
  }
}

/**
 * One of the caller's own invite codes, with whatever the service knows about
 * its redemption. `redeemedAt === null` means the code is still spendable.
 */
export interface InviteCodeStatus {
  code: string;
  redeemedAt: string | null;
  /** Display name of whoever redeemed it, when the service reports one. */
  redeemedBy: string | null;
}

/**
 * "No codes" and "we could not ask" are different answers and must not render
 * the same: telling someone their code list is empty when the service is down
 * reads as "your codes are gone".
 */
export type InviteCodesResult =
  | { status: "ok"; codes: InviteCodeStatus[] }
  | { status: "unavailable" };

/** The service holds codes minted under the gate; they outlive the gate itself. */
export function referralServiceConfigured(env: Env): boolean {
  return !!env.REFERRAL_SERVICE_URL;
}

/**
 * Normalize one entry of the service's `codes` array. `/admit` returns bare
 * strings, so both shapes are accepted rather than making the two endpoints
 * disagree. Anything else is dropped — a malformed entry must not render as a
 * blank code someone might try to share.
 */
function parseCodeEntry(entry: unknown): InviteCodeStatus | null {
  if (typeof entry === "string") {
    const code = entry.trim();
    return code ? { code, redeemedAt: null, redeemedBy: null } : null;
  }
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code.trim() : "";
  if (!code) return null;
  return {
    code,
    redeemedAt: typeof record.redeemedAt === "string" ? record.redeemedAt : null,
    redeemedBy: typeof record.redeemedBy === "string" ? record.redeemedBy : null,
  };
}

/**
 * Fetch the invite codes minted for a user, so they can be shown in-app rather
 * than living only in the one email sent at signup (which is best-effort and
 * silently skipped when no email binding is configured).
 *
 * Read-only and never on the signup path, so unlike `validateInviteCode` this
 * fails *open-ended* rather than closed: an outage reports "unavailable" and
 * the page says so, because withholding a shareable code is not a security
 * boundary and a wrong "you have none" is the worse answer.
 */
export async function fetchInviteCodes(
  env: Env,
  userId: string,
  logger: Logger,
): Promise<InviteCodesResult> {
  if (!referralServiceConfigured(env)) return { status: "ok", codes: [] };

  try {
    const url = `${serviceUrl(env, "/api/referral/codes")}?userId=${encodeURIComponent(userId)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.REFERRAL_SERVICE_SECRET ?? ""}` },
      signal: AbortSignal.timeout(REFERRAL_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn("Invite code lookup returned non-OK", { status: res.status, userId });
      return { status: "unavailable" };
    }
    const data = (await res.json()) as { codes?: unknown };
    if (!Array.isArray(data.codes)) {
      logger.warn("Invite code lookup returned no code list", { userId });
      return { status: "unavailable" };
    }
    const codes: InviteCodeStatus[] = [];
    for (const entry of data.codes) {
      const parsed = parseCodeEntry(entry);
      if (parsed) codes.push(parsed);
    }
    return { status: "ok", codes };
  } catch (error) {
    logger.error("Invite code lookup failed", error instanceof Error ? error : undefined, {
      userId,
    });
    return { status: "unavailable" };
  }
}
