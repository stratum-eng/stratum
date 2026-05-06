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
}

export interface CreatePROpts {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
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

function recordCircuitResult(endpoint: string, success: boolean): void {
  const key = endpoint.split("/").slice(0, 3).join("/");
  const cb = circuitBreakers.get(key) || { failures: 0, lastFailure: 0, state: "closed" };
  if (success) {
    if (cb.state === "half-open") {
      cb.state = "closed";
      cb.failures = 0;
    }
  } else {
    cb.failures++;
    cb.lastFailure = Date.now();
    if (cb.failures >= CIRCUIT_BREAKER_THRESHOLD) {
      cb.state = "open";
    }
  }
  circuitBreakers.set(key, cb);
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

    return {
      accessToken: decryptedToken,
      refreshToken: result.github_refresh_token ?? undefined,
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
    await db
      .prepare(
        `UPDATE users SET github_access_token = ?, github_refresh_token = ?,
         github_token_expires_at = ?, github_id = ?, github_username = ? WHERE id = ?`,
      )
      .bind(
        encryptedToken,
        token.refreshToken ?? null,
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

export class GitHubClient {
  private token: string;
  private logger: Logger;

  constructor(token: string, logger: Logger) {
    this.token = token;
    this.logger = logger;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    retryCount = 0,
  ): Promise<
    | { success: true; data: T }
    | { success: false; error: string; status: number; rateLimited?: boolean }
  > {
    if (isCircuitOpen(endpoint)) {
      return {
        success: false,
        error: "Service temporarily unavailable (circuit open)",
        status: 503,
      };
    }

    const url = `${GITHUB_API_BASE}${endpoint}`;
    try {
      const response = await fetch(url, {
        ...options,
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
          if (retryCount < MAX_RETRIES && waitTime < MAX_DELAY_MS) {
            this.logger.warn("Rate limited, waiting and retrying", {
              endpoint,
              waitTime,
              retryCount,
            });
            await new Promise((resolve) => setTimeout(resolve, Math.max(waitTime, 1000)));
            return this.request(endpoint, options, retryCount + 1);
          }
          recordCircuitResult(endpoint, false);
          return {
            success: false,
            error: `GitHub rate limit exceeded. Resets at ${new Date(resetTime).toISOString()}`,
            status: 403,
            rateLimited: true,
          };
        }
      }

      // Handle other retryable errors (5xx)
      if (response.status >= 500 && retryCount < MAX_RETRIES) {
        const delay = getBackoffDelay(retryCount);
        this.logger.warn("Retryable error, backing off", {
          endpoint,
          status: response.status,
          retryCount,
          delay,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.request(endpoint, options, retryCount + 1);
      }

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error("GitHub API error", undefined, {
          endpoint,
          status: response.status,
          error: errorText,
        });
        recordCircuitResult(endpoint, false);
        return {
          success: false,
          error: `GitHub API error: ${response.status} - ${errorText}`,
          status: response.status,
        };
      }

      recordCircuitResult(endpoint, true);
      const data = await response.json();
      return { success: true, data: data as T };
    } catch (error) {
      this.logger.error("GitHub API request failed", error instanceof Error ? error : undefined, {
        endpoint,
      });
      recordCircuitResult(endpoint, false);
      return {
        success: false,
        error: `Request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        status: 500,
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
        }),
      },
    );
    if (!result.success) return { success: false, error: result.error };
    return { success: true, pr: result.data };
  }

  async updatePR(
    opts: UpdatePROpts,
  ): Promise<{ success: true; pr: GitHubPullRequest } | { success: false; error: string }> {
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
    if (!result.success) return { success: false, error: result.error };
    return { success: true, pr: result.data };
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
  ): Promise<{ success: true; id: number } | { success: false; error: string }> {
    const result = await this.request<{ id: number }>(
      `/repos/${opts.owner}/${opts.repo}/issues/${opts.issue_number}/comments`,
      {
        method: "POST",
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
