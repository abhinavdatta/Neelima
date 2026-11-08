// Pure helpers connecting verified agent writes to the coding workspace
// (Checkpoint 6). The backend emits `file-changed` only after a real tool
// outcome whose disk read-back succeeded; nothing here may be driven by a
// model's success claim.
//
// • appendAgentChange dedupes by task/call/path, so a replayed event cannot
//   refresh twice or mark a file twice.
// • refreshDirFor picks the deepest ALREADY-EXPANDED ancestor, so a change
//   never triggers a full-tree walk and never loads an unrelated directory.
// • mergeListing merges a targeted directory listing while preserving the
//   expansion state of everything below it (applyListing intentionally
//   replaces a directory's children and is only safe for full refreshes).
// • reconcileDocAfterExternalWrite reloads a CLEAN document from disk and
//   never touches a dirty draft.
import type { DocRec } from "./editorTabs";
import { docDir, docDirty } from "./editorTabs";
import { listingMeta, replaceNode } from "./fileTree";
import type { TreeListing, TreeNode } from "./fileTree";

export interface AgentChange {
  /** Stable identity for dedupe: task + call occurrence + path. */
  key: string;
  taskId: string;
  callId: string;
  actionId: string | null;
  tool: string;
  /** Canonical workspace-relative path (full path, never just a basename). */
  path: string;
  /** Workspace root the write happened in; other trees must ignore it. */
  workspace: string;
  at: number;
}

/** Validate one `file-changed` event. Unverified payloads are refused. */
export function parseFileChanged(p: any, now: number = Date.now()): AgentChange | null {
  if (!p || p.kind !== "file-changed") return null;
  if (p.verified !== true) return null;
  if (typeof p.task_id !== "string" || !p.task_id) return null;
  if (typeof p.path !== "string" || !p.path) return null;
  if (typeof p.workspace !== "string" || !p.workspace) return null;
  const callId = typeof p.call_id === "string" ? p.call_id : "";
  const tool = typeof p.tool === "string" ? p.tool : "";
  return {
    key: `${p.task_id}:${callId}:${p.path}`,
    taskId: p.task_id,
    callId,
    actionId: typeof p.action_id === "string" && p.action_id ? p.action_id : null,
    tool,
    path: p.path,
    workspace: p.workspace,
    at: now,
  };
}

/** Append unless this exact change was already seen; bounded history. */
export function appendAgentChange(
  list: AgentChange[],
  change: AgentChange,
  limit = 100,
): AgentChange[] {
  if (list.some((c) => c.key === change.key)) return list;
  return [...list, change].slice(-limit);
}

/**
 * The deepest expanded directory that contains `path` (the workspace root ""
 * when none is deeper). This is the only directory whose listing must be
 * refreshed for the changed file to appear.
 */
export function refreshDirFor(path: string, expanded: string[]): string {
  const parent = docDir(path);
  let best = "";
  for (const dir of expanded) {
    if (!dir || dir.length <= best.length) continue;
    if (parent === dir || parent.startsWith(`${dir}/`) || parent.startsWith(`${dir}\\`)) {
      best = dir;
    }
  }
  return best;
}

/**
 * Merge one directory listing into the tree, REUSING existing nodes (and
 * therefore their open/children state) for entries that still exist. New
 * entries are added, vanished entries are dropped, metadata is refreshed.
 */
export function mergeListing(nodes: TreeNode[], listing: TreeListing): TreeNode[] {
  const reuse = (existing: TreeNode[], entries: TreeListing["entries"]): TreeNode[] => {
    const before = new Map(existing.map((node) => [node.path, node]));
    return entries.map((entry) => {
      const previous = before.get(entry.path);
      if (previous && previous.dir === entry.dir) {
        return { ...previous, name: entry.name };
      }
      return { ...entry, children: entry.dir ? undefined : [] };
    });
  };
  const meta = listingMeta(listing);
  if (!listing.path) return reuse(nodes, listing.entries);
  return replaceNode(nodes, listing.path, (node) => ({
    ...node,
    children: reuse(node.children ?? [], listing.entries),
    open: true,
    error: undefined,
    truncated: meta.truncated,
    limit: meta.limit,
    unreadable: meta.unreadable,
  }));
}

/**
 * Reconcile one open document after the agent wrote its file.
 *
 * A clean document (draft === original) is reloaded to the new on-disk text:
 * it had no unsaved work, so the new content is the only truth. A dirty
 * document keeps its draft untouched — discarding unsaved work would be data
 * loss — and reports `conflict`, so the caller can warn the user; the existing
 * save conflict path will rebase the diff when they save.
 */
export function reconcileDocAfterExternalWrite(
  doc: DocRec,
  diskText: string,
): { doc: DocRec; reloaded: boolean; conflict: boolean } {
  if (docDirty(doc)) return { doc, reloaded: false, conflict: true };
  if (doc.original === diskText && doc.draft === diskText) {
    return { doc, reloaded: false, conflict: false };
  }
  return {
    doc: { ...doc, original: diskText, draft: diskText },
    reloaded: true,
    conflict: false,
  };
}

/**
 * Reconcile ONE path across all open documents: only the matching document
 * may change, other tabs and their drafts are returned untouched. Missing
 * documents are a no-op.
 */
export function reconcileDocsAfterExternalWrite(
  docs: DocRec[],
  path: string,
  diskText: string,
): { docs: DocRec[]; reloaded: boolean; conflict: boolean } {
  const index = docs.findIndex((doc) => doc.path === path);
  if (index < 0) return { docs, reloaded: false, conflict: false };
  const result = reconcileDocAfterExternalWrite(docs[index], diskText);
  if (!result.reloaded) return { docs, reloaded: false, conflict: result.conflict };
  return {
    docs: docs.map((doc, i) => (i === index ? result.doc : doc)),
    reloaded: true,
    conflict: false,
  };
}

/** Human-readable provenance for a marked row/tab. */
export function changeSummary(change: AgentChange): string {
  const call = change.callId ? ` · call ${change.callId}` : "";
  const action = change.actionId ? ` · action ${change.actionId}` : "";
  return `Changed by the agent (${change.tool || "write"})${call}${action}`;
}
