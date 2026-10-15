// Plugin Marketplace = adapter manager: list adapters, open the adapters
// folder, create a new adapter with the Inspector (click input / send /
// last message in the provider page).
import { useState } from "preact/hooks";
import { setState, toast, useStore } from "../store";
import { cmd } from "../tauri";

export function MarketplacePane() {
  const s = useStore();
  const [inspName, setInspName] = useState("");
  const [inspUrl, setInspUrl] = useState("");
  const [captured, setCaptured] = useState<{ kind: string; selector: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const startInspector = async () => {
    if (!inspName.trim() || !inspUrl.trim()) { toast("warn", "Give the provider a name and a chat URL."); return; }
    setCaptured([]);
    try {
      await cmd.inspectorStart(inspName.trim(), inspUrl.trim());
      setState({ view: "provider" });
      toast("info", "Log into the site in the provider view, then come back here to capture selectors.");
      setBusy("ready");
    } catch (e) { toast("error", String(e)); }
  };

  const capture = async (kind: string) => {
    try {
      const r = await cmd.inspectorCapture(kind);
      setCaptured((c) => [...c.filter((x) => x.kind !== kind), r]);
      toast("info", `${kind}: ${r.selector}`);
    } catch (e) { toast("error", String(e)); }
  };

  return (
    <div class="pane">
      <h2>Plugin Marketplace</h2>
      <p class="dim">Provider adapters are plain JSON files, hot-reloaded on save. DOM selectors break often — the Inspector records them for you by clicking the elements in the real page.</p>

      <div class="card">
        <h3>Installed adapters</h3>
        {s.adapters.map((a) => (
          <div class="row-item" key={a.id}>
            <b>{a.name}</b> <span class="dim">{a.url}</span> {a.built_in ? <span class="chip">built-in</span> : null}
          </div>
        ))}
        <div class="row-item">
          <button class="ghost" onClick={() => cmd.adaptersOpenFolder()}>Open adapters folder</button>
        </div>
      </div>

      <div class="card">
        <h3>Create with the Adapter Inspector</h3>
        <div class="add-form">
          <input placeholder="Provider name" value={inspName} onInput={(e: any) => setInspName(e.currentTarget.value)} />
          <input placeholder="https://chat.example.com/" value={inspUrl} onInput={(e: any) => setInspUrl(e.currentTarget.value)} />
          <button class="btn-ok" onClick={startInspector}>Open page with Inspector</button>
        </div>
        {busy === "ready" ? (
          <>
            <p class="hint">In the provider view: log in, open a chat, then click each button below and click the matching element on the page.</p>
            <div class="row-item">
              <button class="ghost" onClick={() => capture("input")}>1. Capture input box</button>
              <button class="ghost" onClick={() => capture("send")}>2. Capture send button</button>
              <button class="ghost" onClick={() => capture("assistant")}>3. Capture last assistant message</button>
            </div>
            {captured.map((c) => <div class="row-item" key={c.kind}><code>{c.kind}</code> → <code>{c.selector}</code></div>)}
            {captured.length >= 3 ? (
              <button class="btn-ok" onClick={async () => {
                try {
                  const a = await cmd.inspectorFinish();
                  const adapters = await cmd.adaptersList();
                  setState({ adapters });
                  toast("info", `Adapter "${a.name}" saved — it hot-reloaded.`);
                  setBusy(null);
                } catch (e) { toast("error", String(e)); }
              }}>Save adapter</button>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

export default MarketplacePane;
