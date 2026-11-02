/**
 * The `WWW-Authenticate` challenge the MCP endpoint answers with (#349).
 *
 * RFC 9728 makes this header the whole discovery story for a protected
 * resource: a client that gets a bare 401 knows only that it failed, while a
 * client that gets one carrying `resource_metadata` knows exactly where to go
 * to register and authorize. That is what lets someone paste a URL into their
 * editor and have the OAuth flow start on its own, with nothing else
 * configured — so this header is load-bearing UX, not decoration.
 */

import { SUPPORTED_SCOPES } from "../storage/oauth";

/** The MCP endpoint's path.
 *
 * Lives here, in a module that imports nothing from the route or middleware
 * layers, because `authMiddleware` needs it and `src/routes/mcp.ts` imports the
 * middleware (through the dispatcher) —
 * defining it there and reading it from the middleware is an import cycle that
 * leaves `authMiddleware` undefined at module-init time inside the dispatcher,
 * which fails as an unauthenticated sub-request rather than as a loud error.
 */
export const MCP_ENDPOINT_PATH = "/mcp";

/**
 * Is this the MCP endpoint?
 *
 * `authMiddleware` treats this one path specially in two ways, both documented
 * there: every 401 on it carries the OAuth challenge, and the method-based
 * read-only rule is deferred to the sub-request (every MCP call is a POST,
 * whatever the tool underneath actually does).
 */
export function isMcpPath(path: string): boolean {
  return path === MCP_ENDPOINT_PATH;
}

/** Where the protected-resource metadata lives, derived from the request so a
 * self-hosted instance advertises its own origin rather than the maintainer's.
 */
export function protectedResourceMetadataUrl(requestUrl: string): string {
  return new URL("/.well-known/oauth-protected-resource", requestUrl).toString();
}

/** Where the authorization-server metadata lives (RFC 8414). */
export function authorizationServerMetadataUrl(requestUrl: string): string {
  return new URL("/.well-known/oauth-authorization-server", requestUrl).toString();
}

/** The canonical resource identifier clients pass as RFC 8707 `resource`. */
export function mcpResourceIdentifier(requestUrl: string): string {
  return new URL(MCP_ENDPOINT_PATH, requestUrl).toString();
}

/**
 * Builds a `Bearer` challenge.
 *
 * Values are emitted as quoted-strings, so anything that would terminate one —
 * a quote or a backslash — is stripped rather than escaped. A description is
 * assembled from our own message strings today, but stripping means a future
 * caller that passes something client-controlled cannot inject a second
 * auth-param, and losing a character from an English sentence costs nothing.
 *
 * `scope` (RFC 6750 §3) names what full use of the endpoint needs. Clients that
 * follow the MCP authorization guidance take the scopes they request from this
 * attribute first and from the protected-resource metadata second; a client
 * that consults neither still gets `mcp:read` by default. Without the hint, a
 * connector authorizes read-only and fails on its first commit with no
 * indication that the fix is to re-authorize.
 */
export function buildAuthenticateChallenge(
  requestUrl: string,
  error: "invalid_token" | "insufficient_scope" | "invalid_request",
  description: string,
): string {
  const quoted = (value: string) => `"${value.replace(/["\\]/g, "")}"`;
  return [
    "Bearer",
    [
      `error=${quoted(error)}`,
      `error_description=${quoted(description)}`,
      `scope=${quoted(SUPPORTED_SCOPES.join(" "))}`,
      `resource_metadata=${quoted(protectedResourceMetadataUrl(requestUrl))}`,
    ].join(", "),
  ].join(" ");
}
