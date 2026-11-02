/**
 * Browser-based login: OAuth 2.1 authorization code + PKCE, run the way RFC
 * 8252 tells a native app to run it.
 *
 * The CLI is a *public* client. It ships no secret (anything in an npm tarball
 * is not a secret), so it registers itself on first use via RFC 7591 dynamic
 * registration and proves possession of the authorization code with PKCE
 * instead. The code comes back to a loopback HTTP server this process starts
 * on an ephemeral port — the one redirect target a program on someone's laptop
 * can actually own.
 *
 * Everything here talks to endpoints the Worker already serves for MCP
 * clients; nothing is CLI-specific on the server side.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** Shown on the consent screen, so make it the name a user would recognise. */
const CLIENT_NAME = "Stratum CLI";

/** The user has to find the browser, maybe sign in, then read the screen. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Every OAuth round trip is bounded. Without this a black-holed host hangs not
 * just `login` but every ordinary command, because a token refresh re-enters
 * discovery on its way to the token endpoint.
 */
const OAUTH_TIMEOUT_MS = 30_000;

const SCOPE_READ = "mcp:read";
const SCOPE_WRITE = "mcp:write";

export interface OAuthTokens {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** Absolute ISO instant, computed from `expires_in` at the moment of issue. */
  expiresAt: string;
  /** The scope the server GRANTED, which may be narrower than the one asked for. */
  scope: string;
}

export interface AuthServerMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
}

/** A token pair the caller can use without re-checking its own fields. */
interface IssuedTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: unknown;
  scope: string | undefined;
}

function describeOAuthError(body: Record<string, unknown>, status: number): string {
  const detail = body.error_description ?? body.error;
  return typeof detail === "string" && detail !== "" ? detail : `HTTP ${status}`;
}

/**
 * A token endpoint answers with credentials, so its fields are validated rather
 * than asserted: a numeric `access_token` cast to `string` is persisted as a
 * JSON number and later sent as `Bearer 12345`.
 */
function readTokenPair(body: Record<string, unknown>): IssuedTokenPair | null {
  const accessToken = body.access_token;
  const refreshToken = body.refresh_token;
  if (typeof accessToken !== "string" || accessToken === "") return null;
  if (typeof refreshToken !== "string" || refreshToken === "") return null;
  return {
    accessToken,
    refreshToken,
    expiresIn: body.expires_in,
    scope: typeof body.scope === "string" ? body.scope : undefined,
  };
}

export function normalizeHost(host: string): string {
  return host.replace(/\/$/, "");
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Refuse to run the flow over plaintext.
 *
 * Everything that follows — the authorization code, the PKCE verifier, the
 * refresh token — is a bearer credential, and `http://` puts all of it on the
 * wire in the clear. Loopback is the sole exception, because there is no wire.
 */
export function assertSecureHost(host: string): URL {
  const url = parseUrl(host);
  if (url === null) throw new Error(`'${host}' is not a valid URL`);
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url;
  throw new Error(`refusing to send credentials to ${host} over plaintext — use an https:// host`);
}

/**
 * A discovery document names the URLs this process is about to POST the
 * authorization code and the refresh token to. Trusting it blindly means a
 * hostile or tampered-with document can redirect those credentials to a server
 * of its choosing, so every endpoint must belong to the host the user named.
 */
function assertSameOrigin(endpoint: string, origin: string, field: string): void {
  const url = parseUrl(endpoint);
  if (url === null || url.origin !== origin) {
    throw new Error(
      `discovery document for ${origin} points ${field} at ${endpoint} — refusing to send credentials off-origin`,
    );
  }
}

/** A response whose body has already been read, so nothing is left to stall on. */
interface TimedResponse {
  ok: boolean;
  status: number;
  text: string;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<TimedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`request to ${url} timed out`)),
    OAUTH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    // The body is read while the timer is still armed. Clearing it as soon as
    // the headers land leaves a server free to send `200 OK` and then stall the
    // body forever — which would hang not just `login` but every command, since
    // a token refresh runs through here.
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `response.json()` on a host that answers HTML — a proxy error page, a captive
 * portal, an SPA catch-all — throws a parser error naming a stray `<`, which
 * tells the user nothing. Every OAuth response goes through here so the failure
 * names the actual problem.
 */
function readJson(response: TimedResponse, context: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(response.text);
    if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${context} did not return JSON (HTTP ${response.status})`);
  }
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/**
 * RFC 7636 §4.1: 43–128 characters from the unreserved set. 32 random bytes
 * base64url-encode to 43, the shortest length the spec allows and already 256
 * bits of entropy.
 */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Constant-time, because `state` is the CSRF defence for the callback. */
function stateMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function discover(host: string): Promise<AuthServerMetadata> {
  const origin = assertSecureHost(host).origin;
  // Built from the origin, not concatenated onto the raw host: a host carrying a
  // query or path suffix would otherwise bury the well-known path inside it.
  const url = new URL("/.well-known/oauth-authorization-server", origin).toString();
  const response = await fetchWithTimeout(url).catch((err: unknown) => {
    throw new Error(`could not reach ${host}: ${err instanceof Error ? err.message : String(err)}`);
  });
  if (!response.ok) {
    throw new Error(
      `${host} does not advertise OAuth (HTTP ${response.status} from ${url}). Use \`stratum login --key <token>\` against this host.`,
    );
  }
  let metadata: Partial<AuthServerMetadata>;
  try {
    metadata = readJson(response, `${host} OAuth discovery`) as Partial<AuthServerMetadata>;
  } catch {
    throw new Error(
      `${host} does not advertise OAuth (its discovery endpoint did not return JSON). Use \`stratum login --key <token>\` against this host.`,
    );
  }

  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error(`${host} returned incomplete OAuth metadata`);
  }
  // RFC 8414 §3.3: the issuer must be the host we asked, or the document is
  // describing somebody else's authorization server.
  if (metadata.issuer !== undefined && parseUrl(metadata.issuer)?.origin !== origin) {
    throw new Error(`discovery document for ${origin} claims issuer ${metadata.issuer}`);
  }
  assertSameOrigin(metadata.authorization_endpoint, origin, "authorization_endpoint");
  assertSameOrigin(metadata.token_endpoint, origin, "token_endpoint");
  if (metadata.registration_endpoint) {
    assertSameOrigin(metadata.registration_endpoint, origin, "registration_endpoint");
  }
  if (metadata.revocation_endpoint) {
    assertSameOrigin(metadata.revocation_endpoint, origin, "revocation_endpoint");
  }
  return metadata as AuthServerMetadata;
}

/** RFC 7591 dynamic registration. Public client: no secret, PKCE mandatory. */
async function registerClient(
  metadata: AuthServerMetadata,
  redirectUri: string,
  scope: string,
): Promise<string> {
  const endpoint = metadata.registration_endpoint;
  if (!endpoint) {
    throw new Error("This host does not support dynamic client registration");
  }
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      scope,
    }),
  });
  const body = await readJson(response, "client registration");
  const clientId = typeof body.client_id === "string" ? body.client_id : null;
  if (!response.ok || clientId === null) {
    throw new Error(`client registration failed: ${describeOAuthError(body, response.status)}`);
  }
  return clientId;
}

/**
 * Is a cached client_id still usable on this host?
 *
 * The token endpoint authenticates the client *before* it looks at the grant,
 * so a deliberately junk refresh grant separates the two cases: `invalid_client`
 * means the row is gone, anything else means it is still there. Worth the one
 * request — the alternative is discovering it in the browser, where an unknown
 * client is a dead-end HTML page rather than something the CLI can recover from.
 *
 * Fails CLOSED. Only a well-formed JSON answer proves the client exists; a 5xx,
 * a WAF interstitial, or a dropped connection proves nothing, and re-registering
 * costs one spare row while guessing wrong costs the user a dead end.
 */
async function cachedClientUsable(
  metadata: AuthServerMetadata,
  clientId: string,
): Promise<boolean> {
  const response = await fetchWithTimeout(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: "probe",
      client_id: clientId,
    }).toString(),
  }).catch(() => null);
  if (response === null) return false;
  try {
    return readJson(response, "client probe").error !== "invalid_client";
  } catch {
    // Unparseable is inconclusive, and inconclusive fails closed.
    return false;
  }
}

/**
 * Hand the URL to the user's browser. Best-effort by design: the URL is always
 * printed too, so a headless box, an unusual desktop, or a missing `open`
 * degrades to copy-and-paste rather than to a failed login.
 */
function openBrowser(url: string): void {
  // Windows deliberately avoids `cmd /c start`: cmd re-parses its argument and
  // treats `&`, `|` and `^` as syntax, so a host whose authorization_endpoint
  // carries those characters — same-origin is enforced, the path and query are
  // not — could turn opening a browser into running a command. `rundll32` takes
  // the URL as a single argument and never goes through a shell.
  const [command, args] =
    process.platform === "darwin"
      ? (["open", [url]] as const)
      : process.platform === "win32"
        ? (["rundll32", ["url.dll,FileProtocolHandler", url]] as const)
        : (["xdg-open", [url]] as const);
  try {
    const child = spawn(command, [...args], {
      stdio: "ignore",
      detached: true,
      // Explicit: `spawn` must never hand these arguments to a shell.
      shell: false,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Printed URL is the fallback.
  }
}

const DONE_STYLE =
  "font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh";

const DONE_PAGE = (heading: string, detail: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Stratum CLI</title><body style="${DONE_STYLE}"><div style="text-align:center"><h1 style="font-size:1.25rem;margin:0 0 .5rem">${heading}</h1><p style="margin:0;color:#555">${detail}</p></div>`;

interface CallbackResult {
  code: string;
}

export interface CallbackListener {
  port: number;
  /** The interface actually bound, so tests can pin the loopback-only property. */
  address: string;
  code: Promise<CallbackResult>;
  close: () => void;
}

/**
 * Start the loopback listener and return the port plus a promise for the code.
 *
 * The listener is started *before* registration so the redirect URI we register
 * is the one we will actually present. (The server also implements RFC 8252
 * §7.3 port relaxation, which is what lets a *cached* client_id keep working on
 * a different ephemeral port next time.)
 *
 * Anything the browser sends that is not a valid callback is answered and then
 * IGNORED, and the listener keeps waiting. Every page the user has open can
 * reach a loopback port, so treating a stray or mismatched request as fatal
 * would let any of them cancel a login in progress.
 */
export function listenForCallback(expectedState: string): Promise<CallbackListener> {
  const server = createServer();
  let settle: ((result: CallbackResult) => void) | null = null;
  let fail: ((err: Error) => void) | null = null;
  const code = new Promise<CallbackResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const params = url.searchParams;
    const presentedState = params.get("state") ?? "";
    // The state gate comes first: without a matching state this request did not
    // originate from the authorization we started, whatever else it carries.
    if (!stateMatches(expectedState, presentedState)) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(DONE_PAGE("Not this login", "This request did not match a login in progress."));
      return;
    }

    const error = params.get("error");
    if (error !== null) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(DONE_PAGE("Authorization declined", "You can close this window."));
      fail?.(new Error(`${error}: ${params.get("error_description") ?? "authorization denied"}`));
      return;
    }

    const authCode = params.get("code") ?? "";
    if (authCode === "") {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(DONE_PAGE("Login failed", "No authorization code was returned."));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      DONE_PAGE("Signed in to Stratum", "You can close this window and return to the terminal."),
    );
    settle?.({ code: authCode });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    // Loopback only: this listener accepts an authorization code, and nothing
    // outside this machine has any business reaching it.
    server.listen(0, "127.0.0.1", () => {
      const bound = server.address() as AddressInfo;
      resolve({
        port: bound.port,
        address: bound.address,
        code,
        close: () => server.close(),
      });
    });
  });
}

async function exchangeCode(
  metadata: AuthServerMetadata,
  params: { clientId: string; code: string; verifier: string; redirectUri: string },
): Promise<IssuedTokenPair> {
  const response = await fetchWithTimeout(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      code_verifier: params.verifier,
    }).toString(),
  });
  const body = await readJson(response, "token exchange");
  const tokens = response.ok ? readTokenPair(body) : null;
  if (tokens === null) {
    throw new Error(`token exchange failed: ${describeOAuthError(body, response.status)}`);
  }
  return tokens;
}

/**
 * `expires_in` is whatever the server sent, not necessarily a number. A string,
 * an object, or 1e18 all reach `new Date(...)` and throw `Invalid time value` —
 * and this runs *after* the token endpoint has already retired the refresh
 * token we presented, so throwing here loses the rotated token before it can be
 * written and logs the user out with an error about dates.
 *
 * An unusable value is therefore treated as absent, which the design already
 * handles: the credential looks expired and costs one extra refresh.
 */
export function expiresAtFrom(expiresIn: unknown, now = Date.now()): string {
  const seconds =
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn >= 0
      ? Math.min(expiresIn, MAX_EXPIRES_IN_SECONDS)
      : 0;
  return new Date(now + seconds * 1000).toISOString();
}

/** A year. Anything beyond this is a broken server, not a long-lived token. */
const MAX_EXPIRES_IN_SECONDS = 366 * 24 * 60 * 60;

export interface BrowserLoginOptions {
  /** Reuse a client_id from a previous login on this host, if still valid. */
  cachedClientId?: string | undefined;
  readOnly?: boolean;
  /** Where progress lines go; the caller owns stdout formatting. */
  notify?: (line: string) => void;
}

/**
 * Run the whole browser flow and return tokens ready to persist.
 */
export async function browserLogin(
  host: string,
  opts: BrowserLoginOptions = {},
): Promise<OAuthTokens> {
  const notify = opts.notify ?? (() => {});
  const requestedScope = opts.readOnly ? SCOPE_READ : `${SCOPE_READ} ${SCOPE_WRITE}`;
  const metadata = await discover(host);

  const state = base64Url(randomBytes(24));
  const { verifier, challenge } = createPkcePair();
  const listener = await listenForCallback(state);
  const redirectUri = `http://127.0.0.1:${listener.port}/callback`;

  try {
    let clientId = opts.cachedClientId;
    if (clientId && !(await cachedClientUsable(metadata, clientId))) clientId = undefined;
    if (!clientId) clientId = await registerClient(metadata, redirectUri, requestedScope);

    const authorizeUrl = new URL(metadata.authorization_endpoint);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", requestedScope);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    notify("Opening your browser to authorize the Stratum CLI…");
    notify(`If it does not open, visit:\n  ${authorizeUrl.toString()}`);
    openBrowser(authorizeUrl.toString());

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for authorization (5 minutes)")),
        LOGIN_TIMEOUT_MS,
      ).unref(),
    );
    const { code } = await Promise.race([listener.code, timeout]);

    const tokens = await exchangeCode(metadata, { clientId, code, verifier, redirectUri });
    return {
      clientId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: expiresAtFrom(tokens.expiresIn),
      // What the server granted, not what we asked for. The two can differ, and
      // recording the request would hide a narrower grant until the first write.
      scope: tokens.scope ?? requestedScope,
    };
  } finally {
    // `unref` on the timer is not what releases the event loop — the HTTP
    // server is. This close is load-bearing.
    listener.close();
  }
}

/** Distinguishes "this session is over" from "the network is down". */
export class SessionExpiredError extends Error {
  constructor(detail: string) {
    super(`session expired (${detail}). Run: stratum login`);
    this.name = "SessionExpiredError";
  }
}

/**
 * Rotate an access token. Stratum rotates the refresh token on every use, so
 * the caller MUST persist what comes back — the presented refresh token is
 * dead the moment this returns, and replaying it later reads as theft and
 * revokes the whole grant.
 */
export async function refreshTokens(
  host: string,
  params: { clientId: string; refreshToken: string; metadata?: AuthServerMetadata },
): Promise<OAuthTokens> {
  const metadata = params.metadata ?? (await discover(host));
  const response = await fetchWithTimeout(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
      client_id: params.clientId,
    }).toString(),
  });
  const body = await readJson(response, "token refresh");
  const tokens = response.ok ? readTokenPair(body) : null;
  if (tokens === null) {
    const detail = describeOAuthError(body, response.status);
    // Only the grant-level errors mean re-authenticating would help. A 429 or a
    // 503 reported as "session expired" sends the user to log in again over a
    // problem that logging in cannot fix — the same misreporting the 401 path
    // one layer up goes out of its way to avoid.
    const code = body.error;
    if (code === "invalid_grant" || code === "invalid_client") {
      throw new SessionExpiredError(detail);
    }
    throw new Error(`could not refresh the session: ${detail}`);
  }
  return {
    clientId: params.clientId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: expiresAtFrom(tokens.expiresIn),
    scope: tokens.scope ?? "",
  };
}

/**
 * RFC 7009 revocation.
 *
 * Returns whether the request was *delivered*, which is the most this can
 * honestly report: §2.2 has the server answer 200 whether or not anything
 * matched, so a `true` here never proves the grant is gone.
 */
export async function revokeToken(
  host: string,
  params: { clientId: string; token: string },
): Promise<boolean> {
  const metadata = await discover(host).catch(() => null);
  if (!metadata?.revocation_endpoint) return false;
  const response = await fetchWithTimeout(metadata.revocation_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: params.token, client_id: params.clientId }).toString(),
  }).catch(() => null);
  return response?.ok ?? false;
}
