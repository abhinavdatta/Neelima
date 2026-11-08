// Diff viewer: CodeMirror 6 @codemirror/merge, lazily imported on first open.
// Also the confirmation surface for a native editor save: when the entry
// carries `apply`, the user must read the diff and press Apply before any byte
// is written, exactly like an agent-proposed edit.
import { useEffect, useRef, useState } from "preact/hooks";
import { setState, toast, useStore } from "../store";
import { cmd } from "../tauri";
import { Button, IconButton } from "./ui";

export function DiffModal() {
  const s = useStore();
  const hostRef = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    const d = s.diffEntry;
    if (!d || !hostRef.current) return;
    (async () => {
      let doc: { path: string; old: string; new: string } | null = null;
      if (d.entryId >= 0 && d.taskId) {
        doc = await cmd.diffGet(d.taskId, d.entryId).catch(() => null);
      } else if (d.preview) {
        doc = d.preview;
      }
      if (!doc || !hostRef.current) return;
      hostRef.current.innerHTML = "";
      const [{ MergeView }, { EditorView }] = await Promise.all([
        import("@codemirror/merge"),
        import("@codemirror/view"),
      ]);
      new MergeView({
        a: { doc: doc.old || "" },
        b: { doc: doc.new || "" },
        parent: hostRef.current,
        gutter: true,
      });
      void EditorView;
      loaded.current = true;
    })();
  }, [s.diffEntry]);

  useEffect(() => setApplying(false), [s.diffEntry]);

  if (!s.diffEntry) return null;
  const preview = s.diffEntry.preview;
  const close = () => setState({ diffEntry: null });
  const apply = async () => {
    if (!preview?.apply || applying) return;
    setApplying(true);
    try {
      await preview.apply();
      close();
    } catch (error) {
      toast("error", String(error));
      setApplying(false);
    }
  };
  return (
    <div class="modal-backdrop" onClick={close}>
      <div class="modal diff-modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-head">
          <h2>{preview ? "Review change" : "Proposed change"}</h2>
          <IconButton icon="close" label="Close diff" onClick={close} />
        </div>
        <div class="diff-host" ref={hostRef} />
        {preview ? (
          <footer class="diff-actions">
            <span class="diff-path" title={preview.path}>{preview.path}</span>
            <Button variant="secondary" onClick={close} disabled={applying}>Cancel</Button>
            {preview.apply ? (
              <Button variant="primary" onClick={() => void apply()} disabled={applying}>
                {applying ? "Saving…" : "Apply change"}
              </Button>
            ) : null}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

export default DiffModal;
