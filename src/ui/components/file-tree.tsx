import type { FC } from "hono/jsx";
import type { FileTreeNode } from "../file-tree";

interface FileTreeProps {
  nodes: FileTreeNode[];
  namespace: string;
  slug: string;
  /** Per-request CSP nonce — required so the toggle script passes `script-src`. */
  nonce: string;
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
}

const FileTreeNodeItem: FC<NodeProps> = ({ node, namespace, slug, depth }) => {
  if (node.type === "file") {
    const href = `/${namespace}/${slug}/blob/${node.path.split("/").map(encodeURIComponent).join("/")}`;
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
          />
        ))}
      </div>
    </details>
  );
};

export const FileTree: FC<FileTreeProps> = ({ nodes, namespace, slug, nonce }) => {
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
        <FileTreeNodeItem key={node.path} node={node} namespace={namespace} slug={slug} depth={0} />
      ))}
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: FILE_TREE_SCRIPT }} />
    </div>
  );
};
