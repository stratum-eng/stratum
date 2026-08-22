/**
 * HTML utility functions
 *
 * Shared utilities for HTML escaping and manipulation.
 */

/**
 * Escape HTML special characters to prevent XSS attacks
 *
 * Converts special characters to their HTML entities:
 * - & → &amp;
 * - < → &lt;
 * - > → &gt;
 * - " → &quot;
 * - ' → &#039;
 *
 * @param text The text to escape
 * @returns The escaped text safe for HTML insertion
 *
 * @example
 * escapeHtml('<script>alert("xss")</script>')
 * // Returns: '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * JSON-encode a value for interpolation into an inline `<script>` body.
 * `JSON.stringify` alone does not escape `<`, so a value containing
 * `</script>` would terminate the script tag early and let the rest be
 * parsed as HTML — escape it to `<` so the string stays inert.
 */
export function serializeForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
