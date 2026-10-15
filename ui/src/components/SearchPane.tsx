// Search: task history search (title + workspace).
import { useState } from "preact/hooks";
import { setState, toast, useStore } from "../store";
import { cmd } from "../tauri";

export function SearchPane() {
  const s = useStore();
  const [q, setQ] = useState("");

  const run = async () => {
    try {
      const results = q.trim() ? await cmd.searchTasks(q) : await cmd.historyTasks();
      setState({ searchResults: results });
    } catch (e) { toast("error", String(e)); }
  };

  return (
    <div class="pane">
      <h2>Search</h2>
      <div class="add-form">
        <input
          autoFocus
          placeholder="Search tasks…"
          value={q}
          onInput={(e: any) => setQ(e.currentTarget.value)}
          onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter") run(); }}
        />
        <button class="btn-ok" onClick={run}>Search</button>
      </div>
      <div class="card">
        {(s.searchResults.length ? s.searchResults : s.tasks).slice(0, 50).map((t) => (
          <div class="row-item" key={t.id}>
            <button class="link" onClick={async () => {
              const entries = await cmd.historyOpen(t.id);
              setState({ entries, openTask: t, view: "task", pendingCalls: [] });
            }}>{t.title}</button>
            <span class="dim">{t.workspace} · {t.status} · {new Date(t.started_ms).toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default SearchPane;
