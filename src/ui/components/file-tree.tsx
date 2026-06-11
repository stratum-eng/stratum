import type { FC } from "hono/jsx";
import type { FileTreeNode } from "../file-tree";

interface FileTreeProps {
  nodes: FileTreeNode[];
  namespace: string;
  slug: string;
}

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

export const FileTree: FC<FileTreeProps> = ({ nodes, namespace, slug }) => {
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
        <button
          type="button"
          class="file-tree-toggle-btn"
          onclick="(function(btn){var t=btn.closest('.file-tree');var ds=t.querySelectorAll('details');var open=Array.from(ds).some(function(d){return d.open});ds.forEach(function(d){d.open=!open});btn.textContent=open?'Expand all':'Collapse all'})(this)"
        >
          Expand all
        </button>
      </div>
      {nodes.map((node) => (
        <FileTreeNodeItem key={node.path} node={node} namespace={namespace} slug={slug} depth={0} />
      ))}
    </div>
  );
};
