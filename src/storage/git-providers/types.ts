/**
 * Git provider interfaces for multi-provider support
 * Supports GitHub, GitLab, and Bitbucket
 */

import type { GitProvider } from "../../types";
import type { Logger } from "../../utils/logger";

/**
 * Parsed repository information
 */
export interface ParsedRepoInfo {
  /** Repository owner (user or organization) */
  owner: string;
  /** Repository name */
  repo: string;
  /** Full URL to the repository */
  url: string;
  /** Branch if specified in URL */
  branch?: string;
}

/**
 * Commit information from a provider
 */
export interface CommitInfo {
  /** Commit SHA */
  sha: string;
  /** Commit message */
  message: string;
  /** Author name */
  author: string;
  /** Author email */
  authorEmail?: string;
  /** Commit timestamp */
  timestamp: string;
  /** Commit URL */
  url?: string;
}

/**
 * Result of checking for updates
 */
export interface UpdateCheckResult {
  /** Whether there are updates available */
  hasUpdates: boolean;
  /** Current commit SHA in our system */
  currentCommit?: string;
  /** Latest commit SHA from remote */
  latestCommit?: string;
  /** Number of commits behind */
  commitsBehind?: number;
  /** Error message if check failed */
  error?: string;
}

/**
 * Provider-specific API response
 */
export interface ProviderApiResponse<T> {
  /** Whether the API call was successful */
  success: boolean;
  /** Response data if successful */
  data?: T;
  /** Error message if failed */
  error?: string;
  /** HTTP status code */
  statusCode?: number;
}

/**
 * Configuration for provider authentication
 */
export interface ProviderAuthConfig {
  /** Personal access token */
  token?: string;
  /** OAuth token */
  oauthToken?: string;
  /** Username for basic auth */
  username?: string;
  /** Password or app password for basic auth */
  password?: string;
}

/**
 * Base interface for all git providers
 */
export interface GitProviderClient {
  /** Provider type identifier */
  readonly provider: GitProvider;

  /**
   * Parse a repository URL into owner/repo components
   * @param url - Repository URL
   * @returns Parsed repo info or null if invalid
   */
  parseUrl(url: string): ParsedRepoInfo | null;

  /**
   * Check if a URL is valid for this provider
   * @param url - URL to validate
   * @returns Whether the URL is valid
   */
  isValidUrl(url: string): boolean;

  /**
   * Check for updates between local and remote
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param currentCommit - Current commit SHA we have
   * @param branch - Branch to check
   * @param auth - Authentication config
   * @param logger - Logger instance
   * @returns Update check result
   */
  checkForUpdates(
    owner: string,
    repo: string,
    currentCommit: string | undefined,
    branch: string,
    auth: ProviderAuthConfig | undefined,
    logger: Logger,
  ): Promise<UpdateCheckResult>;

  /**
   * Get the latest commit SHA for a branch
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param branch - Branch name
   * @param auth - Authentication config
   * @param logger - Logger instance
   * @returns Latest commit info or null if failed
   */
  getLatestCommit(
    owner: string,
    repo: string,
    branch: string,
    auth: ProviderAuthConfig | undefined,
    logger: Logger,
  ): Promise<ProviderApiResponse<CommitInfo>>;

  /**
   * Get repository metadata
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param auth - Authentication config
   * @param logger - Logger instance
   * @returns Repository metadata
   */
  getRepoMetadata(
    owner: string,
    repo: string,
    auth: ProviderAuthConfig | undefined,
    logger: Logger,
  ): Promise<ProviderApiResponse<RepoMetadata>>;

  /**
   * Build a clone URL for the repository
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param auth - Authentication config (for token-based auth)
   * @returns Clone URL
   */
  buildCloneUrl(
    owner: string,
    repo: string,
    auth?: ProviderAuthConfig,
  ): string;

  /**
   * Get the web URL for a commit
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param sha - Commit SHA
   * @returns Web URL for the commit
   */
  getCommitUrl(owner: string, repo: string, sha: string): string;

  /**
   * Get the default branch for a repository
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param auth - Authentication config
   * @param logger - Logger instance
   * @returns Default branch name or null
   */
  getDefaultBranch(
    owner: string,
    repo: string,
    auth: ProviderAuthConfig | undefined,
    logger: Logger,
  ): Promise<ProviderApiResponse<string>>;
}

/**
 * Repository metadata
 */
export interface RepoMetadata {
  /** Repository name */
  name: string;
  /** Full repository name (owner/repo) */
  fullName: string;
  /** Repository description */
  description?: string;
  /** Whether the repository is private */
  isPrivate: boolean;
  /** Default branch */
  defaultBranch: string;
  /** Clone URL (HTTPS) */
  cloneUrl: string;
  /** Clone URL (SSH) */
  sshUrl?: string;
  /** Repository web URL */
  webUrl: string;
  /** Number of stars */
  stars?: number;
  /** Number of forks */
  forks?: number;
  /** Last updated timestamp */
  updatedAt?: string;
  /** Repository size in KB */
  size?: number;
}

/**
 * Factory function type for creating provider clients
 */
export type ProviderFactory = (provider: GitProvider) => GitProviderClient;
