/**
 * GitHub provider implementation
 */

import type {
  CommitInfo,
  GitProviderClient,
  ParsedRepoInfo,
  ProviderApiResponse,
  ProviderAuthConfig,
  RepoMetadata,
  UpdateCheckResult,
} from "./types";
import type { Logger } from "../../utils/logger";

const GITHUB_API_BASE = "https://api.github.com";

export class GitHubProvider implements GitProviderClient {
  readonly provider = "github" as const;

  parseUrl(url: string): ParsedRepoInfo | null {
    // Support various GitHub URL formats:
    // https://github.com/owner/repo
    // https://github.com/owner/repo.git
    // https://github.com/owner/repo/tree/branch
    // git@github.com:owner/repo.git

    const httpsMatch = url.match(
      /^https?:\/\/github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?(?:\/tree\/([^/\s]+))?\/?$/i,
    );
    if (httpsMatch && httpsMatch[1] && httpsMatch[2]) {
      return {
        owner: httpsMatch[1],
        repo: httpsMatch[2].replace(/\.git$/i, ""),
        url: `https://github.com/${httpsMatch[1]}/${httpsMatch[2].replace(/\.git$/i, "")}`,
        branch: httpsMatch[3],
      };
    }

    const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/\s]+?)(?:\.git)?$/i);
    if (sshMatch && sshMatch[1] && sshMatch[2]) {
      return {
        owner: sshMatch[1],
        repo: sshMatch[2].replace(/\.git$/i, ""),
        url: `https://github.com/${sshMatch[1]}/${sshMatch[2].replace(/\.git$/i, "")}`,
      };
    }

    return null;
  }

  isValidUrl(url: string): boolean {
    return this.parseUrl(url) !== null;
  }

  private buildApiUrl(path: string): string {
    return `${GITHUB_API_BASE}${path}`;
  }

  private buildHeaders(auth?: ProviderAuthConfig): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "Stratum-Git-Sync/1.0",
    };

    if (auth?.token) {
      headers.Authorization = `Bearer ${auth.token}`;
    } else if (auth?.oauthToken) {
      headers.Authorization = `token ${auth.oauthToken}`;
    }

    return headers;
  }

  async getLatestCommit(
    owner: string,
    repo: string,
    branch: string,
    auth: ProviderAuthConfig | undefined,
    logger: Logger,
  ): Promise<ProviderApiResponse<CommitInfo>> {
    try {
      const url = this.buildApiUrl(`/repos/${owner}/${repo}/commits/${branch}`);
      logger.debug("Fetching latest commit from GitHub", { owner, repo, branch });

      const response = await fetch(url, {
        method: "GET",
        headers: this.buildHeaders(auth),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error("GitHub API error", undefined, {
          status: response.status,
          error: errorText,
          owner,
          repo,
        });
        return {
          success: false,
          error: `GitHub API error: ${response.status} - ${errorText}`,
          statusCode: response.status,
        };
      }

      const data = (await response.json()) as {
        sha: string;
        commit: {
          message: string;
          author: {
            name: string;
            email: string;
            date: string;
          };
        };
        html_url: string;
      };

      return {
        success: true,
        data: {
          sha: data.sha,
          message: data.commit.message,
          author: data.commit.author.name,
          authorEmail: data.commit.author.email,
          timestamp: data.commit.author.date,
          url: data.html_url,
        },
      };
    } catch (error) {
      logger.error("Failed to get latest commit from GitHub", error instanceof Error ? error : undefined);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async checkForUpdates(
    owner: string,
    repo: string,
    currentCommit: string | undefined,
    branch: string,
    auth: ProviderAuthConfig | undefined,
    logger: Logger,
  ): Promise<UpdateCheckResult> {
    try {
      const latestResult = await this.getLatestCommit(owner, repo, branch, auth, logger);

      if (!latestResult.success || !latestResult.data) {
        return {
          hasUpdates: false,
          error: latestResult.error || "Failed to get latest commit",
        };
      }

      const latestCommit = latestResult.data.sha;

      // If no current commit, we need to sync
      if (!currentCommit) {
        return {
          hasUpdates: true,
          currentCommit: undefined,
          latestCommit,
          commitsBehind: undefined,
        };
      }

      // If commits match, no updates needed
      if (currentCommit === latestCommit) {
        return {
          hasUpdates: false,
          currentCommit,
          latestCommit,
          commitsBehind: 0,
        };
      }

      // Compare commits to count how far behind we are
      try {
        const compareUrl = this.buildApiUrl(`/repos/${owner}/${repo}/compare/${currentCommit}...${latestCommit}`);
        const compareResponse = await fetch(compareUrl, {
          method: "GET",
          headers: this.buildHeaders(auth),
        });

        if (compareResponse.ok) {
          const compareData = (await compareResponse.json()) as { ahead_by: number };
          return {
            hasUpdates: true,
            currentCommit,
            latestCommit,
            commitsBehind: compareData.ahead_by,
          };
        }
      } catch (error) {
        logger.debug("Failed to compare commits, using basic check", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Fallback: we know there are updates but don't know how many
      return {
        hasUpdates: true,
        currentCommit,
        latestCommit,
        commitsBehind: undefined,
      };
    } catch (error) {
      logger.error("Error checking for updates", error instanceof Error ? error : undefined);
      return {
        hasUpdates: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async getRepoMetadata(
    owner: string,
    repo: string,
    auth: ProviderAuthConfig | undefined,
    logger: Logger,
  ): Promise<ProviderApiResponse<RepoMetadata>> {
    try {
      const url = this.buildApiUrl(`/repos/${owner}/${repo}`);
      logger.debug("Fetching repo metadata from GitHub", { owner, repo });

      const response = await fetch(url, {
        method: "GET",
        headers: this.buildHeaders(auth),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `GitHub API error: ${response.status} - ${errorText}`,
          statusCode: response.status,
        };
      }

      const data = (await response.json()) as {
        name: string;
        full_name: string;
        description: string | null;
        private: boolean;
        default_branch: string;
        clone_url: string;
        ssh_url: string;
        html_url: string;
        stargazers_count: number;
        forks_count: number;
        updated_at: string;
        size: number;
      };

      return {
        success: true,
        data: {
          name: data.name,
          fullName: data.full_name,
          description: data.description || undefined,
          isPrivate: data.private,
          defaultBranch: data.default_branch,
          cloneUrl: data.clone_url,
          sshUrl: data.ssh_url,
          webUrl: data.html_url,
          stars: data.stargazers_count,
          forks: data.forks_count,
          updatedAt: data.updated_at,
          size: data.size,
        },
      };
    } catch (error) {
      logger.error("Failed to get repo metadata", error instanceof Error ? error : undefined);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  buildCloneUrl(owner: string, repo: string, auth?: ProviderAuthConfig): string {
    if (auth?.token) {
      return `https://${auth.token}@github.com/${owner}/${repo}.git`;
    }
    return `https://github.com/${owner}/${repo}.git`;
  }

  getCommitUrl(owner: string, repo: string, sha: string): string {
    return `https://github.com/${owner}/${repo}/commit/${sha}`;
  }

  async getDefaultBranch(
    owner: string,
    repo: string,
    auth: ProviderAuthConfig | undefined,
    logger: Logger,
  ): Promise<ProviderApiResponse<string>> {
    const metadataResult = await this.getRepoMetadata(owner, repo, auth, logger);

    if (!metadataResult.success || !metadataResult.data) {
      return {
        success: false,
        error: metadataResult.error || "Failed to get repository metadata",
      };
    }

    return {
      success: true,
      data: metadataResult.data.defaultBranch,
    };
  }
}

// Export singleton instance
export const githubProvider = new GitHubProvider();
