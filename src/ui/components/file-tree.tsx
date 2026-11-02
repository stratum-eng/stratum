import type { FC } from "hono/jsx";
import type { FileTreeNode } from "../file-tree";

interface FileTreeProps {
  nodes: FileTreeNode[];
  namespace: string;
  slug: string;
  /** Per-request CSP nonce — required so the toggle script passes `script-src`. */
  nonce: string;
  /** Branch the tree was read from, threaded into every blob link so clicking a
   * file stays on it. `undefined` means the default branch — see {@link refQuery}. */
  refName?: string;
}

/**
 * The `?ref=` suffix a generated link needs to keep the reader on the branch
 * they are browsing.
 *
 * `undefined` — the default branch — deliberately yields the empty string.
 * Every URL this UI produced before multi-branch support pointed at the default
 * branch implicitly, so appending a redundant parameter to all of them would
 * churn every existing link and bookmark for no change in behaviour.
 */
export function refQuery(refName: string | undefined): string {
  return refName === undefined ? "" : `?ref=${encodeURIComponent(refName)}`;
}

/**
 * Expand/collapse-all wiring for `.file-tree-toggle-btn`, CSP-safe (no inline
 * handler). Delegated from `document` behind a global flag so rendering more
 * than one FileTree on a page never double-binds the buttons.
 */
const FILE_TREE_SCRIPT = `
(function () {
  if (window.__stratumFileTreeWired) return;
  window.__stratumFileTreeWired = true;
  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.closest) return;
    var btn = target.closest('.file-tree-toggle-btn');
    if (!btn) return;
    var t = btn.closest('.file-tree');
    if (!t) return;
    var ds = t.querySelectorAll('details');
    var open = Array.from(ds).some(function (d) { return d.open; });
    ds.forEach(function (d) { d.open = !open; });
    btn.textContent = open ? 'Expand all' : 'Collapse all';
  });
})();
`;

interface NodeProps {
  node: FileTreeNode;
  namespace: string;
  slug: string;
  depth: number;
  refName?: string;
}

const FileTreeNodeItem: FC<NodeProps> = ({ node, namespace, slug, depth, refName }) => {
  if (node.type === "file") {
    const path = node.path.split("/").map(encodeURIComponent).join("/");
    const href = `/${namespace}/${slug}/blob/${path}${refQuery(refName)}`;
    return (
      <div class="file-tree-file">
        <a href={href}>{node.name}</a>
      </div>
    );
  }

  return (
    <details class="file-tree-dir">
      <summary>{node.name}</summary>
      <div class="file-tree-children">
        {node.children.map((child) => (
          <FileTreeNodeItem
            key={child.path}
            node={child}
            namespace={namespace}
            slug={slug}
            depth={depth + 1}
            refName={refName}
          />
        ))}
      </div>
    </details>
  );
};

/**
 * The collapsible repository file tree.
 *
 * `refName` is the branch being browsed; every blob link carries it so a reader
 * who switched branches stays on that branch as they navigate. Omitted on the
 * default branch so those links keep their existing shape.
 */
export const FileTree: FC<FileTreeProps> = ({ nodes, namespace, slug, nonce, refName }) => {
  if (nodes.length === 0) {
    return (
      <div class="empty-state">
        <p>No files in this repository.</p>
      </div>
    );
  }

  return (
    <div class="file-tree">
      <div class="file-tree-controls">
        <button type="button" class="file-tree-toggle-btn">
          Expand all
        </button>
      </div>
      {nodes.map((node) => (
        <FileTreeNodeItem
          key={node.path}
          node={node}
          namespace={namespace}
          slug={slug}
          depth={0}
          refName={refName}
        />
      ))}
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: FILE_TREE_SCRIPT }} />
    </div>
  );
};
