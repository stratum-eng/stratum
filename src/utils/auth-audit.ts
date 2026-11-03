import type { Context } from "hono";
import { recordAuditOncePerWindow } from "../storage/audit";
import { getWaitUntil } from "./execution-ctx";
import type { Logger } from "./logger";

/**
 * Failed-authentication auditing (#255).
 *
 * Failed auth is the one audit event an outsider can generate at will, so it
 * is recorded under two rules that keep it from becoming a log-flooding (and
 * D1-write) amplifier:
 *
 * 1. **Only failures that identify something real are recorded.** A revoked,
 *    expired, or owner-disabled credential that exists; a magic link that
 *    exists but was already used or has expired; a sign-in refused for a
 *    disabled account; an SSO callback that got as far as a real org
 *    connection (its single-use state was valid). A random or unknown bearer
 *    identifies nobody, answers no "who tried to get into OUR account"
 *    question, and costs an attacker nothing to send — it goes to the
 *    structured log only, never the audit table.
 * 2. **One row per subject per org scope per minute.** The insert is guarded
 *    in the same statement (`recordAuditOncePerWindow`): if the same
 *    credential/account already failed within `AUTH_FAILURE_DEDUPE_MS` in the
 *    same org scope (unscoped matching only unscoped), nothing is written —
 *    atomically, so concurrent failures cannot each slip past the check. A
 *    leaked-then-revoked token hammered by a script yields at most one row a
 *    minute, enough to see that it is happening and when it stopped; and one
 *    org's SSO failure never hides another org's. If the guarded insert
 *    errors it falls back to a plain insert (fail open), so an outage of the
 *    guard cannot hide failures.
 */
export const AUTH_FAILURE_DEDUPE_MS = 60_000;

export type AuthFailureMethod =
  | "api_token"
  | "legacy_token"
  | "agent_token"
  | "oauth_token"
  | "magic_link"
  | "sso"
  // The second factor (#256): a wrong passkey or recovery code after the
  // primary sign-in succeeded. Always identifies a real account.
  | "passkey"
  | "recovery_code";

export interface AuthFailure {
  method: AuthFailureMethod;
  /** Short machine-readable cause, e.g. "revoked", "expired", "account_disabled". */
  reason: string;
  actorType: "user" | "agent" | "system";
  /** The account the credential belongs to, when it belongs to one. */
  actorId?: string;
  /**
   * The dedupe key and the row's subject: the credential's id where one
   * exists (token, grant, agent), else the account or SSO connection id.
   */
  subject: string;
  orgId?: string;
  detail?: Record<string, unknown>;
}

/** Record one failed authentication, subject to the dedupe window above. */
export async function recordAuthFailure(
  db: D1Database,
  logger: Logger,
  failure: AuthFailure,
): Promise<void> {
  const sinceIso = new Date(Date.now() - AUTH_FAILURE_DEDUPE_MS).toISOString();
  await recordAuditOncePerWindow(
    db,
    logger,
    {
      action: "auth.failed",
      actorType: failure.actorType,
      ...(failure.actorId !== undefined ? { actorId: failure.actorId } : {}),
      subject: failure.subject,
      ...(failure.orgId !== undefined ? { orgId: failure.orgId } : {}),
      detail: { method: failure.method, reason: failure.reason, ...(failure.detail ?? {}) },
    },
    sinceIso,
  );
}

/**
 * `recordAuthFailure` off the response path where the runtime allows it: a
 * rejected request should not wait on two D1 round-trips to learn it was
 * rejected. Without an ExecutionContext (unit tests) it is awaited inline.
 * Never throws — auditing must not change an auth outcome.
 */
export async function auditAuthFailure(
  c: Context,
  db: D1Database,
  logger: Logger,
  failure: AuthFailure,
): Promise<void> {
  const write = recordAuthFailure(db, logger, failure).catch((error: unknown) => {
    logger.warn("Failed to audit authentication failure", {
      method: failure.method,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  const waitUntil = getWaitUntil(c);
  if (waitUntil) waitUntil(write);
  else await write;
}
