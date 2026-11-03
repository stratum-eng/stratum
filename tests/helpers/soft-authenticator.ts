import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

/**
 * A software WebAuthn authenticator for tests (#256): a real ES256 key pair
 * producing genuine "none"-attestation registrations and signed assertions, so
 * `@simplewebauthn/server` verifies them for real — no fake verifier.
 *
 * Layouts follow WebAuthn L2 §6.1 (authenticator data) and §6.5.4 (attestation
 * object); signatures are DER-encoded ECDSA, as authenticators emit them.
 */

type CborValue = Parameters<typeof isoCBOR.encode>[0];

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

async function sha256(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data)));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

/** Raw r||s (WebCrypto) → ASN.1 DER SEQUENCE { INTEGER r, INTEGER s }. */
function rawToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const integer = (bytes: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.slice(i);
    if ((v[0] ?? 0) & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

function clientData(type: string, challenge: string, origin: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false })),
  );
}

export interface SoftAuthenticator {
  credentialId: string;
  /** The signature counter the next assertion will report (then increments). */
  counter: number;
  register(
    options: PublicKeyCredentialCreationOptionsJSON,
    origin: string,
  ): Promise<RegistrationResponseJSON>;
  authenticate(
    options: PublicKeyCredentialRequestOptionsJSON,
    origin: string,
  ): Promise<AuthenticationResponseJSON>;
}

export async function makeSoftAuthenticator(initialCounter = 0): Promise<SoftAuthenticator> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
  const rawId = crypto.getRandomValues(new Uint8Array(16));
  const credentialId = isoBase64URL.fromBuffer(rawId);

  // COSE_Key (RFC 8152): kty EC2, alg ES256, crv P-256, x, y.
  const cosePublicKey = isoCBOR.encode(
    new Map<number, CborValue>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, isoBase64URL.toBuffer(jwk.x ?? "")],
      [-3, isoBase64URL.toBuffer(jwk.y ?? "")],
    ]),
  );

  const auth: SoftAuthenticator = {
    credentialId,
    counter: initialCounter,

    async register(options, origin) {
      const cdj = clientData("webauthn.create", options.challenge, origin);
      const authData = concat(
        await sha256(new TextEncoder().encode(options.rp.id ?? "")),
        new Uint8Array([FLAG_UP | FLAG_UV | FLAG_AT]),
        u32be(auth.counter),
        new Uint8Array(16), // AAGUID: all zeros for "none" attestation
        new Uint8Array([0, rawId.length]),
        rawId,
        cosePublicKey,
      );
      const attestationObject = new Uint8Array(
        isoCBOR.encode(
          new Map<string, CborValue>([
            ["fmt", "none"],
            ["attStmt", new Map<string, CborValue>()],
            ["authData", authData],
          ]),
        ),
      );
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: isoBase64URL.fromBuffer(cdj),
          attestationObject: isoBase64URL.fromBuffer(attestationObject),
          transports: ["internal"],
        },
      };
    },

    async authenticate(options, origin) {
      const cdj = clientData("webauthn.get", options.challenge, origin);
      auth.counter += 1;
      const authData = concat(
        await sha256(new TextEncoder().encode(options.rpId ?? "")),
        new Uint8Array([FLAG_UP | FLAG_UV]),
        u32be(auth.counter),
      );
      const signed = concat(authData, await sha256(cdj));
      const raw = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, signed),
      );
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: isoBase64URL.fromBuffer(cdj),
          authenticatorData: isoBase64URL.fromBuffer(authData),
          signature: isoBase64URL.fromBuffer(rawToDer(raw)),
        },
      };
    },
  };
  return auth;
}
