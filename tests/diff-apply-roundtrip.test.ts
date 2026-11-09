/**
 * The change diff is something `git apply` rebuilds a tree from (#415).
 *
 * The CI executor does not fetch a change's head. It fetches the BASE commit,
 * applies the dispatch's `diff`, and refuses to run a single step unless the
 * tree it ends up with is the `headTreeSha` it was told to expect. That makes
 * "the diff reads correctly" too weak a property: a diff that drops a missing
 * final newline, an empty file or an executable bit fails every job that
 * touches one.
 *
 * So these tests drive real `git`: build the base and head trees, apply
 * `buildUnifiedDiff`'s output to the base with `git apply --index`, and compare
 * `git write-tree` with the head's tree id. Nothing here is mocked, which is
 * the point — the claim is about what git does with the bytes.
 */
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { buildUnifiedDiff } from "../src/storage/git-ops";

type Mode = "100644" | "100755" | "120000";
type Files = Record<string, string | { content: string; mode: Mode }>;

/** No user or system git config: a contributor's `core.autocrlf` must not decide a test. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

const repos: string[] = [];

function git(repo: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: GIT_ENV,
    ...(input !== undefined ? { input } : {}),
  }).trim();
}

function makeRepo(): string {
  const dir = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
  repos.push(dir);
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  return dir;
}

afterEach(() => {
  for (const dir of repos.splice(0)) execFileSync("rm", ["-rf", dir], { encoding: "utf8" });
});

function entry(file: Files[string]): { content: string; mode: Mode } {
  return typeof file === "string" ? { content: file, mode: "100644" } : file;
}

/** Write `files` into the index as exactly these bytes and modes; return the tree id. */
function treeOf(repo: string, files: Files): string {
  git(repo, ["read-tree", "--empty"]);
  for (const [path, file] of Object.entries(files)) {
    const { content, mode } = entry(file);
    const oid = git(repo, ["hash-object", "-w", "--stdin"], content);
    git(repo, ["update-index", "--add", "--cacheinfo", `${mode},${oid},${path}`]);
  }
  return git(repo, ["write-tree"]);
}

function diffOf(base: Files, head: Files): string {
  const side = (files: Files) => ({
    content: new Map(Object.entries(files).map(([path, file]) => [path, entry(file).content])),
    modes: new Map(
      Object.entries(files).map(([path, file]) => [path, Number.parseInt(entry(file).mode, 8)]),
    ),
  });
  const before = side(base);
  const after = side(head);
  return buildUnifiedDiff(before.content, after.content, {
    base: before.modes,
    workspace: after.modes,
  });
}

/** Check the base tree out, apply the diff the way the executor does, return the tree. */
function applyTo(base: Files, diff: string): { baseTree: string; applied: string } {
  const repo = makeRepo();
  const baseTree = treeOf(repo, base);
  // A real commit, checked out detached: what the executor has in front of it.
  const commit = git(repo, ["commit-tree", baseTree, "-m", "base"]);
  git(repo, ["checkout", "--quiet", "--force", "--detach", commit]);
  git(repo, ["apply", "--index", "--whitespace=nowarn"], diff);
  return { baseTree, applied: git(repo, ["write-tree"]) };
}

const UNCHANGED = { "README.md": "# project\n", "src/keep.ts": "export const keep = 1;\n" };

const CASES: Array<{ name: string; base: Files; head: Files }> = [
  {
    name: "an edit in the middle of a long file",
    base: { "src/a.ts": `${Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")}\n` },
    head: {
      "src/a.ts": `${Array.from({ length: 200 }, (_, i) => (i === 90 ? "changed" : `line ${i}`)).join("\n")}\n`,
    },
  },
  {
    name: "a new file that ends with a newline",
    base: {},
    head: { "src/new.ts": "export const a = 1;\nexport const b = 2;\n" },
  },
  {
    name: "a new file with no final newline",
    base: {},
    head: { "src/new.ts": "export const a = 1;\nexport const b = 2;" },
  },
  { name: "a new empty file", base: {}, head: { "src/.gitkeep": "" } },
  { name: "a new file holding one newline", base: {}, head: { blank: "\n" } },
  {
    name: "a deleted file that ended with a newline",
    base: { "old.txt": "one\ntwo\n" },
    head: {},
  },
  { name: "a deleted file with no final newline", base: { "old.txt": "one\ntwo" }, head: {} },
  { name: "a deleted empty file", base: { "old.txt": "" }, head: {} },
  { name: "a final newline added", base: { f: "one\ntwo" }, head: { f: "one\ntwo\n" } },
  { name: "a final newline removed", base: { f: "one\ntwo\n" }, head: { f: "one\ntwo" } },
  { name: "a file emptied", base: { f: "one\ntwo\n" }, head: { f: "" } },
  { name: "an empty file filled", base: { f: "" }, head: { f: "one\ntwo\n" } },
  {
    name: "a new executable",
    base: {},
    head: { "scripts/run.sh": { content: "#!/bin/sh\necho hi\n", mode: "100755" } },
  },
  {
    name: "an executable bit set with no other change",
    base: { "scripts/run.sh": "#!/bin/sh\necho hi\n" },
    head: { "scripts/run.sh": { content: "#!/bin/sh\necho hi\n", mode: "100755" } },
  },
  {
    name: "an executable bit cleared along with an edit",
    base: { "scripts/run.sh": { content: "#!/bin/sh\necho hi\n", mode: "100755" } },
    head: { "scripts/run.sh": "#!/bin/sh\necho bye\n" },
  },
  {
    name: "a deleted executable",
    base: { "scripts/run.sh": { content: "#!/bin/sh\n", mode: "100755" } },
    head: {},
  },
  {
    name: "a new symlink",
    base: { "real.txt": "x\n" },
    head: { "real.txt": "x\n", link: { content: "real.txt", mode: "120000" } },
  },
  {
    name: "a symlink pointed somewhere else",
    base: { link: { content: "a.txt", mode: "120000" } },
    head: { link: { content: "b.txt", mode: "120000" } },
  },
  {
    name: "a file replaced by a symlink",
    base: { thing: "contents\n" },
    head: { thing: { content: "elsewhere", mode: "120000" } },
  },
  {
    name: "a symlink replaced by a file",
    base: { thing: { content: "elsewhere", mode: "120000" } },
    head: { thing: "contents\n" },
  },
  {
    name: "CRLF line endings",
    base: { "win.txt": "one\r\ntwo\r\nthree\r\n" },
    head: { "win.txt": "one\r\nTWO\r\nthree\r\nfour\r\n" },
  },
  {
    name: "paths with spaces and non-ASCII characters",
    base: { "docs/release notes.md": "v1\n" },
    head: { "docs/release notes.md": "v2\n", "docs/日本語 メモ.md": "こんにちは\n" },
  },
  {
    name: "content that looks like diff syntax",
    base: { "q.sql": "SELECT 1;\n-- legacy\n++ plus\n@@ -1 +1 @@\n" },
    head: {
      "q.sql":
        "SELECT 2;\n@@ -1 +1 @@\ndiff --git a/x b/x\n\\ No newline at end of file\n--- a/x\n+++ b/x\n",
    },
  },
  {
    name: "trailing whitespace and blank lines",
    base: { f: "a  \n\n\nb\t\n" },
    head: { f: "a\n\n\n\nb\t \n\n" },
  },
  {
    name: "many kinds of change in one diff",
    base: {
      ...UNCHANGED,
      "a.txt": "one\ntwo\nthree\n",
      "gone.txt": "bye",
      "run.sh": "#!/bin/sh\n",
      link: { content: "a.txt", mode: "120000" },
      "empty-goes": "",
    },
    head: {
      ...UNCHANGED,
      "a.txt": "one\n2\nthree",
      "added.txt": "hello\n",
      "added-empty": "",
      "run.sh": { content: "#!/bin/sh\n", mode: "100755" },
      link: { content: "added.txt", mode: "120000" },
      "z/deep/er/file.ts": "export {};\n",
    },
  },
];

describe("buildUnifiedDiff output applies with real git", () => {
  it.each(CASES)("rebuilds the head tree: $name", ({ base, head }) => {
    const headTree = treeOf(makeRepo(), head);
    const diff = diffOf(base, head);
    expect(diff).not.toBe("");

    const { baseTree, applied } = applyTo(base, diff);

    expect(baseTree).not.toBe(headTree);
    expect(applied).toBe(headTree);
  });

  it("produces nothing at all when the two sides are identical", () => {
    expect(diffOf(UNCHANGED, UNCHANGED)).toBe("");
  });

  it("does not reproduce a tree it was not built from", () => {
    // The check the executor relies on has to be able to fail: a diff built
    // against one base, applied to another, must not land on the head's tree.
    const head = { "a.txt": "one\ntwo\nthree\nfour\n", "b.txt": "b\n" };
    const headTree = treeOf(makeRepo(), head);
    const diff = diffOf({ "a.txt": "one\ntwo\nthree\n", "b.txt": "b\n" }, head);

    const { applied } = applyTo({ "a.txt": "one\ntwo\nthree\n", "b.txt": "moved on\n" }, diff);

    expect(applied).not.toBe(headTree);
  });
});
