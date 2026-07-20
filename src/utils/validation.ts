import { MAX_NAMESPACE_LENGTH, MAX_SLUG_LENGTH } from "../types";
import { type Logger, createLogger } from "./logger";
import { type Result, err, ok } from "./result";

const SLUG_RE = /^[\w-]{1,64}$/;
const NAMESPACE_RE = /^@[a-z0-9][-a-z0-9]*[a-z0-9]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/;

const defaultLogger = createLogger({ component: "Validation" });

export interface ValidationFailure {
  field: string;
  message: string;
}

export type ValidationResult<T> = Result<T, ValidationFailure[]>;

/**
 * Validates a slug and returns a Result.
 */
export function validateSlug(value: unknown, logger?: Logger): ValidationResult<string> {
  const log = logger ?? defaultLogger;

  if (typeof value !== "string") {
    log.debug("Validation failed - slug is not a string", { value });
    return err([{ field: "slug", message: "Must be a string" }]);
  }

  if (value.length > MAX_SLUG_LENGTH) {
    log.debug("Validation failed - slug too long", { value, length: value.length });
    return err([{ field: "slug", message: `Slug too long (max ${MAX_SLUG_LENGTH} characters)` }]);
  }

  if (!SLUG_RE.test(value)) {
    log.debug("Validation failed - invalid slug format", { value });
    return err([
      { field: "slug", message: "Must be 1-64 characters, alphanumeric, hyphens, or underscores" },
    ]);
  }

  log.debug("Validation passed - slug", { value });
  return ok(value);
}

/**
 * Validates a namespace and returns a Result.
 * Namespaces must start with @, contain only lowercase alphanumeric and hyphens,
 * start/end with alphanumeric, and be within length limits.
 */
export function validateNamespace(value: unknown, logger?: Logger): ValidationResult<string> {
  const log = logger ?? defaultLogger;

  if (typeof value !== "string") {
    log.debug("Validation failed - namespace is not a string", { value });
    return err([{ field: "namespace", message: "Must be a string" }]);
  }

  if (value.length > MAX_NAMESPACE_LENGTH) {
    log.debug("Validation failed - namespace too long", { value, length: value.length });
    return err([
      {
        field: "namespace",
        message: `Namespace too long (max ${MAX_NAMESPACE_LENGTH} characters)`,
      },
    ]);
  }

  if (!NAMESPACE_RE.test(value)) {
    log.debug("Validation failed - invalid namespace format", { value });
    return err([{ field: "namespace", message: "Invalid namespace format" }]);
  }

  log.debug("Validation passed - namespace", { value });
  return ok(value);
}

/**
 * Validates an email address and returns a Result.
 */
export function validateEmail(value: unknown, logger?: Logger): ValidationResult<string> {
  const log = logger ?? defaultLogger;

  if (typeof value !== "string") {
    log.debug("Validation failed - email is not a string", { value });
    return err([{ field: "email", message: "Must be a string" }]);
  }

  if (!EMAIL_RE.test(value)) {
    log.debug("Validation failed - invalid email format", { value });
    return err([{ field: "email", message: "Invalid email format" }]);
  }

  log.debug("Validation passed - email");
  return ok(value);
}

/**
 * Validates a GitHub URL and returns a Result.
 */
export function validateGitHubUrl(value: unknown, logger?: Logger): ValidationResult<string> {
  const log = logger ?? defaultLogger;

  if (typeof value !== "string") {
    log.debug("Validation failed - GitHub URL is not a string", { value });
    return err([{ field: "githubUrl", message: "Must be a string" }]);
  }

  if (!GITHUB_URL_RE.test(value)) {
    log.debug("Validation failed - invalid GitHub URL format", { value });
    return err([
      {
        field: "githubUrl",
        message: "Must be a valid GitHub repository URL (https://github.com/owner/repo)",
      },
    ]);
  }

  log.debug("Validation passed - GitHub URL", { value });
  return ok(value);
}

/**
 * Validates that a value is a string record and returns a Result.
 */
export function validateStringRecord(
  value: unknown,
  logger?: Logger,
): ValidationResult<Record<string, string>> {
  const log = logger ?? defaultLogger;

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    log.debug("Validation failed - not an object", { value });
    return err([{ field: "record", message: "Must be an object" }]);
  }

  const entries = Object.entries(value);
  const nonStringValues = entries.filter(([, v]) => typeof v !== "string");

  if (nonStringValues.length > 0) {
    log.debug("Validation failed - object contains non-string values", {
      keys: nonStringValues.map(([k]) => k),
    });
    return err([{ field: "record", message: "All values must be strings" }]);
  }

  log.debug("Validation passed - string record", { keyCount: entries.length });
  return ok(value as Record<string, string>);
}

/**
 * Legacy boolean-returning validators for backward compatibility.
 * @deprecated Use validate* functions that return Result instead.
 */
export function isValidSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_SLUG_LENGTH && SLUG_RE.test(value);
}

/**
 * Validates namespace format (starts with @, lowercase alphanumeric and hyphens only).
 * @deprecated Use validateNamespace instead.
 */
export function isValidNamespace(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= MAX_NAMESPACE_LENGTH && NAMESPACE_RE.test(value)
  );
}

/** @deprecated Use validateEmail instead. */
export function isValidEmail(value: unknown): value is string {
  return typeof value === "string" && EMAIL_RE.test(value);
}

/** @deprecated Use validateGitHubUrl instead. */
export function isValidGitHubUrl(value: unknown): value is string {
  return typeof value === "string" && GITHUB_URL_RE.test(value);
}

/** @deprecated Use validateStringRecord instead. */
export function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

// Multi-provider URL patterns
// https only: an http:// clone exposes the fetch to MITM (the host is still
// pinned to the three providers below, so this is downgrade protection).
const GITHUB_REPO_RE = /^https:\/\/github\.com\/[^/]+\/[^/\s]+/i;
const GITLAB_REPO_RE = /^https:\/\/gitlab\.com\/.+\/[^/\s]+/i;
const BITBUCKET_REPO_RE = /^https:\/\/bitbucket\.org\/[^/]+\/[^/\s]+/i;

/**
 * Validates a repository URL from any supported provider (GitHub, GitLab, Bitbucket).
 * @param value - URL to validate
 * @returns Whether the URL is valid for any supported provider
 */
export function isValidRepoUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return GITHUB_REPO_RE.test(value) || GITLAB_REPO_RE.test(value) || BITBUCKET_REPO_RE.test(value);
}

/**
 * Whether a hostname is a private/disallowed IP literal. Handles the obfuscated
 * encodings a naive string blocklist misses: integer (2130706433), hex
 * (0x7f000001, 0x7f.0.0.1), octal (0177.0.0.1), and IPv6 unspecified/expanded
 * loopback ([::], [0:0:0:0:0:0:0:1]). The rule is allowlist-shaped: an IP-ish
 * host must be a canonical public dotted-decimal IPv4 (or a public IPv6) — any
 * non-canonical numeric form fails closed. Returns false for DNS names, which
 * the caller filters separately.
 */
function isPrivateIpLiteral(hostname: string): boolean {
  // Bracketed IPv6 literal, e.g. "[::1]".
  if (hostname.startsWith("[")) {
    const inner = hostname.slice(1, -1).toLowerCase();
    const compact = inner.replace(/[0:]/g, "");
    // "" ← "::" / "0:0:…:0" (unspecified); "1" ← "::1" / "0:0:…:1" (loopback).
    if (compact === "" || compact === "1") return true;
    if (/^f[cd]/.test(inner)) return true; // ULA fc00::/7
    if (/^fe80/.test(inner)) return true; // link-local
    if (inner.includes("::ffff:")) return true; // IPv4-mapped
    return false;
  }

  // Only inspect hosts that look like a numeric IP literal (all digits/dots, or
  // containing a hex "0x"). A real DNS name — even a hex-word one like
  // "beef.cafe" — has other letters and is left to the DNS-name checks.
  const looksNumeric = /^[0-9.]+$/.test(hostname) || /0x/i.test(hostname);
  if (!looksNumeric) return false;

  // Accept ONLY canonical dotted-decimal IPv4; integer/hex/octal/short forms are
  // obfuscated addresses → reject.
  const parts = hostname.split(".");
  if (parts.length !== 4) return true;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return true; // hex/non-decimal octet
    if (part.length > 1 && part[0] === "0") return true; // leading zero (octal ambiguity)
    const n = Number(part);
    if (n > 255) return true;
    octets.push(n);
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

/**
 * Validates an outbound webhook URL. Requires http(s) and rejects hostnames
 * that resolve to private space (loopback, RFC 1918, link-local, ULA, CGNAT),
 * including obfuscated IP encodings. DNS-level rebinding is out of scope here;
 * Workers egress is not a guaranteed second layer, so keep this the primary gate.
 */
export function validateWebhookUrl(value: unknown, logger?: Logger): ValidationResult<string> {
  const log = logger ?? defaultLogger;

  if (typeof value !== "string" || value.length > 2048) {
    return err([{ field: "url", message: "Must be a string of at most 2048 characters" }]);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return err([{ field: "url", message: "Must be a valid URL" }]);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return err([{ field: "url", message: "Must use http or https" }]);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    isPrivateIpLiteral(hostname) ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".localhost") ||
    // A bare single label (no dot) is either an intranet name or an obfuscated
    // integer/hex IP — reject. Bracketed IPv6 handled above.
    (!hostname.includes(".") && !hostname.startsWith("["))
  ) {
    log.debug("Validation failed - webhook URL targets a private host", { hostname });
    return err([{ field: "url", message: "URL must target a public host" }]);
  }

  return ok(value);
}

/**
 * Converts a string to a URL-safe slug.
 * - Lowercases the string
 * - Replaces spaces with hyphens
 * - Removes special characters
 * - Truncates to MAX_SLUG_LENGTH characters
 */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "") // Remove special characters
    .replace(/[\s]+/g, "-") // Replace spaces with hyphens
    .replace(/-+/g, "-") // Collapse multiple hyphens
    .slice(0, MAX_SLUG_LENGTH); // Limit to MAX_SLUG_LENGTH characters
}
