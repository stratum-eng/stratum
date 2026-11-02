/**
 * Cryptographic utilities for secure token storage and API key generation
 */

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12;

/**
 * Hash a token using SHA-256
 */
export async function hashToken(plaintext: string): Promise<string> {
  const encoded = new TextEncoder().encode(plaintext);
  const buffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify a token against a hash using constant-time comparison
 */
export async function verifyToken(plaintext: string, hash: string): Promise<boolean> {
  const candidate = await hashToken(plaintext);
  return constantTimeEqual(candidate, hash);
}

/**
 * Compare two strings without a value-dependent early exit, to avoid leaking
 * how many leading characters matched via timing.
 *
 * Caveat: this short-circuits when the lengths differ, so it leaks *length* by
 * timing. That is acceptable only for fixed-length secrets (hex hashes, the
 * admin API key). Do not use it to compare variable-length user input where the
 * length itself is sensitive.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Generate a random API key with prefix
 */
export async function generateApiKey(prefix: string): Promise<string> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${hex}`;
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(encoded: string): Uint8Array {
  return new Uint8Array(
    atob(encoded)
      .split("")
      .map((c) => c.charCodeAt(0)),
  );
}

/**
 * The historical hardcoded salt. It predates any second use of the AES-GCM
 * helpers, so it stays the default: every existing GitHub-token ciphertext was
 * produced under it and must keep decrypting byte-for-byte.
 */
const GITHUB_TOKEN_SALT = "stratum-github-token-salt";

/** PBKDF2 salt for SSO client-secret encryption (keyed off SSO_ENCRYPTION_SECRET). */
export const SSO_SECRET_SALT = "stratum-sso-secret-salt";

/**
 * Derive encryption key from environment secret using PBKDF2. The salt
 * partitions key material per use-case so two subsystems sharing this helper
 * can never decrypt each other's ciphertexts even under a reused env secret.
 */
async function getEncryptionKey(secret: string, salt: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);

  const baseKey = await crypto.subtle.importKey("raw", keyData, { name: "PBKDF2" }, false, [
    "deriveBits",
    "deriveKey",
  ]);

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: "SHA-256",
    },
    baseKey,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a secret using AES-GCM (GitHub-token salt by default).
 */
export async function encryptToken(
  plaintext: string,
  secret: string,
  salt: string = GITHUB_TOKEN_SALT,
): Promise<string> {
  const key = await getEncryptionKey(secret, salt);
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    encoder.encode(plaintext),
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);

  return toBase64(combined);
}

/**
 * Decrypt a secret encrypted by `encryptToken` (same salt required).
 */
export async function decryptToken(
  ciphertext: string,
  secret: string,
  salt: string = GITHUB_TOKEN_SALT,
): Promise<string | null> {
  try {
    const key = await getEncryptionKey(secret, salt);

    const combined = fromBase64(ciphertext);

    const iv = combined.slice(0, IV_LENGTH);
    const encrypted = combined.slice(IV_LENGTH);

    const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, encrypted);

    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}

/**
 * The `(project_id, name)` pair a deploy secret's ciphertext is cryptographically
 * bound to. Both fields are authenticated but not encrypted — they are already
 * public in the row that stores the ciphertext.
 */
export interface SecretScope {
  projectId: string;
  name: string;
}

/**
 * Salt for deploy-secret key derivation.
 *
 * Deliberately distinct from the GitHub-token salt above: an operator who sets
 * `DEPLOY_SECRET_KEY` and the GitHub token key to the same string must still end
 * up with two unrelated AES keys, so compromise of one derived key cannot unlock
 * the other store.
 */
const DEPLOY_SECRET_SALT = "stratum-deploy-secret-salt";

/**
 * NUL-separated so the AAD is an injective encoding of the pair: with a plain
 * concatenation, ("proj_1A", "B") and ("proj_1", "AB") would authenticate
 * identically and a ciphertext could be transplanted between them. Neither field
 * can contain a NUL — ids are `prefix_<hex>` and names match
 * `^[A-Z][A-Z0-9_]{0,63}$` — so the separator is unambiguous.
 */
function secretAad(scope: SecretScope): Uint8Array {
  return new TextEncoder().encode(`${scope.projectId}\u0000${scope.name}`);
}

/**
 * Derives the AES-GCM key used for deploy secrets from `DEPLOY_SECRET_KEY`.
 *
 * Call this **once** per deployment and pass the result to every
 * {@link encryptSecret} / {@link decryptSecret} call. PBKDF2 at 100k iterations
 * is real CPU work and the deploy queue consumer runs under a CPU limit, so
 * deriving per secret is not viable for a deploy that resolves several.
 *
 * @param secret - The raw `DEPLOY_SECRET_KEY` value
 * @returns A non-extractable AES-GCM key
 */
export async function deriveSecretKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(DEPLOY_SECRET_SALT),
      iterations: 100000,
      hash: "SHA-256",
    },
    baseKey,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypts a deploy secret, binding it to one project and one secret name.
 *
 * The scope travels as AES-GCM additional authenticated data, so a ciphertext
 * copied into another project's row — or renamed within the same project — fails
 * authentication instead of silently authenticating against the wrong provider
 * account.
 *
 * @param plaintext - The secret value
 * @param key - A key from {@link deriveSecretKey}
 * @param scope - The `(project_id, name)` pair to bind the ciphertext to
 * @returns Base64 of `iv || ciphertext || tag`
 */
export async function encryptSecret(
  plaintext: string,
  key: CryptoKey,
  scope: SecretScope,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, additionalData: secretAad(scope) },
    key,
    new TextEncoder().encode(plaintext),
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);

  return toBase64(combined);
}

/**
 * Decrypts a deploy secret produced by {@link encryptSecret}.
 *
 * @param ciphertext - Base64 of `iv || ciphertext || tag`
 * @param key - A key from {@link deriveSecretKey}
 * @param scope - The `(project_id, name)` pair the ciphertext must be bound to
 * @returns The plaintext, or `null` when the key, the scope, or the bytes fail to
 *   authenticate. `null` never means "empty secret": the empty string is a legal
 *   value and round-trips as `""`.
 */
export async function decryptSecret(
  ciphertext: string,
  key: CryptoKey,
  scope: SecretScope,
): Promise<string | null> {
  try {
    const combined = fromBase64(ciphertext);
    const iv = combined.slice(0, IV_LENGTH);
    const encrypted = combined.slice(IV_LENGTH);

    const decrypted = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv, additionalData: secretAad(scope) },
      key,
      encrypted,
    );

    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}
