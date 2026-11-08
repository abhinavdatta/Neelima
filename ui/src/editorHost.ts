// Framework-free CodeMirror host controller for the native editor.
// One EditorView per open document; the document text stays the single source
// of truth in the caller (FileTree's draft), which keeps the existing
// diff-gated save flow byte-for-byte: the editor never writes anything itself.
import type { Extension } from "@codemirror/state";
import { buildEditorExtensions, languageIdForFilename, loadLanguageSupport } from "./editorSetup.ts";

export interface EditorHostHandle {
  view: import("@codemirror/view").EditorView;
  languageId: ReturnType<typeof languageIdForFilename>;
  /** Replace the whole document (external value change, e.g. cancel/revert). */
  setText(text: string): void;
  focus(): void;
  destroy(): void;
}

export interface EditorHostOptions {
  path: string;
  value: string;
  readOnly?: boolean;
  /** Called with the current text whenever the user edits the document. */
  onInput: (text: string) => void;
}

/**
 * Create an editor host inside `host`. The returned handle must eventually be
 * `destroy()`ed; `destroy()` disposes the EditorView and everything attached
 * to it, and clears the host container.
 */
export async function createEditorHost(
  host: HTMLElement,
  options: EditorHostOptions,
): Promise<EditorHostHandle> {
  const { EditorState } = await import("@codemirror/state");
  const { EditorView } = await import("@codemirror/view");

  const languageId = languageIdForFilename(options.path);

  // External value syncs (cancel/revert) are marked so the listener never
  // echoes them back as user edits — a reverted draft must stay reverted.
  let insideExternalSync = false;
  const listener = EditorView.updateListener.of((update: any) => {
    if (!update.docChanged || insideExternalSync) return;
    options.onInput(update.state.doc.toString());
  });

  const base = await buildEditorExtensions({
    readOnly: options.readOnly,
    ariaLabel: `Editing ${options.path}`,
  });
  const language = await loadLanguageSupport(languageId);
  const extensions: Extension[] = language ? [...base, language] : base;
  extensions.push(listener);

  const view = new EditorView({
    state: EditorState.create({ doc: options.value, extensions }),
    parent: host,
  });

  // Reachable handle for tests/labels: the contenteditable element.
  const content = host.querySelector(".cm-content") as HTMLElement | null;
  if (content && !content.id) content.id = "neelima-native-editor-content";
  if (content) content.setAttribute("role", "textbox");

  return {
    view,
    languageId,
    setText(text: string): void {
      insideExternalSync = true;
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      } finally {
        insideExternalSync = false;
      }
    },
    focus(): void {
      view.focus();
    },
    destroy(): void {
      view.destroy();
      host.innerHTML = "";
    },
  };
}
