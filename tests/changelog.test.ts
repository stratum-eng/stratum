/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
// The repository's own changelog, so the release automation is exercised against
// the real file rather than only fixtures. Imported raw (not via node:fs) to keep
// this suite type-checking under the Workers tsconfig.
import REAL_CHANGELOG from "../CHANGELOG.md?raw";
import {
  compareVersions,
  cutRelease,
  groupsIn,
  inferBump,
  isCalendarDate,
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
} from "../scripts/changelog";

// The repository's own changelog.d/ fragments — same reasoning as REAL_CHANGELOG
// above: exercised against the real files, imported raw to keep this file
// type-checking under the Workers tsconfig (no node:fs).
const REAL_FRAGMENT_MODULES = import.meta.glob("../changelog.d/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const REPO = "https://github.com/stratum-eng/stratum";

const FIXTURE = `# Changelog

Preamble text.

## [Unreleased]

### Added
- A new thing.

### Fixed
- An old thing.

## [0.1.0] - 2026-06-11

### Added
- Initial release.

[Unreleased]: ${REPO}/compare/v0.1.0...HEAD
[0.1.0]: ${REPO}/releases/tag/v0.1.0
`;

describe("parseChangelog", () => {
  it("splits preamble, sections, and link definitions", () => {
    const parsed = parseChangelog(FIXTURE);

    expect(parsed.preamble).toBe("# Changelog\n\nPreamble text.");
    expect(parsed.sections.map((section) => section.version)).toEqual(["Unreleased", "0.1.0"]);
    expect(parsed.sections[1]?.date).toBe("2026-06-11");
    expect([...parsed.links.keys()]).toEqual(["Unreleased", "0.1.0"]);
  });

  it("keeps link definitions out of section bodies", () => {
    const parsed = parseChangelog(FIXTURE);
    expect(parsed.sections[1]?.body).toBe("### Added\n- Initial release.");
  });

  it("preserves interior blank lines but trims the edges", () => {
    const parsed = parseChangelog(FIXTURE);
    expect(parsed.sections[0]?.body).toBe(
      "### Added\n- A new thing.\n\n### Fixed\n- An old thing.",
    );
  });

  it("leaves Unreleased undated", () => {
    expect(parseChangelog(FIXTURE).sections[0]?.date).toBeUndefined();
  });
});

describe("groupsIn / inferBump", () => {
  it("lists the group headings in a section", () => {
    expect(groupsIn("### Added\n- x\n\n### Fixed\n- y")).toEqual(["added", "fixed"]);
  });

  it("does not mistake a bullet for a heading", () => {
    expect(groupsIn("- ### Added is not a heading")).toEqual([]);
  });

  it("treats Breaking and Removed as major", () => {
    expect(inferBump("### Breaking\n- x")).toBe("major");
    expect(inferBump("### Removed\n- x")).toBe("major");
  });

  it("treats Added as minor", () => {
    expect(inferBump("### Added\n- x\n\n### Fixed\n- y")).toBe("minor");
  });

  it("treats everything else as patch", () => {
    expect(inferBump("### Fixed\n- x\n\n### Security\n- y")).toBe("patch");
  });
});

describe("resolveBump", () => {
  it("clamps an inferred major to a minor while the major version is 0", () => {
    const resolved = resolveBump("0.1.0", "auto", "### Breaking\n- x");
    expect(resolved).toEqual({ success: true, data: "minor" });
  });

  it("honours an explicit major on a 0.x version", () => {
    expect(resolveBump("0.1.0", "major", "### Fixed\n- x")).toEqual({
      success: true,
      data: "major",
    });
  });

  it("does not clamp once the major version is 1 or above", () => {
    expect(resolveBump("1.4.2", "auto", "### Breaking\n- x")).toEqual({
      success: true,
      data: "major",
    });
  });

  it("rejects a non-semver current version", () => {
    expect(resolveBump("v1", "auto", "").success).toBe(false);
  });
});

describe("nextVersion", () => {
  it.each([
    ["0.1.0", "patch", "0.1.1"],
    ["0.1.9", "minor", "0.2.0"],
    ["0.2.3", "major", "1.0.0"],
    ["1.0.0-beta.1", "patch", "1.0.1"],
  ] as const)("%s + %s = %s", (current, bump, expected) => {
    expect(nextVersion(current, bump)).toEqual({ success: true, data: expected });
  });

  it("rejects a non-semver current version", () => {
    expect(nextVersion("nightly", "patch").success).toBe(false);
  });
});

describe("isSemver", () => {
  it("accepts semver and rejects tag-shaped input", () => {
    expect(isSemver("0.2.0")).toBe(true);
    expect(isSemver("1.0.0-rc.1")).toBe(true);
    expect(isSemver("1.0.0+build.5")).toBe(true);
    expect(isSemver("v0.2.0")).toBe(false);
    expect(isSemver("0.2")).toBe(false);
  });

  it("rejects noncanonical versions with leading zeros", () => {
    expect(isSemver("01.2.3")).toBe(false);
    expect(isSemver("1.02.3")).toBe(false);
    expect(isSemver("1.2.03")).toBe(false);
    expect(isSemver("1.2.3-01")).toBe(false);
  });

  it("still accepts a prerelease identifier that only looks numeric", () => {
    expect(isSemver("1.2.3-0")).toBe(true);
    expect(isSemver("1.2.3-0a")).toBe(true);
    expect(isSemver("1.2.3-rc.0")).toBe(true);
  });
});

describe("isCalendarDate", () => {
  it("accepts real dates, including a leap day", () => {
    expect(isCalendarDate("2026-08-29")).toBe(true);
    expect(isCalendarDate("2024-02-29")).toBe(true);
  });

  it("rejects a date that is only the right shape", () => {
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2026-00-00")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2025-02-29")).toBe(false);
  });

  it("rejects anything that is not YYYY-MM-DD", () => {
    expect(isCalendarDate("29 Aug 2026")).toBe(false);
    expect(isCalendarDate("2026-8-29")).toBe(false);
  });
});

describe("compareVersions / latestRelease", () => {
  it("orders versions numerically, not lexically", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
  });

  it("ranks a final release above its own prereleases", () => {
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
  });

  it("compares numeric prerelease identifiers numerically", () => {
    expect(compareVersions("1.0.0-beta.11", "1.0.0-beta.2")).toBeGreaterThan(0);
  });

  it("ranks numeric identifiers below alphanumeric ones", () => {
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
  });

  it("orders differing prerelease labels lexically", () => {
    expect(compareVersions("1.0.0-beta", "1.0.0-alpha")).toBeGreaterThan(0);
  });

  it("ranks a shorter identifier set below a longer one sharing its prefix", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
  });

  it("walks the SemVer spec's own precedence chain", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 1; i < ordered.length; i++) {
      const [lower, higher] = [ordered[i - 1] as string, ordered[i] as string];
      expect(compareVersions(higher, lower)).toBeGreaterThan(0);
    }
  });

  it("orders numeric identifiers beyond 2^53, where Number would collapse them", () => {
    // Number("9007199254740993") === Number("9007199254740992"), so a float
    // comparison would call these equal and flag a valid history as misordered.
    expect(compareVersions("9007199254740993.0.0", "9007199254740992.0.0")).toBeGreaterThan(0);
    expect(
      compareVersions("1.0.0-beta.9007199254740993", "1.0.0-beta.9007199254740992"),
    ).toBeGreaterThan(0);
    expect(compareVersions("9007199254740992.0.0", "9007199254740992.0.0")).toBe(0);
  });

  it("orders long numeric identifiers by magnitude, not string length alone", () => {
    expect(compareVersions("10.0.0", "9.0.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-alpha.10", "1.0.0-alpha.9")).toBeGreaterThan(0);
    expect(
      compareVersions("123456789012345678901.0.0", "99999999999999999999.0.0"),
    ).toBeGreaterThan(0);
  });

  it("ignores build metadata, as the spec requires", () => {
    expect(compareVersions("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
  });

  it("reports the newest released version, skipping Unreleased", () => {
    expect(latestRelease(FIXTURE)).toBe("0.1.0");
  });

  it("returns null when nothing has shipped", () => {
    expect(latestRelease("# Changelog\n\n## [Unreleased]\n\n### Added\n- x\n")).toBeNull();
  });
});

describe("releaseNotes", () => {
  it("returns just that release's entries", () => {
    expect(releaseNotes(FIXTURE, "0.1.0")).toEqual({
      success: true,
      data: "### Added\n- Initial release.",
    });
  });

  it("fails on a version with no section", () => {
    const result = releaseNotes(FIXTURE, "9.9.9");
    expect(result.success).toBe(false);
  });

  it("fails on an empty section rather than publishing empty notes", () => {
    const empty = "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-06-11\n\n[0.1.0]: x\n";
    expect(releaseNotes(empty, "0.1.0").success).toBe(false);
  });
});

describe("cutRelease", () => {
  const cut = cutRelease(FIXTURE, { version: "0.2.0", date: "2026-08-29", repoUrl: REPO });
  const text = cut.success ? cut.data : "";

  it("succeeds", () => {
    expect(cut.success).toBe(true);
  });

  it("moves the Unreleased entries into the dated section", () => {
    expect(releaseNotes(text, "0.2.0")).toEqual({
      success: true,
      data: "### Added\n- A new thing.\n\n### Fixed\n- An old thing.",
    });
  });

  it("leaves a fresh, empty Unreleased section behind", () => {
    const parsed = parseChangelog(text);
    expect(parsed.sections[0]).toEqual({ version: "Unreleased", body: "" });
  });

  it("points Unreleased at the new tag and the new release at its predecessor", () => {
    const links = parseChangelog(text).links;
    expect(links.get("Unreleased")).toBe(`${REPO}/compare/v0.2.0...HEAD`);
    expect(links.get("0.2.0")).toBe(`${REPO}/compare/v0.1.0...v0.2.0`);
    expect(links.get("0.1.0")).toBe(`${REPO}/releases/tag/v0.1.0`);
  });

  it("keeps older releases intact", () => {
    expect(releaseNotes(text, "0.1.0")).toEqual({
      success: true,
      data: "### Added\n- Initial release.",
    });
    expect(parseChangelog(text).sections[2]?.date).toBe("2026-06-11");
  });

  it("produces a file that still validates", () => {
    expect(validateChangelog(text)).toEqual([]);
  });

  it("links the very first release to its tag page, having nothing to compare against", () => {
    const first = `# Changelog\n\n## [Unreleased]\n\n### Added\n- x\n\n[Unreleased]: ${REPO}/commits/main\n`;
    const result = cutRelease(first, { version: "0.1.0", date: "2026-06-11", repoUrl: REPO });
    expect(result.success && parseChangelog(result.data).links.get("0.1.0")).toBe(
      `${REPO}/releases/tag/v0.1.0`,
    );
  });

  it("refuses to cut an empty Unreleased section", () => {
    const empty = FIXTURE.replace("### Added\n- A new thing.\n\n### Fixed\n- An old thing.\n", "");
    expect(cutRelease(empty, { version: "0.2.0", date: "2026-08-29", repoUrl: REPO }).success).toBe(
      false,
    );
  });

  it("refuses to overwrite a version that already exists", () => {
    expect(
      cutRelease(FIXTURE, { version: "0.1.0", date: "2026-08-29", repoUrl: REPO }).success,
    ).toBe(false);
  });

  it("rejects a malformed version or date", () => {
    expect(
      cutRelease(FIXTURE, { version: "v0.2.0", date: "2026-08-29", repoUrl: REPO }).success,
    ).toBe(false);
    expect(
      cutRelease(FIXTURE, { version: "0.2.0", date: "29 Aug 2026", repoUrl: REPO }).success,
    ).toBe(false);
  });

  it("refuses a second cut until new entries land under Unreleased", () => {
    expect(cutRelease(text, { version: "0.3.0", date: "2026-09-01", repoUrl: REPO }).success).toBe(
      false,
    );
  });

  it("chains compare links across successive releases", () => {
    const refilled = text.replace(
      "## [Unreleased]",
      "## [Unreleased]\n\n### Fixed\n- A later fix.",
    );
    const second = cutRelease(refilled, { version: "0.2.1", date: "2026-09-01", repoUrl: REPO });
    expect(second.success).toBe(true);
    if (!second.success) return;

    const parsed = parseChangelog(second.data);
    expect(parsed.sections.map((section) => section.version)).toEqual([
      "Unreleased",
      "0.2.1",
      "0.2.0",
      "0.1.0",
    ]);
    expect(parsed.links.get("0.2.1")).toBe(`${REPO}/compare/v0.2.0...v0.2.1`);
    expect(parsed.links.get("Unreleased")).toBe(`${REPO}/compare/v0.2.1...HEAD`);
    expect(validateChangelog(second.data)).toEqual([]);
  });
});

describe("validateChangelog", () => {
  it("passes a well-formed file", () => {
    expect(validateChangelog(FIXTURE)).toEqual([]);
  });

  it("flags a missing Unreleased section", () => {
    const text = FIXTURE.replace("## [Unreleased]", "## [0.0.9] - 2026-01-01");
    expect(validateChangelog(text).join("\n")).toContain("Unreleased");
  });

  it("flags a release with no link definition — the dead-link failure mode", () => {
    const text = FIXTURE.replace(`[0.1.0]: ${REPO}/releases/tag/v0.1.0\n`, "");
    expect(validateChangelog(text)).toContain("No link definition for `0.1.0`");
  });

  it("flags a link definition with no matching section", () => {
    const text = FIXTURE.replace("[0.1.0]:", "[0.9.0]:");
    expect(validateChangelog(text)).toContain("Link definition `0.9.0` has no matching section");
  });

  it("flags a date that is only the right shape", () => {
    const text = FIXTURE.replace("2026-06-11", "2026-02-30");
    expect(validateChangelog(text)).toContain("`0.1.0` date is not a real YYYY-MM-DD date");
  });

  it("does not flag a final release listed above its own prerelease", () => {
    const text = FIXTURE.replace(
      "## [0.1.0] - 2026-06-11",
      "## [1.0.0] - 2026-07-01\n\n### Added\n- Final.\n\n## [1.0.0-rc.1] - 2026-06-20\n\n### Added\n- Candidate.\n\n## [0.1.0] - 2026-06-11",
    ).replace(`[0.1.0]: ${REPO}`, `[1.0.0]: ${REPO}/x\n[1.0.0-rc.1]: ${REPO}/y\n[0.1.0]: ${REPO}`);
    expect(validateChangelog(text)).toEqual([]);
  });

  it("flags an undated release", () => {
    const text = FIXTURE.replace("## [0.1.0] - 2026-06-11", "## [0.1.0]");
    expect(validateChangelog(text)).toContain("`0.1.0` has no release date");
  });

  it("does not flag a correctly ordered history of very large versions", () => {
    const text =
      "# Changelog\n\n## [Unreleased]\n\n## [9007199254740993.0.0] - 2026-08-29\n\n### Added\n- x\n\n" +
      "## [9007199254740992.0.0] - 2026-08-28\n\n### Added\n- y\n\n" +
      "[Unreleased]: u\n[9007199254740993.0.0]: a\n[9007199254740992.0.0]: b\n";
    expect(validateChangelog(text)).toEqual([]);
  });

  it("flags releases listed out of order", () => {
    const text = FIXTURE.replace(
      "## [0.1.0] - 2026-06-11",
      "## [0.1.0] - 2026-06-11\n\n### Added\n- x\n\n## [0.2.0] - 2026-07-01",
    ).replace(`[0.1.0]: ${REPO}`, `[0.2.0]: ${REPO}/x\n[0.1.0]: ${REPO}`);
    expect(validateChangelog(text).join("\n")).toContain("out of order");
  });
});

describe("mergeChangelogBodies", () => {
  it("passes a single body through unchanged", () => {
    expect(mergeChangelogBodies(["### Added\n- x"])).toBe("### Added\n- x");
  });

  it("returns empty for empty input", () => {
    expect(mergeChangelogBodies([])).toBe("");
    expect(mergeChangelogBodies(["", "   "])).toBe("");
  });

  it("concatenates bullets under a shared group with no forced blank line", () => {
    expect(mergeChangelogBodies(["### Added\n- x", "### Added\n- y"])).toBe("### Added\n- x\n- y");
  });

  it("keeps first-seen group order across bodies", () => {
    const merged = mergeChangelogBodies(["### Fixed\n- a\n\n### Added\n- b", "### Security\n- c"]);
    expect(merged).toBe("### Fixed\n- a\n\n### Added\n- b\n\n### Security\n- c");
  });

  it("handles multiple groups within one fragment alongside another fragment's groups", () => {
    const merged = mergeChangelogBodies(["### Added\n- a", "### Fixed\n- b\n\n### Added\n- c"]);
    expect(merged).toBe("### Added\n- a\n- c\n\n### Fixed\n- b");
  });

  it("canonicalizes heading casing to the recognized spelling", () => {
    expect(mergeChangelogBodies(["### added\n- x", "### Added\n- y"])).toBe("### Added\n- x\n- y");
  });

  it("preserves interior blank lines and indented continuation lines verbatim", () => {
    const body = "### Added\n- x\n\n  more detail, indented.";
    expect(mergeChangelogBodies([body])).toBe(body);
  });

  it("passes an unrecognized-but-preexisting heading through untouched", () => {
    expect(mergeChangelogBodies(["### Notes\n- x"])).toBe("### Notes\n- x");
  });

  it("drops content before a body's first heading", () => {
    expect(mergeChangelogBodies(["stray prose\n\n### Added\n- x"])).toBe("### Added\n- x");
  });

  it("infers a minor bump from a fragment alone when the direct Unreleased body is empty", () => {
    // Regression: fragments must be merged in BEFORE resolveBump runs, or a PR
    // whose only changelog content is a fragment silently bumps as a patch.
    const merged = mergeChangelogBodies(["", "### Added\n- new feature"]);
    expect(inferBump(merged)).toBe("minor");
  });
});

describe("validateFragments", () => {
  it("passes a well-formed single-group fragment", () => {
    expect(validateFragments([{ name: "a.md", body: "### Added\n- x" }])).toEqual([]);
  });

  it("passes a well-formed multi-group fragment", () => {
    const body = "### Added\n- x\n\n### Fixed\n- y";
    expect(validateFragments([{ name: "a.md", body }])).toEqual([]);
  });

  it("accepts case-insensitive canonical headings", () => {
    expect(validateFragments([{ name: "a.md", body: "### added\n- x" }])).toEqual([]);
  });

  it("flags an empty fragment", () => {
    expect(validateFragments([{ name: "a.md", body: "   " }])).toEqual(["a.md: is empty"]);
  });

  it("flags a fragment with no heading at all", () => {
    expect(validateFragments([{ name: "a.md", body: "just prose" }])).toContain(
      "a.md: has no `### Group` heading",
    );
  });

  it("flags content before the first heading", () => {
    const problems = validateFragments([{ name: "a.md", body: "stray\n\n### Added\n- x" }]);
    expect(problems).toContain("a.md: has content before its first `### Group` heading");
  });

  it("flags an unrecognized group name", () => {
    const problems = validateFragments([{ name: "a.md", body: "### Notes\n- x" }]);
    expect(problems.join("\n")).toContain("a.md: unrecognized group `Notes`");
  });

  it("flags a group with no bullets", () => {
    expect(validateFragments([{ name: "a.md", body: "### Added" }])).toContain(
      "a.md: `### Added` has no entries",
    );
  });

  it("attributes each fragment's problems to its own name", () => {
    const problems = validateFragments([
      { name: "a.md", body: "" },
      { name: "b.md", body: "### Notes\n- x" },
    ]);
    expect(problems).toContain("a.md: is empty");
    expect(problems.join("\n")).toContain("b.md: unrecognized group `Notes`");
  });
});

describe("withUnreleasedBody", () => {
  it("replaces only Unreleased's body", () => {
    const result = withUnreleasedBody(FIXTURE, "### Added\n- replaced");
    expect(result.success && parseChangelog(result.data).sections[0]?.body).toBe(
      "### Added\n- replaced",
    );
  });

  it("leaves other sections, links, and the preamble untouched", () => {
    const result = withUnreleasedBody(FIXTURE, "### Added\n- replaced");
    expect(result.success && parseChangelog(result.data).sections[1]?.body).toBe(
      "### Added\n- Initial release.",
    );
    expect(result.success && [...parseChangelog(result.data).links.keys()]).toEqual([
      "Unreleased",
      "0.1.0",
    ]);
  });

  it("round-trips through parseChangelog", () => {
    const result = withUnreleasedBody(FIXTURE, "### Fixed\n- x");
    expect(result.success && parseChangelog(result.data).sections[0]?.version).toBe("Unreleased");
  });

  it("errors when there is no Unreleased section", () => {
    const text = FIXTURE.replace("## [Unreleased]", "## [0.0.9] - 2026-01-01");
    expect(withUnreleasedBody(text, "### Added\n- x").success).toBe(false);
  });

  it("still passes validateChangelog with zero new problems", () => {
    const result = withUnreleasedBody(FIXTURE, "### Fixed\n- x");
    expect(result.success && validateChangelog(result.data)).toEqual([]);
  });
});

describe("fragment merge is transparent to the existing cut/bump machinery", () => {
  it("merges a fragment onto Unreleased exactly as if it had been pasted in by hand", () => {
    const merged = mergeChangelogBodies([
      "### Added\n- A new thing.\n\n### Fixed\n- An old thing.",
      "### Security\n- from a fragment",
    ]);
    expect(merged).toBe(
      "### Added\n- A new thing.\n\n### Fixed\n- An old thing.\n\n### Security\n- from a fragment",
    );
  });

  it("carries that merged body all the way through withUnreleasedBody and cutRelease", () => {
    const merged = mergeChangelogBodies([
      "### Added\n- A new thing.\n\n### Fixed\n- An old thing.",
      "### Security\n- from a fragment",
    ]);
    const spliced = withUnreleasedBody(FIXTURE, merged);
    if (!spliced.success) throw new Error("splice failed");

    const cut = cutRelease(spliced.data, { version: "0.2.0", date: "2026-08-29", repoUrl: REPO });
    if (!cut.success) throw new Error("cut failed");

    // cutRelease moves the merged Unreleased body into the new dated section
    // (index 1 — index 0 is the fresh empty Unreleased it opens).
    expect(parseChangelog(cut.data).sections[1]?.body).toBe(merged);
  });
});

describe("setPackageVersion", () => {
  const MANIFEST = [
    "{",
    '  "name": "stratum",',
    '  "version": "0.2.0",',
    '  "repository": { "type": "git", "url": "https://github.com/stratum-eng/stratum.git" }',
    "}",
    "",
  ].join("\n");

  it("updates the root version and leaves the rest of the file byte-identical", () => {
    const result = setPackageVersion(MANIFEST, "0.3.0");
    expect(result).toEqual({ success: true, data: MANIFEST.replace('"0.2.0"', '"0.3.0"') });
  });

  it("does not reformat hand-written one-line objects", () => {
    const result = setPackageVersion(MANIFEST, "0.3.0");
    expect(result.success && result.data).toContain(
      '"repository": { "type": "git", "url": "https://github.com/stratum-eng/stratum.git" }',
    );
  });

  // The pattern is line-anchored but depth-blind, so a nested `"version"` on its
  // own line above the root one is the case that would silently rewrite the
  // wrong field and still look like it worked.
  it("refuses when a nested version precedes the root one", () => {
    const nested = [
      "{",
      '  "name": "stratum",',
      '  "volta": {',
      '    "version": "22.13.0"',
      "  },",
      '  "version": "0.2.0"',
      "}",
      "",
    ].join("\n");

    const result = setPackageVersion(nested, "0.3.0");
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain("nested");
  });

  it("refuses a manifest with no version field", () => {
    expect(setPackageVersion('{\n  "name": "stratum"\n}\n', "0.3.0").success).toBe(false);
  });

  it("refuses when the rewrite would produce invalid JSON", () => {
    expect(setPackageVersion('{\n  "version": "0.2.0"', "0.3.0").success).toBe(false);
  });
});

describe("previousRelease", () => {
  it("returns the release listed below the given one", () => {
    const cut = cutRelease(FIXTURE, { version: "0.2.0", date: "2026-08-29", repoUrl: REPO });
    expect(cut.success && previousRelease(cut.data, "0.2.0")).toBe("0.1.0");
  });

  it("returns null for the oldest release", () => {
    expect(previousRelease(FIXTURE, "0.1.0")).toBeNull();
  });

  it("returns null for a version that is not listed", () => {
    expect(previousRelease(FIXTURE, "9.9.9")).toBeNull();
  });

  it("never returns Unreleased", () => {
    expect(previousRelease(FIXTURE, "Unreleased")).toBeNull();
  });
});

describe("the repository's own CHANGELOG.md", () => {
  it("is structurally sound, so a release can always be cut from it", () => {
    expect(validateChangelog(REAL_CHANGELOG)).toEqual([]);
  });

  it("has release notes for every shipped version", () => {
    const released = parseChangelog(REAL_CHANGELOG).sections.filter(
      (section) => section.version !== "Unreleased",
    );
    expect(released.length).toBeGreaterThan(0);
    for (const section of released) {
      expect(releaseNotes(REAL_CHANGELOG, section.version).success).toBe(true);
    }
  });
});

describe("the repository's own changelog.d/ fragments", () => {
  it("are all structurally sound", () => {
    const fragments = Object.entries(REAL_FRAGMENT_MODULES)
      .filter(([path]) => !path.endsWith("/README.md"))
      .map(([path, body]) => ({ name: path.split("/").pop() ?? path, body }));
    expect(validateFragments(fragments)).toEqual([]);
  });
});
