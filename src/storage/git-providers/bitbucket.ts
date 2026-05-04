/**
 * Bitbucket provider implementation
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

const BITBUCKET_API_BASE = "https://api.bitbucket.org/2.0";

export class BitbucketProvider implements GitProviderClient {
  readonly provider = "bitbucket" as const;

  parseUrl(url: string): ParsedRepoInfo | null {
    // Support various Bitbucket URL formats:
    // https://bitbucket.org/owner/repo
    // https://bitbucket.org/owner/repo.git
    // https://bitbucket.org/owner/repo/src/branch/main
    // git@bitbucket.org:owner/repo.git

    // HTTPS URL with optional branch
    const httpsMatch = url.match(
      /^https?:\/\/bitbucket\.org\/([^/]+)\/([^/\s]+?)(?:\.git)?(?:\/src\/([^/\s]+))?\/?$/i,
    );
    if (httpsMatch && httpsMatch[1] && httpsMatch[2]) {
      return {
        owner: httpsMatch[1],
        repo: httpsMatch[2].replace(/\.git$/i, ""),
        url: `https://bitbucket.org/${httpsMatch[1]}/${httpsMatch[2].replace(/\.git$/i, "")}`,
        branch: httpsMatch[3],
      };
    }

    // SSH URL
    const sshMatch = url.match(/^git@bitbucket\.org:([^/]+)\/([^/\s]+?)(?:\.git)?$/i);
    if (sshMatch && sshMatch[1] && sshMatch[2]) {
      return {
        owner: sshMatch[1],
        repo: sshMatch[2].replace(/\.git$/i, ""),
        url: `https://bitbucket.org/${sshMatch[1]}/${sshMatch[2].replace(/\.git$/i, "")}`,
      };
    }

    return null;
  }

  isValidUrl(url: string): boolean {
    return this.parseUrl(url) !== null;
  }

  private buildApiUrl(path: string): string {
    return `${BITBUCKET_API_BASE}${path}`;
  }

  private buildHeaders(auth?: ProviderAuthConfig): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "Stratum-Git-Sync/1.0",
    };

    if (auth?.token) {
      headers.Authorization = `Bearer ${auth.token}`;
    } else if (auth?.username && auth?.password) {
      // Basic auth for app passwords
      const encoded = btoa(`${auth.username}:${auth.password}`);
      headers.Authorization = `Basic ${encoded}`;
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
      // Bitbucket uses workspace/repo-slug format
      const url = this.buildApiUrl(`/repositories/${owner}/${repo}/commits/${branch}?limit=1`);
      logger.debug("Fetching latest commit from Bitbucket", { owner, repo, branch });

      const response = await fetch(url, {
        method: "GET",
        headers: this.buildHeaders(auth),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error("Bitbucket API error", undefined, {
          status: response.status,
          error: errorText,
          owner,
          repo,
        });
        return {
          success: false,
          error: `Bitbucket API error: ${response.status} - ${errorText}`,
          statusCode: response.status,
        };
      }

      const data = (await response.json()) as {
        values: Array<{
          hash: string;
          message: string;
          author: {
            user?: {
              display_name: string;
            };
            raw?: string;
          };
          date: string;
          links: {
            html: {
              href: string;
            };
          };
        }>;
      };

      if (!data.values || data.values.length === 0 || !data.values[0]) {
        return {
          success: false,
          error: "No commits found",
        };
      }

      const commit = data.values[0];
      const authorName = commit.author.user?.display_name || commit.author.raw || "Unknown";

      return {
        success: true,
        data: {
          sha: commit.hash,
          message: commit.message,
          author: authorName,
          timestamp: commit.date,
          url: commit.links.html.href,
        },
      };
    } catch (error) {
      logger.error(
        "Failed to get latest commit from Bitbucket",
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
        const url = this.buildApiUrl(
          `/repositories/${owner}/${repo}/commits/${branch}?exclude=${currentCommit}`,
        );
        const countResponse = await fetch(url, {
          method: "GET",
          headers: this.buildHeaders(auth),
        });

        if (countResponse.ok) {
          const countData = (await countResponse.json()) as { values: unknown[] };
          return {
            hasUpdates: true,
            currentCommit,
            latestCommit,
            commitsBehind: countData.values.length,
          };
        }
      } catch (error) {
        logger.debug("Failed to count commits, using basic check", {
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
      const url = this.buildApiUrl(`/repositories/${owner}/${repo}`);
      logger.debug("Fetching repo metadata from Bitbucket", { owner, repo });

      const response = await fetch(url, {
        method: "GET",
        headers: this.buildHeaders(auth),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `Bitbucket API error: ${response.status} - ${errorText}`,
          statusCode: response.status,
        };
      }

      const data = (await response.json()) as {
        name: string;
        full_name: string;
        description: string | null;
        is_private: boolean;
        mainbranch?: {
          name: string;
        };
        links: {
          clone: Array<{
            name: string;
            href: string;
          }>;
          html: {
            href: string;
          };
        };
        forks_count?: number;
        updated_on: string;
      };

      const httpsClone = data.links.clone.find((c) => c.name === "https");
      const sshClone = data.links.clone.find((c) => c.name === "ssh");

      return {
        success: true,
        data: {
          name: data.name,
          fullName: data.full_name,
          description: data.description || undefined,
          isPrivate: data.is_private,
          defaultBranch: data.mainbranch?.name || "main",
          cloneUrl: httpsClone?.href || `https://bitbucket.org/${owner}/${repo}.git`,
          sshUrl: sshClone?.href,
          webUrl: data.links.html.href,
          stars: undefined, // Bitbucket doesn't have stars
          forks: data.forks_count,
          updatedAt: data.updated_on,
          size: undefined, // Not directly available in Bitbucket API
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
    if (auth?.username && auth?.password) {
      // For app passwords: https://username:apppassword@bitbucket.org/owner/repo.git
      return `https://${auth.username}:${auth.password}@bitbucket.org/${owner}/${repo}.git`;
    }
    return `https://bitbucket.org/${owner}/${repo}.git`;
  }

  getCommitUrl(owner: string, repo: string, sha: string): string {
    return `https://bitbucket.org/${owner}/${repo}/commits/${sha}`;
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
export const bitbucketProvider = new BitbucketProvider();
