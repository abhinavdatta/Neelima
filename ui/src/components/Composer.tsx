// Composer: prompt box + attach (+) + permission mode + provider picker + send.
import { useRef, useState } from "preact/hooks";
import { getState, resetTask, setState, toast, useStore } from "../store";
import { cmd } from "../tauri";
import { addWorkspace } from "./Sidebar";

const MODE_LABEL: Record<string, string> = {
  ask_all: "Ask every time",
  ask_writes: "Auto-approve reads",
  full_access: "Full access",
};

export function Composer() {
  const s = useStore();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<null | "provider" | "mode" | "plus">(null);
  const readOnly = s.view === "task";

  const send = async () => {
    const text = ref.current?.value.trim();
    if (!text) return;
    if (s.agentState !== "idle" && s.agentState !== "done" && s.agentState !== "error") {
      toast("warn", "A task is already running.");
      return;
    }
    if (!s.activeWorkspacePath) {
      toast("warn", "Pick a project folder first (+ Add folder in the sidebar).");
      return;
    }
    if (ref.current) ref.current.value = "";
    resetTask();
    try {
      await cmd.taskStart(text, s.providerSelected);
      setState({ view: "chat" });
    } catch (e) {
      toast("error", String(e));
    }
  };

  const label = providerLabel(s);

  return (
    <footer class="composer">
      <div class="composer-box">
        <textarea
          ref={ref}
          rows={2}
          placeholder={readOnly ? "Viewing a past task — press New task to continue" : "Describe the task… (Enter to send, Shift+Enter for newline)"}
          disabled={readOnly}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
        <div class="composer-row">
          <div class="composer-left">
            <button class="chip-btn" title="Add a project folder to work in" onClick={() => addWorkspace()}>
              <span class="plus">＋</span>
            </button>
            <button class="chip-btn" onClick={() => setMenu(menu === "mode" ? null : "mode")}>
              <span class="shield">🛡</span> {s.settings ? MODE_LABEL[s.settings.permission_mode] : "Ask every time"} <span class="caret">▾</span>
            </button>
            {menu === "mode" ? <ModeMenu onPick={async (m) => { setMenu(null); await applyMode(m); }} /> : null}
          </div>
          <div class="composer-right">
            <div class="provider-wrap">
              <button class="chip-btn provider-chip" onClick={async () => { setMenu(menu === "provider" ? null : "provider"); await loadProviderMenu(); }}>
                <span class="brain">◍</span> {label} <span class="caret">▾</span>
              </button>
              {menu === "provider" ? <ProviderMenu onPick={(p) => { setMenu(null); setState({ providerSelected: p }); }} /> : null}
            </div>
            <button class="send-btn" title="Send" onClick={send} disabled={readOnly}>
              <svg viewBox="0 0 16 16"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="#111" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
}

async function applyMode(m: string) {
  const s = getState();
  if (!s.settings) return;
  try {
    const next = await cmd.settingsSet({ ...s.settings, permission_mode: m as any });
    setState({ settings: next });
  } catch (e) { toast("error", String(e)); }
}

async function loadProviderMenu() {
  try {
    const [providers, settings] = await Promise.all([cmd.providersList(), cmd.settingsGet()]);
    setState({ providers, settings });
  } catch (e) { console.error(e); }
}

function providerLabel(s: any): string {
  const id = s.providerSelected as string;
  if (id.startsWith("web:")) {
    const p = s.providers?.web?.find((w: any) => w.id === id.slice(4));
    return p ? `Web: ${p.name}` : "Web provider";
  }
  if (id === "ollama") return `Ollama: ${s.settings?.providers?.ollama?.model ?? "select model"}`;
  if (id === "lmstudio") return `LM Studio: ${s.settings?.providers?.lmstudio?.model ?? "select model"}`;
  return "Manual relay";
}

function ModeMenu({ onPick }: { onPick: (m: string) => void }) {
  return (
    <div class="menu">
      <button onClick={() => onPick("ask_all")}>🔒 Ask every time (safest)</button>
      <button onClick={() => onPick("ask_writes")}>◐ Auto-approve reads, ask for writes</button>
      <button onClick={() => onPick("full_access")}>⚡ Full access inside workspace</button>
    </div>
  );
}

function ProviderMenu({ onPick }: { onPick: (p: string) => void }) {
  const s = useStore();
  const webs: any[] = s.providers?.web ?? [];
  return (
    <div class="menu wide">
      <div class="menu-head">Embedded web chats (your login)</div>
      {webs.length === 0 ? <div class="menu-note">None yet — add one in Settings → Providers.</div> : null}
      {webs.map((p) => (
        <button key={p.id} onClick={() => onPick(`web:${p.id}`)}>🌐 {p.name}</button>
      ))}
      <div class="menu-head">Local models</div>
      <button onClick={() => onPick("ollama")}>🦙 Ollama {s.settings?.providers?.ollama ? "" : "(not configured)"}</button>
      <button onClick={() => onPick("lmstudio")}>🖥 LM Studio {s.settings?.providers?.lmstudio ? "" : "(not configured)"}</button>
      <div class="menu-head">Fallback</div>
      <button onClick={() => onPick("manual")}>📨 Manual relay (copy/paste)</button>
      <button class="menu-cta" onClick={() => setState({ settingsOpen: true })}>Open Settings…</button>
    </div>
  );
}

export default Composer;
