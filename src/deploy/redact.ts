import { MAX_LOG_TAIL } from "./limits";

/** What a redacted secret is replaced with. Fixed-width so it cannot leak a value's length. */
export const REDACTION_PLACEHOLDER = "[redacted]";

/** Appended when text was cut short, so a reader can tell truncation from a provider that said little. */
export const TRUNCATION_MARKER = "\n…[truncated]";

/**
 * Replace every literal occurrence of each secret value with
 * {@link REDACTION_PLACEHOLDER}.
 *
 * **Known limitation, stated rather than claimed away:** this is literal
 * substring matching. A provider that echoes a credential base64-encoded,
 * percent-encoded, or JSON-string-escaped defeats it. The mitigation is
 * structural — no untrusted code runs in the deploy path and no request is
 * ever logged — not this function.
 *
 * Values are matched longest-first so that when one secret contains another
 * (a token and the account id embedded in it, say), the longer match wins and
 * the shorter one cannot leave a recognisable fragment behind.
 *
 * Empty values are skipped: `String.replaceAll("")` inserts the placeholder
 * between every character, which would destroy the text without protecting
 * anything.
 */
export function redactSecrets(text: string, secretValues: Iterable<string>): string {
  const values = [...new Set(secretValues)]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length);

  let redacted = text;
  for (const value of values) {
    redacted = redacted.split(value).join(REDACTION_PLACEHOLDER);
  }
  return redacted;
}

/**
 * Redact secret values from provider output, then cap it at `max` characters.
 *
 * **The order is the point.** Truncating first and redacting after would let a
 * secret that straddles the cut survive as a prefix in the retained half, with
 * nothing left for the matcher to find. Redacting first means the retained
 * text provably contains no whole secret before a single character is dropped,
 * so the cut cannot reveal one.
 *
 * The *head* is kept rather than the tail despite the `log_tail` column name:
 * v1 stores provider error documents, not build logs, and a provider's
 * `{"errors":[{"message":...}]}` puts the actionable part first. When the
 * build tier lands and real logs are stored, that trade-off should be revisited.
 */
export function redactAndTruncate(
  text: string,
  secretValues: Iterable<string>,
  max: number = MAX_LOG_TAIL,
): string {
  const redacted = redactSecrets(text, secretValues);
  if (redacted.length <= max) return redacted;

  const keep = Math.max(0, max - TRUNCATION_MARKER.length);
  return redacted.slice(0, keep) + TRUNCATION_MARKER;
}
