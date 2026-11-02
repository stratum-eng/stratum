/**
 * Where to send someone after they sign in.
 *
 * Stratum has three sign-in paths — magic link, GitHub, Google — and each one
 * used to decide this for itself: the magic-link flow read a
 * `redirect_after_login` cookie that nothing ever set, GitHub threaded a `next`
 * parameter through its OAuth state, and Google went unconditionally to `/`.
 * That was survivable while every entry point was a plain "sign in" link, and
 * stopped being survivable with the MCP consent screen (#349): an authorization
 * request that sends an unauthenticated user to log in has to get that user
 * back to the SAME request afterwards, or the editor waiting on the redirect
 * just times out. Which button they happened to sign in with cannot decide
 * whether the flow completes.
 *
 * The cookie is the only mechanism that survives all three, because the OAuth
 * round-trips to GitHub and Google discard anything not carried in their own
 * state parameter.
 */
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env } from "../types";

export const POST_LOGIN_REDIRECT_COOKIE = "redirect_after_login";

/** Ten minutes: long enough to finish a magic-link round trip through a mail
 * client, short enough that a stale target cannot hijack an unrelated sign-in
 * days later. */
const MAX_AGE_SECONDS = 600;

/**
 * Is this a destination we are willing to send someone to after login?
 *
 * Same-origin, and expressed as a root-relative path. Rejecting `//evil.com`
 * and `/\evil.com` is the point: both are read as *protocol-relative* by
 * browsers, so a naive "starts with /" check is an open redirect, and an open
 * redirect on a login flow is a credential-phishing primitive.
 */
export function isSafeRedirectTarget(raw: string, requestUrl: string): boolean {
  if (!/^\/[^/\\]/.test(raw)) return false;
  try {
    const origin = new URL(requestUrl).origin;
    return new URL(raw, origin).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Remember where to return after login. A target that fails the safety check is
 * dropped silently rather than stored — a caller passing something unusable
 * should land on the default, not on an attacker's page.
 */
export function rememberPostLoginRedirect(c: Context<{ Bindings: Env }>, target: string): void {
  if (!isSafeRedirectTarget(target, c.req.url)) return;
  setCookie(c, POST_LOGIN_REDIRECT_COOKIE, target, {
    httpOnly: true,
    secure: true,
    // Lax, not Strict: the GitHub and Google flows return to us as a top-level
    // cross-site navigation, and a Strict cookie is withheld on exactly that
    // request — the flow would silently lose its destination.
    sameSite: "Lax",
    maxAge: MAX_AGE_SECONDS,
    path: "/",
  });
}

/**
 * Read and clear the remembered destination, falling back to `defaultRedirect`.
 *
 * Always clears, including when the stored value was unusable: leaving a
 * rejected target in the jar means the next sign-in re-evaluates it, and a
 * one-shot destination that outlives its own flow is a bug waiting for a
 * second reader.
 */
export function consumePostLoginRedirect(
  c: Context<{ Bindings: Env }>,
  defaultRedirect = "/",
): string {
  const raw = getCookie(c, POST_LOGIN_REDIRECT_COOKIE) ?? "";
  deleteCookie(c, POST_LOGIN_REDIRECT_COOKIE, { path: "/" });
  if (!isSafeRedirectTarget(raw, c.req.url)) return defaultRedirect;
  const origin = new URL(c.req.url).origin;
  const url = new URL(raw, origin);
  return url.pathname + url.search + url.hash;
}
