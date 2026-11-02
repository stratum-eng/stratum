/**
 * Whether an HTTP method may change state.
 *
 * Expressed as an ALLOW-LIST — only `GET` and `HEAD` are reads — rather than as
 * a deny-list of the four common write verbs. A deny-list fails *open* on the
 * fifth verb: the day someone registers a route on `PURGE`, or Hono's
 * `app.on([...])` picks up something exotic, a deny-list silently grants it to
 * a read-only credential. This way an unrecognised method is a write, which is
 * the safe direction to be wrong in.
 *
 * Deliberately NOT shared with `src/middleware/csrf.ts`, which keeps its own
 * four-verb set: broadening CSRF to every non-GET would start rejecting
 * `OPTIONS` preflights, so the two have genuinely different requirements and
 * collapsing them would trade one bug for another.
 */
export function isWriteMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD";
}
