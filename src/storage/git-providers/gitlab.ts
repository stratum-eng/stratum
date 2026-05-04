/**
 * GitLab provider implementation
 */

import type { Logger } from "../../utils/logger";
import type {
  CommitInfo,
  GitProviderClient,
  ParsedRepoInfo,
  ProviderApiResponse,
  ProviderAuthConfig,
  RepoMetadata,
  UpdateCheckResult,
} from "./types";

const GITLAB_API_BASE = "https://gitlab.com/api/v4";

export class GitLabProvider implements GitProviderClient {
  readonly provider = "gitlab" as const;

  parseUrl(url: string): ParsedRepoInfo | null {
    // Support various GitLab URL formats:
    // https://gitlab.com/owner/repo
    // https://gitlab.com/owner/repo.git
    // https://gitlab.com/group/subgroup/repo
    // git@gitlab.com:owner/repo.git
    // https://gitlab.com/owner/repo/-/tree/branch

    // HTTPS URL with optional branch
    const httpsMatch = url.match(
      /^https?:\/\/gitlab\.com\/(.+?)\/([^/\s]+?)(?:\.git)?(?:\/-\/tree\/([^/\s]+))?\/?$/i,
    );
    if (httpsMatch && httpsMatch[1] && httpsMatch[2]) {
      const path = httpsMatch[1];
      const repo = httpsMatch[2].replace(/\.git$/i, "");
      const branch = httpsMatch[3];
      return {
        owner: path, // In GitLab, this could be "group/subgroup"
        repo,
        url: `https://gitlab.com/${path}/${repo}`,
        branch,
      };
    }

    // SSH URL
    const sshMatch = url.match(/^git@gitlab\.com:(.+)\/([^/\s]+?)(?:\.git)?$/i);
    if (sshMatch && sshMatch[1] && sshMatch[2]) {
      const path = sshMatch[1];
      const repo = sshMatch[2].replace(/\.git$/i, "");
      return {
        owner: path,
        repo,
        url: `https://gitlab.com/${path}/${repo}`,
      };
    }

    return null;
  }

  isValidUrl(url: string): boolean {
    return this.parseUrl(url) !== null;
  }

  private buildApiUrl(path: string): string {
    return `${GITLAB_API_BASE}${path}`;
  }

  private buildHeaders(auth?: ProviderAuthConfig): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "Stratum-Git-Sync/1.0",
    };

    if (auth?.token) {
      headers["Private-Token"] = auth.token;
    } else if (auth?.oauthToken) {
      headers.Authorization = `Bearer ${auth.oauthToken}`;
    }

    return headers;
  }

  /**
   * URL-encode a path for GitLab API
   * GitLab uses URL-encoded paths (e.g., "group%2Fsubgroup%2Frepo")
   */
  private encodePath(path: string): string {
    return encodeURIComponent(path);
  }

  async getLatestCommit(
    owner: string,
    repo: string,
    branch: string,
    auth: ProviderAuthConfig | undefined,
    logger: Logger,
  ): Promise<ProviderApiResponse<CommitInfo>> {
    try {
      const projectPath = this.encodePath(`${owner}/${repo}`);
      const url = this.buildApiUrl(
        `/projects/${projectPath}/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=1`,
      );
      logger.debug("Fetching latest commit from GitLab", { owner, repo, branch });

      const response = await fetch(url, {
        method: "GET",
        headers: this.buildHeaders(auth),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error("GitLab API error", undefined, {
          status: response.status,
          error: errorText,
          owner,
          repo,
        });
        return {
          success: false,
          error: `GitLab API error: ${response.status} - ${errorText}`,
          statusCode: response.status,
        };
      }

      const data = (await response.json()) as Array<{
        id: string;
        short_id: string;
        title: string;
        message: string;
        author_name: string;
        author_email: string;
        created_at: string;
        web_url: string;
      }>;

      if (!data || data.length === 0 || !data[0]) {
        return {
          success: false,
          error: "No commits found",
        };
      }

      const commit = data[0];
      return {
        success: true,
        data: {
          sha: commit.id,
          message: commit.title,
          author: commit.author_name,
          authorEmail: commit.author_email,
          timestamp: commit.created_at,
          url: commit.web_url,
        },
      };
    } catch (error) {
      logger.error(
        "Failed to get latest commit from GitLab",
        error instanceof Error ? error : undefined,
      );
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

      // Try to count commits between current and latest
      try {
        const projectPath = this.encodePath(`${owner}/${repo}`);
        const compareUrl = this.buildApiUrl(
          `/projects/${projectPath}/repository/compare?from=${currentCommit}&to=${latestCommit}`,
        );
        const compareResponse = await fetch(compareUrl, {
          method: "GET",
          headers: this.buildHeaders(auth),
        });

        if (compareResponse.ok) {
          const compareData = (await compareResponse.json()) as { commits: unknown[] };
          return {
            hasUpdates: true,
            currentCommit,
            latestCommit,
            commitsBehind: compareData.commits.length,
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
      const projectPath = this.encodePath(`${owner}/${repo}`);
      const url = this.buildApiUrl(`/projects/${projectPath}`);
      logger.debug("Fetching repo metadata from GitLab", { owner, repo });

      const response = await fetch(url, {
        method: "GET",
        headers: this.buildHeaders(auth),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `GitLab API error: ${response.status} - ${errorText}`,
          statusCode: response.status,
        };
      }

      const data = (await response.json()) as {
        name: string;
        path_with_namespace: string;
        description: string | null;
        visibility: string;
        default_branch: string;
        http_url_to_repo: string;
        ssh_url_to_repo: string;
        web_url: string;
        star_count: number;
        forks_count: number;
        last_activity_at: string;
        statistics?: {
          repository_size: number;
        };
      };

      return {
        success: true,
        data: {
          name: data.name,
          fullName: data.path_with_namespace,
          description: data.description || undefined,
          isPrivate: data.visibility === "private",
          defaultBranch: data.default_branch,
          cloneUrl: data.http_url_to_repo,
          sshUrl: data.ssh_url_to_repo,
          webUrl: data.web_url,
          stars: data.star_count,
          forks: data.forks_count,
          updatedAt: data.last_activity_at,
          size: data.statistics ? Math.round(data.statistics.repository_size / 1024) : undefined,
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
      // GitLab uses oauth2 token in URL
      return `https://oauth2:${auth.token}@gitlab.com/${owner}/${repo}.git`;
    }
    return `https://gitlab.com/${owner}/${repo}.git`;
  }

  getCommitUrl(owner: string, repo: string, sha: string): string {
    return `https://gitlab.com/${owner}/${repo}/-/commit/${sha}`;
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
export const gitlabProvider = new GitLabProvider();
