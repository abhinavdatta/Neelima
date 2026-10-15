// Settings: connect providers (web accounts, Ollama, LM Studio), permission
// mode, hotkey, shell, limits. Saved as plain JSON in the app config dir.
import { useEffect, useState } from "preact/hooks";
import { setState, toast, useStore } from "../store";
import { cmd } from "../tauri";
import type { Settings } from "../types";

export function SettingsModal() {
  const s = useStore();
  const [draft, setDraft] = useState<Settings | null>(s.settings);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newAdapter, setNewAdapter] = useState("");

  useEffect(() => { setDraft(s.settings); }, [s.settings]);
  if (!s.settingsOpen || !draft) return null;

  const save = async (next: Settings) => {
    setDraft(next);
    try {
      const saved = await cmd.settingsSet(next);
      setState({ settings: saved });
      const providers = await cmd.providersList();
      setState({ providers });
    } catch (e) { toast("error", String(e)); }
  };

  const addWebProvider = async () => {
    if (!newName.trim() || !newUrl.trim() || !newAdapter) { toast("warn", "Name, URL and adapter are required."); return; }
    const id = `p${Math.random().toString(36).slice(2, 10)}`;
    await save({
      ...draft,
      providers: { ...draft.providers, web: [...draft.providers.web, { id, adapter_id: newAdapter, name: newName.trim() }] },
    });
    setAdding(false); setNewName(""); setNewUrl("");
    toast("info", "Provider added. Use 'Open / log in' to authenticate inside the embedded chat.");
  };

  const testLocal = async (kind: "ollama" | "lmstudio") => {
    try {
      const models = await cmd.modelsLocal(kind);
      toast("info", models.length ? `Connected. Models: ${models.slice(0, 6).join(", ")}${models.length > 6 ? "…" : ""}` : "Connected, but no models found.");
      setState({ providerModels: models });
    } catch (e) { toast("error", String(e)); }
  };

  return (
    <div class="modal-backdrop" onClick={() => setState({ settingsOpen: false })}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-head">
          <h2>Settings</h2>
          <button class="ghost" onClick={() => setState({ settingsOpen: false })}>✕</button>
        </div>

        <section>
          <h3>Providers — embedded web chats (your own account)</h3>
          <p class="dim">Neelima opens the provider's own web UI in an isolated webview. You log in yourself; credentials/cookies/tokens never leave the webview's private data directory and are never read or stored by Neelima.</p>
          {draft.providers.web.map((p) => (
            <div class="row-item" key={p.id}>
              <b>{p.name}</b> <span class="dim">({s.adapters.find((a: any) => a.id === p.adapter_id)?.name ?? p.adapter_id})</span>
              <span class="spacer" />
              <button class="ghost" onClick={async () => {
                setState({ providerSelected: `web:${p.id}`, view: "provider", settingsOpen: false });
                // Let the provider pane mount and report its rect first, then
                // create the webview at the right geometry.
                await new Promise((r) => setTimeout(r, 200));
                await cmd.providersLogin(p.id).catch((e) => toast("error", String(e)));
              }}>Open / log in</button>
              <button class="ghost danger" onClick={() => save({ ...draft, providers: { ...draft.providers, web: draft.providers.web.filter((x) => x.id !== p.id) } })}>Remove</button>
            </div>
          ))}
          {!adding ? (
            <button class="ghost" onClick={() => setAdding(true)}>＋ Connect a provider</button>
          ) : (
            <div class="add-form">
              <input placeholder="Display name (e.g. ChatGPT)" value={newName} onInput={(e: any) => setNewName(e.currentTarget.value)} />
              <input placeholder="Chat URL (https://…)" value={newUrl} onInput={(e: any) => setNewUrl(e.currentTarget.value)} />
              <select value={newAdapter} onChange={(e: any) => setNewAdapter(e.currentTarget.value)}>
                <option value="">Choose adapter…</option>
                {s.adapters.map((a) => <option value={a.id} key={a.id}>{a.name}</option>)}
              </select>
              <div class="row-item">
                <button class="btn-ok" onClick={addWebProvider}>Add</button>
                <button class="ghost" onClick={() => setAdding(false)}>Cancel</button>
                <span class="dim">No suitable adapter? Use Marketplace → Create with Inspector.</span>
              </div>
            </div>
          )}
        </section>

        <section>
          <h3>Local models</h3>
          <div class="row-item">
            <b>Ollama</b>
            <input class="grow" placeholder="http://localhost:11434" value={draft.providers.ollama?.url ?? ""}
              onInput={(e: any) => save({ ...draft, providers: { ...draft.providers, ollama: { url: e.currentTarget.value, model: draft.providers.ollama?.model ?? null } } })} />
            <select value={draft.providers.ollama?.model ?? ""}
              onChange={(e: any) => save({ ...draft, providers: { ...draft.providers, ollama: { url: draft.providers.ollama?.url ?? "http://localhost:11434", model: e.currentTarget.value || null } } })}>
              <option value="">model…</option>
              {s.providerModels.map((m) => <option key={m}>{m}</option>)}
            </select>
            <button class="ghost" onClick={() => testLocal("ollama")}>Test</button>
          </div>
          <div class="row-item">
            <b>LM Studio</b>
            <input class="grow" placeholder="http://localhost:1234" value={draft.providers.lmstudio?.url ?? ""}
              onInput={(e: any) => save({ ...draft, providers: { ...draft.providers, lmstudio: { url: e.currentTarget.value, model: draft.providers.lmstudio?.model ?? null } } })} />
            <select value={draft.providers.lmstudio?.model ?? ""}
              onChange={(e: any) => save({ ...draft, providers: { ...draft.providers, lmstudio: { url: draft.providers.lmstudio?.url ?? "http://localhost:1234", model: e.currentTarget.value || null } } })}>
              <option value="">model…</option>
              {s.providerModels.map((m) => <option key={m}>{m}</option>)}
            </select>
            <button class="ghost" onClick={() => testLocal("lmstudio")}>Test</button>
          </div>
        </section>

        <section>
          <h3>Permissions & safety</h3>
          <div class="row-item">
            <select value={draft.permission_mode} onChange={(e: any) => save({ ...draft, permission_mode: e.currentTarget.value })}>
              <option value="ask_all">Ask every time (safest)</option>
              <option value="ask_writes">Auto-approve reads, ask for writes & commands</option>
              <option value="full_access">Full access inside workspace</option>
            </select>
          </div>
          <div class="row-item">
            <span>Emergency-stop hotkey</span>
            <input value={draft.hotkey} onChange={(e: any) => setDraft({ ...draft, hotkey: e.currentTarget.value })} onBlur={() => save(draft)} />
          </div>
          <div class="row-item">
            <span>Terminal shell</span>
            <input class="grow" placeholder="(default)" value={draft.shell ?? ""} onChange={(e: any) => setDraft({ ...draft, shell: e.currentTarget.value || null })} onBlur={() => save(draft)} />
          </div>
          <div class="row-item">
            <span>Max iterations</span>
            <input type="number" min={1} max={200} value={draft.max_iterations} onChange={(e: any) => setDraft({ ...draft, max_iterations: Number(e.currentTarget.value) || 25 })} onBlur={() => save(draft)} />
            <span>Result cap (bytes)</span>
            <input type="number" min={1024} max={1048576} value={draft.result_cap_bytes} onChange={(e: any) => setDraft({ ...draft, result_cap_bytes: Number(e.currentTarget.value) || 30720 })} onBlur={() => save(draft)} />
          </div>
          <p class="dim">All content from files, command output and web pages is treated as data, never instructions. Suspected prompt-injection attempts are flagged with a warning badge.</p>
        </section>

        <section>
          <h3>About</h3>
          <p class="dim">Neelima runs fully locally: no telemetry, no accounts, no update pings. Network access is limited to localhost model servers and the pages you open in the provider webview.</p>
        </section>
      </div>
    </div>
  );
}

export default SettingsModal;
