/**
 * The one authentication this Worker has: HMAC-SHA256 with the secret it
 * shares with Stratum, in the same `sha256=<hex>` form as every Stratum check
 * dispatch and callback.
 */
const encoder = new TextEncoder();

async function importKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/** `sha256=<hex>` over `message`. */
export async function sign(secret: string, message: string): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await importKey(secret, "sign"),
    encoder.encode(message),
  );
  const hex = Array.from(new Uint8Array(mac))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

/**
 * Whether `header` is the signature of `message` under `secret`.
 *
 * The comparison is `crypto.subtle.verify`, which compares the two MACs in
 * constant time; nothing here compares signature strings. A header of the
 * wrong shape is refused before any key is touched, which leaks only that it
 * was malformed.
 */
export async function verify(
  secret: string,
  message: string,
  header: string | null | undefined,
): Promise<boolean> {
  if (secret === "" || typeof header !== "string") return false;
  const match = /^sha256=([0-9a-f]{64})$/.exec(header.trim());
  if (!match?.[1]) return false;
  const signature = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    signature[i] = Number.parseInt(match[1].slice(i * 2, i * 2 + 2), 16);
  }
  return crypto.subtle.verify(
    "HMAC",
    await importKey(secret, "verify"),
    signature,
    encoder.encode(message),
  );
}
