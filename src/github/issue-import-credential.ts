/**
 * The one place the GitHub issue importer (#421) gets its GitHub credential.
 *
 * It goes through `resolveGitHubToken`, the same rule every other outbound
 * GitHub call uses: the App's installation token when the installation serves
 * the project's owner, else the instance `GITHUB_TOKEN` only under an operator
 * binding for that owner. The importer only reads, so no canonical-project
 * claim is taken — copying issues into Stratum touches nothing on GitHub.
 */

import { projectPrincipal } from "../storage/github-installations";
import type { ProjectEntry } from "../types";
import type { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, ok } from "../utils/result";
import { type GitHubAuthEnv, resolveGitHubToken } from "./app-auth";

/** Why no credential was available: nothing configured, or none may act for this owner. */
export const isIssueImportRefusal = (error: AppError): boolean => error.statusCode === 403;

export async function resolveIssueImportToken(
  env: GitHubAuthEnv,
  project: Pick<ProjectEntry, "ownerType" | "ownerId">,
  repo: { owner: string; repo: string },
  logger: Logger,
): Promise<Result<string, AppError>> {
  const resolved = await resolveGitHubToken(
    env,
    { owner: repo.owner, repo: repo.repo, principal: projectPrincipal(project) },
    logger,
  );
  if (!resolved.success) return resolved;
  return ok(resolved.data.token);
}
