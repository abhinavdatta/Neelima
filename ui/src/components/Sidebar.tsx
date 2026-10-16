// Left sidebar: New task / Search / Automations / Plugin Marketplace /
// Projects (rename, remove, open-in-Explorer) / Tasks / Checkpoints / footer.
import { useEffect, useState } from "preact/hooks";
import { resetTask, setState, toast, useStore } from "../store";
import type { WorkspaceEntry } from "../types";
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
          {s.workspaces.map((w) => <ProjectItem key={w.id} w={w} active={s.activeWorkspace === w.id} />)}
          <button class="project-item add" onClick={addWorkspace}>+ Add folder</button>
        </div>

        <div class="side-section">Tasks</div>
        <div class="side-list tasks">
          {s.tasks.length === 0 ? <div class="side-empty">No tasks yet</div> : null}
          {s.tasks.slice(0, 30).map((t) => <TaskItem key={t.id} t={t} />)}
        </div>
        {s.activeWorkspacePath ? <Checkpoints /> : null}

function TaskItem({ t }: { t: TaskMeta }) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(t.title);

  const open = async () => {
    try {
      const entries = await cmd.historyOpen(t.id);
      setState({ entries, openTask: t, view: "task", pendingCalls: [], agentState: t.status === "done" ? "done" : "idle" });
    } catch (e) { toast("error", String(e)); }
  };

  const rename = async () => {
    setRenaming(false);
    const title = draft.trim();
    if (!title || title === t.title) return;
    try {
      await cmd.taskRename(t.id, title);
      const tl = await cmd.historyTasks();
      setState({ tasks: tl });
      toast("info", `Renamed to "${title}"`);
    } catch (e) { toast("error", String(e)); }
  };

  const remove = async () => {
    if (!window.confirm(`Delete task "${t.title}"? This cannot be undone.`)) return;
    try {
      await cmd.taskDelete(t.id);
      const tl = await cmd.historyTasks();
      setState({ tasks: tl });
      if (s.openTask?.id === t.id) setState({ openTask: null, entries: [], view: "chat" });
      toast("info", `Deleted "${t.title}"`);
    } catch (e) { toast("error", String(e)); }
  };

  return (
    <div class={`task-item ${menu ? "active" : ""}`}>
      {renaming ? (
        <input
          class="rename-input"
          value={draft}
          autoFocus
          onInput={(e: any) => setDraft(e.currentTarget.value)}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "Enter") rename();
            if (e.key === "Escape") setRenaming(false);
          }}
          onBlur={rename}
        />
      ) : (
        <>
          <button class="ti-open" onClick={open} title={t.title}>
            <span class="task-title">{t.title}</span>
            <span class="task-time">{relTime(t.started_ms)}</span>
          </button>
          <button class="ti-menu" title="Task options" onClick={() => setMenu(!menu)}>⋯</button>
        </>
      )}
      {menu ? (
        <div class="ti-menu-pop">
          <button onClick={() => { setMenu(false); setRenaming(true); }}>Rename</button>
          <button class="danger" onClick={remove}>Delete</button>
        </div>
      ) : null}
    </div>
  );
}
      </nav>

      <div class="side-foot">
        <div class="avatar">N</div>
        <span class="side-user">Local user</span>
        <button class="ghost" title="Settings" onClick={() => setState({ settingsOpen: true })}>⚙</button>
      </div>
    </aside>
  );
}

function ProjectItem({ w, active }: { w: WorkspaceEntry; active: boolean }) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(w.name);

  const open = async () => {
    try {
      await cmd.workspaceUse(w.id);
      setState({ activeWorkspace: w.id, activeWorkspacePath: w.path, view: "chat" });
    } catch (e) { toast("error", String(e)); }
  };

  const rename = async () => {
    setRenaming(false);
    const name = draft.trim();
    if (!name || name === w.name) return;
    try {
      await cmd.workspaceRename(w.id, name);
      const wl = await cmd.workspaceList();
      setState({ workspaces: wl.workspaces });
      toast("info", `Renamed to "${name}"`);
    } catch (e) { toast("error", String(e)); }
  };

  const remove = async () => {
    try {
      await cmd.workspaceRemove(w.id);
      const wl = await cmd.workspaceList();
      setState({
        workspaces: wl.workspaces,
        activeWorkspace: wl.active,
        activeWorkspacePath: wl.workspaces.find((x: any) => x.id === wl.active)?.path ?? null,
      });
      toast("info", `Removed "${w.name}" from the project list (files on disk untouched).`);
    } catch (e) { toast("error", String(e)); }
  };

  return (
    <div class={`project-item ${active ? "active" : ""}`}>
      {renaming ? (
        <input
          class="rename-input"
          value={draft}
          autoFocus
          onInput={(e: any) => setDraft(e.currentTarget.value)}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "Enter") rename();
            if (e.key === "Escape") setRenaming(false);
          }}
          onBlur={rename}
        />
      ) : (
        <>
          <button class="pi-open" onClick={open} title={w.path}>
            <svg viewBox="0 0 16 16" class="ic folder"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 6v5A1.5 1.5 0 0 1 13 12.5H3.5A1.5 1.5 0 0 1 2 11V4.5Z" fill="#5b8def" /></svg>
            <span>{w.name}</span>
          </button>
          <button class="pi-menu" title="Folder options" onClick={() => setMenu(!menu)}>⋯</button>
        </>
      )}
      {menu ? (
        <div class="pi-menu-pop">
          <button onClick={() => { setMenu(false); setRenaming(true); }}>Rename</button>
          <button onClick={async () => { setMenu(false); try { await cmd.workspaceOpenInExplorer(w.id); } catch (e) { toast("error", String(e)); } }}>Open in Explorer</button>
          <button class="danger" onClick={remove}>Remove from list</button>
        </div>
      ) : null}
    </div>
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

function Checkpoints() {
  const [list, setList] = useState<any[]>([]);
  const [open, setOpen] = useState(false);

  const refresh = async () => {
    try { setList(await cmd.checkpoints()); } catch { /* workspace git missing */ }
  };

  useEffect(() => { if (open) refresh(); }, [open]);

  return (
    <>
      <div class="side-section cp-head">
        <span>Checkpoints</span>
        <button class="ghost" onClick={() => setOpen(!open)}>{open ? "▾" : "▸"}</button>
      </div>
      {open ? (
        <div class="side-list checkpoints">
          {list.length === 0 ? <div class="side-empty">No checkpoints yet</div> : null}
          {list.slice(0, 12).map((c) => (
            <div class="cp-item" key={c.id}>
              <span class="cp-label" title={c.label}>{c.label || c.id}</span>
              <span class="cp-id">{c.id.slice(0, 7)}</span>
              <button class="ghost" title="Restore this snapshot" onClick={async () => {
                try {
                  await cmd.checkpointRestore(c.id);
                  toast("info", `Restored checkpoint ${c.id.slice(0, 7)}`);
                  refresh();
                } catch (e) { toast("error", String(e)); }
              }}>restore</button>
            </div>
          ))}
          <button class="project-item add" onClick={async () => {
            try { await cmd.checkpointCreate("manual"); await refresh(); } catch (e) { toast("error", String(e)); }
          }}>+ Snapshot now</button>
        </div>
      ) : null}
    </>
  );
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
