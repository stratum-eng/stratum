/**
 * Keep a Changelog parsing and the version mechanics behind `scripts/release.ts`.
 *
 * Pure string in, string out: no file system, no Node built-ins, no imports.
 * `tests/changelog.test.ts` type-checks under the Workers tsconfig (which has no
 * `@types/node`), and `scripts/release.ts` runs under bare `node`, which needs
 * explicit `.ts` import specifiers that the same tsconfig rejects. Keeping this
 * module dependency-free is what lets both consume it unchanged.
 */

/**
 * Same shape as `src/utils/result.ts`, redeclared for the reason above — this
 * module cannot import from `src/`.
 */
export type Result<T, E = string> = { success: true; data: T } | { success: false; error: E };

export type Bump = "major" | "minor" | "patch";
export type BumpRequest = Bump | "auto";

export const UNRELEASED = "Unreleased";

/** Group headings that force a major bump under `auto`. */
const BREAKING_GROUPS = new Set(["breaking", "removed"]);

/** Group headings that force at least a minor bump under `auto`. */
const FEATURE_GROUPS = new Set(["added"]);

/** The seven Keep a Changelog groups this repo uses, in their canonical spelling. */
const CANONICAL_GROUPS = ["Breaking", "Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];
const CANONICAL_GROUP_BY_LOWER = new Map(CANONICAL_GROUPS.map((group) => [group.toLowerCase(), group]));

const HEADING_RE = /^## \[([^\]]+)\](?:\s+-\s+(\S+))?\s*$/;
const GROUP_RE = /^### (.+?)\s*$/;
const LINK_RE = /^\[([^\]]+)\]:\s*(\S+)\s*$/;
// Canonical SemVer 2.0.0 (semver.org): no leading zeros in the core or in a
// numeric prerelease identifier, so `01.2.3` and `1.2.3-01` are rejected.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NUMERIC_RE = /^\d+$/;

interface ParsedVersion {
  /** Major, minor, patch, kept as canonical decimal strings — see `compareNumeric`. */
  core: [string, string, string];
  /** Dot-separated prerelease identifiers; empty for a final release. */
  prerelease: string[];
}

/** Split a canonical SemVer string into its core numbers and prerelease identifiers. */
function parseVersion(version: string): ParsedVersion | null {
  const match = SEMVER_RE.exec(version);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/**
 * Order two SemVer numeric identifiers without going through `Number`, which
 * silently collapses anything past 2^53 — `9007199254740993` and
 * `9007199254740992` compare equal as floats, which would make
 * `validateChangelog` reject a correctly ordered history. Canonical SemVer
 * forbids leading zeros, so a longer digit run is always the larger number and
 * equal-length runs compare lexically.
 */
function compareNumeric(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * A real UTC calendar date, not just the `YYYY-MM-DD` shape: `2026-02-30` and
 * `2026-00-00` match the pattern but are not dates, and a changelog carrying one
 * would publish a release with impossible metadata.
 */
export function isCalendarDate(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Set the root `version` in a package manifest, editing the text surgically so
 * the rest of the file keeps its formatting — re-serialising would expand the
 * hand-written one-line objects in this repo's manifest and bury the change.
 *
 * The pattern matches the first line-anchored `"version"` at any nesting depth,
 * so the result is verified structurally: a nested hit would otherwise rewrite
 * the wrong field, leave the root version stale, and still look like a success.
 */
export function setPackageVersion(raw: string, version: string): Result<string> {
  const updated = raw.replace(/^(\s*"version"\s*:\s*)"[^"]*"/m, `$1"${version}"`);
  if (updated === raw) {
    return { success: false, error: 'No `"version"` field found in the manifest' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(updated);
  } catch (error) {
    return { success: false, error: `Rewriting the version produced invalid JSON: ${error}` };
  }

  const root = (parsed as { version?: unknown }).version;
  if (root !== version) {
    return {
      success: false,
      error: `Rewrote a nested \`"version"\` rather than the root one — the root is still ${JSON.stringify(root)}`,
    };
  }
  return { success: true, data: updated };
}

export interface ChangelogSection {
  /** `Unreleased`, or a semver string such as `0.1.0`. */
  version: string;
  /** The `YYYY-MM-DD` on the heading. Absent on `Unreleased`. */
  date?: string;
  /** Everything under the heading, with surrounding blank lines trimmed. */
  body: string;
}

export interface ParsedChangelog {
  /** Everything above the first `## [...]` heading, trailing blanks trimmed. */
  preamble: string;
  sections: ChangelogSection[];
  /** `[0.1.0]: https://…` reference definitions, keyed by label, in file order. */
  links: Map<string, string>;
}

/** Trim leading and trailing blank lines without touching interior blank lines. */
function trimBlankLines(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") start++;
  while (end > start && lines[end - 1]?.trim() === "") end--;
  return lines.slice(start, end).join("\n");
}

/**
 * Split a changelog into its preamble, its `## [version]` sections, and its
 * link-reference definitions. Link definitions are pulled out wherever they
 * appear rather than assumed to be a trailing block, so a section body never
 * carries one into the rendered release notes.
 */
export function parseChangelog(text: string): ParsedChangelog {
  const preamble: string[] = [];
  const sections: ChangelogSection[] = [];
  const links = new Map<string, string>();

  let current: { version: string; date?: string; lines: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    const section: ChangelogSection = {
      version: current.version,
      body: trimBlankLines(current.lines),
    };
    if (current.date !== undefined) section.date = current.date;
    sections.push(section);
    current = null;
  };

  for (const line of text.split("\n")) {
    const link = LINK_RE.exec(line);
    if (link?.[1] && link[2]) {
      links.set(link[1], link[2]);
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading?.[1]) {
      flush();
      current = heading[2]
        ? { version: heading[1], date: heading[2], lines: [] }
        : { version: heading[1], lines: [] };
      continue;
    }

    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  flush();

  return { preamble: trimBlankLines(preamble), sections, links };
}

/** The `### Group` headings present in a section body, lowercased. */
export function groupsIn(body: string): string[] {
  const groups: string[] = [];
  for (const line of body.split("\n")) {
    const match = GROUP_RE.exec(line);
    if (match?.[1]) groups.push(match[1].toLowerCase());
  }
  return groups;
}

/**
 * Derive a bump from what the `Unreleased` section actually says: a `Breaking`
 * or `Removed` group is a major, an `Added` group is a minor, anything else
 * (Changed, Fixed, Security, Deprecated) is a patch.
 */
export function inferBump(body: string): Bump {
  const groups = groupsIn(body);
  if (groups.some((group) => BREAKING_GROUPS.has(group))) return "major";
  if (groups.some((group) => FEATURE_GROUPS.has(group))) return "minor";
  return "patch";
}

interface GroupBlock {
  /** Heading text exactly as written, e.g. `added` or `Added`. */
  heading: string;
  /** Lines under the heading, blank-trimmed at the edges. */
  body: string;
}

/**
 * Split a changelog body into its `### Group` blocks and whatever precedes the
 * first heading. Mirrors `parseChangelog`'s split of a whole file into
 * `## [version]` sections, one level down.
 */
function splitGroups(body: string): { preamble: string; groups: GroupBlock[] } {
  const preamble: string[] = [];
  const groups: GroupBlock[] = [];
  let current: { heading: string; lines: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    groups.push({ heading: current.heading, body: trimBlankLines(current.lines) });
    current = null;
  };

  for (const line of body.split("\n")) {
    const heading = GROUP_RE.exec(line);
    if (heading?.[1]) {
      flush();
      current = { heading: heading[1], lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  flush();

  return { preamble: trimBlankLines(preamble), groups };
}

/** One `changelog.d/*.md` fragment, or any other body worth merging. */
export interface ChangelogFragment {
  /** Filename, e.g. `345-fragment-changelog.md` — used only in error messages. */
  name: string;
  body: string;
}

/**
 * Merge one or more Keep a Changelog bodies (an `Unreleased` body, a
 * `changelog.d/*.md` fragment, or any mix) into one coherent body. A group
 * keeps the position it first appears in across `bodies`; its bullets are
 * concatenated in that order, with a blank line between groups but not
 * between two bodies' content under the same group — so the result reads as
 * if everyone had appended to one `Unreleased` section by hand. A recognized
 * heading (case-insensitively, one of the seven Keep a Changelog groups) is
 * rendered in its canonical spelling regardless of how it was written; an
 * unrecognized heading is kept exactly as written, so already-existing
 * `Unreleased` content is never forced to change. Content before a body's
 * first heading is dropped — validate untrusted input with
 * `validateFragments` first so that path is never exercised for a real
 * fragment.
 */
export function mergeChangelogBodies(bodies: string[]): string {
  const order: string[] = [];
  const bulletsByGroup = new Map<string, string[]>();

  for (const body of bodies) {
    for (const group of splitGroups(body).groups) {
      if (group.body === "") continue;
      const canonical = CANONICAL_GROUP_BY_LOWER.get(group.heading.toLowerCase()) ?? group.heading;
      if (!bulletsByGroup.has(canonical)) {
        order.push(canonical);
        bulletsByGroup.set(canonical, []);
      }
      bulletsByGroup.get(canonical)?.push(group.body);
    }
  }

  return order.map((heading) => `### ${heading}\n${bulletsByGroup.get(heading)?.join("\n")}`).join("\n\n");
}

/**
 * Structural problems in `changelog.d/*.md` fragments: no content, content
 * before the first `### Group` heading (including no heading at all), an
 * unrecognized group name, or a group with no bullets. Each problem is
 * prefixed with the fragment's name, so `release:check`/`npm test` can point
 * at exactly which file is malformed.
 */
export function validateFragments(fragments: ChangelogFragment[]): string[] {
  const problems: string[] = [];

  for (const fragment of fragments) {
    if (fragment.body.trim() === "") {
      problems.push(`${fragment.name}: is empty`);
      continue;
    }

    const { preamble, groups } = splitGroups(fragment.body);
    if (preamble !== "") {
      problems.push(`${fragment.name}: has content before its first \`### Group\` heading`);
    }
    if (groups.length === 0) {
      problems.push(`${fragment.name}: has no \`### Group\` heading`);
      continue;
    }

    for (const group of groups) {
      if (!CANONICAL_GROUP_BY_LOWER.has(group.heading.toLowerCase())) {
        problems.push(
          `${fragment.name}: unrecognized group \`${group.heading}\` (expected one of ${CANONICAL_GROUPS.join(", ")})`,
        );
      }
      if (group.body === "") {
        problems.push(`${fragment.name}: \`### ${group.heading}\` has no entries`);
      }
    }
  }

  return problems;
}

/**
 * Apply an explicit bump request, or infer one. While the major version is 0
 * an inferred major is clamped to a minor, per SemVer's "anything MAY change
 * at any time" rule for 0.y.z — an explicit `major` still means 1.0.0.
 */
export function resolveBump(
  current: string,
  request: BumpRequest,
  unreleasedBody: string,
): Result<Bump> {
  const parsed = SEMVER_RE.exec(current);
  if (!parsed) return { success: false, error: `Current version is not semver: ${current}` };
  if (request !== "auto") return { success: true, data: request };

  const inferred = inferBump(unreleasedBody);
  const isZeroMajor = parsed[1] === "0";
  return { success: true, data: isZeroMajor && inferred === "major" ? "minor" : inferred };
}

/** Increment `current` by `bump`, dropping any prerelease or build metadata. */
export function nextVersion(current: string, bump: Bump): Result<string> {
  const parsed = SEMVER_RE.exec(current);
  if (!parsed?.[1] || !parsed[2] || !parsed[3]) {
    return { success: false, error: `Current version is not semver: ${current}` };
  }
  const major = Number(parsed[1]);
  const minor = Number(parsed[2]);
  const patch = Number(parsed[3]);

  if (bump === "major") return { success: true, data: `${major + 1}.0.0` };
  if (bump === "minor") return { success: true, data: `${major}.${minor + 1}.0` };
  return { success: true, data: `${major}.${minor}.${patch + 1}` };
}

/** Whether `version` is canonical SemVer 2.0.0 — the form a release tag must take. */
export function isSemver(version: string): boolean {
  return SEMVER_RE.test(version);
}

/** The most recently released version, or null when nothing has shipped yet. */
export function latestRelease(text: string): string | null {
  const released = parseChangelog(text).sections.find((section) => section.version !== UNRELEASED);
  return released?.version ?? null;
}

/**
 * The body of one release's section, ready to be a GitHub release description.
 * Fails loudly on a missing or empty section rather than publishing a release
 * with no notes.
 */
export function releaseNotes(text: string, version: string): Result<string> {
  const section = parseChangelog(text).sections.find((entry) => entry.version === version);
  if (!section) return { success: false, error: `No \`## [${version}]\` section in CHANGELOG.md` };
  if (section.body.trim() === "")
    return { success: false, error: `The \`## [${version}]\` section is empty` };
  return { success: true, data: section.body };
}

/** Serialise a parsed changelog back to Keep a Changelog markdown, links last. */
function renderChangelog(parsed: ParsedChangelog): string {
  const parts = [parsed.preamble, ""];
  for (const section of parsed.sections) {
    parts.push(
      section.date ? `## [${section.version}] - ${section.date}` : `## [${section.version}]`,
    );
    if (section.body !== "") parts.push("", section.body);
    parts.push("");
  }
  for (const [label, url] of parsed.links) parts.push(`[${label}]: ${url}`);
  return `${parts.join("\n")}\n`;
}

/**
 * Replace the `## [Unreleased]` section's body with `body`; preamble, other
 * sections, and links are untouched. The fragment-merge insertion point, kept
 * separate from `cutRelease` so cutting a release never needs to know
 * fragments exist.
 */
export function withUnreleasedBody(text: string, body: string): Result<string> {
  const parsed = parseChangelog(text);
  const index = parsed.sections.findIndex((section) => section.version === UNRELEASED);
  if (index === -1) {
    return { success: false, error: "CHANGELOG.md has no `## [Unreleased]` section" };
  }

  const sections = [...parsed.sections];
  sections[index] = { version: UNRELEASED, body };
  return { success: true, data: renderChangelog({ ...parsed, sections }) };
}

export interface CutOptions {
  /** The version being cut, e.g. `0.2.0`. */
  version: string;
  /** Release date as `YYYY-MM-DD`. */
  date: string;
  /** Repository URL without a trailing slash, e.g. `https://github.com/owner/repo`. */
  repoUrl: string;
}

/**
 * Move everything under `Unreleased` into a dated section for `version`, open a
 * fresh empty `Unreleased`, and rewrite the compare links so `Unreleased` spans
 * from the new tag and the new version spans from its predecessor.
 */
export function cutRelease(text: string, options: CutOptions): Result<string> {
  const { version, date, repoUrl } = options;
  if (!isSemver(version)) return { success: false, error: `Not a semver version: ${version}` };
  if (!isCalendarDate(date)) return { success: false, error: `Not a YYYY-MM-DD date: ${date}` };

  const parsed = parseChangelog(text);
  const unreleased = parsed.sections.find((section) => section.version === UNRELEASED);
  if (!unreleased)
    return { success: false, error: "CHANGELOG.md has no `## [Unreleased]` section" };
  if (unreleased.body.trim() === "") {
    return { success: false, error: "Nothing to release: the `Unreleased` section is empty" };
  }
  if (parsed.sections.some((section) => section.version === version)) {
    return { success: false, error: `CHANGELOG.md already has a \`## [${version}]\` section` };
  }

  const previous = latestRelease(text);
  const rest = parsed.sections.filter((section) => section.version !== UNRELEASED);

  const links = new Map<string, string>();
  links.set(UNRELEASED, `${repoUrl}/compare/v${version}...HEAD`);
  links.set(
    version,
    previous
      ? `${repoUrl}/compare/v${previous}...v${version}`
      : `${repoUrl}/releases/tag/v${version}`,
  );
  for (const [label, url] of parsed.links) {
    if (label !== UNRELEASED && label !== version) links.set(label, url);
  }

  return {
    success: true,
    data: renderChangelog({
      preamble: parsed.preamble,
      sections: [
        { version: UNRELEASED, body: "" },
        { version, date, body: unreleased.body },
        ...rest,
      ],
      links,
    }),
  };
}

/**
 * Structural problems that would break the release automation later: a missing
 * `Unreleased` heading, an `Unreleased` entry sitting outside a `### Group`,
 * an undated or non-semver release, a version with no link definition (the
 * dead-link failure mode this file exists to prevent), or releases listed out
 * of order. Returns an empty array when the file is sound.
 */
export function validateChangelog(text: string): string[] {
  const problems: string[] = [];
  const parsed = parseChangelog(text);
  const seen = new Set<string>();

  if (!parsed.sections.some((section) => section.version === UNRELEASED)) {
    problems.push("Missing an `## [Unreleased]` section");
  }

  const releases: string[] = [];
  for (const section of parsed.sections) {
    if (seen.has(section.version)) problems.push(`Duplicate section: ${section.version}`);
    seen.add(section.version);

    if (section.version === UNRELEASED) {
      if (section.date) problems.push("`Unreleased` must not carry a date");
      // An entry above the first `### Group` heading is silently dropped when
      // fragments are folded in (mergeChangelogBodies keys everything by
      // group), so reject it here rather than lose it at release time.
      if (splitGroups(section.body).preamble !== "") {
        problems.push(
          "`Unreleased` has content before its first `### Group` heading — put every entry under a group",
        );
      }
      continue;
    }

    if (!isSemver(section.version)) problems.push(`Not a semver version: ${section.version}`);
    else releases.push(section.version);

    if (!section.date) problems.push(`\`${section.version}\` has no release date`);
    else if (!isCalendarDate(section.date))
      problems.push(`\`${section.version}\` date is not a real YYYY-MM-DD date`);

    if (section.body.trim() === "") problems.push(`\`${section.version}\` has no entries`);
  }

  for (const version of seen) {
    if (!parsed.links.has(version)) problems.push(`No link definition for \`${version}\``);
  }
  for (const label of parsed.links.keys()) {
    if (!seen.has(label)) problems.push(`Link definition \`${label}\` has no matching section`);
  }

  for (let i = 1; i < releases.length; i++) {
    const newer = releases[i - 1];
    const older = releases[i];
    if (newer && older && compareVersions(newer, older) <= 0) {
      problems.push(`Releases are out of order: \`${newer}\` is listed above \`${older}\``);
    }
  }

  return problems;
}

/**
 * SemVer 2.0.0 precedence (§11), including prerelease ordering: a final release
 * outranks any of its prereleases, numeric identifiers compare numerically and
 * rank below alphanumeric ones, and a shorter identifier set loses to a longer
 * one that shares its prefix. Build metadata is ignored, as the spec requires.
 * Returns 0 for input that is not canonical SemVer.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;

  for (let i = 0; i < 3; i++) {
    const diff = compareNumeric(left.core[i] ?? "0", right.core[i] ?? "0");
    if (diff !== 0) return diff;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** Compare two prerelease identifier sets under SemVer §11.4. */
function comparePrerelease(left: string[], right: string[]): number {
  // A version without a prerelease has higher precedence than one with it.
  if (left.length === 0) return right.length === 0 ? 0 : 1;
  if (right.length === 0) return -1;

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i];
    const b = right[i];
    // The set that runs out first has lower precedence.
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;

    const aNumeric = NUMERIC_RE.test(a);
    const bNumeric = NUMERIC_RE.test(b);
    if (aNumeric && bNumeric) return compareNumeric(a, b);
    // Numeric identifiers always rank below alphanumeric ones.
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * The release listed immediately below `version` — the predecessor its compare
 * link points at, and therefore the tag that must already exist before this
 * version's release is published. Null when `version` is the oldest release or
 * is not listed at all.
 */
export function previousRelease(text: string, version: string): string | null {
  const released = parseChangelog(text)
    .sections.filter((section) => section.version !== UNRELEASED)
    .map((section) => section.version);
  const index = released.indexOf(version);
  if (index === -1) return null;
  return released[index + 1] ?? null;
}
