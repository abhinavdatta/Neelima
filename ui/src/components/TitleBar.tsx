import { setState, useStore, toast } from "../store";
import { cmd } from "../tauri";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function TitleBar() {
  const s = useStore();
  const workspace = s.activeWorkspacePath?.split(/[\\/]/).pop() ?? "Choose a project to begin";
  const running = s.agentState !== "idle" && s.agentState !== "done" && s.agentState !== "error";

  return (
    <header class="titlebar">
      <div class="topbar-left">
        <button class="assistant-select" title="Open settings" onClick={() => setState({ settingsOpen: true })}>
          <span class="assistant-gear">⚙</span>
          <span>Assistant v2.6</span>
          <svg class="assistant-chevron" viewBox="0 0 12 12"><path d="m3 4.5 3 3 3-3" /></svg>
        </button>
      </div>
      <div class="topbar-context" data-tauri-drag-region>{s.view === "chat" ? workspace : viewLabel(s.view)}</div>
      <div class="topbar-right">
        {running ? <button class="topbar-stop" onClick={() => cmd.taskStop().catch((e) => toast("error", String(e)))}>Stop</button> : null}
        <button class="upgrade-button" title="Open provider and app settings" onClick={() => {
          setState({ settingsOpen: true });
          toast("info", "Neelima has no paid plan. Configure your providers and app preferences in Settings.");
        }}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 11.8 8l5.7 2-5.7 2L10 17.5 8.2 12l-5.7-2 5.7-2L10 2.5Z" /><path d="m16 2 .7 2.1L19 5l-2.3.8L16 8l-.8-2.2L13 5l2.2-.9L16 2Z" /></svg>
          Upgrade
        </button>
        <button class="window-button terminal-control" title="Terminal" onClick={() => setState({ terminalOpen: !s.terminalOpen })}>
          <svg viewBox="0 0 20 20"><rect x="2.5" y="3" width="15" height="14" rx="3" /><path d="m6 8 2.2 2-2.2 2M10.5 12h3" /></svg>
        </button>
        <button class="window-button" title="Minimize" onClick={() => windowAction("minimize")}>−</button>
        <button class="window-button" title="Maximize" onClick={() => windowAction("toggleMaximize")}>□</button>
        <button class="window-button window-close" title="Close" onClick={() => windowAction("close")}>×</button>
      </div>
    </header>
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
    provider: "Your connected AI workspace",
    automations: "Automations",
    marketplace: "Plugin marketplace",
    search: "Search your task history",
    task: "Past task · read only",
    files: "Project files",
  } as Record<string, string>)[view] ?? "Neelima";
}

export default TitleBar;
