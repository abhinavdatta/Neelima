// Diff viewer: CodeMirror 6 @codemirror/merge, lazily imported on first open.
import { useEffect, useRef } from "preact/hooks";
import { setState, useStore } from "../store";
import { cmd } from "../tauri";

export function DiffModal() {
  const s = useStore();
  const hostRef = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);

  useEffect(() => {
    const d = s.diffEntry;
    if (!d || !hostRef.current) return;
    (async () => {
      let doc: { path: string; old: string; new: string } | null = null;
      if (d.entryId >= 0 && d.taskId) {
        doc = await cmd.diffGet(d.taskId, d.entryId).catch(() => null);
      } else if ((d as any).preview) {
        doc = (d as any).preview;
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

  if (!s.diffEntry) return null;
  return (
    <div class="modal-backdrop" onClick={() => setState({ diffEntry: null })}>
      <div class="modal diff-modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-head">
          <h2>Proposed change</h2>
          <button class="ghost" onClick={() => setState({ diffEntry: null })}>✕</button>
        </div>
        <div class="diff-host" ref={hostRef} />
      </div>
    </div>
  );
}

export default DiffModal;
