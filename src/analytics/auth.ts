/**
 * The acquisition funnel's one instrumentation point.
 *
 * Sign-up and sign-in are spread across five handlers in three files — GitHub
 * and Google callbacks, the shared OAuth username step, and magic-link verify
 * for both intents. Each of them ends the same way and each of them would
 * otherwise grow its own copy of "resolve the preference, build a tracker,
 * schedule the send", which is how five copies become four correct ones.
 *
 * So the whole thing is one call: `await captureAuthCompleted(...)` next to
 * the `recordAudit` that already marks the same moment.
 */
import type { Context } from "hono";
import type { Env } from "../types";
import { getWaitUntil } from "../utils/execution-ctx";
import type { Logger } from "../utils/logger";
import type { AuthKind, AuthProvider } from "./events";
import { trackerForUser } from "./tracker";

export interface AuthOutcome {
  /** Whether this created an account or resumed one. The funnel's whole point. */
  kind: AuthKind;
  provider: AuthProvider;
  /** The account that now holds the session. */
  userId: string;
}

/**
 * Record a completed authentication.
 *
 * The preference has to be read from D1 rather than lifted off the request:
 * this runs *before* any middleware has an authenticated context to publish,
 * and on the sign-up path the account did not exist when the request started.
 * A brand-new account has never expressed a preference, which is the opt-in
 * default — the same default the settings page starts from.
 *
 * Scheduled past the response where an ExecutionContext exists and awaited
 * inline where none does (tests), matching how this codebase handles every
 * other best-effort write on an auth path: nobody waits longer to be signed in
 * because analytics is enabled.
 */
export async function captureAuthCompleted(
  c: Context<{ Bindings: Env }>,
  logger: Logger,
  outcome: AuthOutcome,
): Promise<void> {
  const deliver = (async () => {
    const tracker = await trackerForUser(c.env, outcome.userId, logger);
    await tracker.capture(
      "auth_completed",
      { kind: outcome.kind, provider: outcome.provider },
      // Person properties, and only on the sign-up. `$set_once` is the point:
      // "how did this person arrive" has one true answer, and a later sign-in
      // through a different provider must not rewrite it.
      //
      // Without these a person profile is an opaque id with nothing on it, so
      // no cohort can ask "accounts that signed up with GitHub in August" —
      // the question every retention and activation comparison starts from.
      // Deliberately not the email, username, or display name: the whole
      // export is built on not sending those.
      outcome.kind === "signup" ? { signup_provider: outcome.provider } : undefined,
    );
  })().catch((error: unknown) => {
    // Analytics must never be able to fail a sign-in. `capture` already cannot
    // reject; this covers the preference lookup, which touches D1.
    logger.warn("Auth analytics capture failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  const waitUntil = getWaitUntil(c);
  if (waitUntil) {
    waitUntil(deliver);
    return;
  }
  await deliver;
}
