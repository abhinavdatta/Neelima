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

  const addWebProvider = async (presetArg?: { id: string; name: string; url: string } | Event) => {
    // Buttons without arguments pass a click event; treat anything without an
    // `id` field as "use the manual form values".
    const preset = presetArg && typeof presetArg === "object" && "id" in presetArg
      ? (presetArg as { id: string; name: string; url: string })
      : undefined;
    let name = preset?.name ?? "";
    let url = preset?.url ?? "";
    let adapter = preset?.id ?? "";
    if (!preset) {
      name = newName.trim();
      url = newUrl.trim();
      adapter = newAdapter;
      if (!name || !url || !adapter) { toast("warn", "Name, URL and adapter are required."); return; }
    }
    if (preset) {
      // A preset must match its bundled adapter; these ship built-in.
      const ok = s.adapters.some((a: any) => a.id === adapter);
      if (!ok) { toast("error", `Adapter "${adapter}" not found — is the adapters dir set up?`); return; }
    }
    const id = `p${Math.random().toString(36).slice(2, 10)}`;
    await save({
      ...draft,
      providers: { ...draft.providers, web: [...draft.providers.web, { id, adapter_id: adapter, name }] },
    });
    setAdding(false); setNewName(""); setNewUrl("");
    if (preset) {
      setState({ providerSelected: `web:${id}`, view: "provider", settingsOpen: false });
      toast("info", `${name} connected. Log in once inside the embedded chat — after that Neelima drives it.`);
    } else {
      toast("info", "Provider added. Use 'Open / log in' to authenticate inside the embedded chat.");
    }
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
            <>
            <div class="preset-row">
              <button class="preset" onClick={() => addWebProvider({ id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/" })}>
                <b>ChatGPT</b><span class="dim">chatgpt.com</span>
              </button>
              <button class="preset" onClick={() => addWebProvider({ id: "claude", name: "Claude", url: "https://claude.ai/new" })}>
                <b>Claude</b><span class="dim">claude.ai</span>
              </button>
              <button class="preset" onClick={() => addWebProvider({ id: "gemini", name: "Gemini", url: "https://gemini.google.com/app" })}>
                <b>Gemini</b><span class="dim">gemini.google.com</span>
              </button>
            </div>
            <button class="ghost" onClick={() => setAdding(true)}>＋ Connect another (custom URL / adapter)</button>
            </>
          ) : (
            <div class="add-form">
              <input placeholder="Display name (e.g. ChatGPT)" value={newName} onInput={(e: any) => setNewName(e.currentTarget.value)} />
              <input placeholder="Chat URL (https://…)" value={newUrl} onInput={(e: any) => setNewUrl(e.currentTarget.value)} />
              <select value={newAdapter} onChange={(e: any) => setNewAdapter(e.currentTarget.value)}>
                <option value="">Choose adapter…</option>
                {s.adapters.map((a) => <option value={a.id} key={a.id}>{a.name}</option>)}
              </select>
              <div class="row-item">
                <button class="btn-ok" onClick={() => addWebProvider()}>Add</button>
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
              onInput={(e: any) => save({ ...draft, providers: { ...draft.providers, ollama: { ...draft.providers.ollama, url: e.currentTarget.value, model: draft.providers.ollama?.model ?? null } } })} />
            <select value={draft.providers.ollama?.model ?? ""}
              onChange={(e: any) => save({ ...draft, providers: { ...draft.providers, ollama: { ...draft.providers.ollama, url: draft.providers.ollama?.url ?? "http://localhost:11434", model: e.currentTarget.value || null } } })}>
              <option value="">model…</option>
              {s.providerModels.map((m) => <option key={m}>{m}</option>)}
            </select>
            <button class="ghost" onClick={() => testLocal("ollama")}>Test</button>
          </div>
          <div class="row-item">
            <span>Ollama context window</span>
            <input type="number" min={1} max={1048576} step={1}
              value={draft.providers.ollama?.num_ctx ?? 8192}
              onChange={(e: any) => save({
                ...draft,
                providers: {
                  ...draft.providers,
                  ollama: {
                    ...draft.providers.ollama,
                    url: draft.providers.ollama?.url ?? "http://localhost:11434",
                    model: draft.providers.ollama?.model ?? null,
                    num_ctx: Math.min(1048576, Math.max(1, Number(e.currentTarget.value) || 8192)),
                  },
                },
              })} />
            <span>Temperature</span>
            <input type="number" min={0} max={2} step={0.1}
              value={draft.providers.ollama?.temperature ?? 0.7}
              onChange={(e: any) => save({
                ...draft,
                providers: {
                  ...draft.providers,
                  ollama: {
                    ...draft.providers.ollama,
                    url: draft.providers.ollama?.url ?? "http://localhost:11434",
                    model: draft.providers.ollama?.model ?? null,
                    temperature: Math.min(2, Math.max(0, Number(e.currentTarget.value) || 0)),
                  },
                },
              })} />
          </div>
          <div class="row-item">
            <b>LM Studio</b>
            <input class="grow" placeholder="http://localhost:1234" value={draft.providers.lmstudio?.url ?? ""}
              onInput={(e: any) => save({ ...draft, providers: { ...draft.providers, lmstudio: { ...draft.providers.lmstudio, url: e.currentTarget.value, model: draft.providers.lmstudio?.model ?? null } } })} />
            <select value={draft.providers.lmstudio?.model ?? ""}
              onChange={(e: any) => save({ ...draft, providers: { ...draft.providers, lmstudio: { ...draft.providers.lmstudio, url: draft.providers.lmstudio?.url ?? "http://localhost:1234", model: e.currentTarget.value || null } } })}>
              <option value="">model…</option>
              {s.providerModels.map((m) => <option key={m}>{m}</option>)}
            </select>
            <button class="ghost" onClick={() => testLocal("lmstudio")}>Test</button>
          </div>
        </section>

        <section>
          <h3>Permissions & safety</h3>
          <div class="row-item">
            <select value={draft.permission_mode} onChange={(e: any) => {
              const mode = e.currentTarget.value as Settings["permission_mode"];
              if (mode === "full_access" && draft.permission_mode !== "full_access" &&
                  !window.confirm("Full access lets the agent run workspace reads, edits, and commands without per-action approval. Destructive commands and built-in safety checks still require approval. Continue?")) {
                e.currentTarget.value = draft.permission_mode;
                return;
              }
              void save({ ...draft, permission_mode: mode });
            }}>
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
