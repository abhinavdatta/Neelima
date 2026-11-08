// Pure multi-tab document store for the native editor — no DOM, no Tauri.
// Checkpoint 3 spec: stable document identity is the canonical workspace-
// relative path (NEVER the basename; two directories may hold files with the
// same name). A document is dirty iff its draft differs from `original`,
// which makes "failed save keeps dirty" and "successful save clears dirty"
// structural facts of the data instead of flags that can desync.

export interface DocRec {
  /** Canonical workspace-relative path — the document identity. */
  path: string;
  /** Exact on-disk text at the moment the document was opened. */
  original: string;
  /** Current draft (the only thing ever submitted to the review gate). */
  draft: string;
}

export const MAX_DOCS = 12;

export function docDirty(doc: DocRec): boolean {
  return doc.draft !== doc.original;
}

export function docName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

export function docDir(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : "";
}

/** Open (or activate) a document by its canonical path. */
export function openDocument(
  docs: DocRec[],
  path: string,
  exactText: string,
): { docs: DocRec[]; active: string; renewed: boolean } {
  const existing = docs.find((d) => d.path === path);
  if (existing) {
    // Identity by path: never a duplicate tab. The existing draft (possibly
    // unsaved) is preserved; the exact text refreshes the diff base ONLY if
    // the doc is clean — a dirty draft must never lose its base silently.
    if (!docDirty(existing) && existing.original !== exactText) {
      return {
        docs: docs.map((d) => (d.path === path ? { ...d, original: exactText, draft: exactText } : d)),
        active: path,
        renewed: false,
      };
    }
    return { docs, active: path, renewed: false };
  }
  if (docs.length >= MAX_DOCS) {
    throw new Error(`At most ${MAX_DOCS} documents can be open at once. Close one to continue.`);
  }
  return { docs: [...docs, { path, original: exactText, draft: exactText }], active: path, renewed: true };
}

export function activateDocument(docs: DocRec[], path: string): string {
  return docs.some((d) => d.path === path) ? path : (docs[docs.length - 1]?.path ?? "");
}

/** Discard one document's draft by dropping the whole document (its view is
 * disposed by the caller — a discarded draft has nothing left to edit). */
export function closeDocument(docs: DocRec[], path: string): string {
  const idx = docs.findIndex((d) => d.path === path);
  const next = docs.filter((d) => d.path !== path);
  if (idx < 0) return docs[docs.length - 1]?.path ?? "";
  // Prefer keeping the previous tab active (natural reading order), else next.
  const fallback = next[idx - 1]?.path ?? next[idx]?.path ?? "";
  return fallback;
}

/** A successful save: the saved snapshot becomes the new clean base for EXACTLY
 * that one document, whatever is active. Other documents are untouched. */
export function docsAfterSave(docs: DocRec[], savedPath: string, savedText: string): DocRec[] {
  return docs.map((d) => (d.path === savedPath ? { ...d, original: savedText, draft: savedText } : d));
}

/** Failed save: no structural change at all — dirty is draft!==original, so it
 * survives, and no code path can have "forgotten" to clear a flag. */
export function docsAfterFailedSave(docs: DocRec[]): DocRec[] {
  return docs;
}

/**
 * Checkpoint 4 (Phase 3P): external-modification conflicts travel from the
 * Rust save command with this marker (see ui.rs SAVE_CONFLICT_PREFIX — the
 * two spellings must stay mirrored).
 */
export const SAVE_CONFLICT_PREFIX = "CONFLICT::";

/** A refused save's recovery step: the document's diff base is rebased onto
 * the latest disk contents while the DRAFT (unsaved work) is preserved. Dirty
 * is structural (draft !== original), so rebasing re-dirty-checks naturally:
 * a draft that now equals the latest disk text simply becomes clean. */
export function docsAfterConflictRebase(docs: DocRec[], path: string, diskText: string): DocRec[] {
  return docs.map((d) => (d.path === path ? { ...d, original: diskText } : d));
}

/** Append the dirty marker context for tab display. */
export function tabLabel(doc: DocRec): string {
  return docDirty(doc) ? `${docName(doc.path)} •` : docName(doc.path);
}

/**
 * Map a keyboard event to a tab action. Bound at window level in FileTree.
 * Inventory check (audit): Ctrl+N global new task, Ctrl+Enter composer,
 * Escape flows, editor Ctrl+F (CodeMirror) — Ctrl+Tab/Ctrl+Shift+Tab/Ctrl+W
 * are unbound. A code review/skill-check in progress (diffEntry open) must
 * never be disturbed, so it suppresses everything including close.
 */
export type TabKeyAction = "cycle-next" | "cycle-prev" | "close-active";

export function tabKeyAction(
  ev: { ctrlKey?: boolean; shiftKey?: boolean; key: string },
  open: boolean,
): TabKeyAction | null {
  if (!open || !ev.ctrlKey) return null;
  const k = ev.key;
  if (k === "Tab") return ev.shiftKey ? "cycle-prev" : "cycle-next";
  if (k.toLowerCase() === "w") return "close-active";
  return null;
}

export function cycleActive(docs: DocRec[], active: string, direction: "next" | "prev"): string {
  if (docs.length < 2) return active;
  const idx = Math.max(0, docs.findIndex((d) => d.path === active));
  const delta = direction === "next" ? 1 : -1;
  const n = docs.length;
  return docs[(idx + delta + n) % n].path;
}
