// Left sidebar: New task / Search / Automations / Plugin Marketplace /
// Projects (rename, remove, open-in-Explorer) / Tasks / Checkpoints / footer.
import { useEffect, useState } from "preact/hooks";
import { resetTask, setState, toast, useStore } from "../store";
import type { TaskMeta, WorkspaceEntry } from "../types";
import { cmd } from "../tauri";
import { Icon } from "./Icon";

function TaskItem({ t }: { t: TaskMeta }) {
  const s = useStore();
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
          <button class="ti-menu icon-button" title="Task options" aria-label={`Options for ${t.title}`} onClick={() => setMenu(!menu)}><Icon name="more" size={16} /></button>
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

export function Sidebar() {
  const s = useStore();
  const [panel, setPanel] = useState<null | "projects" | "history" | "tools">(null);
  const start = () => {
    if (!s.activeWorkspacePath) {
      void addWorkspace();
      return;
    }
    resetTask();
  };
  return (
    <aside class="sidebar">
      <nav class="rail-nav" aria-label="Main navigation">
        <button class="rail-button rail-new" title={s.activeWorkspacePath ? "New task" : "Choose a project folder"} aria-label={s.activeWorkspacePath ? "New task" : "Choose a project folder"} onClick={start}>
          <Icon name="add" />
        </button>
        <button class={`rail-button ${s.view === "search" ? "active" : ""}`} title="Search" aria-label="Search" onClick={() => { setPanel(null); setState({ view: "search" }); }}>
          <Icon name="search" />
        </button>
        <button class={`rail-button ${panel === "tools" ? "active" : ""}`} title="Tools and files" aria-label="Tools and files" onClick={() => setPanel(panel === "tools" ? null : "tools")}>
          <Icon name="grid" />
        </button>
        <button class={`rail-button ${panel === "history" ? "active" : ""}`} title="Projects and recent tasks" aria-label="Projects and recent tasks" onClick={() => setPanel(panel === "history" ? null : "history")}>
          <Icon name="history" />
        </button>
      </nav>
      {panel ? (
        <div class="rail-popover">
          <div class="rail-popover-head">
            <strong>{panel === "history" ? "Projects & recent tasks" : "Workspace tools"}</strong>
            <button class="rail-close icon-button" aria-label="Close panel" onClick={() => setPanel(null)}><Icon name="close" size={16} /></button>
          </div>
          {panel === "history" ? (
            <>
              <div class="rail-popover-section">Projects</div>
              {s.workspaces.map((w) => <ProjectItem key={w.id} w={w} active={s.activeWorkspace === w.id} />)}
              <button class="rail-add" onClick={() => void addWorkspace()}><Icon name="add" size={16} /> Add project folder</button>
              <div class="rail-popover-section">Recent tasks</div>
              {s.tasks.length === 0 ? <div class="side-empty">No tasks yet</div> : null}
              {s.tasks.slice(0, 20).map((t) => <TaskItem key={t.id} t={t} />)}
              {s.activeWorkspacePath ? <Checkpoints /> : null}
            </>
          ) : (
            <>
              <button class="rail-action" onClick={() => { setPanel(null); setState({ view: "files" }); }}>Browse project files</button>
              <button class="rail-action" onClick={() => { setPanel(null); setState({ view: "automations" }); }}>Automations</button>
              <button class="rail-action" onClick={() => { setPanel(null); setState({ view: "marketplace" }); }}>Plugin marketplace</button>
              <button class="rail-action" onClick={() => { setPanel(null); setState({ settingsOpen: true }); }}>Settings</button>
            </>
          )}
        </div>
      ) : null}
      <div class="rail-bottom">
        <button class={`rail-button rail-settings ${s.settingsOpen ? "active" : ""}`} title="Settings" aria-label="Open Settings" aria-expanded={s.settingsOpen} onClick={() => { setPanel(null); setState({ settingsOpen: true }); }}>
          <Icon name="settings" size={19} />
        </button>
        <button class="rail-logo" title="Neelima home" aria-label="Neelima home" onClick={start}>N</button>
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
            <Icon name="folder" class="ic folder" size={16} />
            <span>{w.name}</span>
          </button>
          <button class="pi-menu icon-button" title="Folder options" aria-label={`Options for ${w.name}`} onClick={() => setMenu(!menu)}><Icon name="more" size={16} /></button>
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
        <button class="ghost icon-button" aria-label={open ? "Collapse checkpoints" : "Expand checkpoints"} onClick={() => setOpen(!open)}><Icon name="chevron" size={16} class={open ? "chevron-open" : ""} /></button>
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
                  const preview = await cmd.checkpointRestorePreview(c.id);
                  const confirmed = window.confirm(
                    `Restore checkpoint ${c.id.slice(0, 7)}?\n\n` +
                    `Files in snapshot: ${preview.checkpoint_files}\n` +
                    `Currently tracked files to remove: ${preview.tracked_files_to_remove}\n\n` +
                    "A backup checkpoint will be created first. New untracked files will be preserved."
                  );
                  if (!confirmed) return;
                  const result = await cmd.checkpointRestore(c.id);
                  toast("info", `Restored ${result.restored_files} files; removed ${result.removed_files}. Backup: ${result.backup_checkpoint.slice(0, 7)}.`);
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
