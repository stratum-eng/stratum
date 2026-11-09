/**
 * Telemetry consent at signup (#257).
 *
 * With `TELEMETRY_CONSENT_AT_SIGNUP = "true"` a new account starts opted OUT of
 * telemetry unless the person creating it ticked the box on the signup form.
 * The preference itself is the existing `users.telemetry_opt_out` column, which
 * both the server-side tracker and the browser snippet already honor — this
 * module only decides what a NEW row starts as.
 *
 * It is its own variable rather than something inferred from `BETA_GATE` or
 * `BILLING_SERVICE_URL`. Those are the nearest things to a "this is the hosted
 * instance" signal, but each means something else (an invite wall, a plan
 * service) and is flipped for its own reasons: production already runs with
 * `BETA_GATE = "0"`, and a self-hoster may set either one. A privacy default
 * that silently moved with them would be a default nobody chose.
 */
import type { Env } from "../types";

/**
 * The signup forms' consent checkbox. It carries no `value`, so a ticked box
 * submits the browser default `"on"` and an unticked one submits nothing —
 * the same contract as the `analytics` box on the settings page.
 */
export const TELEMETRY_CONSENT_FIELD = "telemetryConsent";

/** Where the consent sentence sends someone who wants the full event list. */
export const TELEMETRY_FAQ_URL = "https://docs.usestratum.dev/guides/faq/#can-i-turn-off-telemetry";

/** The one sentence shown beside the box. Shared so no form words it differently. */
export const TELEMETRY_CONSENT_LABEL = "Send anonymous usage analytics";
export const TELEMETRY_CONSENT_DESCRIPTION =
  "Optional. Shares which pages and API routes you use, and how they respond, with our analytics provider; never your code, repository names or email.";

/** Whether this instance asks for telemetry consent at signup. Only the literal `"true"` turns it on. */
export function telemetryConsentAtSignup(env: Pick<Env, "TELEMETRY_CONSENT_AT_SIGNUP">): boolean {
  return env.TELEMETRY_CONSENT_AT_SIGNUP === "true";
}

/**
 * Whether a submitted form field is a ticked consent box.
 *
 * Only the literal `"on"` counts. Anything else — absent, an array from a
 * duplicated field, an unexpected string — reads as no consent, so a malformed
 * submission fails toward privacy.
 */
export function telemetryConsentGiven(field: unknown): boolean {
  return field === "on";
}

/**
 * What a new account's `telemetry_opt_out` starts as.
 *
 * Setting off: `false`, today's behavior, whatever `consented` says. Setting
 * on: opted out unless the person said yes. Paths with nobody to ask (SCIM,
 * SSO just-in-time, the legacy one-field magic link) pass `consented: false`.
 *
 * @param env - Worker bindings
 * @param consented - Whether a person ticked the box for this account
 * @returns The opt-out value to create the account with
 */
export function newAccountTelemetryOptOut(
  env: Pick<Env, "TELEMETRY_CONSENT_AT_SIGNUP">,
  consented: boolean,
): boolean {
  return telemetryConsentAtSignup(env) && !consented;
}
