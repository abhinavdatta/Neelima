// Native CodeMirror 6 editor for the file-review surface.
// Thin Preact glue over editorHost.ts: the document text remains the caller's
// draft state, so the existing DiffModal review gate and ui_file_save flow are
// untouched. One instance stays mounted per open document tab (FileTree keeps
// inactive tabs hidden-but-mounted, which preserves cursor/selection/scroll
// inside the view itself); each instance is destroyed on unmount. Focus is
// claimed only when the tab becomes visible, lazy-loaded because CodeMirror
// (and every language pack) lives in its own chunks.
import { useEffect, useRef, useState } from "preact/hooks";
import { createEditorHost } from "../editorHost";
import type { EditorHostHandle } from "../editorHost";

export interface NativeEditorProps {
  path: string;
  /** The exact full on-disk text (or current draft) — complete file only. */
  value: string;
  /** User edits flow here into the existing draft state (review gate unchanged). */
  onInput: (text: string) => void;
  /** Whether this document's tab is active; only then may the view take focus. */
  visible?: boolean;
  readOnly?: boolean;
}

export function NativeEditor(props: NativeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<EditorHostHandle | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const focusedVisible = useRef(false);

  useEffect(() => {
    let disposed = false;
    const host = hostRef.current;
    if (!host) return;
    (async () => {
      try {
        const handle = await createEditorHost(host, {
          path: props.path,
          value: props.value,
          readOnly: props.readOnly,
          onInput: props.onInput,
        });
        if (disposed) {
          handle.destroy();
          return;
        }
        handleRef.current = handle;
        if (props.visible) {
          handle.focus();
          focusedVisible.current = true;
        }
      } catch (error) {
        setFailed(String(error));
      }
    })();
    return () => {
      disposed = true;
      handleRef.current?.destroy();
      handleRef.current = null;
    };
    // Mount stays per document; edits sync through the effects below, never
    // through remounting, so tab switches never rebuild the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path, props.readOnly]);

  // Activation: claim focus exactly once per activation; hidden documents
  // never steal focus.
  useEffect(() => {
    if (!props.visible) { focusedVisible.current = false; return; }
    if (focusedVisible.current) return;
    const handle = handleRef.current;
    if (handle) {
      handle.focus();
      focusedVisible.current = true;
    }
  }, [props.visible, props.path]);

  // External value changes (cancel/revert/save-routed text) replace the
  // document; user edits arrive through onInput and must not round-trip back.
  useEffect(() => {
    const handle = handleRef.current;
    if (handle && handle.view.state.doc.toString() !== props.value) {
      handle.setText(props.value);
    }
  }, [props.value]);

  if (failed) {
    return (
      <div class="file-editor-host file-editor-fallback" role="alert">
        <p>CodeMirror failed to load; editing stays available in plain text.</p>
      </div>
    );
  }
  return <div class="file-editor-host" ref={hostRef} />;
}

export default NativeEditor;
