/**
 * Release plumbing for the repository itself.
 *
 * Run with: node --experimental-strip-types scripts/release.ts <command>
 *
 *   check                  Validate CHANGELOG.md, changelog.d/, and that package.json agrees
 *   latest                 Print the most recently released version (no `v` prefix)
 *   previous [version]     Print the release listed below `version` (default: latest);
 *                          prints nothing when there is none
 *   notes [version]        Print one release's changelog entries (default: latest)
 *   prepare [options]      Fold changelog.d/ into Unreleased, cut it, bump package.json
 *
 * `prepare` options:
 *   --bump auto|major|minor|patch   Default: auto (derived from the `Unreleased` groups)
 *   --date YYYY-MM-DD               Default: today, UTC
 *   --dry-run                       Print the resulting version, write nothing
 *
 * The npm wrappers are `npm run release:check`, `release:notes`, `release:prepare`.
 * See docs/developer/releasing.md for the whole flow.
 */

import { readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  type BumpRequest,
  type ChangelogFragment,
  UNRELEASED,
  cutRelease,
  isSemver,
  latestRelease,
  mergeChangelogBodies,
  nextVersion,
  parseChangelog,
  previousRelease,
  releaseNotes,
  resolveBump,
  setPackageVersion,
  validateChangelog,
  validateFragments,
  withUnreleasedBody,
} from "./changelog.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG_PATH = resolve(REPO_ROOT, "CHANGELOG.md");
const PACKAGE_PATH = resolve(REPO_ROOT, "package.json");
const CHANGELOGD_PATH = resolve(REPO_ROOT, "changelog.d");

const BUMPS: BumpRequest[] = ["auto", "major", "minor", "patch"];

/** Report a fatal problem and exit non-zero, so CI stops on a bad changelog. */
function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** Read CHANGELOG.md from the repository root, wherever the script is invoked from. */
function readChangelog(): string {
  return readFileSync(CHANGELOG_PATH, "utf8");
}

/** The root manifest's raw text, its version, and its repository URL without the `.git` suffix. */
function readPackage(): { raw: string; version: string; repoUrl: string } {
  const raw = readFileSync(PACKAGE_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const url = parsed.repository?.url;
  if (typeof parsed.version !== "string") fail("package.json has no version");
  if (typeof url !== "string") fail("package.json has no repository.url");
  return { raw, version: parsed.version, repoUrl: url.replace(/\.git$/, "").replace(/\/$/, "") };
}

/** The value following `flag`, or undefined when it is absent; exits if the value is missing. */
function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`${flag} needs a value`);
  return value;
}

/**
 * Every `changelog.d/*.md` fragment except its README, sorted by filename for
 * a deterministic merge order. An absent directory means no fragments yet,
 * not an error — nothing has required one until the first PR adds one.
 */
function readFragments(): Array<ChangelogFragment & { path: string }> {
  let names: string[];
  try {
    names = readdirSync(CHANGELOGD_PATH);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort()
    .map((name) => {
      const path = resolve(CHANGELOGD_PATH, name);
      return { name, path, body: readFileSync(path, "utf8") };
    });
}

/** `check`: report every structural problem in CHANGELOG.md and changelog.d/, plus package.json drift. */
function commandCheck(): void {
  const changelog = readChangelog();
  const problems = [...validateChangelog(changelog), ...validateFragments(readFragments())];

  const latest = latestRelease(changelog);
  const pkg = readPackage();
  if (latest && latest !== pkg.version) {
    problems.push(`package.json is ${pkg.version} but the newest CHANGELOG release is ${latest}`);
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  • ${problem}`);
    fail(`Found ${problems.length} problem(s)`);
  }
  console.log(`✓ CHANGELOG.md and changelog.d/ are well-formed; latest release is ${latest ?? "(none)"}`);
}

/** `latest`: print the newest released version. */
function commandLatest(): void {
  const latest = latestRelease(readChangelog());
  if (!latest) fail("CHANGELOG.md has no released version yet");
  console.log(latest);
}

/** `previous`: print the predecessor whose tag a version's compare link depends on. */
function commandPrevious(args: string[]): void {
  const changelog = readChangelog();
  const requested = args[0]?.replace(/^v/, "") ?? latestRelease(changelog);
  if (!requested) fail("CHANGELOG.md has no released version yet");

  // Empty output is a valid answer — the oldest release has no predecessor — so
  // callers distinguish "none" from "failed" by the exit code, not the output.
  console.log(previousRelease(changelog, requested) ?? "");
}

/** `notes`: print one release's changelog entries, ready to be a GitHub release body. */
function commandNotes(args: string[]): void {
  const changelog = readChangelog();
  const requested = args[0]?.replace(/^v/, "") ?? latestRelease(changelog);
  if (!requested) fail("CHANGELOG.md has no released version yet");

  const notes = releaseNotes(changelog, requested);
  if (!notes.success) fail(notes.error);
  console.log(notes.data);
}

/**
 * `prepare`: fold changelog.d/ fragments into `Unreleased`, cut it into a
 * dated section, relink it, bump package.json, and delete the fragments that
 * were folded in.
 */
function commandPrepare(args: string[]): void {
  const bump = (argValue(args, "--bump") ?? "auto") as BumpRequest;
  if (!BUMPS.includes(bump)) fail(`--bump must be one of ${BUMPS.join(", ")}`);

  const date = argValue(args, "--date") ?? new Date().toISOString().slice(0, 10);
  const dryRun = args.includes("--dry-run");

  const changelog = readChangelog();
  const pkg = readPackage();
  if (!isSemver(pkg.version)) fail(`package.json version is not semver: ${pkg.version}`);

  const fragments = readFragments();
  const problems = [...validateChangelog(changelog), ...validateFragments(fragments)];
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  • ${problem}`);
    fail("Fix CHANGELOG.md / changelog.d/ before cutting a release (npm run release:check)");
  }

  // The next version is computed from package.json, but the changelog is the
  // record. If they have drifted, cutting from the manifest would write a
  // section out of order with the history above it.
  const latest = latestRelease(changelog);
  if (latest && latest !== pkg.version) {
    fail(
      `package.json is ${pkg.version} but the newest CHANGELOG release is ${latest}. ` +
        "Reconcile them before cutting (npm run release:check).",
    );
  }

  // Fold fragments in BEFORE resolving the bump: an Unreleased body that is
  // otherwise empty, with the only new content living in fragments, must
  // still infer its bump from what those fragments actually add.
  const unreleased = parseChangelog(changelog).sections.find((s) => s.version === UNRELEASED);
  const mergedBody = mergeChangelogBodies([unreleased?.body ?? "", ...fragments.map((f) => f.body)]);
  const merged = withUnreleasedBody(changelog, mergedBody);
  if (!merged.success) fail(merged.error);

  const resolved = resolveBump(pkg.version, bump, mergedBody);
  if (!resolved.success) fail(resolved.error);

  const next = nextVersion(pkg.version, resolved.data);
  if (!next.success) fail(next.error);

  const cut = cutRelease(merged.data, { version: next.data, date, repoUrl: pkg.repoUrl });
  if (!cut.success) fail(cut.error);

  // Resolve both files before writing either: a manifest failure after the
  // changelog was already rewritten would leave the release half-cut.
  const bumped = setPackageVersion(pkg.raw, next.data);
  if (!bumped.success) fail(`package.json: ${bumped.error}`);

  if (dryRun) {
    console.log(`${pkg.version} → ${next.data} (${resolved.data}, dry run — nothing written)`);
    return;
  }

  writeFileSync(CHANGELOG_PATH, cut.data);
  writeFileSync(PACKAGE_PATH, bumped.data);
  for (const fragment of fragments) unlinkSync(fragment.path);
  console.log(`✓ Prepared v${next.data} (${resolved.data} from ${pkg.version}), dated ${date}`);
  if (fragments.length > 0) {
    console.log(`  Folded in and removed ${fragments.length} changelog.d/ fragment(s).`);
  }
  console.log("  Review the diff, open a PR, and merge it; then run the Release workflow.");
}

/** Dispatch the subcommand named by the first argument. */
function main(argv: string[]): void {
  const [command, ...args] = argv;
  switch (command) {
    case "check":
      commandCheck();
      break;
    case "latest":
      commandLatest();
      break;
    case "previous":
      commandPrevious(args);
      break;
    case "notes":
      commandNotes(args);
      break;
    case "prepare":
      commandPrepare(args);
      break;
    default:
      fail(
        `Unknown command: ${command ?? "(none)"}. Expected check, latest, previous, notes, or prepare.`,
      );
  }
}

main(process.argv.slice(2));
