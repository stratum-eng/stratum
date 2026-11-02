/**
 * Stratum as an OAuth 2.1 authorization server, for the remote MCP endpoint
 * (#349).
 *
 * The flow this implements is the one an MCP client runs unattended:
 *
 *   1. It hits `/mcp` with no credential and gets a 401 whose
 *      `WWW-Authenticate` names `/.well-known/oauth-protected-resource`.
 *   2. That document points at this authorization server's metadata.
 *   3. The client registers itself (`POST /oauth/register`) — it has never
 *      spoken to this instance before and nobody configured it in advance.
 *   4. It opens `/oauth/authorize` in the user's browser, where a human sees a
 *      consent screen and clicks Allow.
 *   5. It exchanges the resulting code at `/oauth/token` with a PKCE verifier.
 *
 * Steps 1-3 and 5 are unauthenticated, which is what makes "paste a URL into
 * your editor" work at all. Everything that actually confers access hangs off
 * step 4 — a human, in their own browser, in an authenticated session.
 * `client_name` on that screen is self-asserted by an anonymous registrant, so
 * the screen says so.
 */
import type { Context } from "hono";
import { Hono } from "hono";
import { setHtmlSecurityHeaders } from "../middleware/security-headers";
import { recordAudit } from "../storage/audit";
import {
  SCOPE_WRITE,
  SUPPORTED_SCOPES,
  claimAuthorizationCode,
  getClient,
  isValidCodeChallenge,
  issueAuthorizationCode,
  issueTokens,
  parseScope,
  readAuthorizationCode,
  redirectUriMatches,
  registerClient,
  revokeGrantsForClientUser,
  revokeToken,
  rotateRefreshToken,
  verifyClientSecret,
  verifyPkce,
} from "../storage/oauth";
import { getUser } from "../storage/users";
import type { Env } from "../types";
import { SourceFooter } from "../ui/components/source-footer";
import type { createLogger } from "../utils/logger";
import { mcpResourceIdentifier } from "../utils/oauth-challenge";
import { rememberPostLoginRedirect } from "../utils/post-login-redirect";
import { readJsonWithLimit, readTextWithLimit } from "../utils/request-body";
import { requestLogger } from "../utils/request-logger";

const app = new Hono<{ Bindings: Env }>();

/** Every body on every endpoint here is a handful of short fields — a client
 * id, a redirect URI, a code, a verifier. Anything past this is not a client we
 * want to buffer for, and three of these endpoints are unauthenticated. */
const MAX_OAUTH_BODY_BYTES = 64 * 1024;

/**
 * Read a form-encoded body under the cap.
 *
 * `c.req.text()` and `c.req.formData()` both buffer whatever arrives, so every
 * endpoint here goes through the shared streaming limit instead — the cap is
 * enforced DURING the read, so an absent or understated `Content-Length` cannot
 * get past it. Returns the OAuth error to send when the body is too large.
 */
async function readForm(
  c: Context<{ Bindings: Env }>,
  logger: ReturnType<typeof createLogger>,
): Promise<{ form: URLSearchParams } | { response: Response }> {
  const body = await readTextWithLimit(c, MAX_OAUTH_BODY_BYTES, logger);
  if (body.tooLarge) {
    return {
      response: oauthError(
        "invalid_request",
        `Request body too large (max ${MAX_OAUTH_BODY_BYTES} bytes)`,
        413,
      ),
    };
  }
  return { form: new URLSearchParams(body.text) };
}

/**
 * Endpoints that authenticate the CLIENT rather than a Stratum user, and so
 * must be skipped by `authMiddleware`.
 *
 * Two independent reasons, either of which is sufficient:
 *  - `client_secret_basic` sends `Authorization: Basic …`, and the middleware
 *    rejects every non-Bearer Authorization header with a 401 before routing.
 *  - They are reachable before the caller has any Stratum credential at all;
 *    that is the point of them.
 *
 * `/oauth/authorize` is deliberately NOT in this list: it is the one step that
 * requires a signed-in human.
 */
export function isOAuthClientEndpoint(path: string): boolean {
  return path === "/oauth/register" || path === "/oauth/token" || path === "/oauth/revoke";
}

/** RFC 6749 §5.2 error body. Kept distinct from `utils/response`'s `{error,
 * code}` shape because OAuth clients parse `error`/`error_description` by
 * name and will not understand ours. */
function oauthError(
  error: string,
  description: string,
  status: 400 | 401 | 403 | 404 | 405 | 413 | 500 = 400,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error, error_description: description },
    {
      status,
      headers: {
        // Never cached, never stored: these bodies sit one step away from
        // credentials in the same exchange.
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        ...headers,
      },
    },
  );
}

/** A JSON response that must never be cached: these bodies carry, or sit one
 * step away from, credentials. */
function jsonNoStore(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}

// ── Discovery ───────────────────────────────────────────────────────────────

/**
 * Metadata documents are built from the REQUEST origin, never from a
 * configured base URL. A self-hosted instance, a staging deploy and a
 * `workers.dev` preview all serve correct documents with nothing to configure,
 * and a client that reached us at one hostname is never told to authorize at
 * another.
 */
function authorizationServerMetadata(requestUrl: string): Record<string, unknown> {
  const origin = new URL(requestUrl).origin;
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: [...SUPPORTED_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // OAuth 2.1: PKCE is mandatory and `plain` is not offered. Advertising only
    // S256 means a client cannot negotiate its way down to a challenge that
    // protects nothing.
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    // RFC 8707: we honour `resource`, which is what binds a token to this MCP
    // server rather than to any server the user happens to have authorized.
    resource_indicators_supported: true,
    service_documentation: "https://docs.usestratum.dev/guides/mcp/",
  };
}

app.get("/.well-known/oauth-authorization-server", (c) =>
  jsonNoStore(authorizationServerMetadata(c.req.url)),
);

/**
 * RFC 9728 protected-resource metadata.
 *
 * Served at the bare path and at `/mcp`-suffixed variants, because clients
 * differ on which they request: the spec derives the path from the resource's
 * own path, while several shipping clients ask for the bare document. Serving
 * both costs one route and removes a class of "it works in one editor" bug.
 */
function protectedResourceMetadata(requestUrl: string): Record<string, unknown> {
  const origin = new URL(requestUrl).origin;
  return {
    resource: mcpResourceIdentifier(requestUrl),
    authorization_servers: [origin],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://docs.usestratum.dev/guides/mcp/",
  };
}

app.get("/.well-known/oauth-protected-resource", (c) =>
  jsonNoStore(protectedResourceMetadata(c.req.url)),
);
app.get("/.well-known/oauth-protected-resource/mcp", (c) =>
  jsonNoStore(protectedResourceMetadata(c.req.url)),
);

// ── Dynamic client registration (RFC 7591) ──────────────────────────────────

interface RegistrationBody {
  client_name?: unknown;
  redirect_uris?: unknown;
  scope?: unknown;
  token_endpoint_auth_method?: unknown;
}

app.post("/oauth/register", async (c) => {
  const logger = requestLogger(c);

  const raw = await readJsonWithLimit<RegistrationBody>(c, MAX_OAUTH_BODY_BYTES, logger);
  if (raw instanceof Response) return raw;
  const redirectUris = Array.isArray(raw.redirect_uris) ? raw.redirect_uris : [];
  if (redirectUris.some((uri) => typeof uri !== "string")) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be an array of strings");
  }

  const result = await registerClient(c.env.DB, logger, {
    // A client that omits `client_name` still registers — the spec makes the
    // field optional — but it shows up on the consent screen under a label that
    // says exactly how much we know about it.
    clientName: typeof raw.client_name === "string" ? raw.client_name : "Unnamed MCP client",
    redirectUris: redirectUris as string[],
    ...(typeof raw.scope === "string" ? { scope: raw.scope } : {}),
    ...(typeof raw.token_endpoint_auth_method === "string"
      ? { tokenEndpointAuthMethod: raw.token_endpoint_auth_method }
      : {}),
  });

  if (!result.success) {
    const code =
      result.error.code === "INVALID_SCOPE" ? "invalid_scope" : "invalid_client_metadata";
    return oauthError(
      result.error.code === "INVALID_REDIRECT_URI" ? "invalid_redirect_uri" : code,
      result.error.message,
      result.error.code === "DATABASE_ERROR" ? 500 : 400,
    );
  }

  const { client, clientSecret } = result.data;
  return jsonNoStore(
    {
      client_id: client.id,
      ...(clientSecret !== undefined ? { client_secret: clientSecret } : {}),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      scope: client.scope,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // 0 = never expires, per RFC 7591. A client_id is a public identifier
      // that confers nothing without a user's consent, so expiring it would
      // only break long-lived editor installs for no security gain.
      client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
      client_secret_expires_at: 0,
    },
    201,
  );
});

// ── Authorization ───────────────────────────────────────────────────────────

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string | undefined;
  codeChallenge: string;
  resource: string | null;
}

/**
 * Parse and fully validate an authorization request.
 *
 * Returns either the validated parameters, or the Response to send instead.
 * The split that matters is WHERE an error goes:
 *
 *  - A bad `client_id` or a `redirect_uri` that is not registered means we
 *    cannot trust the redirect target, so the error is RENDERED here. Bouncing
 *    it to an unverified URI is precisely the open redirect that turns this
 *    endpoint into a phishing gadget.
 *  - Anything else is redirected back to the (now verified) URI as an OAuth
 *    error, which is what lets the client show a real message instead of
 *    hanging.
 */
async function validateAuthorizeRequest(
  c: Context<{ Bindings: Env }>,
  logger: ReturnType<typeof createLogger>,
  params: URLSearchParams,
): Promise<{ params: AuthorizeParams } | { response: Response }> {
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const state = params.get("state") ?? undefined;

  if (clientId === "") {
    return {
      response: await renderAuthorizeError(c, "Missing client_id", "This request is malformed."),
    };
  }

  const clientResult = await getClient(c.env.DB, logger, clientId);
  if (!clientResult.success) {
    return {
      response: await renderAuthorizeError(
        c,
        "Unknown client",
        "No application is registered under that client_id. It may have been removed, or the link may be for a different Stratum instance.",
      ),
    };
  }
  const client = clientResult.data;

  // Exact match against the registered list, with the single RFC 8252 §7.3
  // exception for a loopback redirect's port (see `redirectUriMatches`). No
  // prefix matching, no subdirectory allowance, no ignoring the query string —
  // every other relaxation of this comparison is a published way to steal
  // authorization codes.
  if (redirectUri === "" || !redirectUriMatches(client.redirectUris, redirectUri)) {
    logger.warn("Authorization rejected - redirect_uri not registered", { clientId });
    return {
      response: await renderAuthorizeError(
        c,
        "Redirect URI mismatch",
        "The application asked to be sent back to an address it has not registered. Nothing has been shared.",
      ),
    };
  }

  // From here the redirect target is trusted, so failures go back to the client.
  const fail = (error: string, description: string): { response: Response } => {
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (state !== undefined) url.searchParams.set("state", state);
    return { response: c.redirect(url.toString()) };
  };

  if ((params.get("response_type") ?? "") !== "code") {
    return fail("unsupported_response_type", "Only response_type=code is supported");
  }

  const codeChallenge = params.get("code_challenge") ?? "";
  const challengeMethod = params.get("code_challenge_method") ?? "";
  if (codeChallenge === "") {
    return fail("invalid_request", "PKCE is required: code_challenge is missing");
  }
  if (challengeMethod !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256");
  }
  if (!isValidCodeChallenge(codeChallenge)) {
    return fail("invalid_request", "code_challenge is not a base64url SHA-256 digest");
  }

  const scopeResult = parseScope(params.get("scope") ?? undefined);
  if (!scopeResult.success) {
    return fail("invalid_scope", scopeResult.error.message);
  }

  // RFC 8707. A client that names a resource must name THIS one; a token minted
  // here is only ever valid here, and echoing back someone else's identifier
  // would invite a client to treat it as valid elsewhere.
  const resource = params.get("resource");
  if (resource !== null && resource !== "") {
    const expected = mcpResourceIdentifier(c.req.url);
    // Compared as URLs so a trailing slash or a default port is not a mismatch.
    let matches = false;
    try {
      matches = new URL(resource).toString().replace(/\/$/, "") === expected.replace(/\/$/, "");
    } catch {
      matches = false;
    }
    if (!matches) {
      return fail("invalid_target", `This server only issues tokens for ${expected}`);
    }
  }

  return {
    params: {
      clientId,
      redirectUri,
      scope: scopeResult.data,
      state,
      codeChallenge,
      resource: resource === "" ? null : resource,
    },
  };
}

/** A dead-end error page for the cases where redirecting would itself be the
 * vulnerability. Deliberately offers no link onward to the client. */
async function renderAuthorizeError(
  c: Context<{ Bindings: Env }>,
  title: string,
  detail: string,
): Promise<Response> {
  return c.html(
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title} — Stratum</title>
        <link rel="stylesheet" href="/ui.css" />
        <style>{CONSENT_CSS}</style>
      </head>
      <body>
        <div class="consent-page">
          <div class="consent-card">
            <h1 class="consent-title">{title}</h1>
            <p class="consent-detail">{detail}</p>
            <p class="consent-detail">
              <a href="/">Return to Stratum</a>
            </p>
          </div>
        </div>
        <SourceFooter />
      </body>
    </html>,
    400,
  );
}

const CONSENT_CSS = `
  .consent-page {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem 1rem;
    background: var(--bg-primary);
  }
  .consent-card {
    width: 100%;
    max-width: 460px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 2rem;
  }
  .consent-title { margin: 0 0 0.5rem; font-size: 1.25rem; }
  .consent-detail { margin: 0 0 0.75rem; color: var(--text-secondary); font-size: 0.9rem; line-height: 1.5; }
  .consent-client {
    display: block;
    font-family: monospace;
    word-break: break-all;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 0.65rem;
    margin: 0.35rem 0 1rem;
    font-size: 0.85rem;
  }
  .consent-scopes { list-style: none; padding: 0; margin: 0 0 1.25rem; }
  .consent-scopes li {
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.9rem;
  }
  .consent-scopes li:last-child { border-bottom: none; }
  .consent-more {
    margin-top: 1.25rem;
    font-size: 0.82rem;
    color: var(--text-secondary);
    line-height: 1.45;
  }
  .consent-more summary { cursor: pointer; color: var(--text-muted, var(--text-secondary)); }
  .consent-more p { margin: 0.6rem 0 0; }
  .consent-more .consent-client { margin: 0.35rem 0 0; }
  .consent-actions { display: flex; gap: 0.75rem; }
  .consent-actions button { flex: 1; padding: 0.6rem 1rem; border-radius: 6px; cursor: pointer; font-size: 0.92rem; border: 1px solid transparent; }
  /* Mirrors .btn-primary. The accent is a deep navy, so near-black text on it
     read as a disabled button; the accent-text pair is the legible one. */
  .consent-allow { background: var(--accent); border-color: var(--accent-border); color: var(--accent-text); font-weight: 600; }
  .consent-allow:hover { background: var(--accent-hover); color: var(--accent-text-hover); }
  .consent-deny { background: transparent; color: var(--text-primary); border-color: var(--border); }
`;

/** Plain-language rendering of a scope. Never show a raw scope token to a
 * person and expect an informed decision. */
function describeScope(scope: string): string[] {
  const lines = ["Read your projects, files, changes, evaluations and issues"];
  if (scope.split(/\s+/).includes(SCOPE_WRITE)) {
    lines.push("Create workspaces, commit files, and open changes for evaluation");
    lines.push("Merge, reject and review changes, and manage issues");
  }
  return lines;
}

app.get("/oauth/authorize", async (c) => {
  const logger = requestLogger(c);
  const url = new URL(c.req.url);

  // Sign-in comes FIRST, before the request is validated, so an unauthenticated
  // visitor is never told whether a given client_id exists. It also means the
  // full authorization request survives the round trip: we remember this exact
  // URL (query string and all) and every sign-in path returns to it.
  const userId = c.get("userId");
  if (!userId || c.get("authVia") !== "session") {
    rememberPostLoginRedirect(c, url.pathname + url.search);
    return c.redirect("/auth/login");
  }

  const validated = await validateAuthorizeRequest(c, logger, url.searchParams);
  if ("response" in validated) return validated.response;
  const params = validated.params;

  const userResult = await getUser(c.env.DB, userId, logger);
  if (!userResult.success) {
    return renderAuthorizeError(c, "Session problem", "Please sign in again.");
  }

  const clientResult = await getClient(c.env.DB, logger, params.clientId);
  if (!clientResult.success) {
    return renderAuthorizeError(c, "Unknown client", "This application is no longer registered.");
  }
  const clientName = clientResult.data.clientName;
  // The first of three lines a healthy connection leaves: this, then
  // "Authorization code issued", then "OAuth tokens issued" seconds later.
  logger.info("MCP consent screen shown", {
    clientId: params.clientId,
    clientName,
    userId,
    scope: params.scope,
  });

  // No `form-action` on this page. Its form POSTs to us, but the answer to that
  // POST is a redirect to the client's callback, and Chromium and WebKit check
  // the submitting page's `form-action` against EVERY hop of the chain that
  // follows — not just the first. Naming the registered redirect origin was
  // not enough: Claude's callback itself answers with a 307 onward, and any hop
  // to an origin this page did not list cancels the whole navigation, leaving
  // the user on a consent page that "did nothing" while the code sits minted
  // and undelivered. The chain past our redirect belongs to the client and is
  // not ours to enumerate, so the directive is omitted here rather than guessed
  // at. This page has no user-controlled markup and its only form targets
  // `/oauth/authorize`, so the directive protected nothing here anyway. Every
  // other response keeps the site-wide `'self'`. See `CspOptions`.
  setHtmlSecurityHeaders(c, { formAction: null });

  return c.html(
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Authorize — Stratum</title>
        <link rel="stylesheet" href="/ui.css" />
        <style>{CONSENT_CSS}</style>
      </head>
      <body>
        <div class="consent-page">
          <div class="consent-card">
            <h1 class="consent-title">
              Allow <strong>{clientName}</strong> to access Stratum?
            </h1>
            {/* The host it returns to is the one signal a person can actually
                check against a self-asserted name, so it stays above the fold;
                the full URI and the rest of the fine print are one click away. */}
            <p class="consent-detail">
              Signed in as <strong>{userResult.data.username}</strong>. Returns you to{" "}
              <strong>{new URL(params.redirectUri).host}</strong> when done.
            </p>

            <p class="consent-detail">It will be able to:</p>
            <ul class="consent-scopes">
              {describeScope(params.scope).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>

            <form method="post" action="/oauth/authorize">
              <input type="hidden" name="client_id" value={params.clientId} />
              <input type="hidden" name="redirect_uri" value={params.redirectUri} />
              <input type="hidden" name="scope" value={params.scope} />
              <input type="hidden" name="code_challenge" value={params.codeChallenge} />
              {params.state !== undefined && (
                <input type="hidden" name="state" value={params.state} />
              )}
              {params.resource !== null && (
                <input type="hidden" name="resource" value={params.resource} />
              )}
              <div class="consent-actions">
                <button type="submit" name="decision" value="deny" class="consent-deny">
                  Cancel
                </button>
                <button type="submit" name="decision" value="allow" class="consent-allow">
                  Allow
                </button>
              </div>
            </form>

            {/* Anyone can register a client under any name. Saying so is the
                only defence against a client registered as "Stratum Official". */}
            <details class="consent-more">
              <summary>Where this request came from</summary>
              <p>
                Application names are self-declared: any application can register itself under any
                name. Only continue if you started this connection from{" "}
                <strong>{clientName}</strong> yourself.
              </p>
              <p>After you allow, your browser is sent to:</p>
              <code class="consent-client">{params.redirectUri}</code>
              <p>
                You can disconnect it at any time from{" "}
                <a href="/settings">Settings → Connected applications</a>.
              </p>
            </details>
          </div>
        </div>
        <SourceFooter />
      </body>
    </html>,
  );
});

app.post("/oauth/authorize", async (c) => {
  const logger = requestLogger(c);

  const userId = c.get("userId");
  if (!userId || c.get("authVia") !== "session") {
    // No redirect-to-login here: a POST cannot be replayed after a sign-in
    // round trip, so the honest answer is "start again".
    return renderAuthorizeError(c, "Not signed in", "Your session expired. Please start again.");
  }

  const body = await readForm(c, logger);
  if ("response" in body) return body.response;
  const form = body.form;

  const asParams = new URLSearchParams();
  for (const key of ["client_id", "redirect_uri", "scope", "state", "code_challenge", "resource"]) {
    const value = form.get(key);
    if (value !== null) asParams.set(key, value);
  }
  // The GET validated a request built from the query string; re-validate the
  // POST from scratch rather than trusting the hidden fields that came back.
  // They round-tripped through a page, and a page is not a trust boundary.
  asParams.set("response_type", "code");
  asParams.set("code_challenge_method", "S256");

  const validated = await validateAuthorizeRequest(c, logger, asParams);
  if ("response" in validated) return validated.response;
  const params = validated.params;

  const redirect = new URL(params.redirectUri);
  if (params.state !== undefined) redirect.searchParams.set("state", params.state);

  if (form.get("decision") !== "allow") {
    logger.info("MCP consent declined", { clientId: params.clientId, userId });
    redirect.searchParams.set("error", "access_denied");
    redirect.searchParams.set("error_description", "The user declined the request");
    return c.redirect(redirect.toString());
  }

  const code = await issueAuthorizationCode(c.env.DB, logger, {
    clientId: params.clientId,
    userId,
    redirectUri: params.redirectUri,
    scope: params.scope,
    codeChallenge: params.codeChallenge,
    resource: params.resource,
  });
  if (!code.success) {
    redirect.searchParams.set("error", "server_error");
    redirect.searchParams.set("error_description", "Could not issue an authorization code");
    return c.redirect(redirect.toString());
  }

  await recordAudit(c.env.DB, logger, {
    action: "oauth.authorized",
    actorType: "user",
    actorId: userId,
    detail: { clientId: params.clientId, scope: params.scope },
  });

  redirect.searchParams.set("code", code.data.code);
  return c.redirect(redirect.toString());
});

// ── Token ───────────────────────────────────────────────────────────────────

/**
 * Which client is calling, and did it prove it?
 *
 * Handles both registered auth methods plus the public-client case. Basic
 * credentials are form-encoded per RFC 6749 §2.3.1 — the userinfo is
 * percent-encoded before base64, and skipping the decode breaks any client
 * whose id or secret contains a reserved character.
 */
function readClientCredentials(
  header: string | undefined,
  form: URLSearchParams,
): { clientId: string; clientSecret?: string } | null {
  if (header?.startsWith("Basic ")) {
    let decoded: string;
    try {
      decoded = atob(header.slice(6));
    } catch {
      return null;
    }
    const separator = decoded.indexOf(":");
    if (separator === -1) return null;
    try {
      return {
        clientId: decodeURIComponent(decoded.slice(0, separator)),
        clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
      };
    } catch {
      // `decodeURIComponent` throws URIError on a malformed percent sequence
      // (`%zz`). Unhandled, that is a 500 from an unauthenticated endpoint;
      // caught, it is the `invalid_client` this function exists to return.
      return null;
    }
  }
  const clientId = form.get("client_id");
  if (clientId === null || clientId === "") return null;
  const secret = form.get("client_secret");
  return secret === null || secret === "" ? { clientId } : { clientId, clientSecret: secret };
}

app.post("/oauth/token", async (c) => {
  const logger = requestLogger(c);

  // RFC 6749 §4.1.3 mandates form encoding here. Parsed by us rather than by
  // the framework so a client sending a wrong Content-Type gets an OAuth error
  // rather than a framework-level failure.
  const body = await readForm(c, logger);
  if ("response" in body) return body.response;
  const form = body.form;

  const credentials = readClientCredentials(c.req.header("Authorization"), form);
  if (credentials === null) {
    return oauthError("invalid_client", "No client credentials presented", 401, {
      "WWW-Authenticate": 'Basic realm="stratum"',
    });
  }

  const clientResult = await getClient(c.env.DB, logger, credentials.clientId);
  if (!clientResult.success) {
    return oauthError("invalid_client", "Unknown client", 401);
  }
  const client = clientResult.data;

  if (!(await verifyClientSecret(client, credentials.clientSecret))) {
    logger.warn("Token request rejected - client authentication failed", {
      clientId: client.id,
    });
    return oauthError("invalid_client", "Client authentication failed", 401);
  }

  const grantType = form.get("grant_type") ?? "";
  if (grantType === "refresh_token") return handleRefreshGrant(c, logger, client.id, form);
  if (grantType === "authorization_code") return handleCodeGrant(c, logger, client, form);
  return oauthError(
    "unsupported_grant_type",
    "Supported grant types: authorization_code, refresh_token",
  );
});

/**
 * The `authorization_code` grant.
 *
 * Order is the security property here: the code is READ, then every binding it
 * carries is checked (client, redirect URI, PKCE), and only then is it claimed.
 * See `readAuthorizationCode` for why claiming first would let anyone who
 * merely observed a code disrupt the client that rightfully holds it.
 */
async function handleCodeGrant(
  c: Context<{ Bindings: Env }>,
  logger: ReturnType<typeof createLogger>,
  client: { id: string; redirectUris: string[] },
  form: URLSearchParams,
): Promise<Response> {
  const code = form.get("code") ?? "";
  const verifier = form.get("code_verifier") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";

  if (code === "") return oauthError("invalid_request", "Missing code");
  if (verifier === "") return oauthError("invalid_request", "Missing code_verifier");

  // Read WITHOUT consuming. Everything below has to pass before the code is
  // claimed, so a caller that cannot legitimately redeem it — the wrong client,
  // the wrong redirect URI, the wrong verifier — leaves it untouched for the
  // client that can. See `readAuthorizationCode` for why that matters.
  const found = await readAuthorizationCode(c.env.DB, logger, code);
  if (!found.success) {
    if (found.error === "lookup_failed") {
      return oauthError("server_error", "Could not verify the authorization code", 500);
    }
    return oauthError("invalid_grant", "Authorization code is invalid or expired");
  }
  const record = found.data;

  if (record.alreadyConsumed) {
    logger.warn("Token request rejected - authorization code replayed", {
      clientId: client.id,
      codeId: record.codeId,
    });
    // RFC 6749 §10.5: a code presented twice means it leaked. Everything the
    // grant produced is now suspect, so the whole grant goes — the legitimate
    // client re-authorizes, the attacker's copy is worthless.
    await revokeGrantsForClientUser(c.env.DB, logger, {
      clientId: record.clientId,
      userId: record.userId,
    });
    return oauthError("invalid_grant", "Authorization code has already been used");
  }

  // The code was minted for a specific client. Without this check, any
  // registered client that intercepted a code could redeem it as itself.
  if (record.clientId !== client.id) {
    logger.warn("Token request rejected - code issued to a different client", {
      codeId: record.codeId,
      codeClientId: record.clientId,
      presentedClientId: client.id,
    });
    return oauthError("invalid_grant", "Authorization code was issued to a different client");
  }

  // RFC 6749 §4.1.3: the redirect_uri must match the one the code was bound to.
  if (redirectUri !== record.redirectUri) {
    return oauthError("invalid_grant", "redirect_uri does not match the authorization request");
  }

  if (!(await verifyPkce(verifier, record.codeChallenge))) {
    logger.warn("Token request rejected - PKCE verification failed", {
      clientId: client.id,
      codeId: record.codeId,
    });
    return oauthError("invalid_grant", "PKCE verification failed");
  }

  // Only now: the atomic single-use claim. Losing this race means a concurrent
  // request already redeemed the code, which is a replay like any other.
  const claimed = await claimAuthorizationCode(c.env.DB, logger, code);
  if (!claimed.success) {
    if (claimed.error === "replayed") {
      await revokeGrantsForClientUser(c.env.DB, logger, {
        clientId: record.clientId,
        userId: record.userId,
      });
      return oauthError("invalid_grant", "Authorization code has already been used");
    }
    return oauthError("server_error", "Could not redeem the authorization code", 500);
  }

  const tokens = await issueTokens(c.env.DB, logger, {
    clientId: client.id,
    userId: record.userId,
    scope: record.scope,
    codeId: record.codeId,
  });
  if (!tokens.success) return oauthError("server_error", "Could not issue tokens", 500);

  return jsonNoStore({
    access_token: tokens.data.accessToken,
    token_type: "Bearer",
    expires_in: tokens.data.expiresIn,
    refresh_token: tokens.data.refreshToken,
    scope: tokens.data.scope,
  });
}

/**
 * The `refresh_token` grant.
 *
 * Rotation is mandatory and happens inside `rotateRefreshToken`, which also
 * detects reuse of an already-retired token and revokes the grant when it sees
 * one. Every failure is reported identically as `invalid_grant`: distinguishing
 * "expired" from "revoked" from "reused" would tell a caller holding a stolen
 * token which it is.
 */
async function handleRefreshGrant(
  c: Context<{ Bindings: Env }>,
  logger: ReturnType<typeof createLogger>,
  clientId: string,
  form: URLSearchParams,
): Promise<Response> {
  const refreshToken = form.get("refresh_token") ?? "";
  if (refreshToken === "") return oauthError("invalid_request", "Missing refresh_token");

  const rotated = await rotateRefreshToken(c.env.DB, logger, { refreshToken, clientId });
  if (!rotated.success) {
    return oauthError("invalid_grant", "Refresh token is invalid, expired, or revoked");
  }

  return jsonNoStore({
    access_token: rotated.data.accessToken,
    token_type: "Bearer",
    expires_in: rotated.data.expiresIn,
    refresh_token: rotated.data.refreshToken,
    scope: rotated.data.scope,
  });
}

// ── Revocation (RFC 7009) ───────────────────────────────────────────────────

app.post("/oauth/revoke", async (c) => {
  const logger = requestLogger(c);

  const body = await readForm(c, logger);
  if ("response" in body) return body.response;
  const form = body.form;

  const token = form.get("token") ?? "";
  if (token === "") return oauthError("invalid_request", "Missing token");

  const credentials = readClientCredentials(c.req.header("Authorization"), form);
  let clientId: string | undefined;
  if (credentials !== null) {
    const clientResult = await getClient(c.env.DB, logger, credentials.clientId);
    if (
      clientResult.success &&
      (await verifyClientSecret(clientResult.data, credentials.clientSecret))
    ) {
      clientId = clientResult.data.id;
    }
  }

  await revokeToken(c.env.DB, logger, { token, ...(clientId ? { clientId } : {}) });

  // RFC 7009 §2.2: 200 regardless of whether the token existed. Reporting the
  // difference would make this endpoint a free oracle for testing stolen
  // tokens.
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
});

export { app as mcpOAuthRouter };
