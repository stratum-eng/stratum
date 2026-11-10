import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import type { ChangeComment } from "../src/storage/change-reviews";
import {
  DiffView,
  LineCommentThreads,
  buildLineCommentThreads,
  diffLineAnchor,
  parseUnifiedDiff,
} from "../src/ui/components/diff-view";

const sampleDiff = [
  "diff --git a/src/x.ts b/src/x.ts",
  "--- a/src/x.ts",
  "+++ b/src/x.ts",
  "@@ -10,4 +20,4 @@",
  " context one",
  "-old line",
  "+new line",
  " context two",
  "@@ -30,1 +40,2 @@",
  "-gone",
  "+kept",
  "+added",
].join("\n");

function comment(overrides: Partial<ChangeComment> = {}): ChangeComment {
  return {
    id: "cmt_root",
    changeId: "chg_1",
    authorType: "user",
    authorId: "user_author",
    body: "root body",
    createdAt: "2026-01-01T00:00:00.000Z",
    resolved: false,
    ...overrides,
  };
}

describe("parseUnifiedDiff line numbers", () => {
  it("numbers old/new lines from the hunk header", () => {
    const [file] = parseUnifiedDiff(sampleDiff);
    if (!file) throw new Error("diff did not parse");
    expect(file.lines).toEqual([
      { kind: "hunk", text: "@@ -10,4 +20,4 @@" },
      { kind: "context", text: " context one", oldLine: 10, newLine: 20 },
      { kind: "del", text: "-old line", oldLine: 11 },
      { kind: "add", text: "+new line", newLine: 21 },
      { kind: "context", text: " context two", oldLine: 12, newLine: 22 },
      { kind: "hunk", text: "@@ -30,1 +40,2 @@" },
      { kind: "del", text: "-gone", oldLine: 30 },
      { kind: "add", text: "+kept", newLine: 40 },
      { kind: "add", text: "+added", newLine: 41 },
    ]);
  });

  it("handles single-line hunk headers without counts", () => {
    const diff = ["--- a/f", "+++ b/f", "@@ -1 +1 @@", "-a", "+b"].join("\n");
    const [file] = parseUnifiedDiff(diff);
    expect(file?.lines).toEqual([
      { kind: "hunk", text: "@@ -1 +1 @@" },
      { kind: "del", text: "-a", oldLine: 1 },
      { kind: "add", text: "+b", newLine: 1 },
    ]);
  });

  it("leaves lines before any hunk header unnumbered", () => {
    const diff = ["--- a/f", "+++ b/f", "+stray"].join("\n");
    const [file] = parseUnifiedDiff(diff);
    expect(file?.lines[0]).toEqual({ kind: "add", text: "+stray" });
  });

  it("keeps a deleted line whose text starts with a `-- ` comment marker", () => {
    // "-" + "-- legacy note" is "--- legacy note", which a prefix test reads as
    // a file header: the line vanished and every later oldLine slipped by one.
    const diff = [
      "diff --git a/migrations/001.sql b/migrations/001.sql",
      "--- a/migrations/001.sql",
      "+++ b/migrations/001.sql",
      "@@ -1,4 +1,3 @@",
      " CREATE TABLE t (id TEXT);",
      "--- legacy note",
      " SELECT 1;",
      " SELECT 2;",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]?.deletions).toBe(1);
    expect(files[0]?.lines).toEqual([
      { kind: "hunk", text: "@@ -1,4 +1,3 @@" },
      { kind: "context", text: " CREATE TABLE t (id TEXT);", oldLine: 1, newLine: 1 },
      { kind: "del", text: "--- legacy note", oldLine: 2 },
      { kind: "context", text: " SELECT 1;", oldLine: 3, newLine: 2 },
      { kind: "context", text: " SELECT 2;", oldLine: 4, newLine: 3 },
    ]);
  });

  it("keeps an added line whose text starts with `++ ` in the same file", () => {
    // "+" + "++ bonus point" is "+++ bonus point", which a prefix test reads as
    // a new file header: the diff split into a phantom file named after the
    // line's own text and the rest of the real file lost its numbering.
    const diff = [
      "diff --git a/notes.md b/notes.md",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1,2 +1,3 @@",
      " intro",
      "+++ bonus point",
      " outro",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files.map((file) => file.path)).toEqual(["notes.md"]);
    expect(files[0]?.additions).toBe(1);
    expect(files[0]?.lines).toEqual([
      { kind: "hunk", text: "@@ -1,2 +1,3 @@" },
      { kind: "context", text: " intro", oldLine: 1, newLine: 1 },
      { kind: "add", text: "+++ bonus point", newLine: 2 },
      { kind: "context", text: " outro", oldLine: 2, newLine: 3 },
    ]);
  });

  it("still starts a new file after a hunk that ends on such a line", () => {
    // The hunk's own @@ counts say where it ends, so the following file's
    // header is recognized even though the hunk's last line looked like one.
    const diff = [
      "diff --git a/a.sql b/a.sql",
      "--- a/a.sql",
      "+++ b/a.sql",
      "@@ -1,1 +1,0 @@",
      "--- trailing note",
      "diff --git a/b.md b/b.md",
      "--- a/b.md",
      "+++ b/b.md",
      "@@ -1,1 +1,1 @@",
      "-x",
      "+y",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files.map((file) => file.path)).toEqual(["a.sql", "b.md"]);
    expect(files[0]?.lines).toEqual([
      { kind: "hunk", text: "@@ -1,1 +1,0 @@" },
      { kind: "del", text: "--- trailing note", oldLine: 1 },
    ]);
    expect(files[1]?.lines).toEqual([
      { kind: "hunk", text: "@@ -1,1 +1,1 @@" },
      { kind: "del", text: "-x", oldLine: 1 },
      { kind: "add", text: "+y", newLine: 1 },
    ]);
  });

  it("does not let a `\\ No newline` marker consume a counted hunk line", () => {
    const diff = [
      "--- a/f",
      "+++ b/f",
      "@@ -1,2 +1,2 @@",
      "-a",
      "\\ No newline at end of file",
      "+b",
      " c",
    ].join("\n");
    const [file] = parseUnifiedDiff(diff);
    expect(file?.lines).toEqual([
      { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
      { kind: "del", text: "-a", oldLine: 1 },
      { kind: "meta", text: "\\ No newline at end of file" },
      { kind: "add", text: "+b", newLine: 1 },
      { kind: "context", text: " c", oldLine: 2, newLine: 2 },
    ]);
  });

  it("stops numbering after a malformed hunk header", () => {
    const diff = ["--- a/f", "+++ b/f", "@@ broken @@", "+x"].join("\n");
    const [file] = parseUnifiedDiff(diff);
    expect(file?.lines).toEqual([
      { kind: "hunk", text: "@@ broken @@" },
      { kind: "add", text: "+x" },
    ]);
  });
});

describe("diffLineAnchor", () => {
  it("prefers the new-side number and falls back to old", () => {
    expect(diffLineAnchor(0, { kind: "add", text: "+x", newLine: 5 })).toBe("L-0-new-5");
    expect(diffLineAnchor(2, { kind: "context", text: " x", oldLine: 4, newLine: 5 })).toBe(
      "L-2-new-5",
    );
    expect(diffLineAnchor(1, { kind: "del", text: "-x", oldLine: 7 })).toBe("L-1-old-7");
    expect(diffLineAnchor(0, { kind: "hunk", text: "@@" })).toBeUndefined();
  });
});

describe("DiffView line numbers and anchors", () => {
  it("renders gutter numbers and stable anchor ids in the unified view", () => {
    const files = parseUnifiedDiff(sampleDiff);
    const html = renderToString(<DiffView files={files} />);
    expect(html).toContain('id="L-0-new-20"');
    expect(html).toContain('id="L-0-old-11"');
    expect(html).toContain('id="L-0-new-21"');
    expect(html).toContain('id="L-0-new-41"');
    expect(html).toContain('class="diff-lineno"');
    // No client-side JavaScript may sneak in.
    expect(html).not.toContain("<script");
  });

  it("keeps ids unique: split view carries no anchors", () => {
    const files = parseUnifiedDiff(sampleDiff);
    const html = renderToString(<DiffView files={files} />);
    expect(html.split('id="L-0-new-21"')).toHaveLength(2);
  });
});

describe("buildLineCommentThreads", () => {
  it("groups replies under their root, ordered by file then line", () => {
    const comments: ChangeComment[] = [
      comment({ id: "c_b", file: "b.ts", line: 2 }),
      comment({ id: "c_a2", file: "a.ts", line: 9 }),
      comment({ id: "c_a1", file: "a.ts", line: 3 }),
      comment({
        id: "c_reply2",
        parentCommentId: "c_a1",
        file: "a.ts",
        line: 3,
        createdAt: "2026-01-01T00:00:09.000Z",
      }),
      comment({
        id: "c_reply1",
        parentCommentId: "c_a1",
        file: "a.ts",
        line: 3,
        createdAt: "2026-01-01T00:00:05.000Z",
      }),
      // Change-level comment: not a line thread.
      comment({ id: "c_plain" }),
    ];
    const threads = buildLineCommentThreads(comments);
    expect(threads.map((t) => t.root.id)).toEqual(["c_a1", "c_a2", "c_b"]);
    expect(threads[0]?.replies.map((r) => r.id)).toEqual(["c_reply1", "c_reply2"]);
    expect(threads[1]?.replies).toEqual([]);
  });

  it("breaks ties on the same file:line by creation time", () => {
    const threads = buildLineCommentThreads([
      comment({ id: "c_later", file: "a.ts", line: 3, createdAt: "2026-01-02T00:00:00.000Z" }),
      comment({ id: "c_earlier", file: "a.ts", line: 3, createdAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(threads.map((t) => t.root.id)).toEqual(["c_earlier", "c_later"]);
  });
});

describe("LineCommentThreads rendering", () => {
  const files = parseUnifiedDiff(sampleDiff);
  const threadComments: ChangeComment[] = [
    comment({ id: "c_root", file: "src/x.ts", line: 21, side: "new" }),
    comment({
      id: "c_reply",
      parentCommentId: "c_root",
      file: "src/x.ts",
      line: 21,
      body: "reply body",
      createdAt: "2026-01-01T00:00:05.000Z",
    }),
  ];

  it("renders threads with anchor links, replies, and forms", () => {
    const html = renderToString(
      <LineCommentThreads
        changeId="chg_1"
        comments={threadComments}
        files={files}
        canComment={true}
        canResolveAny={true}
      />,
    );
    expect(html).toContain("src/x.ts:21");
    expect(html).toContain('href="#L-0-new-21"');
    expect(html).toContain("root body");
    expect(html).toContain("reply body");
    expect(html).toContain('class="line-thread-replies"');
    expect(html).toContain('name="parentCommentId"');
    expect(html).toContain('value="c_root"');
    expect(html).toContain("/api/changes/chg_1/comments/c_root/resolve");
    expect(html).toContain(">open</span>");
    expect(html).not.toContain("<script");
  });

  it("marks resolved threads and offers unresolve instead", () => {
    const html = renderToString(
      <LineCommentThreads
        changeId="chg_1"
        comments={[comment({ id: "c_root", file: "src/x.ts", line: 21, resolved: true })]}
        files={files}
        canComment={true}
        canResolveAny={true}
      />,
    );
    expect(html).toContain("line-thread-resolved");
    expect(html).toContain(">resolved</span>");
    expect(html).toContain("/api/changes/chg_1/comments/c_root/unresolve");
    expect(html).toContain("Unresolve");
  });

  it("hides forms when the viewer cannot comment", () => {
    const html = renderToString(
      <LineCommentThreads changeId="chg_1" comments={threadComments} files={files} />,
    );
    expect(html).not.toContain("<form");
  });

  it("falls back to plain text when the file is not in the rendered diff", () => {
    const html = renderToString(
      <LineCommentThreads
        changeId="chg_1"
        comments={[comment({ id: "c_root", file: "not/in/diff.ts", line: 2, side: "old" })]}
        files={files}
        canComment={false}
      />,
    );
    expect(html).toContain("not/in/diff.ts:2");
    expect(html).not.toContain('href="#L-');
    expect(html).toContain("(old)");
  });

  it("anchors an old-side thread to the row the diff actually rendered", () => {
    // " context one" is old line 10 and new line 20; the unified view gives it
    // one id, the new-side one. Composing "#L-0-old-10" from the thread's own
    // side pointed at an element that does not exist.
    const html = renderToString(
      <LineCommentThreads
        changeId="chg_1"
        comments={[comment({ id: "c_root", file: "src/x.ts", line: 10, side: "old" })]}
        files={files}
        canComment={false}
      />,
    );
    expect(html).toContain('href="#L-0-new-20"');
    expect(html).not.toContain('href="#L-0-old-10"');
  });

  it("anchors a deleted line on its old-side id", () => {
    const html = renderToString(
      <LineCommentThreads
        changeId="chg_1"
        comments={[comment({ id: "c_root", file: "src/x.ts", line: 11, side: "old" })]}
        files={files}
        canComment={false}
      />,
    );
    expect(html).toContain('href="#L-0-old-11"');
  });

  it("omits the link when the anchored line falls outside every hunk", () => {
    const html = renderToString(
      <LineCommentThreads
        changeId="chg_1"
        comments={[comment({ id: "c_root", file: "src/x.ts", line: 900 })]}
        files={files}
        canComment={false}
      />,
    );
    expect(html).toContain("src/x.ts:900");
    expect(html).not.toContain('href="#L-');
  });

  it("renders an empty state without any threads", () => {
    const html = renderToString(
      <LineCommentThreads changeId="chg_1" comments={[comment({ id: "c_plain" })]} />,
    );
    expect(html).toContain("No line comments yet.");
  });

  /**
   * Reply and resolve are different permissions on the server: the resolve
   * route admits a project writer or the thread root's own author, while
   * replying only needs read access. Gating both on `canComment` showed a
   * signed-in reader a Resolve button whose route answers 403.
   */
  describe("resolve authorization", () => {
    const root = comment({ id: "c_root", file: "src/x.ts", line: 20, authorId: "user_author" });

    it("hides Resolve from a signed-in reader who did not write the thread", () => {
      const html = renderToString(
        <LineCommentThreads
          changeId="chg_1"
          comments={[root]}
          files={files}
          canComment={true}
          canResolveAny={false}
          viewerId="user_other"
        />,
      );
      expect(html).toContain("Reply");
      expect(html).not.toContain("Resolve");
    });

    it("shows Resolve to the thread author even without write access", () => {
      const html = renderToString(
        <LineCommentThreads
          changeId="chg_1"
          comments={[root]}
          files={files}
          canComment={true}
          canResolveAny={false}
          viewerId="user_author"
        />,
      );
      expect(html).toContain("Resolve");
    });

    it("shows Resolve to a project writer who did not write the thread", () => {
      const html = renderToString(
        <LineCommentThreads
          changeId="chg_1"
          comments={[root]}
          files={files}
          canComment={true}
          canResolveAny={true}
          viewerId="user_other"
        />,
      );
      expect(html).toContain("Resolve");
    });

    it("names the reply box for screen readers", () => {
      const html = renderToString(
        <LineCommentThreads
          changeId="chg_1"
          comments={[root]}
          files={files}
          canComment={true}
          viewerId="user_other"
        />,
      );
      expect(html).toContain('aria-label="Reply to comment on src/x.ts:20"');
    });
  });
});

describe("parseUnifiedDiff with git's file headers (#415)", () => {
  // What buildUnifiedDiff emits now that the diff is written to be applied:
  // modes, files with no hunks at all, and deletions.
  const diff = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-one",
    "+two",
    "",
    "diff --git a/empty.txt b/empty.txt",
    "new file mode 100644",
    "",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "",
    "diff --git a/run.sh b/run.sh",
    "old mode 100644",
    "new mode 100755",
    "",
    "diff --git a/new.sh b/new.sh",
    "new file mode 100755",
    "--- /dev/null",
    "+++ b/new.sh",
    "@@ -0,0 +1 @@",
    "+echo hi",
    "",
  ].join("\n");

  it("gives every file one section, under its own path", () => {
    const files = parseUnifiedDiff(diff);
    expect(files.map((file) => file.path)).toEqual([
      "a.txt",
      // No hunks at all: still a file that changed.
      "empty.txt",
      // A deletion is listed by the file's name, not as /dev/null.
      "gone.txt",
      "run.sh",
      "new.sh",
    ]);
  });

  it("shows a mode line as metadata of its own file, not as content of the one above", () => {
    const files = parseUnifiedDiff(diff);
    const kinds = (index: number) => files[index]?.lines.map((line) => `${line.kind}:${line.text}`);

    expect(kinds(0)).not.toContain("context:new file mode 100644");
    expect(kinds(1)).toEqual(["meta:new file mode 100644", "context:"]);
    expect(kinds(3)?.slice(0, 2)).toEqual(["meta:old mode 100644", "meta:new mode 100755"]);
    expect(files.map((file) => [file.additions, file.deletions])).toEqual([
      [1, 1],
      [0, 0],
      [0, 1],
      [0, 0],
      [1, 0],
    ]);
  });

  it("still reads a mode-looking line inside a hunk as content", () => {
    const [file] = parseUnifiedDiff(
      [
        "diff --git a/notes b/notes",
        "--- a/notes",
        "+++ b/notes",
        "@@ -1,2 +1,2 @@",
        " keep",
        "-old mode 100644",
        "+new mode 100755",
        "",
      ].join("\n"),
    );
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(1);
    expect(file?.lines.some((line) => line.kind === "meta")).toBe(false);
  });
});
