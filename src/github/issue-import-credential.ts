/**
 * The one place the GitHub issue importer (#421) gets its GitHub credential.
 *
 * Today that is the instance-wide `env.GITHUB_TOKEN`, the same credential the
 * evaluation reporting in `./sync.ts` and the PR-promotion route use. Credential
 * resolution is due to change (per-owner GitHub App installation tokens), and
 * keeping the lookup behind this single function means that change touches this
 * file and nothing in the importer itself. The project is passed even though the
 * current lookup ignores it, because the per-owner lookup will need it.
 */

import type { Env, ProjectEntry } from "../types";
import { AppError } from "../utils/errors";
import { type Result, err, ok } from "../utils/result";

export async function resolveIssueImportToken(
  env: Pick<Env, "GITHUB_TOKEN">,
  _project: ProjectEntry,
): Promise<Result<string, AppError>> {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    return err(
      new AppError(
        "GitHub integration is not configured on this instance (GITHUB_TOKEN is unset)",
        "GITHUB_NOT_CONFIGURED",
        503,
      ),
    );
  }
  return ok(token);
}
