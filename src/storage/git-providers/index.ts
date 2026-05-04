/**
 * Git provider factory and utilities
 * Provides a unified interface for working with multiple git providers
 */

import type { GitProvider } from "../../types";
import type { GitProviderClient, ParsedRepoInfo, ProviderAuthConfig } from "./types";
import { githubProvider } from "./github";
import { gitlabProvider } from "./gitlab";
import { bitbucketProvider } from "./bitbucket";

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

// Re-export types
export * from "./types";

// Re-export provider instances
export { githubProvider, gitlabProvider, bitbucketProvider };
