// Left sidebar: New task / Search / Automations / Plugin Marketplace /
// Projects / Tasks / user footer — mirroring the target design.
import { resetTask, setState, toast, useStore } from "../store";
import { cmd } from "../tauri";

export function Sidebar() {
  const s = useStore();
  return (
    <aside class="sidebar">
      <div class="side-head">
        <div class="logo">N</div>
      </div>

      <nav class="side-nav">
        <button
          class={`side-item ${s.view === "chat" ? "active" : ""}`}
          onClick={() => { resetTask(); }}
        >
          <svg viewBox="0 0 16 16" class="ic"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" /><path d="M8 5v6M5 8h6" stroke="currentColor" /></svg>
          <span>New task</span>
          <kbd>Ctrl+N</kbd>
        </button>
        <button class={`side-item ${s.view === "search" ? "active" : ""}`} onClick={() => setState({ view: "search" })}>
          <svg viewBox="0 0 16 16" class="ic"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" /><path d="M10.5 10.5 14 14" stroke="currentColor" /></svg>
          <span>Search</span>
          <kbd>Ctrl+K</kbd>
        </button>
        <button class={`side-item ${s.view === "automations" ? "active" : ""}`} onClick={() => setState({ view: "automations" })}>
          <svg viewBox="0 0 16 16" class="ic"><rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="currentColor" /><path d="M5 7h2M9 7h2M5 10h6" stroke="currentColor" /></svg>
          <span>Automations</span>
        </button>
        <button class={`side-item ${s.view === "marketplace" ? "active" : ""}`} onClick={() => setState({ view: "marketplace" })}>
          <svg viewBox="0 0 16 16" class="ic"><path d="M3 4h10l-1 9H4L3 4Z" fill="none" stroke="currentColor" /><path d="M6 4V3a2 2 0 0 1 4 0v1" fill="none" stroke="currentColor" /></svg>
          <span>Plugin Marketplace</span>
        </button>

        <div class="side-chips">
          <span class="chip"># Group</span>
          <span class="chip chip-solid">Project</span>
          <span class="chip-link">⇅</span>
        </div>

        <div class="side-section">Projects</div>
        <div class="side-list">
          {s.workspaces.map((w) => (
            <button
              class={`project-item ${s.activeWorkspace === w.id ? "active" : ""}`}
              onClick={async () => {
                try {
                  await cmd.workspaceUse(w.id);
                  setState({ activeWorkspace: w.id, activeWorkspacePath: w.path, view: "chat" });
                } catch (e) { toast("error", String(e)); }
              }}
              title={w.path}
            >
              <svg viewBox="0 0 16 16" class="ic folder"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 6v5A1.5 1.5 0 0 1 13 12.5H3.5A1.5 1.5 0 0 1 2 11V4.5Z" fill="#5b8def" /></svg>
              <span>{w.name}</span>
            </button>
          ))}
          <button class="project-item add" onClick={addWorkspace}>+ Add folder</button>
        </div>

        <div class="side-section">Tasks</div>
        <div class="side-list tasks">
          {s.tasks.length === 0 ? <div class="side-empty">No tasks yet</div> : null}
          {s.tasks.slice(0, 30).map((t) => (
            <button
              class="task-item"
              onClick={async () => {
                try {
                  const entries = await cmd.historyOpen(t.id);
                  setState({ entries, openTask: t, view: "task", pendingCalls: [], agentState: t.status === "done" ? "done" : "idle" });
                } catch (e) { toast("error", String(e)); }
              }}
            >
              <span class="task-title">{t.title}</span>
              <span class="task-time">{relTime(t.started_ms)}</span>
            </button>
          ))}
        </div>
      </nav>

      <div class="side-foot">
        <div class="avatar">N</div>
        <span class="side-user">Local user</span>
        <button class="ghost" title="Settings" onClick={() => setState({ settingsOpen: true })}>⚙</button>
      </div>
    </aside>
  );
}

export async function addWorkspace() {
  const path = await cmd.pickWorkspace();
  if (!path) return;
  try {
    const r = await cmd.workspaceAdd(path);
    const wl = await cmd.workspaceList();
    const active = wl.workspaces.find((w: any) => w.id === wl.active);
    const settings = await cmd.settingsGet();
    setState({ workspaces: wl.workspaces, activeWorkspace: wl.active, activeWorkspacePath: active?.path ?? null, settings });
    toast("info", `Workspace: ${r.name}`);
  } catch (e) { toast("error", String(e)); }
}

function relTime(ms: number): string {
  const d = Date.now() - ms;
  const m = Math.floor(d / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export default Sidebar;
