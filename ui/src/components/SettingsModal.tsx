// Settings: connect providers (web accounts, Ollama, LM Studio), permission
// mode, hotkey, shell, limits. Saved as plain JSON in the app config dir.
import { useEffect, useState } from "preact/hooks";
import { setState, toast, useStore } from "../store";
import { cmd } from "../tauri";
import type { Settings } from "../types";
import { Icon } from "./Icon";
import { DEFAULT_CUSTOM_THEME, parseCustomTheme } from "../theme";
import { SkillsPanel } from "./SkillsPanel";

export function SettingsModal() {
  const s = useStore();
  const [draft, setDraft] = useState<Settings | null>(s.settings);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newAdapter, setNewAdapter] = useState("");
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState("appearance");
  const [localModels, setLocalModels] = useState<{ ollama: string[]; lmstudio: string[] }>({ ollama: [], lmstudio: [] });
  const [localStatus, setLocalStatus] = useState<{ ollama: string; lmstudio: string }>({ ollama: "", lmstudio: "" });

  useEffect(() => { setDraft(s.settings); }, [s.settings]);
  const dirty = !!draft && !!s.settings && JSON.stringify(draft) !== JSON.stringify(s.settings);
  const close = () => {
    if (dirty && !window.confirm("Discard your unsaved Settings changes?")) return;
    setDraft(s.settings);
    setState({ settingsOpen: false });
  };
  useEffect(() => {
    if (!s.settingsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [s.settingsOpen, dirty, s.settings]);
  if (!s.settingsOpen || !draft) return null;

  const save = (next: Settings) => setDraft(next);
  const commit = async () => {
    if (saving || !dirty) return;
    if (draft.theme === "custom") {
      const parsed = parseCustomTheme(draft.custom_theme || DEFAULT_CUSTOM_THEME);
      if (parsed.error) { toast("error", parsed.error); return; }
    }
    setSaving(true);
    try {
      const saved = await cmd.settingsSet(draft);
      setState({ settings: saved });
      setDraft(saved);
      const providers = await cmd.providersList();
      setState({ providers });
      toast("info", "Settings saved.");
    } catch (e) { toast("error", `Settings were not saved: ${String(e)}`); }
    finally { setSaving(false); }
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
    let parsedUrl: URL;
    try { parsedUrl = new URL(url); } catch { toast("error", "Enter a valid HTTPS URL."); return; }
    const selectedAdapter = s.adapters.find((a: any) => a.id === adapter);
    const allowedHost = String(selectedAdapter?.allowed_domain || "").toLowerCase().replace(/^\.+/, "");
    const host = parsedUrl.hostname.toLowerCase();
    if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || (parsedUrl.port && parsedUrl.port !== "443") || !allowedHost || !(host === allowedHost || host.endsWith(`.${allowedHost}`))) {
      toast("error", `Use HTTPS on the selected adapter's allowed domain (${allowedHost || "no allowed domain configured"}).`); return;
    }
    const id = `p${Math.random().toString(36).slice(2, 10)}`;
    await save({
      ...draft,
      providers: { ...draft.providers, web: [...draft.providers.web, { id, adapter_id: adapter, name, url }] },
    });
    setAdding(false); setNewName(""); setNewUrl("");
    toast("info", `${name} added to the draft. Save Settings to apply it.`);
  };

  const testLocal = async (kind: "ollama" | "lmstudio") => {
    const defaultUrl = kind === "ollama" ? "http://localhost:11434" : "http://localhost:1234";
    const draftUrl = (draft.providers[kind]?.url || defaultUrl).trim();
    const savedUrl = (s.settings?.providers[kind]?.url || defaultUrl).trim();
    if (draftUrl !== savedUrl) {
      setLocalStatus((current) => ({ ...current, [kind]: "Save the URL before testing this connection." }));
      return;
    }
    try {
      const models = await cmd.modelsLocal(kind);
      setLocalModels((current) => ({ ...current, [kind]: models }));
      const message = models.length ? `Connection succeeded · ${models.length} model(s) found.` : "Connected, but no models were found.";
      setLocalStatus((current) => ({ ...current, [kind]: message }));
      toast("info", message);
    } catch (e) {
      const message = `Connection failed: ${String(e)}`;
      setLocalStatus((current) => ({ ...current, [kind]: message }));
      toast("error", message);
    }
  };

  const settingsTabs = [
    { id: "appearance", label: "Appearance", icon: "spark" },
    { id: "providers", label: "Providers", icon: "grid" },
    { id: "models", label: "Local models", icon: "terminal" },
    { id: "skills", label: "Skills", icon: "code" },
    { id: "safety", label: "Safety", icon: "settings" },
    { id: "about", label: "About", icon: "mail" },
  ] as const;

  const moveTab = (event: KeyboardEvent) => {
    const currentIndex = settingsTabs.findIndex((tab) => tab.id === activeTab);
    let nextIndex = currentIndex;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (currentIndex + 1) % settingsTabs.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + settingsTabs.length) % settingsTabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = settingsTabs.length - 1;
    else return;
    event.preventDefault();
    const next = settingsTabs[nextIndex];
    setActiveTab(next.id);
    document.getElementById(`settings-tab-${next.id}`)?.focus();
  };

  return (
    <div class="modal-backdrop" onClick={close}>
      <div class="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <div class="modal-head settings-header">
          <div><span class="settings-kicker">PREFERENCES</span><h2 id="settings-title">Settings</h2></div>
          <button class="ghost icon-button" aria-label="Close Settings" onClick={close}><Icon name="close" /></button>
        </div>

        <div class="settings-layout">
          <nav class="settings-nav" role="tablist" aria-label="Settings categories" onKeyDown={moveTab}>
            {settingsTabs.map((tab) => (
              <button
                id={`settings-tab-${tab.id}`}
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls="settings-panel"
                tabIndex={activeTab === tab.id ? 0 : -1}
                class={activeTab === tab.id ? "active" : ""}
                onClick={() => setActiveTab(tab.id)}
              ><Icon name={tab.icon} size={17} /><span>{tab.label}</span>{tab.id === "providers" && draft.providers.web.length > 0 ? <small>{draft.providers.web.length}</small> : null}</button>
            ))}
          </nav>
          <div id="settings-panel" class="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${activeTab}`} tabIndex={0}>
        {activeTab === "appearance" ? <section class="appearance-settings">
          <h3>Appearance</h3>
          <p class="dim">Choose a built-in theme or define a palette with CSS variables or JSON.</p>
          <div class="theme-options" role="group" aria-label="Color theme">
            {(["light", "dark", "pure_dark", "system", "custom"] as const).map((theme) => (
              <button key={theme} type="button" class={`theme-option theme-option-${theme} ${draft.theme === theme ? "selected" : ""}`} aria-pressed={draft.theme === theme} onClick={() => save({ ...draft, theme, custom_theme: theme === "custom" && !draft.custom_theme ? DEFAULT_CUSTOM_THEME : draft.custom_theme })}>
                <span class="theme-preview" aria-hidden="true"><i /><i /><i /></span>
                <span>{theme === "system" ? "System" : theme === "pure_dark" ? "Pure dark" : theme === "custom" ? "Custom" : theme[0].toUpperCase() + theme.slice(1)}</span>
              </button>
            ))}
          </div>
          {draft.theme === "custom" ? <CustomThemeEditor
            value={draft.custom_theme || DEFAULT_CUSTOM_THEME}
            onChange={(custom_theme) => save({ ...draft, custom_theme })}
          /> : null}
        </section> : null}

        {activeTab === "providers" ? <section>
          <h3>Provider sign-in</h3>
          <p class="dim">Neelima is the chat workspace. Provider windows are only for sign-in; website adapters can change when providers update their sites, and sign-in does not grant API access.</p>
          {draft.providers.web.map((p) => (
            <div class="row-item" key={p.id}>
              <b>{p.name}</b> <span class="dim">({s.adapters.find((a: any) => a.id === p.adapter_id)?.name ?? p.adapter_id})</span>
              <span class="spacer" />
              <button class="ghost" onClick={() => {
                if (dirty) { toast("warn", "Save or cancel your draft changes before opening this provider."); return; }
                setState({ providerSelected: `web:${p.id}`, view: "provider", settingsOpen: false });
              }}>Sign in</button>
              <button class="ghost danger" onClick={() => {
                if (!window.confirm(`Remove ${p.name} from Neelima's provider list? Its saved browser session data will remain in app data.`)) return;
                save({ ...draft, providers: { ...draft.providers, web: draft.providers.web.filter((x) => x.id !== p.id) } });
              }}>Remove</button>
              <button class="ghost danger" disabled={dirty} title={dirty ? "Save or cancel Settings changes first" : "Delete this provider's saved sign-in data"} onClick={async () => {
                if (!window.confirm(`Clear the saved sign-in data for ${p.name}? You will need to sign in again.`)) return;
                try { await cmd.providerClearSession(p.id); toast("info", `${p.name} sign-in data cleared.`); }
                catch (e) { toast("error", `Could not clear sign-in data: ${String(e)}`); }
              }}>Clear sign-in data</button>
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
            <button class="ghost inline-icon-button" onClick={() => setAdding(true)}><Icon name="add" size={16} /> Connect another (custom URL / adapter)</button>
            </>
          ) : (
            <div class="add-form">
              <input placeholder="Display name (e.g. ChatGPT)" value={newName} onInput={(e: any) => setNewName(e.currentTarget.value)} />
              <input placeholder="Chat URL (HTTPS on adapter's allowed domain)" value={newUrl} onInput={(e: any) => setNewUrl(e.currentTarget.value)} />
              <select value={newAdapter} onChange={(e: any) => setNewAdapter(e.currentTarget.value)}>
                <option value="">Choose adapter…</option>
                {s.adapters.map((a) => <option value={a.id} key={a.id}>{a.name}</option>)}
              </select>
              <div class="row-item">
                <button class="btn-ok" onClick={() => addWebProvider()}>Add</button>
                <button class="ghost" onClick={() => setAdding(false)}>Cancel</button>
                <span class="dim">The URL must stay within the selected adapter's allowed HTTPS domain. No suitable adapter? Use Marketplace → Create with Inspector.</span>
              </div>
            </div>
          )}
        </section> : null}

        {activeTab === "models" ? <section>
          <h3>Local models</h3>
          <div class="row-item">
            <b>Ollama</b>
            <input class="grow" placeholder="http://localhost:11434" value={draft.providers.ollama?.url ?? ""}
              onInput={(e: any) => setDraft({ ...draft, providers: { ...draft.providers, ollama: { ...draft.providers.ollama, url: e.currentTarget.value, model: draft.providers.ollama?.model ?? null } } })}
              onBlur={() => void save(draft)} onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }} />
            <select value={draft.providers.ollama?.model ?? ""}
              onChange={(e: any) => save({ ...draft, providers: { ...draft.providers, ollama: { ...draft.providers.ollama, url: draft.providers.ollama?.url ?? "http://localhost:11434", model: e.currentTarget.value || null } } })}>
              <option value="">model…</option>
              {localModels.ollama.map((m) => <option key={m}>{m}</option>)}
            </select>
            <button class="ghost" title={dirty ? "Save settings before testing the draft URL" : "Test the saved Ollama URL"} disabled={!!s.settings && (draft.providers.ollama?.url || "http://localhost:11434") !== (s.settings.providers.ollama?.url || "http://localhost:11434")} onClick={() => void testLocal("ollama")}>Test</button>
            {localStatus.ollama ? <small class="local-status">{localStatus.ollama}</small> : null}
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
              onInput={(e: any) => setDraft({ ...draft, providers: { ...draft.providers, lmstudio: { ...draft.providers.lmstudio, url: e.currentTarget.value, model: draft.providers.lmstudio?.model ?? null } } })}
              onBlur={() => void save(draft)} onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }} />
            <select value={draft.providers.lmstudio?.model ?? ""}
              onChange={(e: any) => save({ ...draft, providers: { ...draft.providers, lmstudio: { ...draft.providers.lmstudio, url: draft.providers.lmstudio?.url ?? "http://localhost:1234", model: e.currentTarget.value || null } } })}>
              <option value="">model…</option>
              {localModels.lmstudio.map((m) => <option key={m}>{m}</option>)}
            </select>
            <button class="ghost" title={dirty ? "Save settings before testing the draft URL" : "Test the saved LM Studio URL"} disabled={!!s.settings && (draft.providers.lmstudio?.url || "http://localhost:1234") !== (s.settings.providers.lmstudio?.url || "http://localhost:1234")} onClick={() => void testLocal("lmstudio")}>Test</button>
            {localStatus.lmstudio ? <small class="local-status">{localStatus.lmstudio}</small> : null}
          </div>
        </section> : null}

        {activeTab === "skills" ? <section class="skills-settings-section">
          <h3>Skills</h3>
          <p class="dim">Skills add reusable guidance you can attach to any task from the composer. Their text is untrusted: they cannot change permissions or run anything.</p>
          <SkillsPanel />
        </section> : null}

        {activeTab === "safety" ? <section>
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
            <span>Terminal shell override</span>
            <input class="grow" placeholder="Auto-detect for this OS" value={draft.shell ?? ""} onChange={(e: any) => setDraft({ ...draft, shell: e.currentTarget.value || null })} onBlur={() => save(draft)} />
          </div>
          <div class="row-item">
            <span>Max iterations</span>
            <input type="number" min={1} max={200} value={draft.max_iterations} onChange={(e: any) => setDraft({ ...draft, max_iterations: Number(e.currentTarget.value) || 25 })} onBlur={() => save(draft)} />
            <span>Result cap (bytes)</span>
            <input type="number" min={1024} max={1048576} value={draft.result_cap_bytes} onChange={(e: any) => setDraft({ ...draft, result_cap_bytes: Number(e.currentTarget.value) || 30720 })} onBlur={() => save(draft)} />
          </div>
          <p class="dim">All content from files, command output and web pages is treated as data, never instructions. Suspected prompt-injection attempts are flagged with a warning badge.</p>
        </section> : null}

        {activeTab === "about" ? <section>
          <h3>About</h3>
          <p class="dim">Neelima runs fully locally: no telemetry, no accounts, no update pings. Network access is limited to localhost model servers and the pages you open in the provider webview.</p>
        </section> : null}
          </div>
        </div>
        <div class="settings-actions">
          <span class="dim">{dirty ? "Unsaved changes" : "All changes saved"}</span>
          <button class="ghost" onClick={() => { setDraft(s.settings); setState({ settingsOpen: false }); }}>Cancel</button>
          <button class="btn-ok" disabled={!dirty || saving} onClick={() => void commit()}>{saving ? "Saving…" : "Save settings"}</button>
        </div>
      </div>
    </div>
  );
}

export default SettingsModal;

function CustomThemeEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const parsed = parseCustomTheme(value);
  return (
    <div class="custom-theme-editor">
      <div class="custom-theme-editor-head">
        <label for="custom-theme-code">Theme code · {parsed.format.toUpperCase()}</label>
        <label class="theme-file-button">
          Load .css / .json
          <input type="file" accept=".css,.json,text/css,application/json" onChange={async (event: any) => {
            const input = event.currentTarget as HTMLInputElement;
            const file = input.files?.[0];
            if (!file) return;
            if (file.size > 16 * 1024) { toast("error", "Theme file must be 16 KiB or smaller."); input.value = ""; return; }
            onChange(await file.text());
            input.value = "";
          }} />
        </label>
      </div>
      <textarea id="custom-theme-code" spellcheck={false} value={value} onInput={(event: any) => onChange(event.currentTarget.value)} />
      {parsed.error
        ? <p class="custom-theme-error" role="alert">{parsed.error}</p>
        : <p class="custom-theme-help">Allowed tokens: background, surfaces, text, muted text, borders, hover, and accent. JavaScript, selectors, URLs, and other CSS are rejected.</p>}
      <button type="button" class="ghost" onClick={() => onChange(DEFAULT_CUSTOM_THEME)}>Reset custom palette</button>
    </div>
  );
}
