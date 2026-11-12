/**
 * GitHub API Client
 * Handles all GitHub API interactions for the Stratum bridge
 */

import type { D1Database } from "@cloudflare/workers-types";
import { decryptToken, encryptToken } from "../utils/crypto";
import type { Logger } from "../utils/logger";

const GITHUB_API_BASE = "https://api.github.com";

// Rate limiting configuration
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 32000;

/**
 * Bound on a single GitHub subrequest so one slow response can't hold a
 * Worker invocation open until the platform's own subrequest limit kills it.
 * Callers that also retry (the private `request()` method's `maxRetries`)
 * get a FRESH timeout per attempt, not one deadline shared across the whole
 * call — the
 * worst case wall time for a retried request is therefore roughly
 * `attempts × timeoutMs` plus backoff sleeps between attempts, not
 * `timeoutMs` total. A caller that needs a hard ceiling on total latency
 * (e.g. a request lifecycle bound) should pass `maxRetries: 0` alongside the
 * timeout rather than relying on the timeout alone to cap retries.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

export interface GitHubToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  draft?: boolean;
  /** GraphQL id, which the ready-for-review mutation needs. */
  node_id?: string;
}

export interface CreatePROpts {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  /** Opens the PR as a draft. Defaults to GitHub's own default (false) when omitted. */
  draft?: boolean;
}

/** Result of {@link GitHubClient.createOrReusePR}. */
export type CreateOrReusePRResult =
  | { success: true; pr: unknown; reused: boolean; status: number }
  | {
      success: false;
      /** `true` when the request itself failed (network error/timeout) — no
       * GitHub response was received, so `status`/`githubMessage`/`errors`
       * describe nothing GitHub actually said. */
      networkError: boolean;
      status: number;
      githubMessage?: string;
      errors: GithubErrorDetail[];
    };

/** One entry of GitHub's `errors` array, as far as this client relies on it. */
export interface GithubErrorDetail {
  message?: string;
  code?: string;
  field?: string;
}

/** Narrows one element of an untrusted `errors` array before it is read. */
function isGithubErrorDetail(value: unknown): value is GithubErrorDetail {
  if (typeof value !== "object" || value === null) return false;
  const detail = value as Record<string, unknown>;
  return (["message", "code", "field"] as const).every(
    (key) => detail[key] === undefined || typeof detail[key] === "string",
  );
}

/**
 * Parses a GitHub error response body into its documented `message` +
 * `errors[]` shape, tolerating anything else GitHub might actually send.
 * GitHub is not guaranteed to send the documented shape on every failure —
 * `{"errors":{}}`, `{"errors":"invalid"}`, `{"errors":[null]}`, and a
 * non-JSON body all reach naive `.map()`/property access otherwise.
 */
function parseGithubErrorBody(text: string): { message?: string; errors: GithubErrorDetail[] } {
  try {
    const parsed: unknown = JSON.parse(text);
    const body = (typeof parsed === "object" && parsed !== null ? parsed : {}) as {
      message?: unknown;
      errors?: unknown;
    };
    return {
      message: typeof body.message === "string" ? body.message : undefined,
      errors: Array.isArray(body.errors) ? body.errors.filter(isGithubErrorDetail) : [],
    };
  } catch {
    return { errors: [] };
  }
}

export interface UpdatePROpts {
  owner: string;
  repo: string;
  pull_number: number;
  title?: string;
  body?: string;
  state?: "open" | "closed";
}

export interface PostCommentOpts {
  owner: string;
  repo: string;
  issue_number: number;
  body: string;
}

export interface SetStatusOpts {
  owner: string;
  repo: string;
  sha: string;
  state: "pending" | "success" | "failure" | "error";
  description?: string;
  context?: string;
  target_url?: string;
}

// Circuit breaker state
interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  state: "closed" | "open" | "half-open";
}

const circuitBreakers = new Map<string, CircuitBreakerState>();
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_TIMEOUT_MS = 60000;

/**
 * Test-only escape hatch: this module-level state is shared by every
 * `GitHubClient` instance (and persists for the lifetime of the module), so a
 * test file that exercises several failing calls against the same
 * owner/repo can otherwise trip the breaker and starve later, unrelated
 * assertions in the same run. Not for production use.
 */
export function resetCircuitBreakersForTests(): void {
  circuitBreakers.clear();
}

/**
 * Statuses that GitHub uses to answer a *request* rather than to report on the
 * *repository*.
 *
 * The breaker is keyed per repository, so what it measures is whether that
 * repository is reachable and usable. A `422` saying "a pull request already
 * exists for this head" is GitHub reached, GitHub answering, and the caller
 * expected to interpret the answer — it says nothing about repository health,
 * and it must not move a repository-health counter. That is not academic:
 * duplicate-head `422`s are the ordinary result of re-promoting a change, and
 * counting them let five routine re-promotions open the breaker that the
 * duplicate-head RECOVERY path then has to pass through (see
 * `createOrReusePR`), turning "PR already exists" into a failed promotion.
 *
 * Deliberately narrower than "no 4xx counts": `401`, `403`, and `404` stay
 * counted, because a repository that is gone, renamed, or beyond the token's
 * access is precisely the condition {@link isCircuitOpen} exists to stop
 * rediscovering once per endpoint.
 */
const REQUEST_SCOPED_STATUSES = new Set([400, 409, 422]);

/**
 * Whether a failed response should feed its repository's breaker.
 *
 * Transport errors and rate limiting are recorded by their own call sites and
 * never reach here; this decides only for responses carrying a status.
 */
function isCircuitFailureStatus(status: number): boolean {
  return !REQUEST_SCOPED_STATUSES.has(status);
}

/**
 * Whether calls to `endpoint`'s repository are currently being short-circuited.
 *
 * Keyed by the first three path segments (`/repos/<owner>/<repo>`), so the
 * breaker is per-repository rather than per-endpoint: a repo that is gone,
 * renamed, or whose token lost access fails every call against it, and there
 * is nothing to gain by discovering that once per endpoint. The flip side is
 * blast radius — every caller reaching that repo through this client shares
 * one breaker, so a burst of failures from one route (promotion, say) can
 * short-circuit an unrelated one (evaluation reporting) for
 * {@link CIRCUIT_BREAKER_TIMEOUT_MS}.
 *
 * The open→half-open transition happens on read rather than on a timer: there
 * is no scheduler here, and the next caller after the cooldown is the one that
 * gets to probe. It is allowed through, and {@link recordCircuitResult} decides
 * from its outcome whether the breaker closes or re-opens.
 */
function isCircuitOpen(endpoint: string): boolean {
  const key = endpoint.split("/").slice(0, 3).join("/");
  const cb = circuitBreakers.get(key);
  if (!cb) return false;
  if (cb.state === "open") {
    if (Date.now() - cb.lastFailure > CIRCUIT_BREAKER_TIMEOUT_MS) {
      cb.state = "half-open";
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Feeds one call's outcome back into its repository's breaker.
 *
 * Any success closes the breaker and zeroes the failure count, not just a
 * success while half-open: the count is meant to measure a *consecutive* run
 * of failures, so an intervening success means whatever was wrong is no longer
 * reproducing and the tally should not carry forward into an unrelated later
 * incident.
 *
 * Not every failed call gets here. A response the caller is expected to
 * interpret (see {@link isCircuitFailureStatus}) is NEITHER recorded as a
 * failure nor as a success — it is skipped entirely. Recording it as a success
 * would zero a genuine consecutive-failure run because one `422` landed in the
 * middle of it, which is the opposite of what a consecutive counter is for; and
 * while half-open, skipping correctly leaves the breaker half-open, since a
 * probe that drew a request-scoped answer learned nothing about the repository.
 */
function recordCircuitResult(endpoint: string, success: boolean): void {
  const key = endpoint.split("/").slice(0, 3).join("/");
  const cb = circuitBreakers.get(key) || { failures: 0, lastFailure: 0, state: "closed" };
  if (success) {
    // Reset on ANY success, not just when half-open
    cb.state = "closed";
    cb.failures = 0;
    cb.lastFailure = 0;
  } else {
    cb.failures++;
    cb.lastFailure = Date.now();
    if (cb.failures >= CIRCUIT_BREAKER_THRESHOLD) {
      cb.state = "open";
    }
  }
  circuitBreakers.set(key, cb);
}

/**
 * Releases a response this client is about to abandon.
 *
 * In Cloudflare Workers an unconsumed response body keeps its connection
 * resources held. The retry paths would otherwise hold theirs for the whole
 * backoff sleep — seconds, on a rate-limit wait — under exactly the two
 * conditions (rate limiting, 5xx) where connection pressure is least
 * affordable. Cancelling beats draining here: the bytes are not wanted, and
 * cancelling releases immediately instead of after a full read.
 *
 * A rejected cancel means the body was already disturbed or errored. That is
 * not a reason to fail a retry that would otherwise succeed, so it is logged
 * rather than propagated.
 */
async function discardResponseBody(
  response: Response,
  logger: Logger,
  endpoint: string,
): Promise<void> {
  try {
    await response.body?.cancel();
  } catch (error) {
    logger.debug("Could not cancel an abandoned GitHub response body", {
      endpoint,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function getBackoffDelay(retryCount: number): number {
  const exponentialDelay = Math.min(BASE_DELAY_MS * 2 ** retryCount, MAX_DELAY_MS);
  const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, exponentialDelay + jitter);
}

export async function getGitHubToken(
  db: D1Database,
  userId: string,
  encryptionSecret: string,
  logger: Logger,
): Promise<GitHubToken | null> {
  try {
    const result = await db
      .prepare(
        `SELECT github_access_token, github_refresh_token, github_token_expires_at
         FROM users WHERE id = ? AND github_access_token IS NOT NULL`,
      )
      .bind(userId)
      .first<{
        github_access_token: string;
        github_refresh_token: string | null;
        github_token_expires_at: number | null;
      }>();

    if (!result) return null;

    const decryptedToken = await decryptToken(result.github_access_token, encryptionSecret);
    if (!decryptedToken) {
      logger.error("Failed to decrypt GitHub token", undefined, { userId });
      return null;
    }

    // Decrypt refresh token if present
    let decryptedRefreshToken: string | undefined;
    if (result.github_refresh_token) {
      decryptedRefreshToken =
        (await decryptToken(result.github_refresh_token, encryptionSecret)) ?? undefined;
    }

    return {
      accessToken: decryptedToken,
      refreshToken: decryptedRefreshToken,
      expiresAt: result.github_token_expires_at ?? undefined,
    };
  } catch (error) {
    logger.error("Failed to get GitHub token", error instanceof Error ? error : undefined, {
      userId,
    });
    return null;
  }
}

export async function storeGitHubToken(
  db: D1Database,
  userId: string,
  token: GitHubToken,
  githubUserId: string,
  githubUsername: string,
  encryptionSecret: string,
  logger: Logger,
): Promise<boolean> {
  try {
    const encryptedToken = await encryptToken(token.accessToken, encryptionSecret);
    // Encrypt refresh token if present
    const encryptedRefreshToken = token.refreshToken
      ? await encryptToken(token.refreshToken, encryptionSecret)
      : null;
    await db
      .prepare(
        `UPDATE users SET github_access_token = ?, github_refresh_token = ?,
         github_token_expires_at = ?, github_id = ?, github_username = ? WHERE id = ?`,
      )
      .bind(
        encryptedToken,
        encryptedRefreshToken,
        token.expiresAt ?? null,
        githubUserId,
        githubUsername,
        userId,
      )
      .run();
    logger.info("GitHub token stored", { userId, githubUsername });
    return true;
  } catch (error) {
    logger.error("Failed to store GitHub token", error instanceof Error ? error : undefined, {
      userId,
    });
    return false;
  }
}

/** A page of a GitHub list endpoint, items unparsed (untrusted JSON). */
export type GitHubPageResult =
  | { success: true; items: unknown[] }
  | {
      success: false;
      error: string;
      status: number;
      rateLimited: boolean;
      /** Epoch ms the primary rate limit resets at, when GitHub said. */
      rateLimitResetAt?: number;
    };

export class GitHubClient {
  private token: string;
  private logger: Logger;
  private sharesRepositoryHealth: boolean;

  /**
   * @param token - The credential every call is made with
   * @param logger - Request logger
   * @param options - `personal` for a token that is one person's own. The
   *   circuit breaker measures whether a repository is reachable by the
   *   deployment's credential; a person without access to it answers 403 or
   *   404 every time, and counting those would open the breaker for callers
   *   that can reach the repository perfectly well. A personal client neither
   *   feeds the breaker nor is stopped by it.
   */
  constructor(token: string, logger: Logger, options: { personal?: boolean } = {}) {
    this.token = token;
    this.logger = logger;
    this.sharesRepositoryHealth = options.personal !== true;
  }

  private circuitOpen(endpoint: string): boolean {
    return this.sharesRepositoryHealth && isCircuitOpen(endpoint);
  }

  private recordCircuit(endpoint: string, success: boolean): void {
    if (this.sharesRepositoryHealth) recordCircuitResult(endpoint, success);
  }

  /**
   * Issues one GitHub API call, with retry/backoff, rate-limit handling, and
   * the circuit breaker applying by default.
   *
   * `maxRetries` and `timeoutMs` are opt-in per call (existing callers that
   * don't pass them keep exactly the prior behavior: `MAX_RETRIES` retries,
   * no deadline). Passing `timeoutMs` bounds a single attempt, not the whole
   * call — see the {@link DEFAULT_TIMEOUT_MS} doc comment for how that
   * combines with retries. A caller that wants a single bounded attempt
   * (no automatic retry) should pass `maxRetries: 0` explicitly — e.g. PR
   * creation is not safe to blindly retry on a network-level failure, since
   * the client can't tell whether GitHub received the request before the
   * connection dropped (see `createOrReusePR`, which relies on the
   * duplicate-head 422 to detect that case instead).
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    requestOpts: { maxRetries?: number; timeoutMs?: number; retryCount?: number } = {},
  ): Promise<
    | { success: true; data: T; status: number }
    | {
        success: false;
        error: string;
        status: number;
        rateLimited?: boolean;
        /** Epoch ms at which the primary rate limit resets, when `rateLimited`. */
        rateLimitResetAt?: number;
        networkError?: boolean;
        githubMessage?: string;
        errors?: GithubErrorDetail[];
      }
  > {
    const maxRetries = requestOpts.maxRetries ?? MAX_RETRIES;
    const retryCount = requestOpts.retryCount ?? 0;

    if (this.circuitOpen(endpoint)) {
      return {
        success: false,
        error: "Service temporarily unavailable (circuit open)",
        status: 503,
      };
    }

    const url = `${GITHUB_API_BASE}${endpoint}`;
    // A fresh timeout signal per attempt: a retried call gets the full
    // `timeoutMs` again on each try, not a shrinking remainder of one shared
    // deadline (see the doc comment above).
    const timeoutSignal =
      requestOpts.timeoutMs !== undefined ? AbortSignal.timeout(requestOpts.timeoutMs) : undefined;
    const signal =
      options.signal && timeoutSignal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : (options.signal ?? timeoutSignal);
    try {
      const response = await fetch(url, {
        ...options,
        signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "stratum",
          ...options.headers,
        },
      });

      // Handle rate limiting
      if (response.status === 403) {
        const rateLimitRemaining = response.headers.get("X-RateLimit-Remaining");
        const rateLimitReset = response.headers.get("X-RateLimit-Reset");
        if (rateLimitRemaining === "0" && rateLimitReset) {
          const resetTime = Number.parseInt(rateLimitReset) * 1000;
          const waitTime = resetTime - Date.now();
          if (retryCount < maxRetries && waitTime < MAX_DELAY_MS) {
            this.logger.warn("Rate limited, waiting and retrying", {
              endpoint,
              waitTime,
              retryCount,
            });
            await discardResponseBody(response, this.logger, endpoint);
            await new Promise((resolve) => setTimeout(resolve, Math.max(waitTime, 1000)));
            return this.request(endpoint, options, { ...requestOpts, retryCount: retryCount + 1 });
          }
          await discardResponseBody(response, this.logger, endpoint);
          this.recordCircuit(endpoint, false);
          return {
            success: false,
            error: `GitHub rate limit exceeded. Resets at ${new Date(resetTime).toISOString()}`,
            status: 403,
            rateLimited: true,
            rateLimitResetAt: resetTime,
          };
        }
      }

      // Handle other retryable errors (5xx)
      if (response.status >= 500 && retryCount < maxRetries) {
        const delay = getBackoffDelay(retryCount);
        this.logger.warn("Retryable error, backing off", {
          endpoint,
          status: response.status,
          retryCount,
          delay,
        });
        await discardResponseBody(response, this.logger, endpoint);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.request(endpoint, options, { ...requestOpts, retryCount: retryCount + 1 });
      }

      if (!response.ok) {
        const errorText = await response.text();
        const { message: githubMessage, errors } = parseGithubErrorBody(errorText);
        this.logger.error("GitHub API error", undefined, {
          endpoint,
          status: response.status,
          error: errorText,
        });
        if (isCircuitFailureStatus(response.status)) {
          this.recordCircuit(endpoint, false);
        }
        return {
          success: false,
          error: `GitHub API error: ${response.status} - ${errorText}`,
          status: response.status,
          githubMessage,
          errors,
        };
      }

      this.recordCircuit(endpoint, true);
      // A 2xx response with a body that isn't valid JSON is a malformed
      // response, not a network failure — GitHub was reached and answered.
      // Parsed separately from the fetch itself so the outer catch (network
      // errors/timeouts) doesn't swallow this into the same bucket: a caller
      // that persists side effects before this point (the promotion route
      // has already force-pushed the branch) needs to tell "GitHub never
      // responded" apart from "GitHub responded with garbage".
      try {
        const data = await response.json();
        return { success: true, data: data as T, status: response.status };
      } catch (parseError) {
        this.logger.error(
          "GitHub API response was not valid JSON",
          parseError instanceof Error ? parseError : undefined,
          { endpoint, status: response.status },
        );
        return {
          success: false,
          error: `GitHub API returned a response that could not be parsed as JSON (status ${response.status})`,
          status: response.status,
        };
      }
    } catch (error) {
      this.logger.error("GitHub API request failed", error instanceof Error ? error : undefined, {
        endpoint,
      });
      this.recordCircuit(endpoint, false);
      return {
        success: false,
        error: `Request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        status: 0,
        networkError: true,
      };
    }
  }

  async getAuthenticatedUser(): Promise<
    { success: true; id: string; login: string } | { success: false; error: string }
  > {
    const result = await this.request<{ id: number; login: string }>("/user");
    if (!result.success) return { success: false, error: result.error };
    return { success: true, id: String(result.data.id), login: result.data.login };
  }

  async createPR(
    opts: CreatePROpts,
  ): Promise<{ success: true; pr: GitHubPullRequest } | { success: false; error: string }> {
    const result = await this.request<GitHubPullRequest>(
      `/repos/${opts.owner}/${opts.repo}/pulls`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: opts.title,
          body: opts.body,
          head: opts.head,
          base: opts.base,
          draft: opts.draft,
        }),
      },
    );
    if (!result.success) return { success: false, error: result.error };
    return { success: true, pr: result.data };
  }

  /**
   * Creates a PR from `opts.head`, or reuses the open PR GitHub already has
   * for that head if one exists.
   *
   * GitHub 422s PR creation with "a pull request already exists" when the
   * head ref already has one open — either a concurrent promotion, or a
   * retry after the caller failed to persist the result of a prior create.
   * Looking that PR up and reusing it turns what would otherwise be a dead
   * end into a successful, idempotent call.
   *
   * The raw, `unknown` GitHub response is returned on success rather than a
   * type asserted from it — callers that persist the result (as the
   * promotion route does) are expected to validate its shape themselves
   * against whatever they trust enough to store, since a JSON parse alone
   * doesn't guarantee GitHub's documented fields are actually present.
   *
   * `isReusablePr` selects the lookup hit that gets treated as a successful
   * reuse: this client has no opinion on what a caller trusts enough to
   * accept as "the PR" (the promotion route, for one, only accepts an open
   * PR whose `html_url` is exactly this repo's canonical page for the
   * matched number — see `isUsableGithubPr`). It is applied across every PR
   * the lookup returns, not just the first, since the lookup is head-scoped
   * and a head can carry more than one open PR. A lookup whose entries the
   * predicate all reject behaves exactly like a lookup that failed or found
   * nothing open: the ORIGINAL create error is what gets reported, not a new
   * failure about the lookup response, since that's the one call the caller
   * actually asked for.
   *
   * Required, deliberately not defaulted. The code this replaced always ran
   * an owner/repo check on the lookup hit, and a parameter defaulting to
   * "accept anything" would turn that into something a caller drops by
   * saying nothing. Reuse means persisting a PR this client did not create
   * and did not choose; the caller has to name what it will accept.
   *
   * Both requests this makes use `maxRetries: 0`: a create call is not safe
   * to retry blindly on a network-level failure (this client can't tell
   * whether GitHub received it before the connection dropped — a retry could
   * either double-create or land on the duplicate-head path above, which is
   * exactly why that path exists), and the lookup is a best-effort read
   * whose failure already falls back to the original create error below.
   */
  async createOrReusePR(
    opts: CreatePROpts,
    isReusablePr: (pr: unknown) => boolean,
  ): Promise<CreateOrReusePRResult> {
    const result = await this.request<unknown>(
      `/repos/${opts.owner}/${opts.repo}/pulls`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: opts.title,
          body: opts.body,
          head: opts.head,
          base: opts.base,
          draft: opts.draft,
        }),
      },
      { maxRetries: 0, timeoutMs: DEFAULT_TIMEOUT_MS },
    );

    if (result.success) {
      return { success: true, pr: result.data, reused: false, status: result.status };
    }

    const duplicateHead =
      result.status === 422 &&
      (result.errors ?? []).some((e) =>
        e.message?.toLowerCase().includes("pull request already exists"),
      );

    if (duplicateHead) {
      const lookup = await this.request<unknown>(
        `/repos/${opts.owner}/${opts.repo}/pulls?head=${opts.owner}:${opts.head}&state=open`,
        {},
        { maxRetries: 0, timeoutMs: DEFAULT_TIMEOUT_MS },
      );
      // Searched rather than index-then-test: `GET /pulls?head=` is head-only
      // and can legitimately return more than one open PR, and the predicate
      // is what decides which of them belongs to the repository being pushed
      // to. Testing only the first entry would fail the reuse path in exactly
      // the case the predicate exists for. Order is GitHub's; no preference is
      // expressed here beyond "the first one the caller accepts".
      const candidates: unknown[] = lookup.success && Array.isArray(lookup.data) ? lookup.data : [];
      const candidate = candidates.find(isReusablePr);
      if (candidate !== undefined) {
        return { success: true, pr: candidate, reused: true, status: lookup.status };
      }
      // Lookup failed, found nothing open, or found something the caller
      // won't accept — fall through to the original create error below;
      // that's still the most useful thing to report.
    }

    return {
      success: false,
      networkError: result.networkError ?? false,
      status: result.status,
      githubMessage: result.githubMessage,
      errors: result.errors ?? [],
    };
  }

  async updatePR(
    opts: UpdatePROpts,
  ): Promise<
    { success: true; pr: GitHubPullRequest } | { success: false; error: string; status?: number }
  > {
    const body: Record<string, string> = {};
    if (opts.title) body.title = opts.title;
    if (opts.body) body.body = opts.body;
    if (opts.state) body.state = opts.state;
    const result = await this.request<GitHubPullRequest>(
      `/repos/${opts.owner}/${opts.repo}/pulls/${opts.pull_number}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!result.success) return { success: false, error: result.error, status: result.status };
    return { success: true, pr: result.data };
  }

  /**
   * Reads a pull request and returns GitHub's answer unnarrowed (#420).
   *
   * {@link getPR} types the answer as fields this client has always trusted.
   * A caller reading a pull request a stranger opened needs more of it —
   * `merged`, the counts, the base repository — and must check each field
   * itself, so this hands back `unknown` instead of a wider type that would
   * only look checked. Bounded to one attempt's timeout per try.
   */
  async getPullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<{ success: true; data: unknown } | { success: false; error: string; status: number }> {
    const result = await this.request<unknown>(
      `/repos/${owner}/${repo}/pulls/${pullNumber}`,
      {},
      { timeoutMs: DEFAULT_TIMEOUT_MS },
    );
    if (!result.success) return { success: false, error: result.error, status: result.status };
    return { success: true, data: result.data };
  }

  /**
   * Take a pull request out of draft. The REST API cannot do this (`draft` is
   * not writable on update), so it goes through the one GraphQL mutation that
   * can. A pull request that is already ready is success, not an error.
   */
  async markPRReady(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<
    | { success: true; alreadyReady: boolean }
    /** `closed`: GitHub answered, and the pull request is no longer open. */
    | { success: false; error: string; closed?: true }
  > {
    const found = await this.getPR(owner, repo, pullNumber);
    if (!found.success) return found;
    if (found.pr.state !== "open") {
      return { success: false, error: "The pull request is closed", closed: true };
    }
    if (found.pr.draft === false) return { success: true, alreadyReady: true };
    if (!found.pr.node_id) {
      return { success: false, error: "GitHub did not return the pull request's id" };
    }
    const result = await this.request<{
      data?: { markPullRequestReadyForReview?: { pullRequest?: { isDraft?: boolean } } };
      errors?: Array<{ message?: string }>;
    }>("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query:
          "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
        variables: { id: found.pr.node_id },
      }),
    });
    if (!result.success) return { success: false, error: result.error };
    // GraphQL reports a refused mutation in a 200 response.
    const refused = result.data.errors?.map((e) => e.message).filter(Boolean) ?? [];
    if (refused.length > 0) return { success: false, error: refused.join("; ") };
    if (result.data.data?.markPullRequestReadyForReview?.pullRequest?.isDraft !== false) {
      return { success: false, error: "GitHub did not confirm the pull request is ready" };
    }
    return { success: true, alreadyReady: false };
  }

  async getPR(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<{ success: true; pr: GitHubPullRequest } | { success: false; error: string }> {
    const result = await this.request<GitHubPullRequest>(
      `/repos/${owner}/${repo}/pulls/${pullNumber}`,
    );
    if (!result.success) return { success: false, error: result.error };
    return { success: true, pr: result.data };
  }

  async postComment(
    opts: PostCommentOpts,
  ): Promise<{ success: true; id: number } | { success: false; error: string; status?: number }> {
    const result = await this.request<{ id: number }>(
      `/repos/${opts.owner}/${opts.repo}/issues/${opts.issue_number}/comments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: opts.body }),
      },
    );
    if (!result.success) return { success: false, error: result.error, status: result.status };
    return { success: true, id: result.data.id };
  }

  async updateComment(opts: {
    owner: string;
    repo: string;
    comment_id: number;
    body: string;
  }): Promise<{ success: true; id: number } | { success: false; error: string }> {
    const result = await this.request<{ id: number }>(
      `/repos/${opts.owner}/${opts.repo}/issues/comments/${opts.comment_id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: opts.body }),
      },
    );
    if (!result.success) return { success: false, error: result.error };
    return { success: true, id: result.data.id };
  }

  async setStatus(
    opts: SetStatusOpts,
  ): Promise<{ success: true } | { success: false; error: string }> {
    const result = await this.request<unknown>(
      `/repos/${opts.owner}/${opts.repo}/statuses/${opts.sha}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state: opts.state,
          description: opts.description,
          context: opts.context ?? "stratum/evaluation",
          target_url: opts.target_url,
        }),
      },
    );
    if (!result.success) return { success: false, error: result.error };
    return { success: true };
  }

  /**
   * One page of a repository's issues, oldest first, in every state. GitHub's
   * issues endpoint also returns pull requests (they carry a `pull_request`
   * key); the items are returned unparsed for the caller to validate, because
   * this is untrusted JSON and the importer needs to skip PRs, not reject them.
   *
   * Ascending creation order keeps page boundaries stable while an import is
   * running: an issue opened mid-import lands on the last page instead of
   * shifting every earlier page by one.
   */
  async listRepoIssuesPage(
    owner: string,
    repo: string,
    page: number,
    perPage: number,
  ): Promise<GitHubPageResult> {
    const query = `state=all&sort=created&direction=asc&per_page=${perPage}&page=${page}`;
    return this.listPage(`/repos/${owner}/${repo}/issues?${query}`);
  }

  /** One page of an issue's comments, oldest first, unparsed (see {@link listRepoIssuesPage}). */
  async listIssueCommentsPage(
    owner: string,
    repo: string,
    issueNumber: number,
    page: number,
    perPage: number,
  ): Promise<GitHubPageResult> {
    return this.listPage(
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${perPage}&page=${page}`,
    );
  }

  /** Whether a repository is private (or internal), as GitHub reports it. */
  async getRepoVisibility(
    owner: string,
    repo: string,
  ): Promise<{ success: true; private: boolean } | { success: false; error: string }> {
    const result = await this.request<{ private?: unknown; visibility?: unknown }>(
      `/repos/${owner}/${repo}`,
      {},
      { timeoutMs: DEFAULT_TIMEOUT_MS },
    );
    if (!result.success) return { success: false, error: result.error };
    // Anything other than an explicit public answer counts as private, so a
    // response missing both fields fails closed.
    const isPublic = result.data.private === false && result.data.visibility !== "internal";
    return { success: true, private: !isPublic };
  }

  /**
   * The object id of one entry at the root of a branch's tree, as GitHub has
   * it now, or null when the branch has no such entry.
   *
   * A git tree's id is a hash of its contents, so comparing this with the id
   * of the same directory elsewhere says whether the two are identical without
   * reading a single file.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param ref - Branch name or commit
   * @param name - The root entry, e.g. `.github`
   */
  async getRootTreeEntryOid(
    owner: string,
    repo: string,
    ref: string,
    name: string,
  ): Promise<{ success: true; oid: string | null } | { success: false; error: string }> {
    const result = await this.request<{ tree?: unknown; truncated?: unknown }>(
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}`,
      {},
      { timeoutMs: DEFAULT_TIMEOUT_MS },
    );
    if (!result.success) return { success: false, error: result.error };
    const { tree, truncated } = result.data;
    // A truncated listing cannot say an entry is absent, and absence is an answer here.
    if (!Array.isArray(tree) || truncated === true) {
      return { success: false, error: "GitHub returned an unreadable tree" };
    }
    for (const item of tree) {
      if (typeof item !== "object" || item === null) continue;
      const { path, sha } = item as { path?: unknown; sha?: unknown };
      if (path === name) {
        return typeof sha === "string"
          ? { success: true, oid: sha }
          : { success: false, error: "GitHub returned an unreadable tree" };
      }
    }
    return { success: true, oid: null };
  }

  private async listPage(endpoint: string): Promise<GitHubPageResult> {
    const result = await this.request<unknown>(endpoint, {}, { timeoutMs: DEFAULT_TIMEOUT_MS });
    if (!result.success) {
      // 429, and a 403 GitHub labels a secondary rate limit, are "slow down",
      // not "no access": the importer waits and retries the page.
      const secondary =
        result.status === 429 ||
        (result.status === 403 && /secondary rate limit/i.test(result.githubMessage ?? ""));
      return {
        success: false,
        error: result.error,
        status: result.status,
        rateLimited: result.rateLimited === true || secondary,
        ...(result.rateLimitResetAt !== undefined
          ? { rateLimitResetAt: result.rateLimitResetAt }
          : {}),
      };
    }
    if (!Array.isArray(result.data)) {
      return {
        success: false,
        error: "GitHub returned a non-list response for a list endpoint",
        status: result.status,
        rateLimited: false,
      };
    }
    return { success: true, items: result.data };
  }

  async getRepo(
    owner: string,
    repo: string,
  ): Promise<{ success: true; default_branch: string } | { success: false; error: string }> {
    const result = await this.request<{ default_branch: string }>(`/repos/${owner}/${repo}`);
    if (!result.success) return { success: false, error: result.error };
    return { success: true, default_branch: result.data.default_branch };
  }
}

export async function createGitHubClient(
  db: D1Database,
  userId: string,
  encryptionSecret: string,
  logger: Logger,
): Promise<GitHubClient | null> {
  const token = await getGitHubToken(db, userId, encryptionSecret, logger);
  if (!token) return null;
  return new GitHubClient(token.accessToken, logger);
}
