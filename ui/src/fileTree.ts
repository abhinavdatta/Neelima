// Pure tree-state helpers for the native file explorer (Checkpoint 5).
//
// No DOM, no Tauri: shaping a listing into nodes, merging a refresh without
// losing expansion, flattening the visible rows and resolving a key press are
// all pure functions so they can be tested without jsdom.

export interface TreeEntry {
  name: string;
  dir: boolean;
  path: string;
}

export interface TreeListing {
  path: string;
  entries: TreeEntry[];
  truncated?: boolean;
  limit?: number;
  unreadable?: number;
}

export interface TreeMeta {
  truncated: boolean;
  limit: number;
  unreadable: number;
}

export interface TreeNode extends TreeEntry {
  children?: TreeNode[];
  open?: boolean;
  /** Present when the last expansion attempt failed; clicking retries. */
  error?: string;
  /** Listing metadata for this directory's children (CP5). */
  truncated?: boolean;
  limit?: number;
  unreadable?: number;
}

export interface VisibleRow {
  node: TreeNode;
  depth: number;
  parentPath: string | null;
}

export type TreeKeyResult =
  | { kind: "focus"; path: string }
  | { kind: "activate"; node: TreeNode }
  | { kind: "expand"; node: TreeNode }
  | { kind: "collapse"; node: TreeNode };

/** Directories start collapsed and unloaded; files start with no children. */
export function nodesFromEntries(entries: TreeEntry[]): TreeNode[] {
  return entries.map((entry) => ({
    name: entry.name,
    dir: entry.dir,
    path: entry.path,
    children: entry.dir ? undefined : [],
  }));
}

/** Replace exactly one node anywhere in the tree; missing paths are a no-op. */
export function replaceNode(
  nodes: TreeNode[],
  path: string,
  update: (node: TreeNode) => TreeNode,
): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === path) return update(node);
    if (node.children?.length) {
      return { ...node, children: replaceNode(node.children, path, update) };
    }
    return node;
  });
}

/**
 * Merge one directory listing into the tree.
 *
 * The root listing (""), like a nested one, only replaces that directory's
 * children: ancestors keep their `open` flag, which is what lets Refresh
 * re-walk expanded folders without collapsing them.
 */
export function applyListing(nodes: TreeNode[], listing: TreeListing): TreeNode[] {
  const meta = listingMeta(listing);
  if (!listing.path) return nodesFromEntries(listing.entries);
  return replaceNode(nodes, listing.path, (node) => ({
    ...node,
    children: nodesFromEntries(listing.entries),
    open: true,
    error: undefined,
    truncated: meta.truncated,
    limit: meta.limit,
    unreadable: meta.unreadable,
  }));
}

/** Mark a failed expansion; children stay undefined so the next click retries. */
export function setNodeError(nodes: TreeNode[], path: string, message: string): TreeNode[] {
  return replaceNode(nodes, path, (node) => ({
    ...node,
    children: undefined,
    open: false,
    error: message,
  }));
}

/** Root first, then every successfully loaded open directory, parent first. */
export function expandedDirPaths(nodes: TreeNode[]): string[] {
  const paths = [""];
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      if (node.dir && node.open && node.children) {
        paths.push(node.path);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return paths;
}

/** Rows the user can actually see/focus: open directories' children only. */
export function visibleRows(nodes: TreeNode[]): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const walk = (list: TreeNode[], depth: number, parentPath: string | null) => {
    for (const node of list) {
      rows.push({ node, depth, parentPath });
      if (node.dir && node.open && node.children) {
        walk(node.children, depth + 1, node.path);
      }
    }
  };
  walk(nodes, 0, null);
  return rows;
}

/**
 * Translate one tree key press into an intent, without mutating anything.
 * Arrow keys move focus; Right expands / enters a directory; Left collapses or
 * moves to the parent; Enter/Space activates the row.
 */
export function treeKeyAction(
  rows: VisibleRow[],
  currentPath: string,
  key: string,
): TreeKeyResult | null {
  if (rows.length === 0) return null;
  const index = rows.findIndex((row) => row.node.path === currentPath);
  if (index < 0) {
    return key === "ArrowDown" || key === "Home"
      ? { kind: "focus", path: rows[0].node.path }
      : key === "End"
        ? { kind: "focus", path: rows[rows.length - 1].node.path }
        : null;
  }
  const row = rows[index];
  const node = row.node;
  switch (key) {
    case "ArrowDown":
      return index + 1 < rows.length ? { kind: "focus", path: rows[index + 1].node.path } : null;
    case "ArrowUp":
      return index > 0 ? { kind: "focus", path: rows[index - 1].node.path } : null;
    case "Home":
      return { kind: "focus", path: rows[0].node.path };
    case "End":
      return { kind: "focus", path: rows[rows.length - 1].node.path };
    case "ArrowRight":
      if (!node.dir) return null;
      if (node.children === undefined || !node.open) return { kind: "expand", node };
      return index + 1 < rows.length && rows[index + 1].parentPath === node.path
        ? { kind: "focus", path: rows[index + 1].node.path }
        : null;
    case "ArrowLeft":
      if (node.dir && node.open && node.children) return { kind: "collapse", node };
      return row.parentPath ? { kind: "focus", path: row.parentPath } : null;
    case "Enter":
    case " ":
      return { kind: "activate", node };
    default:
      return null;
  }
}

export function listingMeta(listing: TreeListing): TreeMeta {
  return {
    truncated: !!listing.truncated,
    limit: listing.limit ?? 0,
    unreadable: listing.unreadable ?? 0,
  };
}

/** Honest, bounded copy for a capped or partially unreadable directory. */
export function listingNotice(meta: TreeMeta): string | null {
  const parts: string[] = [];
  if (meta.truncated) {
    parts.push(`Showing the first ${meta.limit} entries; this folder has more.`);
  }
  if (meta.unreadable > 0) {
    parts.push(
      `${meta.unreadable} ${meta.unreadable === 1 ? "entry" : "entries"} could not be read.`,
    );
  }
  return parts.length ? parts.join(" ") : null;
}
