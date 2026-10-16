// Integrated title bar (custom, draggable): nav, task title, view toggle,
// terminal toggle, window controls.
import { setState, useStore } from "../store";
import { cmd } from "../tauri";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function TitleBar() {
  const s = useStore();
  const win = getCurrentWindow();
  const title = s.openTask?.title || (s.activeWorkspacePath ? s.activeWorkspacePath.split(/[\\/]/).pop() : "Neelima");
  const running = s.agentState !== "idle" && s.agentState !== "done" && s.agentState !== "error";

  return (
    <header class="titlebar" data-tauri-drag-region>
      <div class="tb-left">
        <div class="tb-logo">N</div>
        <button class="tb-btn" onClick={() => setState({ view: "chat" })} title="Back">
          <svg viewBox="0 0 16 16"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>
        </button>
        <button class="tb-btn" title="Forward" onClick={() => setState({ view: "provider" })}>
          <svg viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>
        </button>
        <div class="tb-title" data-tauri-drag-region>
          <svg viewBox="0 0 16 16" class="folder-ic"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 6v5A1.5 1.5 0 0 1 13 12.5H3.5A1.5 1.5 0 0 1 2 11V4.5Z" fill="#e8c063" /></svg>
          <span class="tb-title-text">{title}</span>
          <span class="tb-dots">…</span>
        </div>
      </div>

      <div class="tb-right">
        <div class="seg">
          <button class={s.view === "chat" || s.view === "task" ? "seg-on" : ""} onClick={async () => { await cmd.webviewMode("chat"); setState({ view: "chat" }); }}>
            Chat
          </button>
          <button class={s.view === "provider" ? "seg-on" : ""} onClick={async () => {
            setState({ view: "provider" });
            // The pane's own effect auto-mounts the selected profile; nothing to
            // do here besides keeping Rust's stored rect in sync.
            await cmd.webviewMode("provider").catch(() => {});
          }}>
            Provider
          </button>
        </div>
        {running ? (
          <button class="tb-stop" title="Stop the agent (Esc-safe: also Ctrl+Alt+Shift+X)" onClick={() => cmd.taskStop().catch((e) => console.error(e))}>■ Stop</button>
        ) : null}
        <button class="tb-btn" title="Terminal" onClick={() => setState((st) => ({ terminalOpen: !st.terminalOpen }))}>
          <svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" /><path d="M4 6l2.5 2L4 10M8 10h4" stroke="currentColor" fill="none" /></svg>
        </button>
        <button class="tb-btn" title="Minimize" onClick={() => win.minimize()}>─</button>
        <button class="tb-btn" title="Maximize" onClick={() => win.toggleMaximize()}>□</button>
        <button class="tb-btn tb-close" title="Close" onClick={() => win.close()}>✕</button>
      </div>
    </header>
  );
}

export default TitleBar;
