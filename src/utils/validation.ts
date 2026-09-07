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

// Project ids are crypto.randomUUID() values; anything else in a projectId
// field is at best a typo and at worst a KV key-injection probe (the id is
// interpolated into `workspace:<projectId>:<name>` keys).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a repo-relative path would escape its root once joined onto a
 * directory.
 *
 * Segment-based on purpose. A substring test like `path.includes("../")`
 * matches only a `..` followed by a separator, so it lets through every
 * traversal whose `..` lands last — a bare `..`, `./..`, or `dir/..` — each of
 * which still resolves above the clone directory.
 */
export function isTraversalPath(value: string): boolean {
  return value.startsWith("/") || value.split("/").includes("..");
}

/** Whether a value is a canonical UUID string (the shape of project ids). */
export function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
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
 * Why this hostname must not be fetched from the Worker, or null when it is fine.
 *
 * **The one host filter in this codebase.** `validateWebhookUrl` below and the
 * LLM provider allowlist (`blockedHostReason` in `evaluation/llm-providers.ts`)
 * both go through here, because two filters that must agree eventually do not:
 * the provider copy missed CGNAT, `.internal` (GCP's metadata endpoint is
 * `metadata.google.internal`) and everything in `fe80::/10` that is not spelled
 * `fe80`.
 *
 * It handles the obfuscated encodings a naive string blocklist misses: integer
 * (2130706433), hex (0x7f000001, 0x7f.0.0.1), octal (0177.0.0.1), and every
 * IPv6 spelling of the same address — `[::]`, `[0:0:0:0:0:0:0:1]`,
 * `[::ffff:127.0.0.1]` and `[::127.0.0.1]`, which the URL parser rewrites to
 * `[::7f00:1]` before anything here sees it. The rule is allowlist-shaped: an
 * IP-ish host must be a canonical public dotted-decimal IPv4 (or a public
 * IPv6) — any non-canonical numeric form fails closed.
 *
 * **Known limit:** this is an address check, not a resolution check. A public
 * DNS name that resolves to 127.0.0.1 defeats it, and nothing before the fetch
 * can see that.
 */
export function privateHostReason(hostname: string): string | null {
  // A trailing dot is the same name to a resolver; lowercase for the literals.
  const host = hostname.toLowerCase().replace(/\.$/, "");

  if (host === "localhost" || host.endsWith(".localhost")) {
    return "'localhost' names the loopback interface";
  }
  if (host.startsWith("[")) return privateIpv6Reason(host);
  // A bare single label is either an intranet name — `metadata`, the AWS/GCP
  // metadata endpoint's short name, resolves to 169.254.169.254 on an instance
  // — or an obfuscated integer/hex IP. Neither is a public host, and DNS is
  // what makes it one, which is exactly what this check cannot see. Rejected
  // here rather than at one call site, because the caller that had this rule
  // and the caller that did not is how the two filters drifted apart before.
  if (!host.includes(".")) return `${host} is a single-label host, not a public name`;
  if (host.endsWith(".internal")) {
    // metadata.google.internal is the cloud metadata endpoint — the single most
    // valuable SSRF target there is, and it is a DNS name, not an address.
    return `${host} is an internal-only name (.internal)`;
  }
  if (host.endsWith(".local")) return `${host} is a link-local mDNS name (.local)`;
  return privateIpv4Reason(host);
}

/** @see privateHostReason — kept as a boolean for the call sites that only branch. */
function isPrivateIpLiteral(hostname: string): boolean {
  return privateHostReason(hostname) !== null;
}

function privateIpv4Reason(host: string): string | null {
  // Only inspect hosts that look like a numeric IP literal (all digits/dots, or
  // containing a hex "0x"). A real DNS name — even a hex-word one like
  // "beef.cafe" — has other letters and is left to the DNS-name checks.
  const looksNumeric = /^[0-9.]+$/.test(host) || /0x/i.test(host);
  if (!looksNumeric) return null;

  // Accept ONLY canonical dotted-decimal IPv4; integer/hex/octal/short forms are
  // obfuscated addresses → reject.
  const notCanonical = `${host} is not a canonical dotted-quad IPv4 address`;
  const parts = host.split(".");
  if (parts.length !== 4) return notCanonical;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return notCanonical; // hex/non-decimal octet
    if (part.length > 1 && part[0] === "0") return notCanonical; // octal ambiguity
    const n = Number(part);
    if (n > 255) return notCanonical;
    octets.push(n);
  }
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 127) return `${host} is in the loopback range 127.0.0.0/8`;
  if (a === 0) return `${host} is in the unspecified range 0.0.0.0/8`;
  if (a === 169 && b === 254) return `${host} is in the link-local range 169.254.0.0/16`;
  if (a === 10) return `${host} is in the private range 10.0.0.0/8`;
  if (a === 172 && b >= 16 && b <= 31) return `${host} is in the private range 172.16.0.0/12`;
  if (a === 192 && b === 168) return `${host} is in the private range 192.168.0.0/16`;
  if (a === 100 && b >= 64 && b <= 127) return `${host} is in the shared range 100.64.0.0/10`;
  // Everything below is non-global: not "private" in the RFC 1918 sense, but
  // not a public destination either, and each has been someone's internal
  // network. 240/4 is the sharpest — nominally reserved, and used for real
  // internal addressing inside more than one cloud provider — so a Worker that
  // will fetch it is a Worker that can be pointed at that infrastructure.
  if (a >= 224 && a <= 239) return `${host} is in the multicast range 224.0.0.0/4`;
  if (a >= 240) return `${host} is in the reserved range 240.0.0.0/4`;
  if (a === 198 && (b === 18 || b === 19)) {
    return `${host} is in the benchmark range 198.18.0.0/15`;
  }
  if (a === 192 && b === 0 && c === 0) {
    return `${host} is in the IETF protocol-assignments range 192.0.0.0/24`;
  }
  if (
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  ) {
    return `${host} is in a documentation range (TEST-NET-1/2/3)`;
  }
  return null;
}

/**
 * The eight 16-bit groups of a bracketed IPv6 literal, or null when the text is
 * not one this parser recognises.
 *
 * Expanded rather than string-matched because every interesting IPv6 range has
 * more than one spelling: `fe80::/10` is not only the literal prefix "fe80",
 * and `::127.0.0.1` reaches the loopback through a dotted tail the URL parser
 * has already rewritten to hex.
 */
function expandIpv6(inner: string): number[] | null {
  if (!/^[0-9a-f:.]+$/.test(inner)) return null;

  let text = inner;
  // A trailing dotted quad (::ffff:127.0.0.1) is two hextets written in decimal.
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const octets = dotted.slice(1, 5).map(Number);
    if (octets.some((n) => n > 255)) return null;
    const high = ((octets[0] as number) << 8) | (octets[1] as number);
    const low = ((octets[2] as number) << 8) | (octets[3] as number);
    text = `${text.slice(0, dotted.index)}${high.toString(16)}:${low.toString(16)}`;
  }
  if (text.includes(".")) return null;

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : (halves[0] as string).split(":");
  const tail = halves.length === 2 && halves[1] !== "" ? (halves[1] as string).split(":") : [];
  const groups = [...head, ...tail];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  if (halves.length === 1 ? groups.length !== 8 : groups.length > 7) return null;

  const zeros = new Array(8 - groups.length).fill(0) as number[];
  return [
    ...head.map((group) => Number.parseInt(group, 16)),
    ...zeros,
    ...tail.map((group) => Number.parseInt(group, 16)),
  ];
}

function privateIpv6Reason(host: string): string | null {
  const hextets = expandIpv6(host.slice(1, -1));
  // Fail closed: a bracketed literal this parser cannot read is not one anybody
  // should be pointing a Worker at.
  if (hextets === null) return `${host} is not a recognizable IPv6 address`;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0) {
    if (h4 === 0 && h5 === 0 && h6 === 0 && h7 === 0) {
      return `${host} is the IPv6 unspecified address`;
    }
    if (h4 === 0 && h5 === 0 && h6 === 0 && h7 === 1) {
      return `${host} is the IPv6 loopback address`;
    }
    if (h4 === 0 && h5 === 0xffff) return `${host} is an IPv4-mapped IPv6 address`;
    // ::/64 holds nothing routable, and it is where an IPv4-compatible address
    // (`::127.0.0.1`, which normalizes to `::7f00:1`) lands.
    return `${host} is in the reserved ::/64 range, which includes IPv4-compatible addresses`;
  }
  if ((h0 & 0xfe00) === 0xfc00) return `${host} is an IPv6 unique-local address`;
  if ((h0 & 0xffc0) === 0xfe80) return `${host} is an IPv6 link-local address`;
  // `ff02::1` is all-nodes on the local link, which is a local-segment reach
  // rather than a public fetch; site-local is deprecated but still carried on
  // networks that adopted it before it was.
  if ((h0 & 0xff00) === 0xff00) return `${host} is an IPv6 multicast address`;
  if ((h0 & 0xffc0) === 0xfec0) return `${host} is an IPv6 site-local address`;
  if (h0 === 0x2001 && h1 === 0x0db8) {
    return `${host} is in the IPv6 documentation range 2001:db8::/32`;
  }
  return null;
}

/**
 * Validates an outbound webhook URL. Requires http(s) and rejects hostnames
 * that resolve to private space (loopback, RFC 1918, link-local, ULA, CGNAT,
 * `.internal`/`.local`, bare single labels), including obfuscated IP
 * encodings — see
 * {@link privateHostReason}, which is the shared filter. DNS-level rebinding is
 * out of scope here; Workers egress is not a guaranteed second layer, so keep
 * this the primary gate.
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
  if (isPrivateIpLiteral(hostname)) {
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

// ---------------------------------------------------------------------------
// Clone depth (GitHub/GitLab/Bitbucket import)
// ---------------------------------------------------------------------------

/** Default shallow clone depth used when an import does not specify one. */
export const DEFAULT_CLONE_DEPTH = 10;

/** Upper bound for a caller-specified shallow clone depth. */
export const MAX_CLONE_DEPTH = 1000;

/**
 * Sentinel meaning "full history": the depth field is omitted from the
 * underlying Artifacts import call (its `depth` parameter is optional).
 */
export const FULL_HISTORY_DEPTH = 0;

const CLONE_DEPTH_ERROR = `depth must be an integer between 1 and ${MAX_CLONE_DEPTH}, or 0 / "full" for full history`;

/**
 * Validate a caller-supplied clone depth (JSON number, form string, or absent).
 *
 * Accepted values:
 * - undefined / null / "" -> DEFAULT_CLONE_DEPTH
 * - 0, "0", or "full" (case-insensitive) -> FULL_HISTORY_DEPTH (full history)
 * - integer 1..MAX_CLONE_DEPTH (number or numeric string) -> that depth
 * Everything else is rejected.
 */
export function validateCloneDepth(
  value: unknown,
): { valid: true; depth: number } | { valid: false; error: string } {
  if (value === undefined || value === null || value === "") {
    return { valid: true, depth: DEFAULT_CLONE_DEPTH };
  }

  let num: number;
  if (typeof value === "number") {
    num = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "full") {
      return { valid: true, depth: FULL_HISTORY_DEPTH };
    }
    if (!/^\d+$/.test(trimmed)) {
      return { valid: false, error: CLONE_DEPTH_ERROR };
    }
    num = Number(trimmed);
  } else {
    return { valid: false, error: CLONE_DEPTH_ERROR };
  }

  if (!Number.isInteger(num) || num < 0 || num > MAX_CLONE_DEPTH) {
    return { valid: false, error: CLONE_DEPTH_ERROR };
  }

  return { valid: true, depth: num };
}

/** Longest ref name a manifest or request may ask to write. */
const MAX_REF_NAME_LENGTH = 255;

/**
 * Whether `name` is safe to write as the trailing component of a git ref —
 * `refs/tags/<name>` or `refs/heads/<name>`.
 *
 * Both callers consume input they did not produce: restore reads names back
 * out of a stored manifest, and the branch API takes them from a request. The
 * ref path is therefore validated here rather than trusted: an unchecked `../`
 * escapes its namespace and, with `force: true`, can overwrite the default
 * branch's ref.
 *
 * These are git's own `check-ref-format` rules, expressed as a denylist. An
 * allowlist was tried first and was wrong in a way that matters for a restore
 * path: it rejected `release@prod`, every non-ASCII name, and `%`, `,`, `!`,
 * `(`, `'`, `=`, `&`, `;`, `{` — all of which git accepts. A backup holding
 * such a tag could be written but never restored, which is worse than the
 * traversal the allowlist was defending against.
 *
 * The oracle here is isomorphic-git's `writeRef`, not the `git` CLI, because
 * that is what performs the write. It is the stricter of the two: it treats a
 * ref as valid only if `clean-git-ref` leaves it unchanged, so it refuses
 * `v1./next` (`./` collapses to `/`) even though `git check-ref-format`
 * accepts it. Validating against the CLI's looser rules would let such a name
 * past this guard and throw from `writeRef` half-way through the tag loop,
 * leaving a partially restored repository — so `./` is rejected here.
 *
 * Differentially fuzzed against `writeRef` over ~1300 generated names with a
 * fresh MemoryFS per name: no name is accepted here that `writeRef` refuses.
 *
 * Deliberately NOT rejected here: `HEAD`. It is a ref name git accepts, and a
 * backup holding a tag called `HEAD` must stay restorable — this guard's whole
 * point is that it never refuses a name the ref store would have taken.
 * Callers that additionally cannot accept it (branch creation) say so
 * themselves; see `isValidBranchName` in `../storage/git-ops`.
 *
 * @param name - The candidate ref name, straight from a manifest or a request.
 * @returns `true` if `refs/<namespace>/<name>` is a ref name git would accept.
 */
export function isValidRefName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0) return false;
  // Not a git rule: a Stratum bound so a hostile manifest or request can't
  // push an arbitrarily long path at the ref store.
  if (name.length > MAX_REF_NAME_LENGTH) return false;

  // Control characters (including DEL) and space, compared by code point. A
  // regex range spanning them is what lint rules about control characters in
  // patterns object to, and the comparison states the bound outright.
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  // The characters git reserves for its revision syntax.
  if (/[~^:?*[\\]/.test(name)) return false;

  if (name.includes("..") || name.includes("@{")) return false;
  if (name.startsWith("/") || name.endsWith("/")) return false;
  // `./` and a trailing `.` are both rewritten by clean-git-ref, so writeRef
  // rejects them.
  if (name.includes("./") || name.endsWith(".")) return false;

  return name.split("/").every((c) => c.length > 0 && !c.startsWith(".") && !c.endsWith(".lock"));
}
