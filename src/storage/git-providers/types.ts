/**
 * Git Provider Types - Stub for Option A branch
 * Full implementation in Option B
 */

import type { createLogger } from "../../utils/logger";

type Logger = ReturnType<typeof createLogger>;

/**
 * Git provider interface - stub for Option A
 * Full implementation in Option B
 */
export interface GitProvider {
	name: string;
	parseUrl(url: string): { owner: string; repo: string } | null;
	isValidUrl(url: string): boolean;
	checkForUpdates(
		owner: string,
		repo: string,
		branch: string,
		lastCommit: string,
	): Promise<{ success: boolean; data?: { commitsBehind: number; latestCommit: string }; error?: Error }>;
	getLatestCommit(owner: string, repo: string, branch: string): Promise<{ success: boolean; data?: string; error?: Error }>;
	getRepoMetadata(owner: string, repo: string): Promise<{ success: boolean; data?: unknown; error?: Error }>;
	buildCloneUrl(owner: string, repo: string, token?: string): string;
	getCommitUrl(owner: string, repo: string, commitSha: string): string;
	getDefaultBranch(owner: string, repo: string): Promise<{ success: boolean; data?: string; error?: Error }>;
}
