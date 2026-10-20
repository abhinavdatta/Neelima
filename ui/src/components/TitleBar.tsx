import { setState, useStore, toast } from "../store";
import { cmd } from "../tauri";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon } from "./Icon";

export function TitleBar() {
  const s = useStore();
  const workspace = s.activeWorkspacePath?.split(/[\\/]/).pop() ?? "Choose a project to begin";
  const running = s.agentState !== "idle" && s.agentState !== "done" && s.agentState !== "error";

  return (
    <header class="titlebar">
      <div class="titlebar-drag-region" data-tauri-drag-region aria-hidden="true" />
      <div class="topbar-left">
        <button class="assistant-select" title="Open Settings" aria-label="Open Settings" onClick={() => setState({ settingsOpen: true })}>
          <span class="assistant-gear"><Icon name="settings" size={15} /></span>
          <span>Neelima</span>
          <Icon class="assistant-chevron" name="chevron" size={12} />
        </button>
      </div>
      <div class="topbar-context">{s.view === "chat" ? workspace : viewLabel(s.view)}</div>
      <div class="topbar-right">
        {running ? <button class="topbar-stop" onClick={() => cmd.taskStop().catch((e) => toast("error", String(e)))}>Stop</button> : null}
        <button class="window-button terminal-control" title="Terminal" onClick={() => setState({ terminalOpen: !s.terminalOpen })}>
          <Icon name="terminal" size={16} />
        </button>
        <button class="window-button" title="Minimize" aria-label="Minimize" onClick={() => windowAction("minimize")}><Icon name="minimize" size={14} /></button>
        <button class="window-button" title="Maximize" aria-label="Maximize or restore" onClick={() => windowAction("toggleMaximize")}><Icon name="maximize" size={14} /></button>
        <button class="window-button window-close" title="Close" aria-label="Close window" onClick={() => windowAction("close")}><Icon name="close" size={14} /></button>
      </div>
    </header>
  );
}

export function WindowMoveStrip() {
  const beginMove = () => {
    try {
      getCurrentWindow().startDragging().catch((error) => toast("error", `Could not move window: ${String(error)}`));
    } catch (error) {
      toast("error", `Window movement is available only inside the Neelima desktop app: ${String(error)}`);
    }
  };

  return (
    <div class="window-move-strip">
      <button
        type="button"
        class="window-move-button"
        title="Drag to move window"
        aria-label="Move window. Press and drag this control."
        onMouseDown={(event: MouseEvent) => { if (event.button === 0) beginMove(); }}
        onTouchStart={beginMove}
      >
        <Icon name="move" size={13} />
        <span>Move window</span>
      </button>
    </div>
  );
}

function windowAction(action: "minimize" | "toggleMaximize" | "close") {
  try {
    const win = getCurrentWindow();
    const result = action === "minimize" ? win.minimize() : action === "toggleMaximize" ? win.toggleMaximize() : win.close();
    result.catch((error) => toast("error", `Window ${action} failed: ${String(error)}`));
  } catch (error) {
    toast("error", `Window ${action} is available only inside the Neelima desktop app: ${String(error)}`);
  }
}

function viewLabel(view: string) {
  return ({
    provider: "Provider sign-in",
    automations: "Automations",
    marketplace: "Plugin marketplace",
    search: "Search your task history",
    task: "Past task · read only",
    files: "Project files",
  } as Record<string, string>)[view] ?? "Neelima";
}

export default TitleBar;
