import type { FC } from "hono/jsx";
import type { FileTreeNode } from "../file-tree";

const MAX_RENDERED_NODES = 500;

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
  counter: { value: number };
}

const FileTreeNodeItem: FC<NodeProps> = ({ node, namespace, slug, depth, counter }) => {
  if (counter.value >= MAX_RENDERED_NODES) return null;
  counter.value++;

  if (node.type === "file") {
    const href = `/${namespace}/${slug}/blob/${node.path.split("/").map(encodeURIComponent).join("/")}`;
    return (
      <div class="file-tree-file">
        <a href={href}>{node.name}</a>
      </div>
    );
  }

  return (
    <details open={depth === 0} class="file-tree-dir">
      <summary>{node.name}</summary>
      <div class="file-tree-children">
        {node.children.map((child) => (
          <FileTreeNodeItem
            key={child.path}
            node={child}
            namespace={namespace}
            slug={slug}
            depth={depth + 1}
            counter={counter}
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

  const counter = { value: 0 };
  const totalFiles = countFiles(nodes);

  return (
    <div class="file-tree">
      {nodes.map((node) => (
        <FileTreeNodeItem
          key={node.path}
          node={node}
          namespace={namespace}
          slug={slug}
          depth={0}
          counter={counter}
        />
      ))}
      {totalFiles > MAX_RENDERED_NODES && (
        <p class="file-tree-notice">
          Showing first {MAX_RENDERED_NODES} of {totalFiles} files. Use the API to browse the full
          tree.
        </p>
      )}
    </div>
  );
};

function countFiles(nodes: FileTreeNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.type === "file") {
      count++;
    } else {
      count += countFiles(node.children);
    }
  }
  return count;
}
