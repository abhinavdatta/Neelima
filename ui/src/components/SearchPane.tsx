// Search: task history search (title + workspace).
import { useState } from "preact/hooks";
import { setState, toast, useStore } from "../store";
import { cmd } from "../tauri";

export function SearchPane() {
  const s = useStore();
  const [q, setQ] = useState("");
  const [searched, setSearched] = useState(false);

  const run = async () => {
    try {
      const query = q.trim();
      const results = query ? await cmd.searchTasks(query) : await cmd.historyTasks();
      setState({ searchResults: results, searchQuery: query });
      setSearched(true);
    } catch (e) { toast("error", String(e)); }
  };
  const results = searched ? s.searchResults : s.tasks;

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
        {searched && results.length === 0 ? (
          <div class="search-empty">
            <p class="dim">{s.searchQuery ? `No tasks matched “${s.searchQuery}”.` : "No task history yet."}</p>
            {s.searchQuery ? <button class="ghost" onClick={() => { setQ(""); setState({ searchQuery: "", searchResults: [] }); setSearched(false); }}>Clear search</button> : <button class="ghost" onClick={() => setState({ view: "chat" })}>Start a task</button>}
          </div>
        ) : null}
        {!searched && results.length === 0 ? <div class="search-empty"><p class="dim">No task history yet.</p><button class="ghost" onClick={() => setState({ view: "chat" })}>Start a task</button></div> : null}
        {results.slice(0, 50).map((t) => (
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
