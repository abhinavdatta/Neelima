// Shared tab strip (Phase 3Q-2a). Extracted verbatim from the editor's inline
// `EditorTabs` in FileTree.tsx: same element types, same classes, same ARIA and
// the same keyboard handling (Enter/Space activate; arrows are NOT handled here
// — that is an accessibility change for 3Q-4, not a silent behaviour change).
//
// The close button is optional so a read-only tab strip can reuse this without
// rendering a control it cannot honour.
import { tabBarClass, tabClass } from "../../uiPrimitives";

export interface TabItem {
  /** Stable identity, never the display label. */
  id: string;
  label: string;
  /** Tooltip; callers pass the full path (and dirty hint) where they have it. */
  title?: string;
  dirty?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  active: string;
  ariaLabel: string;
  onActivate: (id: string) => void;
  /** Omit to render a strip without close controls. */
  onClose?: (id: string) => void;
  class?: string;
}

export function Tabs(props: TabsProps) {
  return (
    <div class={tabBarClass(props.class)} role="tablist" aria-label={props.ariaLabel}>
      {props.items.map((item) => (
        <span
          key={item.id}
          role="tab"
          tabIndex={0}
          aria-selected={item.id === props.active}
          title={item.title ?? item.label}
          class={tabClass({ active: item.id === props.active, dirty: item.dirty })}
          onClick={() => props.onActivate(item.id)}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              props.onActivate(item.id);
            }
          }}
        >
          <span class="editor-tab-name">{item.label}</span>
          {item.dirty ? (
            <span class="editor-tab-dot" aria-label="Unsaved changes" title="Unsaved changes">
              ●
            </span>
          ) : null}
          {props.onClose ? (
            <button
              class="editor-tab-close"
              aria-label={`Close ${item.label}${item.dirty ? " (unsaved changes)" : ""}`}
              title="Close tab"
              onClick={(event: any) => {
                event.stopPropagation();
                props.onClose?.(item.id);
              }}
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}

export default Tabs;
