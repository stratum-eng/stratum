/**
 * Git Providers Module - Stub for Option A branch
 * Full implementation in Option B
 */

import type { GitProvider } from "./types";

/**
 * Stub provider for compatibility
 * Full implementation includes GitHub, GitLab, Bitbucket providers
 */
export function getProviderFromUrl(_url: string): GitProvider | null {
	// Stub - returns null to disable provider-specific features on Option A branch
	// Full implementation in Option B provides GitHub, GitLab, Bitbucket support
	return null;
}

export * from "./types";
