/**
 * Release plumbing for the repository itself.
 *
 * Run with: node --experimental-strip-types scripts/release.ts <command>
 *
 *   check                  Validate CHANGELOG.md, changelog.d/, and that package.json,
 *                          package-lock.json and src/version.ts agree
 *   latest                 Print the most recently released version (no `v` prefix)
 *   previous [version]     Print the release listed below `version` (default: latest);
 *                          prints nothing when there is none
 *   notes [version]        Print one release's changelog entries (default: latest)
 *   commit [version]       Print the commit on this branch that introduced a release's
 *                          version (default: latest): the commit its tag belongs on
 *   prepare [options]      Fold changelog.d/ into Unreleased, cut it, bump package.json,
 *                          package-lock.json and src/version.ts
 *   pr [options]           Run `prepare` on a fresh branch off origin/main and open the
 *                          release PR. Merging that PR publishes the release.
 *
 * `prepare` and `pr` options:
 *   --bump auto|major|minor|patch   Default: auto (derived from the `Unreleased` groups)
 *   --date YYYY-MM-DD               Default: today, UTC
 *   --dry-run                       Print the resulting version, write nothing
 *
 * `pr` also takes:
 *   --co-author "Name <email>"      Add a Co-Authored-By trailer to the release commit
 *
 * The npm wrappers are `npm run release:pr`, `release:check`, `release:notes`, and so on.
 * See docs/developer/releasing.md for the whole flow.
 */

import { execFileSync } from "node:child_process";
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
  lockfileVersionProblems,
  mergeChangelogBodies,
  nextVersion,
  parseChangelog,
  previousRelease,
  releaseNotes,
  resolveBump,
  serverVersionProblems,
  setLockfileVersion,
  setPackageVersion,
  setServerVersion,
  validateChangelog,
  validateFragments,
  withUnreleasedBody,
} from "./changelog.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG_PATH = resolve(REPO_ROOT, "CHANGELOG.md");
const PACKAGE_PATH = resolve(REPO_ROOT, "package.json");
const LOCKFILE_PATH = resolve(REPO_ROOT, "package-lock.json");
const CHANGELOGD_PATH = resolve(REPO_ROOT, "changelog.d");
const SERVER_VERSION_PATH = resolve(REPO_ROOT, "src/version.ts");

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

/** The root lockfile's raw text; exits if it cannot be read. */
function readLockfile(): string {
  try {
    return readFileSync(LOCKFILE_PATH, "utf8");
  } catch (error) {
    fail(`Could not read package-lock.json: ${error instanceof Error ? error.message : error}`);
  }
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

/**
 * `check`: report every structural problem in CHANGELOG.md and changelog.d/,
 * plus package.json drift from the changelog and package-lock.json drift from
 * package.json.
 */
function commandCheck(): void {
  const changelog = readChangelog();
  const problems = [...validateChangelog(changelog), ...validateFragments(readFragments())];

  const latest = latestRelease(changelog);
  const pkg = readPackage();
  if (latest && latest !== pkg.version) {
    problems.push(`package.json is ${pkg.version} but the newest CHANGELOG release is ${latest}`);
  }
  problems.push(...lockfileVersionProblems(readLockfile(), pkg.version));
  problems.push(...serverVersionProblems(readFileSync(SERVER_VERSION_PATH, "utf8"), pkg.version));

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  • ${problem}`);
    fail(`Found ${problems.length} problem(s)`);
  }
  console.log(
    `✓ CHANGELOG.md and changelog.d/ are well-formed; latest release is ${latest ?? "(none)"}`,
  );
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

/** Run a command in the repository root and return its trimmed stdout; exits if it fails. */
function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    fail(`${command} ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

/**
 * The oldest first-parent commit whose root manifest line carries `version`,
 * which is the release commit. A release must be tagged here and not at the
 * branch tip: anything merged after the release commit is not in its notes.
 */
function releaseCommit(version: string): string | undefined {
  const escaped = version.replaceAll(".", "\\.");
  const log = run("git", [
    "log",
    "--first-parent",
    "--reverse",
    "--format=%H",
    `-G^[[:space:]]*"version": "${escaped}"`,
    "--",
    "package.json",
  ]);
  return log.split("\n")[0] || undefined;
}

/** `commit`: print the commit a release's tag belongs on. */
function commandCommit(args: string[]): void {
  const version = args[0]?.replace(/^v/, "") ?? latestRelease(readChangelog());
  if (!version) fail("CHANGELOG.md has no released version yet");
  const commit = releaseCommit(version);
  if (!commit) fail(`No commit on this branch sets package.json to ${version}`);
  console.log(commit);
}

/** What `prepare` decided, for a caller that goes on to publish it. */
interface Prepared {
  from: string;
  to: string;
  bump: string;
  dryRun: boolean;
}

/**
 * `prepare`: fold changelog.d/ fragments into `Unreleased`, cut it into a
 * dated section, relink it, bump package.json, package-lock.json and
 * src/version.ts, and delete the fragments that were folded in.
 */
function commandPrepare(args: string[]): Prepared {
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
  const mergedBody = mergeChangelogBodies([
    unreleased?.body ?? "",
    ...fragments.map((f) => f.body),
  ]);
  const merged = withUnreleasedBody(changelog, mergedBody);
  if (!merged.success) fail(merged.error);

  const resolved = resolveBump(pkg.version, bump, mergedBody);
  if (!resolved.success) fail(resolved.error);

  const next = nextVersion(pkg.version, resolved.data);
  if (!next.success) fail(next.error);

  const cut = cutRelease(merged.data, { version: next.data, date, repoUrl: pkg.repoUrl });
  if (!cut.success) fail(cut.error);

  // Resolve every file before writing any: a manifest failure after the
  // changelog was already rewritten would leave the release half-cut.
  const bumped = setPackageVersion(pkg.raw, next.data);
  if (!bumped.success) fail(`package.json: ${bumped.error}`);
  const bumpedLock = setLockfileVersion(readLockfile(), next.data);
  if (!bumpedLock.success) fail(bumpedLock.error);
  const bumpedServer = setServerVersion(readFileSync(SERVER_VERSION_PATH, "utf8"), next.data);
  if (!bumpedServer.success) fail(bumpedServer.error);

  const prepared = { from: pkg.version, to: next.data, bump: resolved.data, dryRun };
  if (dryRun) {
    console.log(`${pkg.version} → ${next.data} (${resolved.data}, dry run — nothing written)`);
    return prepared;
  }

  writeFileSync(CHANGELOG_PATH, cut.data);
  writeFileSync(PACKAGE_PATH, bumped.data);
  writeFileSync(LOCKFILE_PATH, bumpedLock.data);
  writeFileSync(SERVER_VERSION_PATH, bumpedServer.data);
  for (const fragment of fragments) unlinkSync(fragment.path);
  console.log(`✓ Prepared v${next.data} (${resolved.data} from ${pkg.version}), dated ${date}`);
  if (fragments.length > 0) {
    console.log(`  Folded in and removed ${fragments.length} changelog.d/ fragment(s).`);
  }
  console.log("  Review the diff (CHANGELOG.md, package.json, package-lock.json, src/version.ts,");
  console.log("  removed fragments), then open a PR. Merging it publishes the release.");
  return prepared;
}

/**
 * `pr`: cut a release from the current origin/main and open its PR. Refuses to
 * cut over a predecessor that never published, which is how v0.2.0 sat
 * unpublished for two months: each release would otherwise paper over the last.
 */
function commandPr(args: string[]): void {
  const coAuthor = argValue(args, "--co-author");
  if (run("git", ["status", "--porcelain"]) !== "") {
    fail("The working tree has uncommitted changes. Commit or stash them first.");
  }

  const startingPoint =
    run("git", ["branch", "--show-current"]) || run("git", ["rev-parse", "HEAD"]);
  run("git", ["fetch", "origin", "main", "--tags"]);

  // gh lists 30 PRs by default, and an agent-heavy repo easily has more open.
  const openPrs = run("gh", [
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "1000",
    "--json",
    "headRefName",
  ]);
  const openRelease = (JSON.parse(openPrs) as Array<{ headRefName: string }>).find((pr) =>
    pr.headRefName.startsWith("release/"),
  );
  if (openRelease) fail(`A release PR is already open from ${openRelease.headRefName}.`);

  // Every failure past this point exits with the checkout away from where the
  // caller started, so say how to get back rather than leave them to work it out.
  process.once("exit", (code) => {
    if (code !== 0) console.error(`  You were on ${startingPoint}: git switch ${startingPoint}`);
  });
  run("git", ["switch", "--detach", "origin/main"]);

  const published = latestRelease(readChangelog());
  if (published && !run("git", ["tag", "--list", `v${published}`])) {
    fail(`v${published} has no tag, so it never published. Run the Release workflow for it first.`);
  }
  // The tag is created before the release, so a tag alone can mean the publish step failed.
  if (published) {
    const releases = JSON.parse(
      run("gh", ["release", "list", "--limit", "1000", "--json", "tagName,isDraft"]),
    ) as Array<{ tagName: string; isDraft: boolean }>;
    if (!releases.some((release) => release.tagName === `v${published}` && !release.isDraft)) {
      fail(
        `v${published} is tagged but has no published GitHub release. Run the Release workflow for it first.`,
      );
    }
  }

  const prepared = commandPrepare(args);
  if (prepared.dryRun) {
    run("git", ["checkout", startingPoint]);
    return;
  }

  const tag = `v${prepared.to}`;
  const branch = `release/${tag}`;
  run("git", ["switch", "-c", branch]);
  run("git", [
    "add",
    "-A",
    "CHANGELOG.md",
    "package.json",
    "package-lock.json",
    "src/version.ts",
    "changelog.d",
  ]);
  const trailer = coAuthor ? ["-m", `Co-Authored-By: ${coAuthor}`] : [];
  run("git", ["commit", "-m", `chore(release): ${tag}`, ...trailer]);
  run("git", ["push", "--set-upstream", "origin", branch]);
  const url = run("gh", [
    "pr",
    "create",
    "--base",
    "main",
    "--head",
    branch,
    "--title",
    `chore(release): ${tag}`,
    "--body",
    [
      `Cuts **${tag}** (${prepared.bump} bump from ${prepared.from}) with \`npm run release:pr\`.`,
      "",
      "Merging this PR tags that merge and publishes the GitHub release, with no further step.",
      "The `CHANGELOG.md` section in this diff ships verbatim as the release notes, so this is",
      "the last chance to reword it. See `docs/developer/releasing.md`.",
    ].join("\n"),
  ]);
  console.log(`✓ Opened ${url}`);
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
    case "commit":
      commandCommit(args);
      break;
    case "pr":
      commandPr(args);
      break;
    default:
      fail(
        `Unknown command: ${command ?? "(none)"}. Expected check, latest, previous, notes, commit, prepare, or pr.`,
      );
  }
}

main(process.argv.slice(2));
