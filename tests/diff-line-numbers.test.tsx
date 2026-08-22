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

  it("renders an empty state without any threads", () => {
    const html = renderToString(
      <LineCommentThreads changeId="chg_1" comments={[comment({ id: "c_plain" })]} />,
    );
    expect(html).toContain("No line comments yet.");
  });
});
