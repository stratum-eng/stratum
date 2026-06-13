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
 */
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
