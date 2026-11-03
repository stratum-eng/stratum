import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { PasskeyRecord } from "../storage/webauthn";
import type { Env } from "../types";
import type { Logger } from "../utils/logger";

/**
 * WebAuthn ceremony helpers (#256), wrapping `@simplewebauthn/server`.
 *
 * The library is pure JS over WebCrypto, so it runs unchanged in the Workers
 * runtime and under vitest's node environment. Everything here is a thin,
 * typed seam: route handlers never touch the library directly, and challenge
 * bookkeeping (KV, single-use) lives beside it so a ceremony cannot be verified
 * without consuming its challenge.
 */

/** Shown in the browser's passkey prompt. */
const RP_NAME = "Stratum";

/** How long a ceremony's challenge stays redeemable. */
export const CHALLENGE_TTL_SECONDS = 300;

/** Browser-side timeout passed in the options; a little under the KV TTL. */
const CEREMONY_TIMEOUT_MS = 240_000;

const CHALLENGE_PREFIX = "webauthn_challenge:";

export interface RelyingParty {
  /** The WebAuthn RP ID: the bare hostname passkeys are scoped to. */
  rpID: string;
  /** The exact origin a ceremony must have run on. */
  origin: string;
}

/**
 * The relying party for this request.
 *
 * `APP_URL` wins when configured, so an environment reachable under several
 * hostnames binds every passkey to one of them. Otherwise the request's own
 * origin is used — on Workers that is the custom domain / route the request
 * arrived on, which is what the browser used as the RP ID too, so self-hosters
 * and per-PR previews work with nothing to configure.
 */
export function relyingParty(env: Pick<Env, "APP_URL">, requestUrl: string): RelyingParty {
  let url: URL;
  try {
    url = new URL(env.APP_URL && env.APP_URL.length > 0 ? env.APP_URL : requestUrl);
  } catch {
    url = new URL(requestUrl);
  }
  return { rpID: url.hostname, origin: url.origin };
}

const KNOWN_TRANSPORTS = new Set<string>(["ble", "hybrid", "internal", "nfc", "usb"]);

function toTransports(values: string[]): AuthenticatorTransport[] {
  return values.filter((t): t is AuthenticatorTransport => KNOWN_TRANSPORTS.has(t));
}

// --- Challenges -------------------------------------------------------------

export type ChallengePurpose = "register" | "authenticate";

interface StoredChallenge {
  purpose: ChallengePurpose;
  /** Who the challenge was issued to: a user id (registration) or the hash of
   * a pending sign-in token (authentication). */
  subject: string;
}

async function storeChallenge(
  kv: KVNamespace,
  challenge: string,
  stored: StoredChallenge,
): Promise<void> {
  await kv.put(`${CHALLENGE_PREFIX}${challenge}`, JSON.stringify(stored), {
    expirationTtl: CHALLENGE_TTL_SECONDS,
  });
}

/**
 * Redeem a challenge exactly once. Deleted before the comparison, so a
 * challenge presented with the wrong purpose or subject is burned rather than
 * left for a second guess. KV's TTL is the expiry.
 */
async function consumeChallenge(
  kv: KVNamespace,
  challenge: string,
  purpose: ChallengePurpose,
  subject: string,
): Promise<boolean> {
  const key = `${CHALLENGE_PREFIX}${challenge}`;
  const raw = await kv.get(key);
  if (raw === null) return false;
  await kv.delete(key);
  try {
    const stored = JSON.parse(raw) as Partial<StoredChallenge>;
    return stored.purpose === purpose && stored.subject === subject;
  } catch {
    return false;
  }
}

/** The challenge the browser signed, read out of clientDataJSON. */
function challengeFromResponse(clientDataJSON: string): string | null {
  try {
    const parsed: unknown = JSON.parse(isoBase64URL.toUTF8String(clientDataJSON));
    if (parsed && typeof parsed === "object" && "challenge" in parsed) {
      const { challenge } = parsed as { challenge: unknown };
      return typeof challenge === "string" ? challenge : null;
    }
    return null;
  } catch {
    return null;
  }
}

// --- Response shape guards ----------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Enough structure to hand to the library, which does the real validation. */
export function isRegistrationResponse(value: unknown): value is RegistrationResponseJSON {
  if (!isRecord(value) || !isRecord(value.response)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.rawId === "string" &&
    value.type === "public-key" &&
    typeof value.response.clientDataJSON === "string" &&
    typeof value.response.attestationObject === "string"
  );
}

export function isAuthenticationResponse(value: unknown): value is AuthenticationResponseJSON {
  if (!isRecord(value) || !isRecord(value.response)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.rawId === "string" &&
    value.type === "public-key" &&
    typeof value.response.clientDataJSON === "string" &&
    typeof value.response.authenticatorData === "string" &&
    typeof value.response.signature === "string"
  );
}

// --- Registration --------------------------------------------------------------

export async function startRegistration(
  kv: KVNamespace,
  rp: RelyingParty,
  user: { id: string; name: string; displayName: string },
  existing: PasskeyRecord[],
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userName: user.name,
    userDisplayName: user.displayName,
    userID: new Uint8Array(new TextEncoder().encode(user.id)),
    attestationType: "none",
    timeout: CEREMONY_TIMEOUT_MS,
    excludeCredentials: existing.map((p) => ({
      id: p.credentialId,
      transports: toTransports(p.transports),
    })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  await storeChallenge(kv, options.challenge, { purpose: "register", subject: user.id });
  return options;
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
}

export type CeremonyFailure =
  | "challenge_invalid"
  | "verification_failed"
  | "unknown_credential"
  | "counter_regression";

/**
 * Verify a registration ceremony. User verification (PIN/biometric) is not
 * required: this is a SECOND factor after a primary sign-in, and a plain
 * security key without a PIN must be usable.
 */
export async function finishRegistration(
  kv: KVNamespace,
  rp: RelyingParty,
  userId: string,
  response: RegistrationResponseJSON,
  logger: Logger,
): Promise<
  { ok: true; credential: VerifiedRegistration } | { ok: false; reason: CeremonyFailure }
> {
  const challenge = challengeFromResponse(response.response.clientDataJSON);
  if (challenge === null || !(await consumeChallenge(kv, challenge, "register", userId))) {
    return { ok: false, reason: "challenge_invalid" };
  }
  try {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: false,
    });
    if (!verification.verified) return { ok: false, reason: "verification_failed" };
    const { credential } = verification.registrationInfo;
    return {
      ok: true,
      credential: {
        credentialId: credential.id,
        publicKey: isoBase64URL.fromBuffer(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? response.response.transports ?? [],
      },
    };
  } catch (error) {
    logger.warn("Passkey registration failed verification", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: "verification_failed" };
  }
}

// --- Authentication --------------------------------------------------------------

export async function startAuthentication(
  kv: KVNamespace,
  rp: RelyingParty,
  subject: string,
  passkeys: PasskeyRecord[],
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    timeout: CEREMONY_TIMEOUT_MS,
    userVerification: "preferred",
    allowCredentials: passkeys.map((p) => ({
      id: p.credentialId,
      transports: toTransports(p.transports),
    })),
  });
  await storeChallenge(kv, options.challenge, { purpose: "authenticate", subject });
  return options;
}

/**
 * Verify an assertion against one stored passkey. Returns the counter the
 * authenticator reported so the caller can advance it (compare-and-swap).
 *
 * The library refuses a counter that fails to increase (a cloned authenticator
 * replaying an old state); authenticators that never count (always 0) pass, as
 * the spec requires, and rely on the single-use challenge instead.
 */
export async function finishAuthentication(
  kv: KVNamespace,
  rp: RelyingParty,
  subject: string,
  passkey: PasskeyRecord,
  response: AuthenticationResponseJSON,
  logger: Logger,
): Promise<{ ok: true; newCounter: number } | { ok: false; reason: CeremonyFailure }> {
  const challenge = challengeFromResponse(response.response.clientDataJSON);
  if (challenge === null || !(await consumeChallenge(kv, challenge, "authenticate", subject))) {
    return { ok: false, reason: "challenge_invalid" };
  }
  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential: {
        id: passkey.credentialId,
        publicKey: isoBase64URL.toBuffer(passkey.publicKey),
        counter: passkey.counter,
        transports: toTransports(passkey.transports),
      },
      requireUserVerification: false,
    });
    if (!verification.verified) return { ok: false, reason: "verification_failed" };
    return { ok: true, newCounter: verification.authenticationInfo.newCounter };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Passkey assertion failed verification", { error: message });
    return {
      ok: false,
      reason: /counter/i.test(message) ? "counter_regression" : "verification_failed",
    };
  }
}
