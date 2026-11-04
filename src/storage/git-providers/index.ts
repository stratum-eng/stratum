/**
 * Git provider factory and utilities
 * Provides a unified interface for working with multiple git providers
 */

import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import { resolveGitHubToken } from "../../github/app-auth";
import type { GitProvider } from "../../types";
import type { Logger } from "../../utils/logger";
import type { GitHubPrincipal } from "../github-installations";
import { bitbucketProvider } from "./bitbucket";
import { githubProvider } from "./github";
import { gitlabProvider } from "./gitlab";
import type { GitProviderClient, ParsedRepoInfo, ProviderAuthConfig } from "./types";

// Registry of all available providers
const providers: Record<GitProvider, GitProviderClient> = {
  github: githubProvider,
  gitlab: gitlabProvider,
  bitbucket: bitbucketProvider,
};

/**
 * Get a provider client by type
 * @param provider - The provider type
 * @returns The provider client instance
 * @throws Error if provider is not supported
 */
export function getProvider(provider: GitProvider): GitProviderClient {
  const client = providers[provider];
  if (!client) {
    throw new Error(`Unsupported git provider: ${provider}`);
  }
  return client;
}

/**
 * Detect the provider from a repository URL
 * @param url - Repository URL
 * @returns The detected provider type or null if unknown
 */
export function detectProvider(url: string): GitProvider | null {
  if (githubProvider.isValidUrl(url)) return "github";
  if (gitlabProvider.isValidUrl(url)) return "gitlab";
  if (bitbucketProvider.isValidUrl(url)) return "bitbucket";
  return null;
}

/**
 * Parse a repository URL and detect the provider
 * @param url - Repository URL
 * @returns Object containing provider and parsed info, or null if invalid
 */
export function parseRepoUrl(url: string): { provider: GitProvider; info: ParsedRepoInfo } | null {
  const provider = detectProvider(url);
  if (!provider) return null;

  const client = getProvider(provider);
  const info = client.parseUrl(url);
  if (!info) return null;

  return { provider, info };
}

/**
 * Check if a URL is valid for any supported provider
 * @param url - URL to validate
 * @returns Whether the URL is valid
 */
export function isValidRepoUrl(url: string): boolean {
  return detectProvider(url) !== null;
}

/**
 * Get all supported provider types
 * @returns Array of supported provider types
 */
export function getSupportedProviders(): GitProvider[] {
  return Object.keys(providers) as GitProvider[];
}

/**
 * Build authentication config from environment or user settings
 * @param provider - The provider type
 * @param env - Environment variables
 * @returns Authentication config
 */
export function buildAuthConfig(
  provider: GitProvider,
  env: {
    GITHUB_TOKEN?: string;
    GITLAB_TOKEN?: string;
    BITBUCKET_TOKEN?: string;
    BITBUCKET_USERNAME?: string;
    BITBUCKET_APP_PASSWORD?: string;
  },
): ProviderAuthConfig | undefined {
  switch (provider) {
    case "github":
      if (env.GITHUB_TOKEN) {
        return { token: env.GITHUB_TOKEN };
      }
      break;
    case "gitlab":
      if (env.GITLAB_TOKEN) {
        return { token: env.GITLAB_TOKEN };
      }
      break;
    case "bitbucket":
      if (env.BITBUCKET_TOKEN) {
        return { token: env.BITBUCKET_TOKEN };
      }
      if (env.BITBUCKET_USERNAME && env.BITBUCKET_APP_PASSWORD) {
        return {
          username: env.BITBUCKET_USERNAME,
          password: env.BITBUCKET_APP_PASSWORD,
        };
      }
      break;
  }
  return undefined;
}

/** Static provider credentials, plus what the GitHub App path needs. */
export interface ProviderAuthEnv {
  GITHUB_TOKEN?: string;
  GITLAB_TOKEN?: string;
  BITBUCKET_TOKEN?: string;
  BITBUCKET_USERNAME?: string;
  BITBUCKET_APP_PASSWORD?: string;
  /** Without STATE and DB the GitHub App path is skipped and GITHUB_TOKEN is used. */
  STATE?: KVNamespace;
  DB?: D1Database;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_ALLOWED_OWNERS?: string;
  GITHUB_APP_ALLOWED_OWNERS?: string;
}

/**
 * Like {@link buildAuthConfig}, but resolves GitHub credentials per repo: a
 * GitHub App installation token when the app is installed on `owner/repo` and
 * that installation serves `principal`, else the GITHUB_TOKEN PAT (see
 * `resolveGitHubToken`). Other providers are
 * unchanged. Returns undefined — an unauthenticated call — when no credential
 * is available, matching buildAuthConfig.
 */
export async function resolveAuthConfig(
  provider: GitProvider,
  repo: { owner: string; repo: string },
  principal: GitHubPrincipal | null,
  env: ProviderAuthEnv,
  logger: Logger,
): Promise<ProviderAuthConfig | undefined> {
  if (provider !== "github" || !env.STATE || !env.DB) return buildAuthConfig(provider, env);

  const resolved = await resolveGitHubToken(
    { ...env, STATE: env.STATE, DB: env.DB },
    { owner: repo.owner, repo: repo.repo, principal },
    logger,
  );
  if (resolved.success) return { token: resolved.data.token };
  logger.debug("No GitHub credential available; calling GitHub unauthenticated", {
    owner: repo.owner,
    repo: repo.repo,
  });
  return undefined;
}

/** Branch used when the provider's real default branch cannot be resolved. */
export const FALLBACK_DEFAULT_BRANCH = "main";

/**
 * Resolve a repository's default branch from its provider API.
 *
 * Fail-open policy: when the URL's provider is unknown or the provider API call
 * fails (network error, rate limit, unknown repo), this falls back to
 * FALLBACK_DEFAULT_BRANCH ("main") and logs a warning instead of failing the
 * import. A wrong fallback surfaces as a clear clone error on the import job,
 * whereas failing closed would block imports on transient provider-API hiccups.
 *
 * @param url - Repository URL
 * @param env - Environment carrying optional provider API tokens
 * @param logger - Logger instance
 * @returns The provider's default branch, or "main" when it cannot be resolved
 */
/**
 * How long a provider metadata lookup may take before we give up and use the
 * fallback. This runs inline on the import request, so an unresponsive provider
 * API would otherwise hold the request open indefinitely; the timeout lands in
 * the same catch as any other lookup failure and yields "main".
 */
const PROVIDER_METADATA_TIMEOUT_MS = 5_000;

export async function resolveDefaultBranch(
  url: string,
  env: ProviderAuthEnv,
  logger: Logger,
  /** Who the import is for — the owner the new project will have. */
  principal: GitHubPrincipal | null = null,
): Promise<string> {
  const parsed = parseRepoUrl(url);
  if (!parsed) {
    logger.warn("resolveDefaultBranch: unrecognized repository URL, falling back to 'main'", {
      url,
    });
    return FALLBACK_DEFAULT_BRANCH;
  }

  const client = getProvider(parsed.provider);

  try {
    const auth = await resolveAuthConfig(parsed.provider, parsed.info, principal, env, logger);
    const result = await client.getDefaultBranch(
      parsed.info.owner,
      parsed.info.repo,
      auth,
      logger,
      AbortSignal.timeout(PROVIDER_METADATA_TIMEOUT_MS),
    );
    if (result.success && result.data) {
      logger.debug("Resolved default branch from provider", {
        url,
        provider: parsed.provider,
        branch: result.data,
      });
      return result.data;
    }
    logger.warn("resolveDefaultBranch: provider lookup failed, falling back to 'main'", {
      url,
      provider: parsed.provider,
      error: result.error,
    });
  } catch (error) {
    logger.warn("resolveDefaultBranch: provider lookup threw, falling back to 'main'", {
      url,
      provider: parsed.provider,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return FALLBACK_DEFAULT_BRANCH;
}

/**
 * Get provider from URL (legacy compatibility function)
 * @param url - Repository URL
 * @param _logger - Logger instance (optional, for compatibility)
 * @returns Provider client or null
 */
export function getProviderFromUrl(url: string, _logger?: unknown): GitProviderClient | null {
  const detected = detectProvider(url);
  if (!detected) return null;
  try {
    return getProvider(detected);
  } catch {
    return null;
  }
}

// Re-export types
export * from "./types";

// Re-export provider instances
export { githubProvider, gitlabProvider, bitbucketProvider };
