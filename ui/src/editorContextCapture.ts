// Checkpoint 9 (Phase 3P) — read the live selection from the active editor.
//
// The editor keeps its CodeMirror view internal (one hidden-but-mounted view
// per document), so the share button asks the DOM for the current view instead
// of duplicating editor state. When no range is selected the caller shares the
// whole current buffer. `null` here means "no selection", never "empty file".
import type { EditorSelectionSnapshot } from "./editorContext";
import { lineNumberAt } from "./editorContext";

/** Locate the mounted editor wrapper for a canonical workspace-relative path. */
export function findEditorRoot(path: string, root: ParentNode): HTMLElement | null {
  const candidates = Array.from(root.querySelectorAll(".doc-editor")) as HTMLElement[];
  return candidates.find((element) => element.getAttribute("data-doc-path") === path) ?? null;
}

/**
 * Read the current selection from `root` (the `.doc-editor` wrapper) against
 * the exact draft supplied by the caller. A collapsed selection is `null`.
 * The range is validated against the draft length, so a stale view can never
 * produce offsets that point outside the text that will be attached.
 */
export async function captureEditorSelection(
  path: string,
  draft: string,
  root: ParentNode | null,
): Promise<EditorSelectionSnapshot | null> {
  if (!root) return null;

  let from = 0;
  let to = 0;

  const textarea = root.querySelector("textarea.file-editor") as HTMLTextAreaElement | null;
  if (textarea) {
    from = Math.min(textarea.selectionStart ?? 0, textarea.selectionEnd ?? 0);
    to = Math.max(textarea.selectionStart ?? 0, textarea.selectionEnd ?? 0);
  } else {
    const cm = root.querySelector(".cm-editor") as HTMLElement | null;
    if (!cm) return null;
    // Loaded only when the user actually shares; CodeMirror already ships for
    // the editor, so this is not a second editor dependency.
    const { EditorView } = await import("@codemirror/view");
    const view = EditorView.findFromDOM(cm);
    if (!view) return null;
    const main = view.state.selection.main;
    from = main.from;
    to = main.to;
  }

  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  if (from < 0 || to <= from || to > draft.length) return null;
  if (draft.slice(from, to).length === 0) return null;

  return {
    path,
    from,
    to,
    startLine: lineNumberAt(draft, from),
    endLine: lineNumberAt(draft, to - 1),
    text: draft.slice(from, to),
  };
}
