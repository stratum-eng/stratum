import { type AppError, ExternalServiceError, ValidationError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/**
 * OIDC discovery (`/.well-known/openid-configuration`) with SSRF hardening.
 *
 * The issuer is org-admin-supplied and the discovery document is fetched
 * server-side, so both the issuer URL and every endpoint the document names
 * are attacker-suppliable. Each must independently pass host validation
 * (https, public non-IP hostname) before anything is stored — a hostile IdP
 * must not be able to point login-time token/JWKS fetches at internal hosts.
 */

/**
 * Issuers reserved for the existing OAuth flows. An org connection claiming
 * one could mint `identities` rows in the GitHub/Google namespace and re-point
 * OAuth-linked accounts, so they are rejected outright.
 */
export const RESERVED_ISSUERS = ["https://github.com", "https://accounts.google.com"] as const;

export interface OidcEndpoints {
  /** The canonical (trailing-slash-normalized) issuer callers should store. */
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

const DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_DISCOVERY_BYTES = 64 * 1024;

// Suffixes that resolve inside private/reserved namespaces regardless of DNS.
const PRIVATE_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".in-addr.arpa",
  ".ip6.arpa",
];

function isIpLiteral(hostname: string): boolean {
  // URL.hostname renders IPv6 literals bracketed ("[::1]"); a colon can only
  // appear in an IPv6 literal.
  if (hostname.startsWith("[") || hostname.includes(":")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Validate that a URL is a safe outbound-fetch target: https, no embedded
 * credentials, and a public multi-label hostname (no IP literals, localhost,
 * or private/reserved suffixes — single-label names catch bare internal
 * hostnames like `metadata`).
 */
export function validateOidcUrl(rawUrl: string, field: string): ValidationError | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return new ValidationError(`${field} must be a valid URL`, { field });
  }
  if (url.protocol !== "https:") {
    return new ValidationError(`${field} must use https`, { field });
  }
  if (url.username !== "" || url.password !== "") {
    return new ValidationError(`${field} must not embed credentials`, { field });
  }
  // WHATWG URL preserves a trailing dot on named hosts ("localhost." !==
  // "localhost"), which would dodge every check below — strip it once here so
  // the whole function sees the canonical name.
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || isIpLiteral(hostname)) {
    return new ValidationError(`${field} must not target a local or IP-literal host`, { field });
  }
  if (PRIVATE_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return new ValidationError(`${field} must not target a private/reserved hostname`, { field });
  }
  if (!hostname.includes(".")) {
    return new ValidationError(`${field} hostname must be a public multi-label name`, { field });
  }
  return null;
}

/** Validate an issuer for connection creation (host rules + reserved-issuer check). */
export function validateIssuer(issuer: string): ValidationError | null {
  const urlError = validateOidcUrl(issuer, "issuer");
  if (urlError) return urlError;

  const url = new URL(issuer);
  if (url.search !== "" || url.hash !== "") {
    return new ValidationError("issuer must not contain a query or fragment", { field: "issuer" });
  }

  const normalized = issuer.replace(/\/+$/, "").toLowerCase();
  if ((RESERVED_ISSUERS as readonly string[]).includes(normalized)) {
    return new ValidationError("issuer is reserved for built-in OAuth providers", {
      field: "issuer",
    });
  }
  return null;
}

/**
 * Read a response body up to `maxBytes`; null when the cap is exceeded. Shared
 * by discovery and the OIDC login token exchange — both fetch org-admin-
 * supplied endpoints, so an unbounded body must never be buffered.
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return new TextEncoder().encode(text).byteLength > maxBytes ? null : text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/**
 * Fetch and validate `<issuer>/.well-known/openid-configuration`.
 *
 * The document's `issuer` must exactly equal the supplied issuer (RFC 8414
 * §3.3 — a mismatch means a confused-deputy or hosting-provider takeover),
 * and all three endpoints must pass the same host validation as the issuer.
 */
export async function discoverOidcConfiguration(
  issuer: string,
  logger: Logger,
): Promise<Result<OidcEndpoints, AppError>> {
  const issuerError = validateIssuer(issuer);
  if (issuerError) return err(issuerError);

  // Normalize once and use the normalized form everywhere — the discovery URL,
  // the RFC 8414 issuer equality check, and the returned (stored) issuer — so
  // a trailing-slash input cannot desync any of the three.
  const normalizedIssuer = issuer.replace(/\/+$/, "");
  const discoveryUrl = `${normalizedIssuer}/.well-known/openid-configuration`;
  logger.info("Fetching OIDC discovery document", { issuer: normalizedIssuer });

  let res: Response;
  try {
    res = await fetch(discoveryUrl, {
      headers: { Accept: "application/json" },
      // A redirect could re-point the fetch at a host that never passed
      // validation; discovery documents live at their canonical URL.
      redirect: "error",
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn("OIDC discovery fetch failed", { issuer });
    return err(
      new ExternalServiceError(
        "oidc-discovery",
        "discovery request failed",
        error instanceof Error ? error : undefined,
      ),
    );
  }

  if (!res.ok) {
    logger.warn("OIDC discovery returned non-OK status", { issuer, status: res.status });
    return err(new ExternalServiceError("oidc-discovery", `discovery returned ${res.status}`));
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return err(new ValidationError("discovery document is not application/json"));
  }

  const body = await readBodyCapped(res, MAX_DISCOVERY_BYTES);
  if (body === null) {
    return err(new ValidationError("discovery document exceeds size limit"));
  }

  let doc: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return err(new ValidationError("discovery document is not a JSON object"));
    }
    doc = parsed as Record<string, unknown>;
  } catch {
    return err(new ValidationError("discovery document is not valid JSON"));
  }

  if (doc.issuer !== normalizedIssuer) {
    logger.warn("OIDC discovery issuer mismatch", { issuer: normalizedIssuer });
    return err(new ValidationError("discovery document issuer does not match the supplied issuer"));
  }

  const endpoints: OidcEndpoints = {
    issuer: normalizedIssuer,
    authorizationEndpoint: "",
    tokenEndpoint: "",
    jwksUri: "",
  };
  const fields: Array<[keyof OidcEndpoints, string]> = [
    ["authorizationEndpoint", "authorization_endpoint"],
    ["tokenEndpoint", "token_endpoint"],
    ["jwksUri", "jwks_uri"],
  ];
  for (const [key, docField] of fields) {
    const value = doc[docField];
    if (typeof value !== "string" || value.length === 0) {
      return err(new ValidationError(`discovery document is missing ${docField}`));
    }
    const endpointError = validateOidcUrl(value, docField);
    if (endpointError) return err(endpointError);
    endpoints[key] = value;
  }

  logger.info("OIDC discovery succeeded", { issuer });
  return ok(endpoints);
}
