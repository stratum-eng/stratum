import type { readFileFromRepo } from "../../src/storage/git-ops";
import { AppError } from "../../src/utils/errors";

type ReadFile = typeof readFileFromRepo;

/**
 * A `readFileFromRepo` that serves a repository holding exactly `files`.
 *
 * The policy loader reads more than one path off the base branch
 * (`.stratum/policy.yaml`, `stratum.config.json`, `.stratum/ci.yaml`), in an
 * order that is an implementation detail. A mock that answers every path with
 * the same bytes, or answers by call order, hands the policy file's content to
 * the CI parser — so a test of "this policy" would really be testing "this
 * policy, with the same bytes as its CI file". This answers by PATH, and says
 * what the real reader says for a file a successful clone does not contain.
 */
export function repoWithFiles(files: Record<string, string>): ReadFile {
  return async (_remote, _token, path) => {
    const content = files[path];
    if (content !== undefined) return { success: true, data: content };
    return {
      success: false,
      error: new AppError(`Failed to read file: ${path}`, "FS_ERROR", 500),
    };
  };
}
