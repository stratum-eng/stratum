import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { captureAuthCompleted } from "../analytics/auth";
import type { AuthKind, AuthProvider } from "../analytics/events";
import { recordAudit } from "../storage/audit";
import { type SessionSecondFactor, createSession, sessionCreatedAtMs } from "../storage/sessions";
import { countPasskeys, replaceRecoveryCodes } from "../storage/webauthn";
import { RECOVERY_CODE_COUNT } from "../storage/webauthn";
import type { Env } from "../types";
import { hashToken } from "../utils/crypto";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/**
 * The browser sign-in funnel, and the second-factor gate inside it (#256).
 *
 * Every interactive primary sign-in (magic link, GitHub, Google, completing a
 * parked OAuth signup, OIDC SSO) ends by calling `completeBrowserSignIn`. If
 * the account has at least one passkey, NO session is minted: the sign-in is
 * parked in KV behind a short-lived, single-use token (cookie scoped to
 * `/auth/2fa`) and the browser is sent to the assertion page. Only a verified
 * passkey assertion, or an unused recovery code, turns it into a session.
 *
 * Keeping the half-signed-in state OUT of the sessions table is deliberate: a
 * "pending" session row is one forgotten check away from being a session, and
 * every reader of `stratum_session` would have to know about it.
 *
 * Non-interactive credentials — API tokens, agent tokens, MCP OAuth grants,
 * git over HTTPS — never pass through here and are not subject to a second
 * factor. Each is a credential the user already holds and can revoke or
 * rotate; see docs/api/authentication.md for what each one may reach.
 */

export const SESSION_COOKIE = "stratum_session";
export const PENDING_COOKIE = "stratum_2fa";
export const PENDING_COOKIE_PATH = "/auth/2fa";
export const PENDING_TTL_SECONDS = 600;
/** Wrong passkeys/codes allowed against one pending sign-in before it is voided. */
export const MAX_SECOND_FACTOR_FAILURES = 5;
/** How recently the session must have been minted to add or remove a passkey. */
export const FRESH_SESSION_WINDOW_MS = 15 * 60 * 1000;

const PENDING_PREFIX = "second_factor_pending:";
const THIRTY_DAYS_SECONDS = 2592000;
const ONE_DAY_SECONDS = 86400;

/** Everything needed to finish a primary sign-in once the second factor passes. */
export interface BrowserSignIn {
  userId: string;
  /** Recorded as `detail.method` on the `session.created` audit row. */
  method: string;
  rememberMe: boolean;
  /** Same-origin, already-validated path to land on afterwards. */
  redirectTo: string;
  /** The org whose IdP authenticated this sign-in (OIDC SSO only). */
  ssoOrgId?: string;
  /** Extra audit detail (e.g. `{ orgId }` for SSO). */
  auditDetail?: Record<string, unknown>;
  /** The org whose audit log the sign-in's rows belong to (#255) — the SSO org. */
  auditOrgId?: string;
  /** Funnel analytics, when the flow reports one. */
  analytics?: { kind: AuthKind; provider: AuthProvider };
}

interface PendingRecord {
  signIn: BrowserSignIn;
  failures: number;
  expiresAt: number;
}

export interface PendingSignIn {
  /** Hash of the pending token — the KV key suffix and the challenge subject. */
  tokenHash: string;
  signIn: BrowserSignIn;
  failures: number;
}

type AppContext = Context<{ Bindings: Env }>;

/**
 * Finish a primary sign-in: either mint the session, or park it behind the
 * second factor. Fails CLOSED — if we cannot tell whether the account has a
 * passkey, no session is issued.
 */
export async function completeBrowserSignIn(
  c: AppContext,
  logger: Logger,
  signIn: BrowserSignIn,
): Promise<Result<Response, AppError>> {
  const passkeys = await countPasskeys(c.env.DB, logger, signIn.userId);
  if (!passkeys.success) return err(passkeys.error);

  if (passkeys.data > 0) {
    const token = randomToken();
    const record: PendingRecord = {
      signIn,
      failures: 0,
      expiresAt: Date.now() + PENDING_TTL_SECONDS * 1000,
    };
    try {
      await c.env.STATE.put(`${PENDING_PREFIX}${await hashToken(token)}`, JSON.stringify(record), {
        expirationTtl: PENDING_TTL_SECONDS,
      });
    } catch (error) {
      logger.error("Failed to park sign-in for second factor", toError(error));
      return err(new AppError("Failed to start second factor", "STORAGE_ERROR", 500));
    }
    setCookie(c, PENDING_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: PENDING_TTL_SECONDS,
      path: PENDING_COOKIE_PATH,
    });
    logger.info("Primary sign-in complete; second factor required", { userId: signIn.userId });
    return ok(c.redirect("/auth/2fa"));
  }

  return issueBrowserSession(c, logger, signIn);
}

/** Mint the session, audit it, set the cookie, and redirect. */
export async function issueBrowserSession(
  c: AppContext,
  logger: Logger,
  signIn: BrowserSignIn,
  secondFactor?: SessionSecondFactor,
): Promise<Result<Response, AppError>> {
  const minted = await mintBrowserSession(c, logger, signIn, secondFactor);
  if (!minted.success) return err(minted.error);
  return ok(c.redirect(minted.data));
}

/**
 * Mint the session, audit it, and set the cookie on `c`. Returns where the
 * browser should go next — the caller decides whether that is a redirect or a
 * JSON answer to a script (the passkey ceremony runs in `fetch`).
 */
export async function mintBrowserSession(
  c: AppContext,
  logger: Logger,
  signIn: BrowserSignIn,
  secondFactor?: SessionSecondFactor,
): Promise<Result<string, AppError>> {
  const sessionResult = await createSession(c.env.DB, signIn.userId, logger, signIn.rememberMe, {
    ...(secondFactor !== undefined ? { secondFactor } : {}),
    ...(signIn.ssoOrgId !== undefined ? { ssoOrgId: signIn.ssoOrgId } : {}),
  });
  if (!sessionResult.success) return err(sessionResult.error);

  await recordAudit(c.env.DB, logger, {
    action: "session.created",
    actorType: "user",
    actorId: signIn.userId,
    ...(signIn.auditOrgId !== undefined ? { orgId: signIn.auditOrgId } : {}),
    detail: {
      method: signIn.method,
      ...(signIn.auditDetail ?? {}),
      ...(secondFactor !== undefined ? { secondFactor } : {}),
    },
  });
  if (signIn.analytics) {
    await captureAuthCompleted(c, logger, { ...signIn.analytics, userId: signIn.userId });
  }

  setCookie(c, SESSION_COOKIE, sessionResult.data.id, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: signIn.rememberMe ? THIRTY_DAYS_SECONDS : ONE_DAY_SECONDS,
    path: "/",
  });
  return ok(signIn.redirectTo);
}

/** The parked sign-in this browser is completing, if it is still live. */
export async function readPendingSignIn(
  c: AppContext,
  logger: Logger,
): Promise<PendingSignIn | null> {
  const token = getCookie(c, PENDING_COOKIE);
  if (!token) return null;
  const tokenHash = await hashToken(token);
  let raw: string | null;
  try {
    raw = await c.env.STATE.get(`${PENDING_PREFIX}${tokenHash}`);
  } catch (error) {
    logger.error("Failed to read pending sign-in", toError(error));
    return null;
  }
  if (raw === null) return null;
  try {
    const record = JSON.parse(raw) as PendingRecord;
    if (typeof record.expiresAt !== "number" || record.expiresAt <= Date.now()) return null;
    if (!record.signIn || typeof record.signIn.userId !== "string") return null;
    return { tokenHash, signIn: record.signIn, failures: record.failures ?? 0 };
  } catch {
    return null;
  }
}

/** Void a parked sign-in: on success (single use) or after too many failures. */
export async function clearPendingSignIn(c: AppContext, pending: PendingSignIn): Promise<void> {
  await c.env.STATE.delete(`${PENDING_PREFIX}${pending.tokenHash}`);
  deleteCookie(c, PENDING_COOKIE, { path: PENDING_COOKIE_PATH });
}

/**
 * Count a failed attempt. Returns true when the sign-in has been voided — the
 * user must start over from the primary factor, which bounds guessing at
 * recovery codes to a handful per magic link / OAuth round-trip.
 */
export async function recordPendingFailure(
  c: AppContext,
  pending: PendingSignIn,
): Promise<boolean> {
  const failures = pending.failures + 1;
  if (failures >= MAX_SECOND_FACTOR_FAILURES) {
    await clearPendingSignIn(c, pending);
    return true;
  }
  const key = `${PENDING_PREFIX}${pending.tokenHash}`;
  const raw = await c.env.STATE.get(key);
  if (raw === null) return true;
  const record = JSON.parse(raw) as PendingRecord;
  const remaining = Math.ceil((record.expiresAt - Date.now()) / 1000);
  // KV refuses a TTL under 60s; a sign-in that close to expiry is simply ended.
  if (remaining < 60) {
    await clearPendingSignIn(c, pending);
    return true;
  }
  await c.env.STATE.put(key, JSON.stringify({ ...record, failures }), {
    expirationTtl: remaining,
  });
  pending.failures = failures;
  return false;
}

/** Was this session minted recently enough to change the account's second factor? */
export function isFreshSession(createdAt: string | undefined, now = Date.now()): boolean {
  const created = sessionCreatedAtMs(createdAt);
  return created !== null && now - created <= FRESH_SESSION_WINDOW_MS;
}

// --- Recovery codes -----------------------------------------------------------

/** Crockford-style alphabet: no 0/O, 1/I/L confusion when read off paper. */
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

const RECOVERY_CODE_LENGTH = 12;

function randomRecoveryCode(): string {
  // Rejection sampling: bytes at or above the largest multiple of the alphabet
  // size are discarded, so every character is uniformly likely: 12 characters
  // of a 31-letter alphabet is ~59 bits.
  const limit = 256 - (256 % RECOVERY_ALPHABET.length);
  let out = "";
  while (out.length < RECOVERY_CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b >= limit || out.length >= RECOVERY_CODE_LENGTH) continue;
      out += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

/** Case- and separator-insensitive, so a code typed as printed always matches. */
export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The stored form of a recovery code.
 *
 * Bound to the user: the hashed input includes the user id, so a stolen
 * `recovery_codes` table cannot be attacked in one pass across every account —
 * each guess is good for one user only. Keyed when the operator configures
 * `RECOVERY_CODE_PEPPER`: an HMAC under a secret that never sits in D1 (or in a
 * D1 backup), so the table alone is not enough to test guesses at all. The
 * pepper is optional; without it the hash is a user-bound SHA-256.
 */
export async function hashRecoveryCode(
  code: string,
  userId: string,
  pepper?: string,
): Promise<string> {
  const input = `recovery:v1:${userId}:${normalizeRecoveryCode(code)}`;
  if (!pepper) return hashToken(input);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(input)));
  return `hmac:${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Every stored form a typed code may match: the keyed hash when a pepper is
 * configured, and the unkeyed one — so codes issued before an operator added
 * the pepper keep working until they are spent or regenerated.
 */
export async function recoveryCodeCandidates(
  code: string,
  userId: string,
  pepper?: string,
): Promise<string[]> {
  const unkeyed = await hashRecoveryCode(code, userId);
  return pepper ? [await hashRecoveryCode(code, userId, pepper), unkeyed] : [unkeyed];
}

/**
 * Issue a fresh set of recovery codes, replacing any previous set. Returns the
 * plaintext ONCE; only hashes are stored.
 */
export async function issueRecoveryCodes(
  db: D1Database,
  logger: Logger,
  userId: string,
  pepper?: string,
): Promise<Result<string[], AppError>> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, randomRecoveryCode);
  const hashes = await Promise.all(codes.map((code) => hashRecoveryCode(code, userId, pepper)));
  const saved = await replaceRecoveryCodes(db, logger, userId, hashes);
  if (!saved.success) return err(saved.error);
  return ok(codes);
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toError(error: unknown): Error | undefined {
  return error instanceof Error ? error : undefined;
}
