import type { Result } from "../../utils/result";
import { err, ok } from "../../utils/result";
import { MAX_FILES, MAX_FILE_BYTES, MAX_SUBREQUESTS, MAX_TOTAL_BYTES } from "../limits";
import { redactAndTruncate } from "../redact";
import type { DeployFailure } from "./index";

/**
 * Machinery every provider target needs, kept out of `./index.ts` so the
 * targets can import it without forming a module cycle with the registry that
 * imports them.
 */

/**
 * Longest provider-supplied detail spliced into a `reason`.
 *
 * The reason is rendered in a list view; a provider that returns a wall of
 * text must not be able to decide how tall that row is. The full payload is
 * still available on the deployment's `log_tail`.
 */
const MAX_REASON_DETAIL = 200;

/** Chunk size for base64 encoding. Bounded so `String.fromCharCode` cannot overflow the arg stack. */
const BASE64_CHUNK_BYTES = 8_192;

/** HTTP status meaning "slow down", which a later attempt can clear. */
const STATUS_TOO_MANY_REQUESTS = 429;

/** First 5xx status. At or above it the provider, not the request, is at fault. */
const STATUS_SERVER_ERROR = 500;

/** The values that must never appear in a reason, a log tail, or a log line. */
export function secretValuesOf(secrets: Readonly<Record<string, string>>): string[] {
  return Object.values(secrets);
}

/**
 * Narrow a repo tree to the deploy's `dir`, stripping the prefix so the
 * provider sees `index.html` rather than `dist/index.html`.
 *
 * `sanitizeDeploys` has already rejected absolute paths and `..` segments, so
 * this only has to handle the shape, not the traversal.
 */
export function selectFiles(
  files: ReadonlyMap<string, Uint8Array>,
  dir: string | undefined,
): Result<Map<string, Uint8Array>, DeployFailure> {
  if (dir === undefined || dir === "") return ok(new Map(files));

  const prefix = `${dir.replace(/\/+$/, "")}/`;
  const selected = new Map<string, Uint8Array>();
  for (const [path, bytes] of files) {
    if (path.startsWith(prefix)) selected.set(path.slice(prefix.length), bytes);
  }

  if (selected.size === 0) {
    return err({
      reason: `no files found under "${dir}" at this commit — check the deploy's "dir"`,
      retryable: false,
    });
  }
  return ok(selected);
}

/**
 * Reject anything over the `src/deploy/limits.ts` bounds **before the first
 * request goes out**.
 *
 * `estimateSubrequests` is the target's own worst case for the file count, not
 * its typical case: a multi-phase upload that discovers it is out of budget
 * halfway through has already published a partial tree, which is strictly
 * worse than never having started.
 */
export function enforceLimits(
  files: ReadonlyMap<string, Uint8Array>,
  estimateSubrequests: (fileCount: number) => number,
): Result<void, DeployFailure> {
  if (files.size === 0) {
    return err({ reason: "nothing to deploy: the selected tree is empty", retryable: false });
  }

  if (files.size > MAX_FILES) {
    return err({
      reason: `too many files: ${files.size} exceeds the ${MAX_FILES}-file deploy limit`,
      retryable: false,
    });
  }

  let totalBytes = 0;
  for (const [path, bytes] of files) {
    if (bytes.byteLength > MAX_FILE_BYTES) {
      return err({
        reason: `"${path}" is ${bytes.byteLength} bytes, over the ${MAX_FILE_BYTES}-byte per-file deploy limit`,
        retryable: false,
      });
    }
    totalBytes += bytes.byteLength;
  }

  if (totalBytes > MAX_TOTAL_BYTES) {
    return err({
      reason: `deploy is ${totalBytes} bytes, over the ${MAX_TOTAL_BYTES}-byte total limit`,
      retryable: false,
    });
  }

  const subrequests = estimateSubrequests(files.size);
  if (subrequests > MAX_SUBREQUESTS) {
    return err({
      reason: `publishing ${files.size} files needs up to ${subrequests} provider requests, over the ${MAX_SUBREQUESTS}-request budget`,
      retryable: false,
    });
  }

  return ok(undefined);
}

/**
 * Check that every required secret is present and non-empty.
 *
 * Names are safe to put in the reason — they come from the policy file, which
 * is public to anyone who can read the repo. Values never are.
 */
export function requireSecrets<Names extends readonly string[]>(
  secrets: Readonly<Record<string, string>>,
  names: Names,
): Result<Record<Names[number], string>, DeployFailure> {
  const missing = names.filter((name) => {
    const value = secrets[name];
    return typeof value !== "string" || value.length === 0;
  });

  if (missing.length > 0) {
    return err({
      reason: `missing project secret${missing.length === 1 ? "" : "s"}: ${missing.join(", ")} — add ${missing.length === 1 ? "it" : "them"} in project settings`,
      retryable: false,
    });
  }

  // Keyed by the literal names the caller asked for, so a target reads
  // `resolved.CLOUDFLARE_API_TOKEN` as a `string` rather than re-checking for
  // undefined that the loop above has already ruled out.
  const resolved = {} as Record<Names[number], string>;
  for (const name of names) {
    resolved[name as Names[number]] = secrets[name] as string;
  }
  return ok(resolved);
}

/** A provider status that a later attempt could plausibly clear. */
export function isRetryableStatus(status: number): boolean {
  return status >= STATUS_SERVER_ERROR || status === STATUS_TOO_MANY_REQUESTS;
}

/**
 * Turn a non-OK provider response into a persistable failure.
 *
 * The body is read in full and redacted *before* it is truncated, so no secret
 * can survive in either the reason or the log tail. The response itself is
 * never logged: it was produced by a request carrying an `Authorization`
 * header, and providers do echo request context back.
 */
export async function providerFailure(
  service: string,
  response: Response,
  secretValues: readonly string[],
): Promise<DeployFailure> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    // A body that cannot be read is not worth failing differently over — the
    // status alone is already an actionable reason. Swallowing is safe here
    // precisely because the status is preserved below.
    body = "";
  }

  const detail = providerMessage(body);
  const safeDetail = detail
    ? redactAndTruncate(detail, secretValues, MAX_REASON_DETAIL)
    : undefined;

  return {
    reason: `${service} returned HTTP ${response.status}${safeDetail ? `: ${safeDetail}` : ""}`,
    logTail: body.length > 0 ? redactAndTruncate(body, secretValues) : undefined,
    retryable: isRetryableStatus(response.status),
  };
}

/**
 * Pull the human-readable message out of a provider error body.
 *
 * Handles both shapes this feature talks to: Cloudflare's
 * `{"success":false,"errors":[{"code":…,"message":…}]}` and Vercel's
 * `{"error":{"code":…,"message":…}}`. Anything else falls back to `undefined`
 * and the caller reports the status alone rather than pasting an unparsed
 * document into a list row.
 */
export function providerMessage(body: string): string | undefined {
  if (body.trim() === "") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) return undefined;
  const document = parsed as Record<string, unknown>;

  const cloudflareErrors = document.errors;
  if (Array.isArray(cloudflareErrors)) {
    const messages = cloudflareErrors
      .map((entry) =>
        typeof entry === "object" && entry !== null
          ? (entry as Record<string, unknown>).message
          : undefined,
      )
      .filter((message): message is string => typeof message === "string");
    if (messages.length > 0) return messages.join("; ");
  }

  const vercelError = document.error;
  if (typeof vercelError === "object" && vercelError !== null) {
    const message = (vercelError as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }

  if (typeof document.message === "string") return document.message;

  return undefined;
}

/** Failure for a `fetch` that never produced a response (DNS, TLS, connection reset). */
export function transportFailure(service: string, error: unknown): DeployFailure {
  // The message is ours, not the provider's: a thrown fetch error can carry a
  // rendered request, and a rendered request carries the Authorization header.
  return {
    reason: `${service} could not be reached: ${error instanceof Error ? error.name : "network error"}`,
    retryable: true,
  };
}

/** Parse a JSON response body, as a value: a provider that returns HTML on success is a failure, not a throw. */
export async function readJson(
  service: string,
  response: Response,
  secretValues: readonly string[],
): Promise<Result<Record<string, unknown>, DeployFailure>> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    return err({ reason: `${service} returned an unreadable response body`, retryable: true });
  }

  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return err({
        reason: `${service} returned an unexpected response shape`,
        logTail: redactAndTruncate(body, secretValues),
        retryable: false,
      });
    }
    return ok(parsed as Record<string, unknown>);
  } catch {
    return err({
      reason: `${service} returned a response that is not JSON`,
      logTail: redactAndTruncate(body, secretValues),
      retryable: false,
    });
  }
}

/** Base64-encode raw bytes without Node's `Buffer`, which the Workers runtime does not provide. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_BYTES);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/** Lowercase hex of a `crypto.subtle.digest` result. */
export function toHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
