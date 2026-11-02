import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { recordAudit } from "../storage/audit";
import { markSessionSecondFactor } from "../storage/sessions";
import { getUser } from "../storage/users";
import {
  MAX_PASSKEY_NAME_LENGTH,
  type PasskeySummary,
  countPasskeys,
  countUnusedRecoveryCodes,
  deletePasskey,
  deleteRecoveryCodes,
  insertPasskey,
  listPasskeys,
  renamePasskey,
  toPasskeySummary,
} from "../storage/webauthn";
import type { Env } from "../types";
import type { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { SESSION_COOKIE, isFreshSession, issueRecoveryCodes } from "./second-factor";
import {
  finishRegistration,
  isRegistrationResponse,
  relyingParty,
  startRegistration,
} from "./webauthn";

/**
 * Passkey management for the signed-in user (#256), shared by the JSON API
 * (`/api/users/me/passkeys`) and the server-rendered settings page
 * (`/settings/security`) so both enforce the same rules.
 */

type AppContext = Context<{ Bindings: Env }>;

/** Why a sensitive change to the account's second factor was refused. */
export type SensitiveRefusal =
  /** Not a browser session — an API token can never add or remove a passkey. */
  | "session_required"
  /** The session is too old, or skipped the second factor the account has. */
  | "reauthentication_required";

/**
 * Adding or removing a passkey, or minting recovery codes, changes what it
 * takes to sign in to the account — so it needs a browser session that was
 * minted in the last few minutes and, once the account HAS a passkey, one that
 * presented it. A stolen session cookie on its own can therefore neither
 * enroll the thief's authenticator nor strip the owner's.
 */
export function checkSensitiveSession(
  c: AppContext,
  hasPasskeys: boolean,
): SensitiveRefusal | null {
  if (c.get("authVia") !== "session") return "session_required";
  if (!isFreshSession(c.get("sessionCreatedAt"))) return "reauthentication_required";
  if (hasPasskeys && c.get("sessionSecondFactor") === undefined) {
    return "reauthentication_required";
  }
  return null;
}

export function sensitiveRefusalMessage(refusal: SensitiveRefusal): string {
  return refusal === "session_required"
    ? "Passkeys can only be managed from a signed-in browser session, not an API token."
    : "For your security, sign in again (within the last 15 minutes) to change your passkeys or recovery codes.";
}

export interface SecurityOverview {
  passkeys: PasskeySummary[];
  recoveryCodesRemaining: number;
}

export async function loadSecurityOverview(
  db: D1Database,
  logger: Logger,
  userId: string,
): Promise<Result<SecurityOverview, AppError>> {
  const [passkeys, codes] = await Promise.all([
    listPasskeys(db, logger, userId),
    countUnusedRecoveryCodes(db, logger, userId),
  ]);
  if (!passkeys.success) return err(passkeys.error);
  if (!codes.success) return err(codes.error);
  return ok({ passkeys: passkeys.data.map(toPasskeySummary), recoveryCodesRemaining: codes.data });
}

/** Trimmed, bounded display name; a blank one falls back to a default. */
export function normalizePasskeyName(raw: unknown, fallback = "Passkey"): string | null {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name.length === 0) return fallback;
  if (name.length > MAX_PASSKEY_NAME_LENGTH) return null;
  return name;
}

export type BeginRegistrationOutcome =
  | { kind: "ok"; options: unknown }
  | { kind: "refused"; refusal: SensitiveRefusal }
  | { kind: "error"; error: AppError };

export async function beginPasskeyRegistration(
  c: AppContext,
  logger: Logger,
  userId: string,
): Promise<BeginRegistrationOutcome> {
  const [existing, user] = await Promise.all([
    listPasskeys(c.env.DB, logger, userId),
    getUser(c.env.DB, userId, logger),
  ]);
  if (!existing.success) return { kind: "error", error: existing.error };
  if (!user.success) return { kind: "error", error: user.error };
  const refusal = checkSensitiveSession(c, existing.data.length > 0);
  if (refusal) return { kind: "refused", refusal };

  const options = await startRegistration(
    c.env.STATE,
    relyingParty(c.env, c.req.url),
    {
      id: userId,
      name: user.data.username || user.data.email,
      displayName: user.data.displayName ?? user.data.username ?? user.data.email,
    },
    existing.data,
  );
  return { kind: "ok", options };
}

export type FinishRegistrationOutcome =
  | { kind: "ok"; passkey: PasskeySummary; recoveryCodes?: string[] }
  | { kind: "refused"; refusal: SensitiveRefusal }
  | { kind: "invalid"; message: string; status: 400 | 409 }
  | { kind: "error"; error: AppError };

export async function finishPasskeyRegistration(
  c: AppContext,
  logger: Logger,
  userId: string,
  body: { name?: unknown; response?: unknown },
): Promise<FinishRegistrationOutcome> {
  const name = normalizePasskeyName(body.name);
  if (name === null) {
    return {
      kind: "invalid",
      message: `name must be a string of at most ${MAX_PASSKEY_NAME_LENGTH} characters`,
      status: 400,
    };
  }
  if (!isRegistrationResponse(body.response)) {
    return {
      kind: "invalid",
      message: "response must be a WebAuthn registration response",
      status: 400,
    };
  }

  const before = await countPasskeys(c.env.DB, logger, userId);
  if (!before.success) return { kind: "error", error: before.error };
  const isFirst = before.data === 0;
  const refusal = checkSensitiveSession(c, !isFirst);
  if (refusal) return { kind: "refused", refusal };

  const verified = await finishRegistration(
    c.env.STATE,
    relyingParty(c.env, c.req.url),
    userId,
    body.response,
    logger,
  );
  if (!verified.ok) {
    return {
      kind: "invalid",
      message:
        verified.reason === "challenge_invalid"
          ? "The registration challenge is missing, expired, or already used. Start again."
          : "The passkey could not be verified.",
      status: 400,
    };
  }

  const saved = await insertPasskey(c.env.DB, logger, { userId, name, ...verified.credential });
  if (!saved.success) {
    if (saved.error.statusCode === 409) {
      return { kind: "invalid", message: saved.error.message, status: 409 };
    }
    return { kind: "error", error: saved.error };
  }

  let recoveryCodes: string[] | undefined;
  if (isFirst) {
    // The first passkey turns the second factor on, so this is the moment a
    // lost device would otherwise become a locked account: issue the codes
    // now, and show them exactly once.
    const codes = await issueRecoveryCodes(c.env.DB, logger, userId);
    if (!codes.success) return { kind: "error", error: codes.error };
    recoveryCodes = codes.data;
    // The user just proved possession of the authenticator from this session;
    // treat it as verified so they are not bounced by an org policy.
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (sessionId) await markSessionSecondFactor(c.env.DB, sessionId, "passkey", logger);
  }

  await recordAudit(c.env.DB, logger, {
    action: "passkey.registered",
    actorType: "user",
    actorId: userId,
    subject: saved.data.id,
    detail: { name, first: isFirst },
  });
  return {
    kind: "ok",
    passkey: toPasskeySummary(saved.data),
    ...(recoveryCodes !== undefined ? { recoveryCodes } : {}),
  };
}

export type RenameOutcome = "renamed" | "not_found" | "invalid_name";

export async function renameUserPasskey(
  db: D1Database,
  logger: Logger,
  userId: string,
  passkeyId: string,
  rawName: unknown,
): Promise<Result<RenameOutcome, AppError>> {
  const name = normalizePasskeyName(rawName, "");
  if (name === null || name.length === 0) return ok("invalid_name");
  const renamed = await renamePasskey(db, logger, userId, passkeyId, name);
  if (!renamed.success) return err(renamed.error);
  if (!renamed.data) return ok("not_found");
  await recordAudit(db, logger, {
    action: "passkey.renamed",
    actorType: "user",
    actorId: userId,
    subject: passkeyId,
    detail: { name },
  });
  return ok("renamed");
}

export type RemoveOutcome =
  | { kind: "removed"; remaining: number }
  | { kind: "not_found" }
  | { kind: "refused"; refusal: SensitiveRefusal }
  | { kind: "error"; error: AppError };

/**
 * Remove a passkey.
 *
 * Removing the LAST one is allowed even while an org the user belongs to
 * requires a second factor: that org's policy then denies its own resources to
 * the user until they enroll again, and nothing else. Refusing instead would
 * let any org — membership needs no consent — pin a passkey onto a user's
 * account.
 *
 * Removing the last passkey also deletes the recovery codes: they exist only
 * to stand in for a passkey, and leaving them behind would make the next
 * enrollment start with codes the user may no longer have.
 */
export async function removeUserPasskey(
  c: AppContext,
  logger: Logger,
  userId: string,
  passkeyId: string,
): Promise<RemoveOutcome> {
  const all = await listPasskeys(c.env.DB, logger, userId);
  if (!all.success) return { kind: "error", error: all.error };
  const refusal = checkSensitiveSession(c, all.data.length > 0);
  if (refusal) return { kind: "refused", refusal };
  if (!all.data.some((p) => p.id === passkeyId)) return { kind: "not_found" };

  const deleted = await deletePasskey(c.env.DB, logger, userId, passkeyId);
  if (!deleted.success) return { kind: "error", error: deleted.error };
  if (!deleted.data) return { kind: "not_found" };
  const remaining = all.data.length - 1;
  if (remaining === 0) {
    const cleared = await deleteRecoveryCodes(c.env.DB, logger, userId);
    if (!cleared.success) return { kind: "error", error: cleared.error };
  }

  await recordAudit(c.env.DB, logger, {
    action: "passkey.removed",
    actorType: "user",
    actorId: userId,
    subject: passkeyId,
    detail: { remaining },
  });
  return { kind: "removed", remaining };
}

export type RegenerateOutcome =
  | { kind: "ok"; codes: string[] }
  | { kind: "refused"; refusal: SensitiveRefusal }
  | { kind: "no_passkey" }
  | { kind: "error"; error: AppError };

export async function regenerateUserRecoveryCodes(
  c: AppContext,
  logger: Logger,
  userId: string,
): Promise<RegenerateOutcome> {
  const count = await countPasskeys(c.env.DB, logger, userId);
  if (!count.success) return { kind: "error", error: count.error };
  if (count.data === 0) return { kind: "no_passkey" };
  const refusal = checkSensitiveSession(c, true);
  if (refusal) return { kind: "refused", refusal };
  const codes = await issueRecoveryCodes(c.env.DB, logger, userId);
  if (!codes.success) return { kind: "error", error: codes.error };
  await recordAudit(c.env.DB, logger, {
    action: "recovery_codes.regenerated",
    actorType: "user",
    actorId: userId,
    detail: { count: codes.data.length },
  });
  return { kind: "ok", codes: codes.data };
}
