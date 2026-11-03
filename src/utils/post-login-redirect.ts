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
 *
 * The check runs on the *normalized* path too, because that — not `raw` — is
 * what callers put in the Location header. URL parsing resolves dot segments,
 * so `/.//evil.com`, `/a/..//evil.com` and `/%2e//evil.com` all pass a check
 * on the raw string and stay same-origin, yet normalize to `//evil.com`.
 */
export function isSafeRedirectTarget(raw: string, requestUrl: string): boolean {
  if (!/^\/(?![/\\])/.test(raw)) return false;
  try {
    const origin = new URL(requestUrl).origin;
    const url = new URL(raw, origin);
    return url.origin === origin && !/^\/[/\\]/.test(url.pathname);
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

/** The one destination a magic link may carry across devices (#410). */
const OAUTH_AUTHORIZE_PATH = "/oauth/authorize";

/**
 * Is this a safe, same-origin target whose normalized path is exactly the MCP
 * authorization endpoint? An allowlist on top of {@link isSafeRedirectTarget}:
 * a destination stored inside a magic link outlives the browser that chose it,
 * so it is held to the narrowest set we have a reason to carry — the consent
 * screen — and nothing else.
 *
 * @returns The normalized `path?query` to redirect to, or null when refused
 */
export function oauthAuthorizeTarget(raw: string, requestUrl: string): string | null {
  if (!isSafeRedirectTarget(raw, requestUrl)) return null;
  const origin = new URL(requestUrl).origin;
  const url = new URL(raw, origin);
  if (url.pathname !== OAUTH_AUTHORIZE_PATH) return null;
  return url.pathname + url.search;
}

/**
 * The remembered destination when it is an OAuth authorization request, read
 * WITHOUT clearing it: the login and signup pages use this to say "you are
 * connecting an editor", and the sign-in that follows still consumes it.
 */
export function pendingOAuthAuthorize(c: Context<{ Bindings: Env }>): string | null {
  const raw = getCookie(c, POST_LOGIN_REDIRECT_COOKIE);
  if (raw === undefined) return null;
  return oauthAuthorizeTarget(raw, c.req.url);
}

/**
 * The `invite` parameter an MCP client put on its authorization URL, for
 * instances running the invite gate. Display-only (it pre-fills a form field);
 * the code is validated when the form is submitted, as any typed code is.
 */
export function inviteFromAuthorizeTarget(target: string): string {
  const invite = new URL(target, "https://placeholder.invalid").searchParams.get("invite") ?? "";
  return /^[A-Za-z0-9-]{1,64}$/.test(invite) ? invite : "";
}

/**
 * Cookie tying a magic link's bound return-to to the browser that requested
 * it. Holds a random nonce; the link's server-side payload holds only its hash.
 */
export const MAGIC_LINK_BINDING_COOKIE = "magic_link_binding";

/** Matches the magic link's own 15-minute lifetime. */
const BINDING_MAX_AGE_SECONDS = 15 * 60;

/** Where verify sends a browser whose bound consent screen cannot follow it. */
export const RECONNECT_EDITOR_PATH = "/auth/email/reconnect";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Bind a return-to to this browser: set a fresh nonce cookie and return the
 * hash to store in the magic link's payload.
 */
export async function bindReturnToBrowser(c: Context<{ Bindings: Env }>): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  setCookie(c, MAGIC_LINK_BINDING_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: BINDING_MAX_AGE_SECONDS,
    path: "/auth/email",
  });
  return sha256Hex(nonce);
}

/**
 * Decide whether a verified magic link's bound return-to may be followed here.
 *
 * The return-to is honoured only when the browser verifying the link is the
 * one that asked for it. A link opened anywhere else — another device, or a
 * mailbox someone else forwarded it to — could otherwise drop a stranger onto
 * a consent screen for a client they never started connecting, which is a
 * phishing primitive; and the client's loopback redirect would not reach the
 * editor from there anyway. The caller then falls back to the cookie-remembered
 * destination (which can only exist in the originating browser) and then to
 * the "reconnect your editor" page. Always clears the binding cookie.
 *
 * @returns null when the link carried no return-to; otherwise the normalized
 *   target to follow, or `target: null` when it must not be followed here
 */
export async function resolveBoundReturn(
  c: Context<{ Bindings: Env }>,
  bound: { returnTo?: string; returnBinding?: string },
): Promise<{ target: string | null } | null> {
  if (bound.returnTo === undefined) return null;
  const nonce = getCookie(c, MAGIC_LINK_BINDING_COOKIE);
  deleteCookie(c, MAGIC_LINK_BINDING_COOKIE, { path: "/auth/email" });
  const target = oauthAuthorizeTarget(bound.returnTo, c.req.url);
  if (target === null || nonce === undefined || bound.returnBinding === undefined) {
    return { target: null };
  }
  const sameBrowser = (await sha256Hex(nonce)) === bound.returnBinding;
  return { target: sameBrowser ? target : null };
}
