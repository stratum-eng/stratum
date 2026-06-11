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
const GITHUB_REPO_RE = /^https?:\/\/github\.com\/[^/]+\/[^/\s]+/i;
const GITLAB_REPO_RE = /^https?:\/\/gitlab\.com\/.+\/[^/\s]+/i;
const BITBUCKET_REPO_RE = /^https?:\/\/bitbucket\.org\/[^/]+\/[^/\s]+/i;

/**
 * Validates a repository URL from any supported provider (GitHub, GitLab, Bitbucket).
 * @param value - URL to validate
 * @returns Whether the URL is valid for any supported provider
 */
export function isValidRepoUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return GITHUB_REPO_RE.test(value) || GITLAB_REPO_RE.test(value) || BITBUCKET_REPO_RE.test(value);
}

const PRIVATE_HOSTNAME_RE = /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|0\.)/i;
const PRIVATE_172_RE = /^172\.(1[6-9]|2\d|3[01])\./;
// URL.hostname keeps brackets for IPv6 literals, e.g. "[::1]".
const PRIVATE_IPV6_RE = /^\[(::1\]$|f[cd]|fe80|::ffff:)/i;

/**
 * Validates an outbound webhook URL. Requires http(s) and rejects hostnames
 * that are obviously private (loopback, RFC 1918, link-local, ULA) to limit
 * SSRF from user-supplied webhook targets. DNS-level rebinding is out of
 * scope here; Workers egress provides the second layer.
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

  const hostname = parsed.hostname;
  if (
    PRIVATE_HOSTNAME_RE.test(hostname) ||
    PRIVATE_172_RE.test(hostname) ||
    PRIVATE_IPV6_RE.test(hostname) ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".local") ||
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
