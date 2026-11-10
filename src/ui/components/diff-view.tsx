import type { FC } from "hono/jsx";
import type { ChangeComment } from "../../storage/change-reviews";

export interface DiffLine {
  kind: "add" | "del" | "context" | "hunk" | "meta";
  text: string;
  /** 1-based line number in the old file (del/context lines). */
  oldLine?: number;
  /** 1-based line number in the new file (add/context lines). */
  newLine?: number;
}

export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

/**
 * Parse a unified diff into per-file sections for rendering.
 * Tolerant of partial input: unrecognized lines render as context.
 * Old/new line numbers are computed from hunk headers as lines stream by, so
 * every content line can carry a stable anchor for line comments.
 *
 * `--- ` / `+++ ` are recognized as file headers only *outside* a hunk (or as
 * an adjacent `--- `/`+++ ` pair, which starts a file section even when the
 * preceding hunk was truncated). Inside a hunk every content line carries a
 * `+`, `-`, ` ` or `\` marker, so `--- x` is a deleted line whose text starts
 * with `-- ` (a SQL or Lua comment) and `+++ x` an added line starting with
 * `++ `. Treating those as headers dropped the line from the render and
 * desynchronized every following line number, which now anchors comments —
 * hence the hunk-scoped check. The one case the pair rule still mistakes is a
 * deletion of a `-- ` line immediately followed by an addition of a `++ ` one;
 * no diff this app generates puts those two adjacent.
 */
/** Git's extended header lines for a file's mode: metadata, not content. */
const GIT_MODE_LINE = /^(?:new file mode|deleted file mode|old mode|new mode) \d{6}$/;

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;
  // Lines before any @@ header (or in malformed input) get no numbers.
  let inHunk = false;
  // Lines the current hunk still owes on each side, from its @@ counts. A hunk
  // ends when both reach zero; that is what closes `inHunk` so the next `--- `
  // is read as a header again.
  let oldRemaining = 0;
  let newRemaining = 0;
  // Between a `diff --git` line and that file's `+++` line (or the next file).
  let gitHeader = false;

  const consume = (kind: "add" | "del" | "context") => {
    if (kind !== "add") oldRemaining -= 1;
    if (kind !== "del") newRemaining -= 1;
    if (oldRemaining <= 0 && newRemaining <= 0) inHunk = false;
  };

  const rawLines = diff.split("\n");
  for (const [index, line] of rawLines.entries()) {
    // A `diff --git`/`Index:` preamble can only start a new file section, so it
    // also closes a hunk left open by truncated input.
    if (line.startsWith("Index:") || line.startsWith("diff ") || line.startsWith("index ")) {
      inHunk = false;
      // A git header names its file itself, so the section starts here. That
      // is what gives a file with no hunks at all — an empty new file, a
      // change of mode alone — a section of its own, and keeps its
      // `new file mode` line out of the file above it.
      const git = /^diff --git a\/(.+) b\/\1$/.exec(line);
      gitHeader = git?.[1] !== undefined;
      if (git?.[1] !== undefined) {
        current = { path: git[1], additions: 0, deletions: 0, lines: [] };
        files.push(current);
      }
      continue;
    }
    if (gitHeader && !inHunk && current && GIT_MODE_LINE.test(line)) {
      current.lines.push({ kind: "meta", text: line });
      continue;
    }
    // A `--- ` line directly followed by a `+++ ` line is the header pair of a
    // new file section, so it closes the previous hunk even when that hunk's
    // @@ counts were wrong or its body was truncated.
    if (line.startsWith("--- ") && rawLines[index + 1]?.startsWith("+++ ")) {
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      // Already opened by this file's `diff --git` line, under its real path
      // (a deleted file's `+++` side is /dev/null).
      if (gitHeader) {
        gitHeader = false;
        continue;
      }
      const rawPath = line.slice(4).trim();
      const path = rawPath.startsWith("b/") ? rawPath.slice(2) : rawPath;
      current = { path, additions: 0, deletions: 0, lines: [] };
      files.push(current);
      continue;
    }
    if (!inHunk && line.startsWith("===")) {
      continue;
    }
    if (!current) continue;

    // Unconditional: inside a hunk every content line carries a marker, so a
    // bare `@@` at column 0 is always a header — including one that starts the
    // next hunk when a malformed count left this one open.
    if (line.startsWith("@@")) {
      const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (header) {
        oldLine = Number(header[1]);
        newLine = Number(header[3]);
        // An omitted count means 1 line, per the unified-diff format.
        oldRemaining = header[2] === undefined ? 1 : Number(header[2]);
        newRemaining = header[4] === undefined ? 1 : Number(header[4]);
        inHunk = oldRemaining > 0 || newRemaining > 0;
      } else {
        // Unparseable header: stop numbering rather than guess.
        inHunk = false;
      }
      current.lines.push({ kind: "hunk", text: line });
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — metadata about the adjacent line, not
      // file content; kept distinct so the split view doesn't pair it. It is
      // not counted by the hunk header, so it does not consume a line.
      current.lines.push({ kind: "meta", text: line });
    } else if (line.startsWith("+")) {
      current.additions += 1;
      current.lines.push({
        kind: "add",
        text: line,
        ...(inHunk ? { newLine: newLine++ } : {}),
      });
      if (inHunk) consume("add");
    } else if (line.startsWith("-")) {
      current.deletions += 1;
      current.lines.push({
        kind: "del",
        text: line,
        ...(inHunk ? { oldLine: oldLine++ } : {}),
      });
      if (inHunk) consume("del");
    } else {
      current.lines.push({
        kind: "context",
        text: line,
        ...(inHunk ? { oldLine: oldLine++, newLine: newLine++ } : {}),
      });
      if (inHunk) consume("context");
    }
  }

  return files;
}

/**
 * Stable anchor id for a diff line: `L-{fileIndex}-{new|old}-{n}`. Added and
 * context lines anchor on their new-file number; deleted lines only exist on
 * the old side. Only the unified view carries the ids (an id must be unique
 * per document, and the unified view is always rendered).
 */
export function diffLineAnchor(fileIndex: number, line: DiffLine): string | undefined {
  if (line.newLine !== undefined) return `L-${fileIndex}-new-${line.newLine}`;
  if (line.oldLine !== undefined) return `L-${fileIndex}-old-${line.oldLine}`;
  return undefined;
}

const lineClass: Record<DiffFile["lines"][number]["kind"], string> = {
  add: "diff-line diff-add",
  del: "diff-line diff-del",
  context: "diff-line",
  hunk: "diff-line diff-hunk",
  meta: "diff-line diff-meta",
};

export type SplitRow =
  | { kind: "hunk"; text: string }
  | {
      kind: "pair";
      left: string | null;
      right: string | null;
      leftKind: "del" | "context";
      rightKind: "add" | "context";
    };

/** Drop the unified-diff marker (+ / - / leading space) for side-by-side cells. */
function stripMarker(text: string): string {
  return text.startsWith("+") || text.startsWith("-") || text.startsWith(" ")
    ? text.slice(1)
    : text;
}

/**
 * Pair a file's unified-diff lines into side-by-side rows. Unified diffs list a
 * segment's deletions before its additions, so buffered del/add runs are zipped
 * together at each context/hunk boundary; the longer run leaves empty cells on
 * the other side.
 */
export function buildSplitRows(lines: DiffFile["lines"]): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: string[] = [];
  let adds: string[] = [];

  const flush = () => {
    const count = Math.max(dels.length, adds.length);
    for (let i = 0; i < count; i++) {
      rows.push({
        kind: "pair",
        left: dels[i] ?? null,
        right: adds[i] ?? null,
        leftKind: "del",
        rightKind: "add",
      });
    }
    dels = [];
    adds = [];
  };

  for (const line of lines) {
    switch (line.kind) {
      case "del":
        dels.push(stripMarker(line.text));
        break;
      case "add":
        adds.push(stripMarker(line.text));
        break;
      case "hunk":
        flush();
        rows.push({ kind: "hunk", text: line.text });
        break;
      case "meta":
        // Skip without flushing: the marker sits inside a del/add segment and
        // must not break the pairing (or render as content in both columns).
        break;
      case "context": {
        flush();
        const text = stripMarker(line.text);
        rows.push({
          kind: "pair",
          left: text,
          right: text,
          leftKind: "context",
          rightKind: "context",
        });
        break;
      }
    }
  }
  flush();
  return rows;
}

const SplitTable: FC<{ file: DiffFile }> = ({ file }) => (
  <table class="diff-split">
    <caption class="visually-hidden">Side-by-side diff of {file.path}</caption>
    <thead class="visually-hidden">
      <tr>
        <th scope="col">Original</th>
        <th scope="col">Modified</th>
      </tr>
    </thead>
    <tbody>
      {buildSplitRows(file.lines).map((row, index) =>
        row.kind === "hunk" ? (
          <tr key={index}>
            <td class="diff-cell diff-hunk" colspan={2}>
              {row.text}
            </td>
          </tr>
        ) : (
          <tr key={index}>
            <td class={row.leftKind === "del" ? "diff-cell diff-del" : "diff-cell"}>
              {row.left ?? ""}
            </td>
            <td class={row.rightKind === "add" ? "diff-cell diff-add" : "diff-cell"}>
              {row.right ?? ""}
            </td>
          </tr>
        ),
      )}
    </tbody>
  </table>
);

/**
 * The unified/split toggle is a hidden checkbox + CSS sibling selectors — the
 * switch is instant and needs no client-side JavaScript, keeping the UI's
 * server-rendered-only invariant. Both views are rendered; CSS shows one.
 */
export const DiffView: FC<{ files: DiffFile[] }> = ({ files }) => {
  if (files.length === 0) {
    return <p class="diff-empty">No changes between the workspace and the project.</p>;
  }
  return (
    <div class="diff-view">
      <input type="checkbox" id="diff-split-toggle" class="diff-split-toggle" />
      <label for="diff-split-toggle" class="diff-split-label">
        <span class="diff-label-unified">Switch to split view</span>
        <span class="diff-label-split">Switch to unified view</span>
      </label>
      {files.map((file, fileIndex) => (
        <details class="diff-file" key={file.path} open={files.length <= 5}>
          <summary class="diff-file-header">
            <span class="diff-file-path">{file.path}</span>
            <span class="diff-file-stats">
              <span class="diff-stat-add">+{file.additions}</span>{" "}
              <span class="diff-stat-del">−{file.deletions}</span>
            </span>
          </summary>
          <pre class="diff-file-body">
            {file.lines.map((line, index) => {
              const anchor = diffLineAnchor(fileIndex, line);
              return (
                <span
                  class={lineClass[line.kind]}
                  {...(anchor !== undefined ? { id: anchor } : {})}
                  key={index}
                >
                  <span class="diff-lineno">{line.oldLine ?? ""}</span>
                  <span class="diff-lineno">{line.newLine ?? ""}</span>
                  {line.text}
                  {"\n"}
                </span>
              );
            })}
          </pre>
          <SplitTable file={file} />
        </details>
      ))}
    </div>
  );
};

export interface LineCommentThread {
  root: ChangeComment;
  replies: ChangeComment[];
}

/**
 * Group line-anchored comments into threads: roots (comments with a file
 * anchor and no parent) ordered by file, line, then creation time, each with
 * its replies in chronological order.
 */
export function buildLineCommentThreads(comments: ChangeComment[]): LineCommentThread[] {
  const repliesByRoot = new Map<string, ChangeComment[]>();
  for (const comment of comments) {
    if (comment.parentCommentId !== undefined) {
      const existing = repliesByRoot.get(comment.parentCommentId) ?? [];
      existing.push(comment);
      repliesByRoot.set(comment.parentCommentId, existing);
    }
  }
  return comments
    .filter((comment) => comment.file !== undefined && comment.parentCommentId === undefined)
    .sort((a, b) => {
      const fileA = a.file ?? "";
      const fileB = b.file ?? "";
      if (fileA !== fileB) return fileA < fileB ? -1 : 1;
      const lineDiff = (a.line ?? 0) - (b.line ?? 0);
      if (lineDiff !== 0) return lineDiff;
      return a.createdAt.localeCompare(b.createdAt);
    })
    .map((root) => ({
      root,
      replies: (repliesByRoot.get(root.id) ?? []).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      ),
    }));
}

const CommentBlock: FC<{ comment: ChangeComment }> = ({ comment }) => (
  <div class="comment-item">
    <div class="comment-meta">
      <span class={`activity-actor activity-actor-${comment.authorType}`}>
        {comment.authorType}
      </span>
      <span class="mono">{comment.authorId}</span>
      <span class="review-time">{new Date(comment.createdAt).toLocaleString()}</span>
    </div>
    <pre class="comment-body">{comment.body}</pre>
  </div>
);

/**
 * Line comment threads rendered beneath the diff, grouped by file:line.
 * Server-rendered forms only (reply, resolve/unresolve) — no client-side JS.
 * When the thread's file is present in `files`, the header links to the
 * line's anchor in the unified diff.
 */
export const LineCommentThreads: FC<{
  changeId: string;
  comments: ChangeComment[];
  /** Rendered diff files, used to link threads to line anchors. */
  files?: DiffFile[];
  canComment?: boolean;
  /**
   * Whether the viewer may resolve *any* thread — i.e. is a project writer.
   * The resolve route also admits a thread's own author, so a reader who wrote
   * the root still gets the control; `viewerId` is what identifies them.
   * Reply and resolve are separate permissions: gating both on `canComment`
   * showed readers a button whose route answers 403.
   */
  canResolveAny?: boolean;
  viewerId?: string;
}> = ({ changeId, comments, files = [], canComment = false, canResolveAny = false, viewerId }) => {
  const threads = buildLineCommentThreads(comments);
  if (threads.length === 0) {
    return <p class="review-empty">No line comments yet.</p>;
  }
  return (
    <div class="line-threads">
      {threads.map(({ root, replies }) => {
        const fileIndex = files.findIndex((file) => file.path === root.file);
        const side = root.side ?? "new";
        // Link to the anchor the diff actually rendered rather than composing
        // one from the thread's own side: a context line is anchored on its
        // new-file number even when the comment names the old side, and a line
        // outside every hunk has no anchor at all. Composing `L-i-old-n` for
        // either case produced an href pointing at no element.
        const anchored =
          fileIndex >= 0 && root.line !== undefined
            ? files[fileIndex]?.lines.find(
                (line) => (side === "old" ? line.oldLine : line.newLine) === root.line,
              )
            : undefined;
        const anchorId = anchored !== undefined ? diffLineAnchor(fileIndex, anchored) : undefined;
        const anchorHref = anchorId !== undefined ? `#${anchorId}` : undefined;
        const location = `${root.file}:${root.line}`;
        // Mirrors handleResolveToggle: a project writer, or the thread root's
        // own author.
        const canResolveThread =
          canResolveAny ||
          (root.authorType === "user" && viewerId !== undefined && root.authorId === viewerId);
        return (
          <div
            class={root.resolved ? "line-thread line-thread-resolved" : "line-thread"}
            key={root.id}
          >
            <div class="line-thread-header">
              {anchorHref !== undefined ? (
                <a class="mono line-thread-anchor" href={anchorHref}>
                  {location}
                </a>
              ) : (
                <span class="mono">{location}</span>
              )}
              {root.side === "old" && <span class="line-thread-side">(old)</span>}
              {root.resolved ? (
                <span class="badge badge-approved">resolved</span>
              ) : (
                <span class="badge badge-open">open</span>
              )}
            </div>
            <CommentBlock comment={root} />
            {replies.length > 0 && (
              <ul class="line-thread-replies">
                {replies.map((reply) => (
                  <li key={reply.id}>
                    <CommentBlock comment={reply} />
                  </li>
                ))}
              </ul>
            )}
            {(canComment || canResolveThread) && (
              <div class="line-thread-actions">
                {canComment && (
                  <form
                    method="post"
                    action={`/api/changes/${changeId}/comments`}
                    class="comment-form"
                  >
                    <input type="hidden" name="parentCommentId" value={root.id} />
                    <textarea
                      name="body"
                      rows={2}
                      placeholder="Reply…"
                      aria-label={`Reply to comment on ${location}`}
                      required
                    />
                    <button type="submit" class="btn">
                      Reply
                    </button>
                  </form>
                )}
                {canResolveThread && (
                  <form
                    method="post"
                    action={`/api/changes/${changeId}/comments/${root.id}/${root.resolved ? "unresolve" : "resolve"}`}
                  >
                    <button type="submit" class="btn">
                      {root.resolved ? "Unresolve" : "Resolve"}
                    </button>
                  </form>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
