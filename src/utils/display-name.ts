/**
 * The display name: a free-form label shown in the header in place of the
 * username. Never an identifier, so nothing is keyed under it and it can
 * change at any time.
 */

/** Longest display name accepted; room for a full name, short enough for the header. */
export const MAX_DISPLAY_NAME_LENGTH = 60;

/**
 * Collapse whitespace runs and drop control and format characters, then trim.
 * The value is rendered on every page, where a newline or a tab is only
 * noise — and a format character is worse: a bidi override (U+202E) reorders
 * the text around it, and a zero-width space (U+200B) makes two names look
 * identical while being different. An empty result means "no display name";
 * the caller stores NULL for it.
 */
export function normalizeDisplayName(raw: string): string {
  return raw.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
}
