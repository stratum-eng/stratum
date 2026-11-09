/**
 * The rules behind the "Docs & Changelog" PR check: which changes need public docs,
 * which need a changelog fragment, and how a PR says it needs neither.
 *
 * Pure (no I/O) so tests/pr-docs.test.ts can exercise it directly. The runner is
 * scripts/pr-docs-check.ts; the workflow is .github/workflows/pr-docs.yml.
 */

/** Changes that alter what an API client, MCP agent, CLI user or policy author sees. */
const DOCS_TRIGGERS: readonly RegExp[] = [
  /^src\/routes\/[^/]+\.ts$/, // API handlers (.tsx files there are server-rendered pages)
  /^src\/mcp\//,
  /^src\/evaluation\//,
  /^cli\/src\//,
];

/** Changes a user can notice, so they belong in the release notes. */
const CHANGELOG_TRIGGERS: readonly RegExp[] = [
  /^src\//,
  /^cli\/src\//,
  /^agent\/src\//,
  /^migrations\//,
];

/** Never user-facing on their own, even inside a trigger directory. */
const NEVER_TRIGGERS: readonly RegExp[] = [
  /\.test\.tsx?$/,
  /^src\/version\.ts$/, // bumped by release PRs, which fold fragments away
];

const DOCS_SATISFIERS: readonly RegExp[] = [/^docs\/user-guide\//, /^docs\/api\//];

const FRAGMENT = /^changelog\.d\/(?!README\.md$)[^/]+\.md$/;

/** A reason must say something, not just tick a box. */
const MIN_REASON_LENGTH = 10;

export interface ChangedFile {
  path: string;
  /** GitHub's file status: added, modified, removed, renamed, ... */
  status: string;
}

export interface Requirement {
  needed: boolean;
  /** Changed files that made it needed (at most a few, for the message). */
  because: string[];
  satisfied: boolean;
  /** How it was satisfied: "changed", or the opt-out reason given in the PR body. */
  by: string | null;
}

export interface DocsCheck {
  docs: Requirement;
  changelog: Requirement;
  ok: boolean;
}

const matchesAny = (path: string, patterns: readonly RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(path));

const triggered = (files: ChangedFile[], patterns: readonly RegExp[]): string[] =>
  files
    .map((file) => file.path)
    .filter((path) => matchesAny(path, patterns) && !matchesAny(path, NEVER_TRIGGERS));

/**
 * Finds `<label>: <reason>` on its own line in a PR body, optionally as a list item.
 * Returns the reason, or null when it is absent or too short to mean anything.
 */
export function optOutReason(body: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = new RegExp(`^[\\t ]*(?:[-*][\\t ]+)?${escaped}:[\\t ]*(.*)$`, "im");
  const reason = body.match(line)?.[1]?.trim() ?? "";
  return reason.length >= MIN_REASON_LENGTH ? reason : null;
}

export const DOCS_OPT_OUT = "No docs needed";
export const CHANGELOG_OPT_OUT = "No changelog";

export function checkPullRequest(files: ChangedFile[], body: string): DocsCheck {
  const docsBecause = triggered(files, DOCS_TRIGGERS);
  const docsChanged = files.some((file) => matchesAny(file.path, DOCS_SATISFIERS));
  const docsReason = optOutReason(body, DOCS_OPT_OUT);

  const changelogBecause = triggered(files, CHANGELOG_TRIGGERS);
  const fragmentAdded = files.some((file) => file.status !== "removed" && FRAGMENT.test(file.path));
  const changelogReason = optOutReason(body, CHANGELOG_OPT_OUT);

  const docs: Requirement = {
    needed: docsBecause.length > 0,
    because: docsBecause.slice(0, 5),
    satisfied: docsBecause.length === 0 || docsChanged || docsReason !== null,
    by: docsChanged ? "changed" : docsReason,
  };
  const changelog: Requirement = {
    needed: changelogBecause.length > 0,
    because: changelogBecause.slice(0, 5),
    satisfied: changelogBecause.length === 0 || fragmentAdded || changelogReason !== null,
    by: fragmentAdded ? "changed" : changelogReason,
  };
  return { docs, changelog, ok: docs.satisfied && changelog.satisfied };
}
