/// <reference types="vite/client" />

/**
 * Guard: the Durable Object migration chain in wrangler.toml is append-only.
 *
 * Cloudflare records the last-applied migration tag on the deployed script, not
 * in our config. Wrangler reads that tag, finds it in `[[migrations]]`, and
 * sends only the migrations after it. When the tag is NOT in the list, wrangler
 * assumes it was deleted and replays the chain from the top — which fails on any
 * class that already has live objects:
 *
 *   ▲ [WARNING] The published script stratum-staging has a migration tag "v3",
 *     which was not found in your wrangler.toml file. [...] Applying all
 *     available migrations to the script...
 *   ✘ [ERROR] Cannot apply new-class migration to class 'MergeQueue' that is
 *     already depended on by existing Durable Objects [code: 10074]
 *
 * A tag cannot be un-applied from a deployed script, so this is not transient:
 * every deploy of that environment stays broken until the config is put back.
 * Reverting a merged migration, renaming a tag, or editing the classes of a tag
 * that already shipped all produce it — and ci.yml gates the production deploy
 * on staging, so a single revert takes down both.
 *
 * The rule that prevents all of it: the migration list may only ever grow at the
 * end. This asserts that against main.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
// Read via Vite's raw import rather than node:fs, so the guard type-checks under
// the Workers tsconfig (the same trick tests/helpers/sqlite-d1.ts uses for SQL).
import headToml from "../wrangler.toml?raw";

/** One `[[migrations]]` entry: its tag, plus its remaining keys, normalized. */
interface MigrationEntry {
  tag: string;
  /** `key = value` lines with comments and incidental whitespace removed. */
  fields: string[];
}

/**
 * Drop a trailing `#` comment, honouring quotes so a `#` inside a string value
 * survives. TOML basic strings support backslash escapes and literal ('…')
 * strings do not, which is why the escape is only consumed inside double quotes.
 */
function stripComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote === '"' && char === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return line.slice(0, i);
  }
  return line;
}

function countChar(text: string, char: string): number {
  let count = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const candidate = text[i];
    if (quote === '"' && candidate === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (candidate === quote) quote = null;
      continue;
    }
    if (candidate === '"' || candidate === "'") {
      quote = candidate;
      continue;
    }
    if (candidate === char) count++;
  }
  return count;
}

/** Collapse whitespace runs so reformatting alone cannot trip the guard. */
function normalize(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

/**
 * Parse the top-level `[[migrations]]` entries out of a wrangler.toml, in file
 * order. Per-environment `[[env.*.migrations]]` tables are deliberately not
 * matched: this config declares migrations once at the top level and every
 * environment inherits them.
 */
function parseMigrations(toml: string): MigrationEntry[] {
  const entries: MigrationEntry[] = [];
  let current: MigrationEntry | null = null;

  for (const rawLine of toml.split("\n")) {
    const line = normalize(stripComment(rawLine));
    if (line === "") continue;

    // Any table header closes the entry being filled; only ours opens one.
    if (line.startsWith("[")) {
      current = line === "[[migrations]]" ? { tag: "", fields: [] } : null;
      if (current) entries.push(current);
      continue;
    }

    if (!current) continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    // A value whose brackets don't balance on this line continues onto the
    // next, where the parser would drop it — and a silently dropped field makes
    // the comparison below pass for the wrong reason. Refuse to guess.
    if (countChar(value, "[") !== countChar(value, "]")) {
      throw new Error(
        `[[migrations]] value for \`${key}\` spans multiple lines, which this guard cannot read. Keep migration values on one line so the append-only check can compare them.`,
      );
    }
    if (key === "tag") {
      current.tag = value.replace(/^["']|["']$/g, "");
    } else {
      current.fields.push(`${key} = ${value}`);
    }
  }

  return entries;
}

/** Order-insensitive rendering of an entry, for both comparison and messages. */
function describeEntry(entry: MigrationEntry): string {
  return [`tag = "${entry.tag}"`, ...[...entry.fields].sort()].join(", ");
}

/**
 * Compare a candidate migration chain against the one already on main. Returns a
 * human-readable problem, or null when the candidate is a clean append. Kept pure
 * so the rule itself is unit-tested below without touching git.
 */
function findChainViolation(base: MigrationEntry[], head: MigrationEntry[]): string | null {
  const seen = new Set<string>();
  for (const entry of head) {
    if (entry.tag === "") {
      return "A [[migrations]] entry has no `tag`. Every migration needs one — the tag is the only thing Cloudflare records on the deployed script.";
    }
    if (seen.has(entry.tag)) {
      return `Migration tag "${entry.tag}" appears more than once. Tags must be unique: wrangler matches the deployed script's tag by name and applies everything after the first match.`;
    }
    seen.add(entry.tag);
  }

  if (head.length < base.length) {
    const headTags = new Set(head.map((entry) => entry.tag));
    const dropped = base
      .filter((entry) => !headTags.has(entry.tag))
      .map((entry) => `"${entry.tag}"`)
      .join(", ");
    return `This branch removes migration(s) ${dropped} that are already on main. Those tags are recorded on the deployed staging and production scripts; dropping them makes wrangler replay the chain from the start and every deploy of those environments fails with error 10074. Add a follow-up migration instead of removing this one.`;
  }

  for (let i = 0; i < base.length; i++) {
    const before = base[i];
    const after = head[i];
    if (!before || !after) continue;
    if (before.tag !== after.tag) {
      return `Migration #${i + 1} is "${after.tag}" on this branch but "${before.tag}" on main. Tags are immutable once deployed — append a new one rather than renaming or reordering an existing one.`;
    }
    if (describeEntry(before) !== describeEntry(after)) {
      return `Migration "${after.tag}" is already deployed but its definition changed.\n  on main:   ${describeEntry(before)}\n  on branch: ${describeEntry(after)}\nAn applied migration cannot be rewritten — environments that already ran it never see the edit, and fresh environments would diverge from them. Append a new migration instead.`;
    }
  }

  return null;
}

function gitShowWranglerToml(ref: string): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:wrangler.toml`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** The nearest available trunk ref, or null in a checkout that has none. */
function resolveBaseRef(): string | null {
  for (const ref of ["origin/main", "main"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        stdio: "ignore",
      });
      return ref;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

describe("parseMigrations", () => {
  it("reads tags and fields in file order", () => {
    expect(
      parseMigrations(`
name = "stratum"

[[migrations]]
tag = "v1"
new_classes = ["MergeQueue"]

[[migrations]]
tag = "v2"
new_sqlite_classes = ["RepoDO"]
`),
    ).toEqual([
      { tag: "v1", fields: ['new_classes = ["MergeQueue"]'] },
      { tag: "v2", fields: ['new_sqlite_classes = ["RepoDO"]'] },
    ]);
  });

  it("ignores comments, blank lines, and incidental whitespace", () => {
    expect(
      parseMigrations(`
# leading comment
[[migrations]]
tag   =   "v1"     # why this exists
new_classes = ["MergeQueue"]
`),
    ).toEqual([{ tag: "v1", fields: ['new_classes = ["MergeQueue"]'] }]);
  });

  it("keeps a # that is inside a quoted value", () => {
    expect(parseMigrations('[[migrations]]\ntag = "v#1"\n')).toEqual([{ tag: "v#1", fields: [] }]);
  });

  it("stops collecting at the next table header", () => {
    expect(
      parseMigrations(`
[[migrations]]
tag = "v1"

[vars]
tag = "not-a-migration"
`),
    ).toEqual([{ tag: "v1", fields: [] }]);
  });

  it("does not match per-environment migration tables", () => {
    expect(parseMigrations('[[env.staging.migrations]]\ntag = "v9"\n')).toEqual([]);
  });

  it("returns nothing for a config with no migrations", () => {
    expect(parseMigrations('name = "stratum"\n')).toEqual([]);
  });

  // A multi-line array used to be stored truncated as `new_sqlite_classes = [`,
  // dropping the class names — so a rewritten class list compared equal to the
  // original and the append-only check below passed for the wrong reason.
  it("refuses a value that spans multiple lines rather than truncating it", () => {
    expect(() =>
      parseMigrations('[[migrations]]\ntag = "v2"\nnew_sqlite_classes = [\n  "RepoDO",\n]\n'),
    ).toThrow(/spans multiple lines/);
  });

  it("accepts a single-line array containing brackets in strings", () => {
    expect(
      parseMigrations('[[migrations]]\ntag = "v1"\nnew_classes = ["A[]", "A[", "A]"]\n'),
    ).toEqual([{ tag: "v1", fields: ['new_classes = ["A[]", "A[", "A]"]'] }]);
  });

  it("refuses genuinely unbalanced brackets outside strings", () => {
    expect(() => parseMigrations('[[migrations]]\ntag = "v1"\nnew_classes = ["A"]]\n')).toThrow(
      /spans multiple lines/,
    );
  });
});

describe("findChainViolation", () => {
  const v1: MigrationEntry = { tag: "v1", fields: ['new_classes = ["MergeQueue"]'] };
  const v2: MigrationEntry = { tag: "v2", fields: ['new_sqlite_classes = ["RepoDO"]'] };
  const v3: MigrationEntry = {
    tag: "v3",
    fields: ['new_sqlite_classes = ["MagicLinkRateLimiter"]'],
  };

  it("accepts an unchanged chain", () => {
    expect(findChainViolation([v1, v2], [v1, v2])).toBeNull();
  });

  it("accepts appending a new migration", () => {
    expect(findChainViolation([v1, v2], [v1, v2, v3])).toBeNull();
  });

  it("accepts field reordering within an already-deployed entry", () => {
    expect(
      findChainViolation(
        [{ tag: "v1", fields: ["a = 1", "b = 2"] }],
        [{ tag: "v1", fields: ["b = 2", "a = 1"] }],
      ),
    ).toBeNull();
  });

  it("rejects removing a deployed migration", () => {
    expect(findChainViolation([v1, v2, v3], [v1, v2])).toMatch(/removes migration\(s\) "v3"/);
  });

  // Naming the trailing entries of main rather than the missing ones accused
  // "v3" here, which is still present.
  it("names the migration that actually went missing, not the last one", () => {
    const message = findChainViolation([v1, v2, v3], [v2, v3]);
    expect(message).toMatch(/removes migration\(s\) "v1"/);
    expect(message).not.toMatch(/"v3"/);
  });

  it("rejects renaming a deployed tag", () => {
    expect(findChainViolation([v1, v2], [v1, { ...v2, tag: "v2-repo" }])).toMatch(
      /immutable once deployed/,
    );
  });

  it("rejects reordering deployed migrations", () => {
    expect(findChainViolation([v1, v2], [v2, v1])).toMatch(/but "v1" on main/);
  });

  it("rejects editing the classes of a deployed migration", () => {
    expect(
      findChainViolation([v1, v2], [v1, { tag: "v2", fields: ['new_sqlite_classes = ["Repo"]'] }]),
    ).toMatch(/its definition changed/);
  });

  it("rejects inserting a migration ahead of a deployed one", () => {
    expect(findChainViolation([v1, v2], [v1, v3, v2])).toMatch(/is "v3" on this branch/);
  });

  it("rejects a duplicate tag", () => {
    expect(findChainViolation([v1], [v1, { ...v3, tag: "v1" }])).toMatch(/appears more than once/);
  });

  it("rejects a migration with no tag", () => {
    expect(findChainViolation([], [{ tag: "", fields: [] }])).toMatch(/has no `tag`/);
  });
});

describe("wrangler.toml migration chain vs. main", () => {
  const baseRef = resolveBaseRef();

  // Skipping is only defensible on a developer checkout with no trunk ref (a
  // shallow clone, or a fork whose remote isn't named origin). In CI it is a
  // real failure: a guard that quietly doesn't run is not a guard.
  it.runIf(Boolean(process.env.CI))("can reach main to compare against", () => {
    expect(
      baseRef,
      "Neither origin/main nor main is present. Check out with `fetch-depth: 0` so this guard can run.",
    ).not.toBeNull();
  });

  it.skipIf(baseRef === null)("only ever appends Durable Object migrations", () => {
    const baseToml = gitShowWranglerToml(baseRef as string);
    expect(baseToml, `Could not read wrangler.toml at ${baseRef}`).not.toBeNull();

    const base = parseMigrations(baseToml as string);
    const head = parseMigrations(headToml);

    // Both sides being empty would make the comparison vacuously green.
    expect(
      base.length,
      "main declares no [[migrations]] — this guard would pass for the wrong reason",
    ).toBeGreaterThan(0);

    expect(findChainViolation(base, head)).toBeNull();
  });
});
