export type FileTreeNode =
  | { type: "file"; name: string; path: string }
  | { type: "dir"; name: string; path: string; children: FileTreeNode[] };

export function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const filePath of paths) {
    const parts = filePath.split("/").filter((p) => p.length > 0);
    insertNode(root, parts, 0, "");
  }

  sortNodes(root);
  return root;
}

function insertNode(
  nodes: FileTreeNode[],
  parts: readonly string[],
  depth: number,
  prefix: string,
): void {
  if (depth >= parts.length) return;

  const name = parts[depth] ?? "";
  if (!name) return;

  const path = prefix ? `${prefix}/${name}` : name;

  if (depth === parts.length - 1) {
    nodes.push({ type: "file", name, path });
    return;
  }

  let dir = nodes.find(
    (n): n is Extract<FileTreeNode, { type: "dir" }> => n.type === "dir" && n.name === name,
  );
  if (!dir) {
    const newDir: Extract<FileTreeNode, { type: "dir" }> = {
      type: "dir",
      name,
      path,
      children: [],
    };
    nodes.push(newDir);
    dir = newDir;
  }

  insertNode(dir.children, parts, depth + 1, path);
}

function sortNodes(nodes: FileTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  for (const node of nodes) {
    if (node.type === "dir") sortNodes(node.children);
  }
}
