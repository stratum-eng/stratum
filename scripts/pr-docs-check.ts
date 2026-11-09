/**
 * Runs the "Docs & Changelog" PR check. See scripts/pr-docs.ts for the rules.
 *
 *   node --experimental-strip-types scripts/pr-docs-check.ts <files.json>
 *
 * files.json is the GitHub "list pull request files" response (all pages, flattened).
 * The PR body comes from the PR_BODY environment variable.
 */

import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
import {
  CHANGELOG_OPT_OUT,
  type ChangedFile,
  DOCS_OPT_OUT,
  type Requirement,
  checkPullRequest,
} from "./pr-docs.ts";

const [filesPath] = process.argv.slice(2);
if (!filesPath) {
  console.error("usage: pr-docs-check.ts <files.json>");
  process.exit(2);
}

const files = (JSON.parse(readFileSync(filesPath, "utf8")) as ChangedFile[]).map(
  ({ path, status }) => ({ path, status }),
);
const result = checkPullRequest(files, process.env.PR_BODY ?? "");

function describe(name: string, requirement: Requirement, fix: string): string {
  if (!requirement.needed) return `- **${name}:** not needed by these changes.`;
  if (requirement.satisfied) {
    const how = requirement.by === "changed" ? "updated in this PR" : `skipped: ${requirement.by}`;
    return `- **${name}:** ${how}.`;
  }
  return `- **${name}: missing.** Needed because of ${requirement.because.map((p) => `\`${p}\``).join(", ")}. ${fix}`;
}

const lines = [
  "## Docs & Changelog",
  "",
  describe(
    "Public docs",
    result.docs,
    `Update the page under \`docs/user-guide/\` or \`docs/api/\` (then \`cd website && npm run sync:guides\`), or add a line \`${DOCS_OPT_OUT}: <why>\` to the PR description.`,
  ),
  describe(
    "Changelog",
    result.changelog,
    `Add a fragment under \`changelog.d/\` (see changelog.d/README.md), or add a line \`${CHANGELOG_OPT_OUT}: <why>\` to the PR description.`,
  ),
];
const summary = lines.join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

if (!result.ok) {
  console.log("::error::Docs or changelog missing. The summary above says what is needed.");
  process.exit(1);
}
