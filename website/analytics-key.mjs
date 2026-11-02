/**
 * The single reader for `POSTHOG_PUBLIC_KEY` on the documentation site.
 *
 * Shared deliberately. The build bakes the key into the HTML and the Worker
 * gates the proxy on it, and when those two disagreed — `startsWith("phc_")`
 * against `^phc_[A-Za-z0-9]+$` — a value like `phc_bad-key` produced a site
 * that loaded the SDK and then had every one of its requests refused by its own
 * proxy. A deployment that looks enabled and silently sends nothing is the
 * failure this whole feature is built to avoid, so there is one function and
 * both paths call it.
 *
 * It returns the key rather than a boolean for the same reason. A validator
 * that trims before testing hands its caller a verdict about a value the caller
 * does not have: `" phc_abc "` passed, and the build then embedded the padded
 * string, which PostHog rejects. Normalising and validating in one step means a
 * caller cannot obtain one without the other.
 *
 * @param {string | undefined | null} value
 * @returns {string} the trimmed project key, or `""` if it is not one
 */
export function readPostHogProjectKey(value) {
  const key = (value ?? "").trim();
  return /^phc_[A-Za-z0-9]+$/.test(key) ? key : "";
}
