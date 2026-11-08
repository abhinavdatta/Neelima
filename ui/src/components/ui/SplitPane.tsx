// Phase 3Q-2b — resizable splitter between the explorer and the editor.
//
// One consumer (the Files workspace), so this is deliberately small: a 4 px
// separator that is draggable with the pointer and adjustable from the keyboard.
// All math lives in splitPane.ts; this component only renders and routes input.
//
// Accessibility: the handle is a real `role="separator"` with a name, value and
// bounds, focusable and operable with the arrow keys (Home/End jump to the
// limits). Double-click resets to the default width, which is also the only way
// back if a drag ends somewhere unexpected.
import { useRef } from "preact/hooks";
import { splitWidthForKey, splitWidthForDrag } from "../../splitPane";
import type { SplitBounds } from "../../splitPane";

export interface SplitPaneProps {
  width: number;
  bounds: SplitBounds;
  /** Live width while dragging/resizing. */
  onWidth: (width: number) => void;
  /** Called once per gesture so the width is persisted, not streamed. */
  onCommit?: (width: number) => void;
  /** Double-click target. */
  defaultWidth: number;
  label: string;
}

export function SplitPane(props: SplitPaneProps) {
  const drag = useRef<{ startWidth: number; startX: number; last: number } | null>(null);

  const finish = () => {
    const current = drag.current;
    drag.current = null;
    if (current) props.onCommit?.(current.last);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
  };

  const onMove = (event: PointerEvent) => {
    const current = drag.current;
    if (!current) return;
    current.last = splitWidthForDrag(current.startWidth, current.startX, event.clientX, props.bounds);
    props.onWidth(current.last);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { startWidth: props.width, startX: event.clientX, last: props.width };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const next = splitWidthForKey(event.key, props.width, props.bounds);
    if (next === null) return;
    event.preventDefault();
    props.onWidth(next);
    props.onCommit?.(next);
  };

  return (
    <div
      class="fw-split"
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuenow={Math.round(props.width)}
      aria-valuemin={props.bounds.min}
      aria-valuemax={props.bounds.max}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDblClick={() => {
        props.onWidth(props.defaultWidth);
        props.onCommit?.(props.defaultWidth);
      }}
    />
  );
}

export default SplitPane;
