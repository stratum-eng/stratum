import { MAX_NAMESPACE_LENGTH } from "../types";
import { type Logger, createLogger } from "./logger";
import { type Result, err, ok } from "./result";

const defaultLogger = createLogger({ component: "UsernameValidation" });

export interface ValidationFailure {
  field: string;
  message: string;
}

export type ValidationResult<T> = Result<T, ValidationFailure[]>;

// Minimum username length
const MIN_USERNAME_LENGTH = 3;

// Reserved usernames that cannot be used
const RESERVED_USERNAMES = new Set([
  // System
  "api",
  "www",
  "admin",
  "root",
  "support",
  "help",
  "login",
  "auth",
  // Services
  "static",
  "assets",
  "docs",
  "blog",
  "shop",
  "mail",
  "email",
  "ftp",
  "ssh",
  "git",
  "cdn",
  // API versions
  "api-v1",
  "api-v2",
  "api-v3",
  "v1",
  "v2",
  "v3",
  // Common
  "test",
  "testing",
  "staging",
  "production",
  "prod",
  "dev",
  "demo",
  "sample",
  "example",
  // Short (single letters)
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
]);

/**
 * Validates a username and returns a Result with detailed errors.
 *
 * Username rules:
 * - 3-39 characters (MAX_NAMESPACE_LENGTH)
 * - Lowercase alphanumeric + hyphens only
 * - Must start with letter (a-z)
 * - Must end with letter or number (not hyphen)
 * - No consecutive hyphens
 * - Cannot be empty or just numbers
 */
export function validateUsername(username: unknown, logger?: Logger): ValidationResult<string> {
  const log = logger ?? defaultLogger;
  const failures: ValidationFailure[] = [];

  // Type check
  if (typeof username !== "string") {
    log.debug("Validation failed - username is not a string", { username });
    return err([{ field: "username", message: "Username must be a string" }]);
  }

  const normalized = username.toLowerCase().trim();

  // Empty check
  if (normalized.length === 0) {
    log.debug("Validation failed - username is empty");
    return err([{ field: "username", message: "Username cannot be empty" }]);
  }

  // Minimum length check
  if (normalized.length < MIN_USERNAME_LENGTH) {
    log.debug("Validation failed - username too short", {
      username: normalized,
      length: normalized.length,
    });
    failures.push({
      field: "username",
      message: `Username must be at least ${MIN_USERNAME_LENGTH} characters`,
    });
  }

  // Maximum length check
  if (normalized.length > MAX_NAMESPACE_LENGTH) {
    log.debug("Validation failed - username too long", {
      username: normalized,
      length: normalized.length,
    });
    failures.push({
      field: "username",
      message: `Username must be no more than ${MAX_NAMESPACE_LENGTH} characters`,
    });
  }

  // Check for valid characters (lowercase alphanumeric and hyphens only)
  if (!/^[a-z0-9-]+$/.test(normalized)) {
    log.debug("Validation failed - username contains invalid characters", {
      username: normalized,
    });
    failures.push({
      field: "username",
      message: "Username can only contain lowercase letters, numbers, and hyphens",
    });
  }

  // Must start with a letter
  if (!/^[a-z]/.test(normalized)) {
    log.debug("Validation failed - username does not start with a letter", {
      username: normalized,
    });
    failures.push({
      field: "username",
      message: "Username must start with a letter (a-z)",
    });
  }

  // Must end with letter or number (not hyphen)
  if (!/[a-z0-9]$/.test(normalized)) {
    log.debug("Validation failed - username does not end with letter or number", {
      username: normalized,
    });
    failures.push({
      field: "username",
      message: "Username must end with a letter or number",
    });
  }

  // No consecutive hyphens
  if (normalized.includes("--")) {
    log.debug("Validation failed - username contains consecutive hyphens", {
      username: normalized,
    });
    failures.push({
      field: "username",
      message: "Username cannot contain consecutive hyphens",
    });
  }

  // Cannot be just numbers
  if (/^[0-9]+$/.test(normalized)) {
    log.debug("Validation failed - username contains only numbers", {
      username: normalized,
    });
    failures.push({
      field: "username",
      message: "Username cannot be only numbers",
    });
  }

  // Check reserved usernames
  if (RESERVED_USERNAMES.has(normalized)) {
    log.debug("Validation failed - username is reserved", { username: normalized });
    failures.push({
      field: "username",
      message: "This username is reserved and cannot be used",
    });
  }

  // Return errors if any failures
  if (failures.length > 0) {
    return err(failures);
  }

  log.debug("Validation passed - username", { username: normalized });
  return ok(normalized);
}

/**
 * Checks if a username is in the reserved list.
 */
export function isReservedUsername(username: string): boolean {
  const normalized = username.toLowerCase().trim();
  return RESERVED_USERNAMES.has(normalized);
}

/**
 * Type guard for valid usernames.
 * Returns true if the value is a valid username string.
 */
export function isValidUsername(value: unknown): value is string {
  if (typeof value !== "string") return false;

  const normalized = value.toLowerCase().trim();

  // All validation rules in one check
  if (normalized.length < MIN_USERNAME_LENGTH) return false;
  if (normalized.length > MAX_NAMESPACE_LENGTH) return false;
  if (!/^[a-z0-9-]+$/.test(normalized)) return false;
  if (!/^[a-z]/.test(normalized)) return false;
  if (!/[a-z0-9]$/.test(normalized)) return false;
  if (normalized.includes("--")) return false;
  if (/^[0-9]+$/.test(normalized)) return false;
  if (RESERVED_USERNAMES.has(normalized)) return false;

  return true;
}

/**
 * Sanitizes a username input by:
 * - Converting to lowercase
 * - Trimming whitespace
 * - Removing invalid characters (keeping only lowercase alphanumeric and hyphens)
 * - Collapsing consecutive hyphens
 * - Ensuring valid start/end characters
 */
export function sanitizeUsername(input: string): string {
  let sanitized = input
    .toLowerCase()
    .trim()
    // Convert common word separators to hyphens first
    .replace(/[_\s]+/g, "-")
    // Remove all characters except lowercase alphanumeric and hyphens
    .replace(/[^a-z0-9-]/g, "")
    // Collapse consecutive hyphens
    .replace(/-+/g, "-")
    // Trim hyphens from start
    .replace(/^-+/, "")
    // Trim hyphens from end
    .replace(/-+$/, "");

  // Ensure minimum length by padding if needed (though caller should handle this)
  // Just ensure we don't exceed max length
  if (sanitized.length > MAX_NAMESPACE_LENGTH) {
    sanitized = sanitized.slice(0, MAX_NAMESPACE_LENGTH);
    // Re-trim hyphens from end after truncation
    sanitized = sanitized.replace(/-+$/, "");
  }

  return sanitized;
}

/**
 * Returns the list of reserved usernames (for documentation/testing purposes).
 */
export function getReservedUsernames(): readonly string[] {
  return Array.from(RESERVED_USERNAMES);
}
