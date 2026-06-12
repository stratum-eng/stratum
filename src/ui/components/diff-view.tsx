import type { FC } from "hono/jsx";

export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  lines: Array<{ kind: "add" | "del" | "context" | "hunk"; text: string }>;
}

/**
 * Parse a unified diff into per-file sections for rendering.
 * Tolerant of partial input: unrecognized lines render as context.
 */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;

  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("+++ ")) {
      const rawPath = line.slice(4).trim();
      const path = rawPath.startsWith("b/") ? rawPath.slice(2) : rawPath;
      current = { path, additions: 0, deletions: 0, lines: [] };
      files.push(current);
      continue;
    }
    if (line.startsWith("Index:") || line.startsWith("diff ") || line.startsWith("index ")) {
      continue;
    }
    if (line.startsWith("===")) {
      continue;
    }
    if (!current) continue;

    if (line.startsWith("@@")) {
      current.lines.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) {
      current.additions += 1;
      current.lines.push({ kind: "add", text: line });
    } else if (line.startsWith("-")) {
      current.deletions += 1;
      current.lines.push({ kind: "del", text: line });
    } else {
      current.lines.push({ kind: "context", text: line });
    }
  }

  return files;
}

const lineClass: Record<DiffFile["lines"][number]["kind"], string> = {
  add: "diff-line diff-add",
  del: "diff-line diff-del",
  context: "diff-line",
  hunk: "diff-line diff-hunk",
};

export const DiffView: FC<{ files: DiffFile[] }> = ({ files }) => {
  if (files.length === 0) {
    return <p class="diff-empty">No changes between the workspace and the project.</p>;
  }
  return (
    <div class="diff-view">
      {files.map((file) => (
        <details class="diff-file" key={file.path} open={files.length <= 5}>
          <summary class="diff-file-header">
            <span class="diff-file-path">{file.path}</span>
            <span class="diff-file-stats">
              <span class="diff-stat-add">+{file.additions}</span>{" "}
              <span class="diff-stat-del">−{file.deletions}</span>
            </span>
          </summary>
          <pre class="diff-file-body">
            {file.lines.map((line, index) => (
              <span class={lineClass[line.kind]} key={index}>
                {line.text}
                {"\n"}
              </span>
            ))}
          </pre>
        </details>
      ))}
    </div>
  );
};
